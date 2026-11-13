// Model process. The daemon (speakd.ts) starts it on demand and kills it when
// idle, so the ~300-600 MB the model needs is returned to the system in full.
//
// Talks to the daemon only over Bun IPC (a private pipe). Text arrives in IPC
// messages, never in arguments or the environment, and is never logged.
//
//   daemon -> synth : { type: "synth", id, text, voice, speed }
//   synth -> daemon : { type: "ready", loadMs }
//                     { type: "result", id, samples: Float32Array, rate,
//                       words: [{ s, e, n }] }   spoken words: sample span and
//                                                phoneme count, in order
//                     { type: "error", id, message }   (message has no text)
//                     { type: "fatal", message }

import { KokoroTTS } from "kokoro-js";
import {
  AutoTokenizer,
  StyleTextToSpeech2Model,
  env,
} from "@huggingface/transformers";
import { availableParallelism } from "node:os";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
// model_timed_fp16.onnx = model_fp16.onnx plus the per-token durations as a
// second output (see patch-model.ts).
const MODEL_FILE = "model_timed";
const DURATIONS = "/encoder/Gather_output_0";
const SAMPLES_PER_FRAME = 600; // 24 kHz, 25 ms frames (verified: frames x 600 = samples)
const DTYPE = process.env.READ_ALOUD_DTYPE ?? "fp16";
// Measured on a 13700HX: 6 is fastest; more threads cost memory, not speed.
const THREADS = Number(
  process.env.READ_ALOUD_THREADS ??
    Math.max(1, Math.min(6, availableParallelism())),
);

// Model files live with the engine, not in node_modules.
if (process.env.READ_ALOUD_MODELS) env.cacheDir = process.env.READ_ALOUD_MODELS;
// Once the model is on disk, never touch the network again.
if (process.env.READ_ALOUD_OFFLINE === "1") env.allowRemoteModels = false;

const send = (msg: Record<string, unknown>) => process.send!(msg);

const t0 = performance.now();
let tts: KokoroTTS;
let last: { ids: number[]; dur?: BigInt64Array } | null = null;
const tokenChar: string[] = [];

// Spoken words from the token durations: a space token ends a word. Each word
// gets its sample span and its phoneme count (used to align it to the text).
function wordSpans() {
  if (!last?.dur) return [];
  const words: { s: number; e: number; n: number }[] = [];
  let t = 0, cur: { s: number; e: number; n: number } | null = null;
  for (let i = 0; i < last.ids.length; i++) {
    const len = Number(last.dur[i]) * SAMPLES_PER_FRAME;
    const ch = tokenChar[last.ids[i]] ?? "";
    if (ch === " " || ch === "$" || ch === "") { cur = null; }
    else if (/\p{L}/u.test(ch)) {
      if (!cur) { cur = { s: t, e: t + len, n: 0 }; words.push(cur); }
      cur.e = t + len;
      cur.n++;
    }
    t += len;
  }
  return words;
}
try {
  const model = await StyleTextToSpeech2Model.from_pretrained(MODEL, {
    dtype: DTYPE,
    device: "cpu",
    model_file_name: MODEL_FILE,
    session_options: {
      intraOpNumThreads: THREADS,
      interOpNumThreads: 1,
      executionMode: "sequential",
      // "basic" loads ~80 ms faster than "all" (328 vs 410 ms) and measured
      // the same synthesis speed; the extra fusions do not pay off here.
      graphOptimizationLevel: "basic",
      // Pre-packed weight copies cost ~100 MB for a few % speed.
      extra: { session: { disable_prepacking: "1" } },
    },
  } as any);
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
  tts = new KokoroTTS(model, tokenizer);
  // kokoro-js returns only the waveform; keep the durations and the tokens
  // of the last call as well. Tokens are single phoneme characters.
  const call = tts.model;
  (tts as any).model = async (inputs: any) => {
    const out = await (call as any)(inputs);
    last = { ids: Array.from(inputs.input_ids.data as BigInt64Array, Number), dur: out[DURATIONS]?.data };
    return out;
  };
  for (const [ch, id] of (tokenizer as any).model.tokens_to_ids as Map<string, number>) tokenChar[id] = ch;
  if (tokenChar[16] !== " ") throw new Error("unexpected tokenizer vocabulary");
} catch (e) {
  send({ type: "fatal", message: (e as Error).message });
  process.exit(1);
}
send({ type: "ready", loadMs: Math.round(performance.now() - t0) });

process.on("message", async (msg: any) => {
  if (!msg || msg.type !== "synth") return;
  const { id, text, voice, speed } = msg;
  try {
    last = null;
    const audio = await tts.generate(text, { voice, speed });
    send({ type: "result", id, samples: audio.audio, rate: audio.sampling_rate, words: wordSpans() });
  } catch (e) {
    send({ type: "error", id, message: (e as Error).name || "synthesis failed" });
  }
});

// The daemon going away (crash, restart) must not leave a model resident.
process.on("disconnect", () => process.exit(0));
