# Control socket

`$XDG_RUNTIME_DIR/omarchy-read-aloud/control.sock`, newline-delimited JSON.

## Commands (client → daemon)

| `cmd` | Fields | Effect |
| --- | --- | --- |
| `subscribe` | | Replies with `text`, `state` and `word`, then pushes each on every change |
| `status` | | Replies with `state` |
| `text` | | Replies with `text` |
| `speak` | `text?` | With `text`: replace the text and read it. Without: read the current text, or resume |
| `toggle` | | Pause if reading, otherwise play/resume |
| `pause`, `resume`, `stop` | | Stop keeps the text; the next play starts from the top |
| `clear` | | Stop and forget the text |
| `set` | `voice?`, `speed?` (0.5–2) | During a read, re-synthesizes from the next sentence not yet playing |

Other commands reply `{"type":"ok"}` or `{"type":"error","error":…}`.

## Pushed messages (daemon → client)

```json
{"type":"text","textRev":3,"text":"…"}
{"type":"state","phase":"playing","engine":"unloaded","textRev":3,"hasText":true,
 "progress":0.2,"voice":"af_heart","speed":1,"voices":["af_alloy","…"],"error":""}
{"type":"word","word":{"start":178,"end":184}}
```

`word`: character offsets of the word being heard (or `null`), pushed when it changes.

`phase`: `empty` · `ready` · `loading` · `playing` · `paused`.
`engine`: `unloaded` · `loading` · `loaded` (the model process).
`voices`: only in the replies to `subscribe` and `status` (it never changes
while the daemon runs), not in pushed states.
