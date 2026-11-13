// Read Aloud daemon.
//
// Holds the text being read, plays it, and answers a control socket. The
// model runs in a separate process (synth.ts) that is started on the first
// request and killed when idle, so this process stays small.
//
//   segment.ts        text -> chunks and words
//   engine-client.ts  the model process
//   align.ts          model output -> PCM and word times
//   player.ts         pw-play
//   server.ts         the control socket
//   this file         the read itself: what to synthesize, play and show
//
// Privacy ("incognito only"):
//   - Text is kept in RAM only, and only until Clear, or FORGET_SEC without
//     playback. It is never written to disk, logged, or put in arguments.
//   - Audio is played straight from RAM to pw-play and dropped once heard.
//   - The socket lives in $XDG_RUNTIME_DIR (tmpfs) in a 0700 directory.
//   - Logs carry state changes only: no text, no counts derived from it.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { alignWords, RATE, trimAndConvert } from "./align.ts";
import { Engine } from "./engine-client.ts";
import { Player } from "./player.ts";
import { DEFAULT_RAMP, segment, type Segment } from "./segment.ts";
import { send, serve, type Client } from "./server.ts";

const env = (k: string, d: number) => Number(process.env[k] ?? d);
// The model is unloaded this long after its last synthesis, even while the
// buffered audio is still playing: a 73 s read is synthesized in ~16 s, after
// which only this ~40 MB process and the PCM remain.
// Default 0 (unload at once): about a second after the model goes idle, the
// Bun runtime in synth.ts grows by ~150 MB (590 -> 715 MB peak), and no GC
// setting avoided it. The cost is a ~1.5 s cold start on the next read.
const IDLE_UNLOAD_SEC = env("READ_ALOUD_IDLE_UNLOAD_SEC", 0);
const FORGET_SEC = env("READ_ALOUD_FORGET_SEC", 600);
const MAX_CHARS = env("READ_ALOUD_MAX_CHARS", 200_000);
// Synthesize the whole text back to back, up to 10 min ahead (~29 MB of PCM).
// Idle gaps between generations measured ~120 MB higher peak RSS in the model
// process (717 vs 590 MB), and finishing early lets the model unload sooner.
const SYNTH_AHEAD_SEC = 600;
const WRITE_AHEAD_SEC = 0.3; // pw-play never holds more than this, so pause is instant
const TICK_MS = 40;
const RAMP = process.env.READ_ALOUD_RAMP
  ? process.env.READ_ALOUD_RAMP.split(",").map(Number).filter((n) => n >= 2)
  : DEFAULT_RAMP;

const RUNTIME = process.env.XDG_RUNTIME_DIR;
if (!RUNTIME) throw new Error("XDG_RUNTIME_DIR is not set");
const SOCK = join(RUNTIME, "omarchy-read-aloud", "control.sock");
const ENGINE_DIR = import.meta.dir;

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.error([event, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join(" "));

// --- voices (shipped inside kokoro-js; no network) ---------------------------
const VOICES = (() => {
  try {
    const dir = join(dirname(Bun.resolveSync("kokoro-js", ENGINE_DIR)), "..", "voices");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".bin"))
      .map((f) => f.slice(0, -4))
      .filter((v) => /^[ab][fm]_/.test(v)) // English voices; others need other G2P
      .sort();
  } catch {
    return ["af_heart"];
  }
})();

// --- state -------------------------------------------------------------------
type Phase = "empty" | "ready" | "loading" | "playing" | "paused";
type Chunk = Segment & {
  pcm: Int16Array | null; // null until synthesized, and again once heard
  at: number; // global sample index where this chunk starts (-1 = unknown)
  len: number;
  wordAt: number[] | null; // start sample of each word, relative to pcm
};
type Span = { start: number; end: number }; // char offsets into `text`

let phase: Phase = "empty";
let text = "";
let textRev = 0;
let chunks: Chunk[] = [];
let words: Span[] = [];
let voice = VOICES.includes(process.env.READ_ALOUD_VOICE ?? "")
  ? process.env.READ_ALOUD_VOICE!
  : VOICES.includes("af_heart") ? "af_heart" : VOICES[0];
