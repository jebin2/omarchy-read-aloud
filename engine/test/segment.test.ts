import { describe, expect, test } from "bun:test";
import { chunkWords, headLength, segment, wordsOf } from "../segment.ts";

const DRAGONBALL = "Dragon Ball is a massive global media franchise created by legendary manga artist " +
  "Akira Toriyama in 1984. Initiated as a manga, it follows the adventures of Son Goku from his childhood " +
  "through adulthood as he trains in martial arts and explores the world in search of the seven mystical " +
  "orbs known as the Dragon Balls, which can summon a wish-granting dragon.";

const texts = (c: ReturnType<typeof chunkWords>, t: string) => {
  const w = wordsOf(t);
  return c.map(([w0, n]) => w.slice(w0, w0 + n).map((x) => x.text).join(" "));
};

describe("wordsOf", () => {
  test("offsets point into the original text", () => {
    const t = "  Hello,\n\tworld!  ";
    const w = wordsOf(t);
    expect(w.map((x) => x.text)).toEqual(["Hello,", "world!"]);
    for (const x of w) expect(t.slice(x.start, x.end)).toBe(x.text);
  });
});

describe("chunkWords", () => {
  const cut = (t: string, max = 28, min = 8) => texts(chunkWords(t, wordsOf(t), max, min), t);

  test("cuts after a sentence once it is long enough", () => {
    expect(cut("One two three four five six seven eight. Nine ten.")).toEqual([
      "One two three four five six seven eight.", "Nine ten."]);
  });
  test("a short sentence is not cut on its own", () => {
    expect(cut("Hi there. How are you today, my old friend?")).toEqual(["Hi there. How are you today, my old friend?"]);
  });
  test("a line break always cuts", () => {
    expect(cut("Title\nBody text here.")).toEqual(["Title", "Body text here."]);
  });
  test("over budget: last comma that fits, else the budget", () => {
    expect(cut("a b c d e f g h i, j k l m n o", 10)).toEqual(["a b c d e f g h i,", "j k l m n o"]);
    expect(cut("a b c d e f g h i j k l", 10)).toEqual(["a b c d e f g h i j", "k l"]);
  });
  test("covers every word exactly once, in order", () => {
    const t = DRAGONBALL.repeat(30);
    const c = chunkWords(t, wordsOf(t), 28, 8);
    let next = 0;
    for (const [w0, n] of c) { expect(w0).toBe(next); expect(n).toBeGreaterThan(0); expect(n).toBeLessThanOrEqual(28); next += n; }
    expect(next).toBe(wordsOf(t).length);
  });
  test("linear time: 200k characters well under 100 ms", () => {
    const t = "The quick brown fox jumps over the lazy dog. ".repeat(4500);
    const s = performance.now();
    chunkWords(t, wordsOf(t), 28, 8);
    expect(performance.now() - s).toBeLessThan(100);
  });
});

describe("opening ramp", () => {
  test("first pieces follow the 3, 5, 12 ramp and cut naturally", () => {
    const { segments } = segment(DRAGONBALL);
    expect(segments[0].wn).toBeLessThanOrEqual(3);
    expect(segments[1].wn).toBeLessThanOrEqual(5);
    expect(segments[2].wn).toBeLessThanOrEqual(12);
    expect(segments[0].speak).toBe("Dragon Ball is");
  });
  test("headLength prefers a comma, then the spot before a joiner", () => {
    // A comma after the first word would leave a one-word piece: cut at the limit.
    expect(headLength("well, then we go home now".split(" "), 4)).toBe(4);
    expect(headLength("we went, then we left".split(" "), 4)).toBe(2);
    expect(headLength("a franchise created by legendary artist".split(" "), 5)).toBe(3);
  });
  test("segments map back to the text", () => {
    const { words, segments } = segment(DRAGONBALL);
    for (const s of segments) {
      expect(DRAGONBALL.slice(s.start, s.end).split(/\s+/).join(" ")).toBe(s.speak);
      expect(words[s.w0].start).toBe(s.start);
    }
  });
  test("empty text has no segments", () => {
    expect(segment("   \n ").segments).toEqual([]);
  });
});
