// Text -> the pieces the model synthesizes one at a time.
//
// Pure functions, no state: the daemon calls segment() once per text.
//
// Chunks prefer to end on sentence punctuation (or a line break), then clause
// punctuation, then a plain word boundary. The goal is a chunk whose synthesis
// time is comfortably shorter than the previous chunk's playback time, so the
// audio queue never starves (long single-sentence chunks were the cause of
// multi-second gaps). Everything is one pass over the words: 200k characters
// take a few milliseconds.

export const SENTENCE_END = /[.!?…]+["'”’)\]]*$/u;
export const CLAUSE_END = /[,;:—–]+["'”’)\]]*$/u;

export type Word = { text: string; start: number; end: number }; // char offsets into the text
export type Range = [first: number, count: number]; // a run of words
export type Segment = { start: number; end: number; speak: string; w0: number; wn: number };

export function wordsOf(text: string): Word[] {
  return Array.from(text.matchAll(/\S+/gu), (m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
}

/** Splits `words` (from wordsOf(text)) into chunks of at most maxWords. */
export function chunkWords(text: string, words: Word[], maxWords: number, minWords = 8): Range[] {
  const out: Range[] = [];
  for (let w = 0; w < words.length;) {
    const n = cutLength(text, words, w, maxWords, minWords);
    out.push([w, n]);
    w += n;
  }
  return out;
}

function cutLength(text: string, words: Word[], w0: number, max: number, minWords: number): number {
  const left = words.length - w0;
  // 1. Earliest complete sentence/line that is long enough to be worth
  //    synthesizing on its own, but never longer than the word budget.
  for (let i = 0; i < Math.min(left, max); i++) {
    const w = words[w0 + i];
    const lineBreak = text[w.end] === "\n";
    if (lineBreak || (i + 1 >= minWords && SENTENCE_END.test(w.text))) return i + 1;
  }
  // 2. Over budget: cut at the last clause boundary that fits and is close
  //    enough to the budget to be a sensible split (a comma right at the start
  //    would leave a one-word chunk), else at the budget.
  if (left > max) {
    const minWeak = Math.max(minWords, Math.ceil(max * 0.35));
    for (let i = max - 1; i >= minWeak - 1; i--) if (CLAUSE_END.test(words[w0 + i].text)) return i + 1;
    return max;
  }
  // 3. The rest fits: one last chunk.
  return left;
}

// Time to first word is the model load plus the synthesis of the first chunk.
// Each generation costs ~0.3 s fixed plus ~0.2 s per second of speech
// (measured: 3 words 295 ms -> 0.77 s of speech, 5-6 words ~470 ms -> 1.6 s,
// 10 words 822 ms -> 3.6 s). So the opening is cut into a ramp of growing
// pieces, 3 -> 5 -> 12 words by default: the first one is ready fastest, and
// each piece plays long enough to cover synthesizing the next, with margin for
// a CPU throttled on battery. After the ramp, chunks are whole sentences.
// Cuts prefer a comma, then the spot just before a joining word ("by",
// "which", "and"…), which sounds like a natural breath.
export const DEFAULT_RAMP = [3, 5, 12];
const JOINERS = new Set(("by in on at of to for from with without about after before during " +
  "while when where which who whom whose that and but or so because since until as than " +
  "if though although").split(" "));

/** How many of `words` to take as a head of at most `limit`, cut at the most natural spot. */
export function headLength(words: string[], limit: number) {
  const max = Math.min(limit, words.length - 1);
  for (let i = max - 1; i >= 1; i--) if (CLAUSE_END.test(words[i])) return i + 1; // comma after word i
  for (let i = max; i >= 2; i--)
    if (JOINERS.has(words[i].toLowerCase().replace(/[^a-z]/g, ""))) return i; // before a joiner
  return max;
}

/** Splits the opening chunks along the ramp (only splitting, never merging). */
export function rampOpening(words: Word[], parts: Range[], ramp = DEFAULT_RAMP): Range[] {
  const out: Range[] = [];
  let i = 0;
  for (let step = 0; i < parts.length && step < ramp.length; step++) {
    const [w0, n] = parts[i];
    if (n <= ramp[step] + 1) { out.push(parts[i++]); continue; }
    const head = headLength(words.slice(w0, w0 + n).map((w) => w.text), ramp[step]);
    out.push([w0, head]);
    parts[i] = [w0 + head, n - head];
  }
  return out.concat(parts.slice(i));
}

export function segment(text: string, ramp = DEFAULT_RAMP, maxWords = 28, minWords = 8) {
  const words = wordsOf(text);
  const segments: Segment[] = rampOpening(words, chunkWords(text, words, maxWords, minWords), ramp)
    .map(([w0, n]) => ({
      start: words[w0].start,
      end: words[w0 + n - 1].end,
      speak: words.slice(w0, w0 + n).map((w) => w.text).join(" "),
      w0,
      wn: n,
    }));
  return { words, segments };
}