let speed = Math.min(2, Math.max(0.5, env("READ_ALOUD_SPEED", 1)));
let error = "";

let gen = 0; // bumped on stop/replace; stale synth results are dropped
let synthNext = 0; // next chunk index to send to the model
let synthBusy = false;
let synthEnd = 0; // global samples synthesized (contiguous from 0)
let playPos = 0; // global sample index of the playhead
let writePos = 0; // global samples written to the current player
let lastTick = 0;
let lastActivity = Date.now();
let lastSynthAt = Date.now();
let crashRetries = 0; // model restarts in a row for this read

const reading = () => phase === "playing" || phase === "loading" || phase === "paused";

const engine = new Engine({
  script: join(ENGINE_DIR, "synth.ts"),
  env: { READ_ALOUD_MODELS: process.env.READ_ALOUD_MODELS ?? join(ENGINE_DIR, "..", "models") },
  log,
  onFatal: (message) => fail(message),
});

const player = new Player((code) => {
  if (phase === "playing" || phase === "loading") fail(`Audio output failed (pw-play exited ${code}).`);
});

function startPlayer() {
  if (player.running) return;
  player.start();
  writePos = playPos;
  lastTick = performance.now();
}

// --- synthesis loop ---------------------------------------------------------------
async function pumpSynth() {
  if (synthBusy) return;
  synthBusy = true;
  try {
    while (reading() && synthNext < chunks.length && (synthEnd - playPos) / RATE < SYNTH_AHEAD_SEC) {
      const myGen = gen;
      const i = synthNext;
      const r = await engine.synth(chunks[i].speak, voice, speed);
      lastSynthAt = Date.now();
      if (myGen !== gen) continue; // stopped, replaced or re-voiced meanwhile
      const c = chunks[i];
      if (r.type !== "result") {
        log("synth.error", { message: r.message });
        if (!engine.running) {
          // The model process died (crashed, killed for memory): start it
          // again once and retry this chunk before giving up on the read.
          if (crashRetries++ < 1) { log("engine.retry"); continue; }
          return fail(error || "The speech model stopped unexpectedly.");
        }
        // One bad chunk should not end the whole read; skip it.
        c.pcm = new Int16Array(0);
        c.wordAt = null;
      } else {
        crashRetries = 0;
        const { pcm, offset } = trimAndConvert(r.samples, c.speak);
        c.pcm = pcm;
        const textWords = c.speak.split(" ").slice(0, c.wn);
        c.wordAt = alignWords(textWords, Array.isArray(r.words) ? r.words : [], r.samples.length)
          .map((at) => Math.max(0, at - offset));
      }
      c.at = synthEnd;
      c.len = c.pcm.length;
      synthEnd += c.len;
      synthNext = i + 1;
      if (phase === "loading") { setPhase("playing"); tick(); }
    }
  } finally {
    synthBusy = false;
  }
}

// --- playback ------------------------------------------------------------------------
function chunkAt(pos: number) {
  for (let i = 0; i < synthNext; i++) {
    const c = chunks[i];
    if (pos < c.at + c.len) return i;
  }
  return synthNext - 1;
}

let lastHighlight = -1; // chunk being heard, for progress
function tick() {
  const now = performance.now();
  maybeIdle();
  if (phase !== "playing" || !player.running) {
    lastTick = now;
    return;
  }
  // Advance the playhead in real time, but never past what was written: an
  // underrun means pw-play is playing silence, not our audio.
  playPos = Math.min(writePos, playPos + ((now - lastTick) / 1000) * RATE);
  lastTick = now;
  lastActivity = Date.now();

  // Feed the player up to WRITE_AHEAD_SEC past the playhead.
  const target = playPos + WRITE_AHEAD_SEC * RATE;
  while (writePos < target && writePos < synthEnd) {
    const c = chunks[chunkAt(writePos)];
    if (!c?.pcm) break;
    const off = Math.floor(writePos - c.at);
    const n = Math.min(c.len - off, Math.ceil(target - writePos));
    if (n <= 0) { writePos = c.at + c.len; continue; }
    if (!player.write(c.pcm.subarray(off, off + n))) break;
    writePos += n;
  }
  player.flush();

  // Drop audio that has been heard.
  for (let i = 0; i < synthNext; i++) {
    const c = chunks[i];
    if (c.pcm && c.at + c.len < playPos - RATE) c.pcm = null;
  }

  const cur = chunkAt(playPos);
  if (cur !== lastHighlight) { lastHighlight = cur; broadcastState(); }
  updateWord();

  if (synthNext >= chunks.length && playPos >= synthEnd) {
    player.finish();
    resetPlayback();
    setPhase("ready");
    return;
  }
  void pumpSynth();
}

