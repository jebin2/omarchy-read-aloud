// The model process (synth.ts), seen from the daemon: started on demand,
// one synthesis at a time over Bun IPC, killed when no longer needed.
//
// Every promise handed out (synth, waiting for the load) settles, whether the
// process answers, crashes, or is killed by stop(): a caller never hangs.

import { dirname } from "node:path";
import type { Subprocess } from "bun";
import type { Spoken } from "./align.ts";

export type SynthReply =
  | { type: "result"; samples: Float32Array; words: Spoken[] }
  | { type: "error"; message: string };

type Options = {
  script: string; // path to synth.ts
  env?: Record<string, string | undefined>;
  log: (event: string, fields?: Record<string, unknown>) => void;
  onFatal: (message: string) => void; // the model could not be loaded
};

export class Engine {
  private proc: Subprocess | null = null;
  private ready = false;
  private waiters: (() => void)[] = [];
  private pending: { id: number; resolve: (r: SynthReply) => void } | null = null;
  private nextId = 1;

  constructor(private readonly o: Options) {}

  get state(): "unloaded" | "loading" | "loaded" {
    return this.proc ? (this.ready ? "loaded" : "loading") : "unloaded";
  }
  get running() { return this.proc !== null; }
  get busy() { return this.pending !== null; }

  start() {
    if (this.proc) return;
    this.ready = false;
    this.o.log("engine.start");
    const proc = Bun.spawn([process.execPath, this.o.script], {
      cwd: dirname(this.o.script),
      stdio: ["ignore", "ignore", "inherit"],
      serialization: "advanced", // typed arrays pass through as they are
      env: { ...process.env, ...this.o.env },
      ipc: (msg) => {
        if (msg.type === "ready") {
          this.ready = true;
          this.o.log("engine.ready", { loadMs: msg.loadMs });
          this.waiters.splice(0).forEach((w) => w());
        } else if (msg.type === "fatal") {
          this.o.onFatal(`Model failed to load: ${msg.message}`);
        } else if ((msg.type === "result" || msg.type === "error") && msg.id === this.pending?.id) {
          const { resolve } = this.pending;
          this.pending = null;
          resolve(msg);
        }
      },
      onExit: (p, code, signal) => {
        if (this.proc !== p) return; // killed by stop(), already settled
        this.o.log("engine.exit", { code, signal });
        this.proc = null;
        this.settle();
      },
    });
    this.proc = proc;
  }

  stop(reason: string) {
    if (!this.proc) return;
    this.o.log("engine.unload", { reason });
    const p = this.proc;
    this.proc = null;
    p.kill("SIGKILL");
    this.settle();
  }

  async synth(text: string, voice: string, speed: number): Promise<SynthReply> {
    this.start();
    if (!this.ready) await new Promise<void>((r) => this.waiters.push(r));
    const proc = this.proc;
    if (!proc || !this.ready) return { type: "error", message: "model process exited" };
    return new Promise((resolve) => {
      this.pending = { id: this.nextId++, resolve };
      proc.send({ type: "synth", id: this.pending.id, text, voice, speed });
    });
  }

  // The process is gone: answer whoever is waiting on it.
  private settle() {
    this.ready = false;
    const p = this.pending;
    this.pending = null;
    p?.resolve({ type: "error", message: "model process exited" });
    this.waiters.splice(0).forEach((w) => w());
  }
}
