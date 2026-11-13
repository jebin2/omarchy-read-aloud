// Downloads the Kokoro model (fp16, ~165 MB) and its tokenizer files into
// READ_ALOUD_MODELS once. The daemon itself always runs offline.
// Afterwards read-aloud-setup patches it (patch-model.ts) to model_timed_fp16.onnx.
// fp16 over uint8: closer to the full-precision voice at the same speed and
// memory on a 13700HX (4.3x vs 4.9x real time, ~660 MB peak for both).
//
// Pinned: every file comes from one fixed commit of the Hugging Face repo and
// must match its SHA-256, so a later change upstream is never installed
// silently. To move to a newer model, update REVISION and the hashes together.
// Files are written where transformers.js looks for them (cacheDir/<repo>/<file>).
import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const FILES: Record<string, string> = {
  "config.json": "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
  "tokenizer.json": "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
  "tokenizer_config.json": "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
  "onnx/model_fp16.onnx": "ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a",
};

const root = process.env.READ_ALOUD_MODELS;
if (!root) throw new Error("READ_ALOUD_MODELS is not set");

for (const [file, sha256] of Object.entries(FILES)) {
  const dest = join(root, REPO, file);
  const tmp = dest + ".part";
  await mkdir(dirname(dest), { recursive: true });
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${file} (HTTP ${res.status})`);
  // Stream to disk and hash on the way, so the 165 MB model never sits in memory.
  const hash = createHash("sha256");
  const out = Bun.file(tmp).writer();
  for await (const chunk of res.body) {
    hash.update(chunk);
    out.write(chunk);
  }
  await out.end();
  const got = hash.digest("hex");
  if (got !== sha256) {
    await rm(tmp, { force: true });
    throw new Error(`checksum mismatch for ${file}: expected ${sha256}, got ${got}`);
  }
  await rename(tmp, dest);
}
console.log("downloaded");
process.exit(0);
