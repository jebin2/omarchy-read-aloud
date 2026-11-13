// Audio output: pw-play fed raw 16-bit mono PCM from RAM. The caller keeps
// only ~0.3 s in it, so kill() silences it at once (pause), and finish() lets
// that last bit drain (end of the text).

import type { Subprocess } from "bun";
import { RATE } from "./align.ts";

export class Player {
  private proc: Subprocess<"pipe", "ignore", "inherit"> | null = null;

  /** onFailure: pw-play exited on its own (no audio device, PipeWire gone…). */
  constructor(private readonly onFailure: (code: number | null) => void) {}

  get running() { return this.proc !== null; }

  start() {
    if (this.proc) return;
    this.proc = Bun.spawn(
      ["pw-play", "-a", "--rate", String(RATE), "--channels", "1", "--format", "s16",
       "--latency", "60ms",
       "-P", '{ media.name = "Read Aloud" application.name = "Read Aloud" }', "-"],
      {
        stdin: "pipe", stdout: "ignore", stderr: "inherit",
        onExit: (p, code) => {
          if (this.proc !== p) return; // killed or finished by us
          this.proc = null;
          this.onFailure(code);
        },
      },
    );
  }

  /** False if the player is gone (the caller stops feeding). */
  write(pcm: Int16Array): boolean {
    if (!this.proc) return false;
    try { this.proc.stdin.write(pcm); return true; } catch { return false; }
  }

  flush() {
    try { this.proc?.stdin.flush(); } catch {}
  }

  kill() {
    const p = this.proc;
    this.proc = null;
    try { p?.kill("SIGKILL"); } catch {}
  }

  finish() {
    const p = this.proc;
    this.proc = null;
    try { p?.stdin.end(); } catch {}
  }
}
