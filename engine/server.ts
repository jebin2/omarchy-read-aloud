// A private Unix socket speaking newline-delimited JSON (see ../PROTOCOL.md).
// The directory is 0700 and the socket 0600: only this user can connect.

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "bun";

type State = { buf: string; dec: TextDecoder; subscribed: boolean };
export type Client = Socket<State>;

export function send(c: Client, msg: object) {
  c.write(JSON.stringify(msg) + "\n");
}

/** maxLine: longest request accepted, in characters; a client sending more is dropped. */
export function serve(path: string, maxLine: number, handle: (c: Client, line: string) => void) {
  const clients = new Set<Client>();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  rmSync(path, { force: true });
  Bun.listen<State>({
    unix: path,
    socket: {
      open(s) { s.data = { buf: "", dec: new TextDecoder(), subscribed: false }; clients.add(s); },
      close(s) { clients.delete(s); },
      error(s) { clients.delete(s); },
      data(s, d) {
        // stream: true keeps a UTF-8 character split across packets intact.
        s.data.buf += s.data.dec.decode(d, { stream: true });
        let nl: number;
        while ((nl = s.data.buf.indexOf("\n")) >= 0) {
          const line = s.data.buf.slice(0, nl);
          s.data.buf = s.data.buf.slice(nl + 1);
          if (line.trim()) handle(s, line);
        }
        if (s.data.buf.length > maxLine) { s.data.buf = ""; s.end(); }
      },
    },
  });
  chmodSync(path, 0o600);
  return {
    /** To every client that sent `subscribe`. */
    broadcast(msg: object) {
      const line = JSON.stringify(msg) + "\n";
      for (const c of clients) if (c.data.subscribed) c.write(line);
    },
    close() { rmSync(path, { force: true }); },
  };
}
