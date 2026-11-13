// Downloads the Kokoro model (fp16, ~165 MB) and its tokenizer files into
// READ_ALOUD_MODELS once. The daemon itself always runs offline.
// Afterwards install.sh patches it (patch-model.ts) to model_timed_fp16.onnx.
// fp16 over uint8: closer to the full-precision voice at the same speed and
// memory on a 13700HX (4.3x vs 4.9x real time, ~660 MB peak for both).
import { AutoTokenizer, StyleTextToSpeech2Model, env } from "@huggingface/transformers";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
if (!process.env.READ_ALOUD_MODELS) throw new Error("READ_ALOUD_MODELS is not set");
env.cacheDir = process.env.READ_ALOUD_MODELS;
env.allowRemoteModels = true;
await StyleTextToSpeech2Model.from_pretrained(MODEL, { dtype: "fp16", device: "cpu" } as any);
await AutoTokenizer.from_pretrained(MODEL);
console.log("downloaded");
process.exit(0);
