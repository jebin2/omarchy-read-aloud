// Loads, and answers each request with one second of a quiet tone.
process.send!({ type: "ready", loadMs: 1 });
process.on("message", (m: any) => {
  const samples = new Float32Array(24000).map((_, i) => 0.1 * Math.sin(i / 10));
  process.send!({ type: "result", id: m.id, samples, words: [{ s: 0, e: 24000, n: 3 }] });
});
