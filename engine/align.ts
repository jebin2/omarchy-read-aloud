// Model output -> playable PCM and word start times. Pure functions.

import { CLAUSE_END, SENTENCE_END } from "./segment.ts";

export const RATE = 24000; // Kokoro's sample rate

export type Spoken = { s: number; e: number; n: number }; // a timed spoken word: samples, phoneme count

// Kokoro pads every generation with ~0.75 s of silence; keep a pause sized to
// the kind of split instead (same values as the kokoro-js-test prototype).
// `offset` is where the kept audio starts in `samples`.
export function trimAndConvert(samples: Float32Array, chunkText: string) {
  const sentence = SENTENCE_END.test(chunkText);
  const clause = CLAUSE_END.test(chunkText);
  const headPad = Math.round(RATE * (sentence ? 0.04 : clause ? 0.025 : 0.015));
  const tailPad = Math.round(RATE * (sentence ? 0.12 : clause ? 0.07 : 0.025));
  let s = 0;
  let e = samples.length;
  while (s < e && Math.abs(samples[s]) <= 0.004) s++;
  while (e > s && Math.abs(samples[e - 1]) <= 0.004) e--;
  if (s >= e) return { pcm: new Int16Array(0), offset: 0 };
  s = Math.max(0, s - headPad);
  e = Math.min(samples.length, e + tailPad);
  const out = new Int16Array(e - s);
  for (let i = 0; i < out.length; i++) {
    const v = samples[s + i];
    out[i] = (v > 1 ? 1 : v < -1 ? -1 : v) * 32767;
  }
  return { pcm: out, offset: s };
}

// Start sample of each text word in a chunk, from the spoken words the model
// timed. Usually they match one to one. When they do not (a number becomes
// several spoken words, a symbol none), align by cumulative length: a text
// word starts at the spoken word whose position, as a fraction of all
// phonemes, is closest to the word's position as a fraction of all letters.
export function alignWords(textWords: string[], spoken: Spoken[], total: number): number[] {
  if (spoken.length === textWords.length) return spoken.map((w) => w.s);
  // More spoken than written words: numbers, symbols and hyphenated words are
  // what expand ("1984" -> "nineteen eighty-four"). Give the extra spoken
  // words to those, the most expandable first, and map the rest one to one.
  const extra = spoken.length - textWords.length;
  const expand = textWords.map((w) => (w.match(/[\p{N}$£€%&@+#]/gu) ?? []).length * 2 + (w.match(/\p{L}-\p{L}/gu) ?? []).length);
  if (extra > 0 && expand.some((x) => x > 0)) {
    const takes = textWords.map(() => 1);
    const order = expand.map((x, i) => [x, i]).filter(([x]) => x > 0).sort((p, q) => q[0] - p[0]).map(([, i]) => i);
    for (let k = 0; k < extra; k++) takes[order[k % order.length]]++;
    const out: number[] = [];
    let j = 0;
    for (const t of takes) { out.push(spoken[Math.min(j, spoken.length - 1)].s); j += t; }
    return out;
  }
  const weight = (w: string) => {
    const letters = (w.match(/\p{L}/gu) ?? []).length;
    const digits = (w.match(/\p{N}/gu) ?? []).length;
    return letters + digits * 3;
  };
  const tw = textWords.map(weight);
  const tTotal = tw.reduce((a, b) => a + b, 0) || 1;
  if (!spoken.length) {
    let acc = 0;
    return tw.map((x) => { const at = (acc / tTotal) * total; acc += x; return at; });
  }
  const sTotal = spoken.reduce((a, w) => a + w.n, 0) || 1;
  const sFrac: number[] = [];
  let acc = 0;
  for (const w of spoken) { sFrac.push(acc / sTotal); acc += w.n; }
  const out: number[] = [];
  let j = 0;
  acc = 0;
  for (const x of tw) {
    const f = acc / tTotal;
    while (j + 1 < spoken.length && Math.abs(sFrac[j + 1] - f) <= Math.abs(sFrac[j] - f)) j++;
    out.push(spoken[j].s);
    acc += x;
  }
  return out;
}