// The word being heard. playPos runs ahead of the speakers by the player's
// buffering, so look a little behind it.
const WORD_LAG = Math.round(0.08 * RATE);
let lastWord = -1;
function updateWord() {
  const pos = Math.max(0, playPos - WORD_LAG);
  const c = chunks[chunkAt(pos)];
  let w = -1;
  if (c?.wordAt) {
    const rel = pos - c.at;
    let k = 0;
    while (k + 1 < c.wordAt.length && c.wordAt[k + 1] <= rel) k++;
    w = c.w0 + k;
  }
  if (w !== lastWord) {
    lastWord = w;
    server.broadcast(wordMsg());
  }
}

function resetPlayback() {
  gen++;
  lastWord = -1;
  server.broadcast(wordMsg());
  for (const c of chunks) { c.pcm = null; c.at = -1; c.len = 0; c.wordAt = null; }
  synthNext = 0;
  synthEnd = 0;
  playPos = 0;
  writePos = 0;
  lastHighlight = -1;
}

// --- idle: unload the model, then forget the text ------------------------------------
function maybeIdle() {
  const now = Date.now();
  // Model: unload once nothing is left to synthesize for a while.
  const needsModel = reading() && synthNext < chunks.length;
  if (engine.state === "loaded" && !synthBusy && !needsModel
      && (now - lastSynthAt) / 1000 >= IDLE_UNLOAD_SEC) engine.stop("idle");
  // Text: forget it after FORGET_SEC without playback.
  if (phase === "playing" || phase === "loading") return;
  if (phase !== "empty" && (now - lastActivity) / 1000 >= FORGET_SEC) {
    log("text.forget", { reason: "idle" });
    clear();
  }
}

// --- commands --------------------------------------------------------------------------
function setPhase(p: Phase) {
  if (phase === p) return;
  phase = p;
  log("phase", { phase: p });
  broadcastState();
}

function fail(message: string) {
  error = message;
  log("error", { message });
  player.kill();
  resetPlayback();
  setPhase(text ? "ready" : "empty");
  broadcastState();
}

function speak(newText?: string) {
  error = "";
  crashRetries = 0;
  lastActivity = Date.now();
  if (typeof newText === "string") {
    const t = newText.slice(0, MAX_CHARS);
    if (!t.trim()) return;
    player.kill();
    resetPlayback();
    text = t;
    textRev++;
    const s = segment(text, RAMP);
    words = s.words.map(({ start, end }) => ({ start, end }));
    chunks = s.segments.map((seg) => ({ ...seg, pcm: null, at: -1, len: 0, wordAt: null }));
    broadcastText();
  } else if (phase === "paused") {
    return resume();
  } else if (phase === "playing" || phase === "loading") {
    return;
  }
  if (!chunks.length) return;
  setPhase("loading");
  startPlayer();
  void pumpSynth();
}

function pause() {
  if (phase !== "playing" && phase !== "loading") return;
  // Killing pw-play drops its ~0.3 s buffer, so audio stops at once; the
  // playhead stays where it was and resume() continues from there.
  player.kill();
  writePos = playPos;
  lastActivity = Date.now();
  setPhase("paused");
}

function resume() {
  if (phase !== "paused") return;
  lastActivity = Date.now();
  startPlayer();
  setPhase(synthEnd > playPos ? "playing" : "loading");
  void pumpSynth();
}

