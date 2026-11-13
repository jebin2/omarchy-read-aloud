import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const PATCH = join(import.meta.dir, "..", "patch-model.ts");
const varint = (n: number) => { const o: number[] = []; while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return o; };
const field = (num: number, p: number[]) => [...varint((num << 3) | 2), ...varint(p.length), ...p];

// A tiny ModelProto: ir_version, a graph with one node name, an opset field.
const graph = field(2, Array.from(new TextEncoder().encode("g".repeat(150)))); // >127 bytes: 2-byte length
const model = new Uint8Array([...[0x08, 0x08], ...field(7, graph), ...field(8, [0x10, 0x11])]);

function topLevel(b: Uint8Array) {
  const out: Record<number, number> = {};
  let pos = 0;
  const rd = () => { let r = 0, s = 0; for (;;) { const x = b[pos++]; r += (x & 0x7f) * 2 ** s; if (!(x & 0x80)) return r; s += 7; } };
  while (pos < b.length) {
    const key = rd(); const wire = key & 7;
    if (wire === 0) rd(); else if (wire === 2) { const l = rd(); out[key >> 3] = l; pos += l; } else throw new Error("wire " + wire);
  }
  return out;
}

test("adds the durations output once, keeps the rest, and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-"));
  try {
    const a = join(dir, "a.onnx"), b = join(dir, "b.onnx"), c = join(dir, "c.onnx");
    Bun.write(a, model);
    const run = (i: string, o: string) => Bun.spawnSync([process.execPath, PATCH, i, o]).stdout.toString();
    expect(run(a, b)).toContain("patched");
    const out = new Uint8Array(require("node:fs").readFileSync(b));
    const t = topLevel(out);
    expect(t[7]).toBeGreaterThan(graph.length);
    expect(t[8]).toBe(2);
    expect(Buffer.from(out).includes(Buffer.from("/encoder/Gather_output_0"))).toBe(true);
    expect(run(b, c)).toContain("already patched");
    expect(Buffer.compare(require("node:fs").readFileSync(c), out)).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
