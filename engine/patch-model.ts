// Adds the per-token durations Kokoro computes internally as a second output
// of the ONNX model, so the daemon gets exact word timings for highlighting.
//
//   bun patch-model.ts IN.onnx OUT.onnx
//
// The tensor `/encoder/Gather_output_0` holds one duration (in 600-sample
// frames at 24 kHz) per input token; the decoder already uses it. Exposing it
// costs nothing at runtime. The file is edited at the protobuf level: one
// ValueInfoProto is appended to ModelProto.graph (field 7) as a new
// GraphProto.output (field 12); every other byte is kept as is.

const DURATIONS = "/encoder/Gather_output_0";
const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error("usage: bun patch-model.ts IN.onnx OUT.onnx");
  process.exit(2);
}

const buf = new Uint8Array(await Bun.file(inPath).arrayBuffer());

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let result = 0, shift = 0;
  for (;;) {
    const byte = b[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [result, pos];
    shift += 7;
  }
}
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
const enc = new TextEncoder();
function field(num: number, payload: Uint8Array | number[]): number[] {
  const p = Array.from(payload);
  return [...varint((num << 3) | 2), ...varint(p.length), ...p];
}
function fieldVarint(num: number, value: number): number[] {
  return [...varint(num << 3), ...varint(value)];
}

// Find ModelProto.graph (field 7, length-delimited).
let pos = 0, graphKeyStart = -1, graphStart = -1, graphLen = 0;
while (pos < buf.length) {
  const keyStart = pos;
  let key: number;
  [key, pos] = readVarint(buf, pos);
  const num = Math.floor(key / 8), wire = key & 7;
  if (wire === 0) [, pos] = readVarint(buf, pos);
  else if (wire === 1) pos += 8;
  else if (wire === 5) pos += 4;
  else if (wire === 2) {
    let len: number;
    [len, pos] = readVarint(buf, pos);
    if (num === 7) { graphKeyStart = keyStart; graphStart = pos; graphLen = len; }
    pos += len;
  } else throw new Error(`unsupported wire type ${wire}`);
}
if (graphStart < 0) throw new Error("no graph in model");

const graph = buf.subarray(graphStart, graphStart + graphLen);
const name = enc.encode(DURATIONS);

// ValueInfoProto { name, type: TypeProto { tensor_type { elem_type: INT64, shape { dim { dim_param } } } } }
const dim = field(1, field(2, enc.encode("n_tokens")));   // Dimension.dim_param = 2
const shape = field(2, dim);                              // Tensor.shape = 2 (TensorShapeProto.dim = 1)
const tensor = [...fieldVarint(1, 7), ...shape];          // Tensor.elem_type = 1 (7 = INT64)
const type = field(1, tensor);                            // TypeProto.tensor_type = 1
const valueInfo = [...field(1, name), ...field(2, type)]; // ValueInfoProto.name = 1, .type = 2
const outputRecord = new Uint8Array(field(12, valueInfo)); // GraphProto.output = 12

if (Buffer.from(graph).includes(Buffer.from(outputRecord))) {
  console.log("already patched");
  await Bun.write(outPath, buf);
  process.exit(0);
}

const newGraphLen = graphLen + outputRecord.length;
const out = new Uint8Array(
  graphKeyStart + 1 + varint(newGraphLen).length + newGraphLen + (buf.length - graphStart - graphLen),
);
let o = 0;
out.set(buf.subarray(0, graphKeyStart), o); o += graphKeyStart;
out.set([...varint((7 << 3) | 2), ...varint(newGraphLen)], o); o += 1 + varint(newGraphLen).length;
out.set(graph, o); o += graphLen;
out.set(outputRecord, o); o += outputRecord.length;
out.set(buf.subarray(graphStart + graphLen), o);
await Bun.write(outPath, out);
console.log(`patched: ${outPath} (+${outputRecord.length} bytes)`);