function stop() {
  player.kill();
  resetPlayback();
  // A model still loading is not needed any more: don't let it finish
  // (~0.4 s and ~300 MB) only to be unloaded.
  if (engine.state === "loading") engine.stop("stopped");
  lastActivity = Date.now();
  setPhase(text ? "ready" : "empty");
}

function clear() {
  stop();
  text = "";
  chunks = [];
  words = [];
  textRev++;
  error = "";
  setPhase("empty");
  broadcastText();
}

function setOptions(o: { voice?: unknown; speed?: unknown }) {
  const before = voice + "/" + speed;
  if (typeof o.voice === "string" && VOICES.includes(o.voice)) voice = o.voice;
  if (typeof o.speed === "number" && isFinite(o.speed)) speed = Math.min(2, Math.max(0.5, o.speed));
  if (voice + "/" + speed !== before && reading()) resynthFrom(nextUnwritten());
  broadcastState();
}

// The text is synthesized well ahead of playback, so a new voice or speed
// would otherwise only be heard on the next read. Drop everything not yet
// handed to the player and synthesize it again with the new settings.
function nextUnwritten() {
  for (let i = 0; i < synthNext; i++) if (writePos < chunks[i].at + chunks[i].len) return i + 1;
  return synthNext;
}
function resynthFrom(k: number) {
  if (k >= chunks.length) return;
  gen++; // drops the result of a synthesis already in flight
  for (let i = k; i < chunks.length; i++) { chunks[i].pcm = null; chunks[i].at = -1; chunks[i].len = 0; chunks[i].wordAt = null; }
  if (k < synthNext) {
    synthNext = k;
    synthEnd = k > 0 ? chunks[k - 1].at + chunks[k - 1].len : 0;
  }
  log("resynth");
  void pumpSynth();
}

// --- socket ----------------------------------------------------------------------------
// `voices` never changes while running, so it is sent with replies to
// subscribe and status only, not with every pushed state.
function stateMsg(withVoices = false) {
  return {
    type: "state",
    phase,
    engine: engine.state,
    textRev,
    hasText: text.length > 0,
    progress: chunks.length ? Math.max(0, lastHighlight) / chunks.length : 0,
    voice,
    speed,
    ...(withVoices ? { voices: VOICES } : {}),
    error,
  };
}
const textMsg = () => ({ type: "text", textRev, text });
const wordMsg = () => ({ type: "word", word: lastWord >= 0 && words[lastWord] ? words[lastWord] : null });

const broadcastState = () => server.broadcast(stateMsg());
const broadcastText = () => server.broadcast(textMsg());

function handle(s: Client, line: string) {
  let req: any;
  try { req = JSON.parse(line); } catch { return send(s, { type: "error", error: "bad json" }); }
  switch (req?.cmd) {
    case "subscribe":
      s.data.subscribed = true;
      send(s, textMsg());
      send(s, stateMsg(true));
      send(s, wordMsg());
      return;
    case "status": return send(s, stateMsg(true));
    case "text": return send(s, textMsg());
    case "speak": speak(typeof req.text === "string" ? req.text : undefined); break;
    case "toggle":
      if (phase === "playing" || phase === "loading") pause(); else speak();
      break;
    case "pause": pause(); break;
    case "resume": resume(); break;
    case "stop": stop(); break;
    case "clear": clear(); break;
    case "set": setOptions(req); break;
    default: return send(s, { type: "error", error: "unknown command" });
  }
  send(s, { type: "ok" });
}

// A JSON-escaped text can be up to 6 characters per character in theory; real
// text is close to 1. Anything past this is not a request we would accept.
const server = serve(SOCK, MAX_CHARS * 2 + 4096, handle);

setInterval(tick, TICK_MS);

const shutdown = () => {
  player.kill();
  engine.stop("shutdown");
  server.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

log("listening", { voices: VOICES.length, idleUnloadSec: IDLE_UNLOAD_SEC, forgetSec: FORGET_SEC });
