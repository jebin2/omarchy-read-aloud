// read-aloud: command-line client for the Read Aloud daemon.
//
//   read-aloud selection        read the text highlighted in the window under
//                               the pointer; if it is already playing, stop
//   echo text | read-aloud speak
//   read-aloud toggle | pause | resume | stop | clear | status
//   read-aloud set voice af_heart | set speed 1.1
//
// Text is taken from stdin or the selection only, never from arguments:
// arguments are readable by every local user in /proc/<pid>/cmdline.

import { join } from "node:path";

const SOCK = join(process.env.XDG_RUNTIME_DIR ?? "/run/user/" + process.getuid!(), "omarchy-read-aloud", "control.sock");
const SERVICE = "omarchy-read-aloud.service";

function usage(code = 2): never {
  console.error("usage: read-aloud selection | speak (text on stdin) | toggle | pause | resume | stop | clear | status | set voice NAME | set speed N");
  process.exit(code);
}

async function connect() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const lines: string[] = [];
      let buf = "";
      let wake: (() => void) | null = null;
      let closed = false;
      const dec = new TextDecoder();
      const sock = await Bun.connect({
        unix: SOCK,
        socket: {
          data(_s, d) {
            buf += dec.decode(d, { stream: true });
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
            wake?.();
          },
          close() { closed = true; wake?.(); },
        },
      });
      // The next message; throws once the daemon has closed the connection.
      const next = async (): Promise<any> => {
        while (!lines.length) {
          if (closed) throw new Error("connection closed");
          await new Promise<void>((r) => (wake = r));
        }
        return JSON.parse(lines.shift()!);
      };
      return { sock, next };
    } catch {
      if (attempt === 0) Bun.spawnSync(["systemctl", "--user", "start", SERVICE]);
      await Bun.sleep(100);
    }
  }
  console.error("read-aloud: the daemon is not running (systemctl --user status " + SERVICE + ")");
  process.exit(1);
}

async function request(msg: object) {
  const c = await connect();
  c.sock.write(JSON.stringify(msg) + "\n");
  const reply = await c.next();
  c.sock.end();
  return reply;
}

// The text highlighted in the window under the pointer, decided the way pique
// does (see selection.py); falls back to the primary selection without pique.
function selection(): string {
  const r = Bun.spawnSync(["python3", "-I", join(import.meta.dir, "selection.py")], { stderr: "ignore" });
  return r.success ? r.stdout.toString() : "";
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "selection": {
    const t = selection();
    if (!t.trim()) {
      Bun.spawnSync(["notify-send", "-a", "Read Aloud", "-t", "2000", "Read Aloud", "Highlight some text first."]);
      process.exit(1);
    }
    const c = await connect();
    c.sock.write(JSON.stringify({ cmd: "subscribe" }) + "\n");
    // subscribe replies with text, state and word; take them by type.
    let cur: any = null, st: any = null;
    while (!cur || !st) {
      const m = await c.next();
      if (m.type === "text") cur = m;
      else if (m.type === "state") st = m;
    }
    const same = cur.text === t && (st.phase === "playing" || st.phase === "loading" || st.phase === "paused");
    c.sock.write(JSON.stringify(same ? { cmd: "stop" } : { cmd: "speak", text: t }) + "\n");
    await c.next().catch(() => null);
    c.sock.end();
    break;
  }
  case "speak": {
    if (args.length) usage(); // no text in arguments, by design
    const t = await Bun.stdin.text();
    console.log(JSON.stringify(await request({ cmd: "speak", text: t })));
    break;
  }
  case "toggle": case "pause": case "resume": case "stop": case "clear": case "status":
    console.log(JSON.stringify(await request({ cmd })));
    break;
  case "set": {
    const [key, value] = args;
    if (key === "voice" && value) console.log(JSON.stringify(await request({ cmd: "set", voice: value })));
    else if (key === "speed" && value) console.log(JSON.stringify(await request({ cmd: "set", speed: Number(value) })));
    else usage();
    break;
  }
  default:
    usage(cmd ? 2 : 0);
}
