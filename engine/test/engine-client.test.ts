import { expect, test } from "bun:test";
import { join } from "node:path";
import { Engine } from "../engine-client.ts";

const make = (fixture: string, fatal: string[] = []) =>
  new Engine({ script: join(import.meta.dir, "fixtures", fixture), log: () => {}, onFatal: (m) => fatal.push(m) });

test("synthesizes and reports its state", async () => {
  const e = make("echo.ts");
  expect(e.state).toBe("unloaded");
  const r = await e.synth("hello", "af_heart", 1);
  expect(r.type).toBe("result");
  expect(e.state).toBe("loaded");
  e.stop("test");
  expect(e.state).toBe("unloaded");
});

test("stop while loading answers the waiting synth instead of hanging", async () => {
  const e = make("never-ready.ts");
  const p = e.synth("hello", "af_heart", 1);
  await Bun.sleep(50);
  expect(e.state).toBe("loading");
  e.stop("stopped");
  expect(await p).toEqual({ type: "error", message: "model process exited" });
});

test("a crash mid-synthesis is an error, and the next synth starts a new process", async () => {
  const e = make("crash-on-synth.ts");
  expect((await e.synth("a", "af_heart", 1)).type).toBe("error");
  expect(e.running).toBe(false);
  expect((await e.synth("b", "af_heart", 1)).type).toBe("error"); // crashes again, still settles
  e.stop("test");
});
