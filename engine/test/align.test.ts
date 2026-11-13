import { describe, expect, test } from "bun:test";
import { alignWords, RATE, trimAndConvert } from "../align.ts";

describe("trimAndConvert", () => {
  const withSilence = (lead: number, tone: number, tail: number) => {
    const a = new Float32Array(lead + tone + tail);
    for (let i = 0; i < tone; i++) a[lead + i] = 0.5;
    return a;
  };
  test("trims the model's silence and keeps a pause sized to the split", () => {
    const { pcm, offset } = trimAndConvert(withSilence(RATE, RATE, RATE), "A sentence.");
    expect(offset).toBe(RATE - Math.round(RATE * 0.04));
    expect(pcm.length).toBe(Math.round(RATE * 0.04) + RATE + Math.round(RATE * 0.12));
    const plain = trimAndConvert(withSilence(RATE, RATE, RATE), "no punctuation");
    expect(plain.pcm.length).toBeLessThan(pcm.length);
  });
  test("all silence gives no audio", () => {
    expect(trimAndConvert(new Float32Array(1000), "x.").pcm.length).toBe(0);
  });
  test("clips to 16 bits", () => {
    const { pcm } = trimAndConvert(Float32Array.from([2, -2, 0.5]), "x");
    expect(Array.from(pcm)).toEqual([32767, -32767, 16383]);
  });
});

describe("alignWords", () => {
  const sp = (...starts: number[]) => starts.map((s) => ({ s, e: s + 1, n: 3 }));
  test("one to one", () => {
    expect(alignWords(["a", "b", "c"], sp(0, 10, 20), 30)).toEqual([0, 10, 20]);
  });
  test("a number takes the extra spoken words (\"in 1984\")", () => {
    // created in nineteen eighty four
    expect(alignWords(["created", "in", "1984."], sp(0, 10, 20, 30, 40), 50)).toEqual([0, 10, 20]);
  });
  test("fewer spoken words: monotonic, inside the audio", () => {
    const at = alignWords(["one", "&", "two", "three"], sp(0, 10, 20), 30);
    expect(at.length).toBe(4);
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThanOrEqual(at[i - 1]);
    expect(at[3]).toBeLessThanOrEqual(20);
  });
  test("no timings at all: spread over the audio", () => {
    expect(alignWords(["aa", "bb"], [], 100)).toEqual([0, 50]);
  });
});
