#!/usr/bin/env python3
# Prints the text highlighted in the window under the pointer, the same way
# pique (https://github.com/jebin2/pique) decides it, and exits 1 if there is
# none. read-aloud's `selection` command (Super+Alt+R) reads it from stdout.
#
# - Apps on the accessibility bus (GTK and Qt apps) are asked for their
#   selection right now.
# - Everything else (terminals, browsers): pique-watch's memory of that
#   window's last highlight, which a plain click in the window forgets. So a
#   highlight that was clicked away, or one made in another window, is not
#   read by mistake. pique-watch keeps at most 2000 characters; when the
#   window's highlight is also the latest one on the system, the full text is
#   taken from the primary selection instead.
# - Without pique installed (or its watcher not running): the primary
#   selection, as before.
#
# The text goes to stdout only (a pipe to read-aloud); nothing is written.
# The clipboard is never read.

import importlib.machinery
import importlib.util
import os
import shutil
import subprocess
import sys

MAX_CHARS = 200_000


def primary():
    try:
        r = subprocess.run(["wl-paste", "--primary", "--no-newline", "--type", "text"],
                           capture_output=True, timeout=2)
        return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""
    except Exception:
        return ""


def load_pique():
    """pique-peek's helpers (window under the pointer, accessibility bus,
    pique-watch), imported from the installed script; None without pique."""
    path = shutil.which("pique-peek") or "/usr/bin/pique-peek"
    if not os.path.isfile(path):
        return None
    try:
        loader = importlib.machinery.SourceFileLoader("pique_peek", path)
        spec = importlib.util.spec_from_loader("pique_peek", loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
    except Exception:
        return None
    # A pique whose helpers changed counts as no pique (primary selection).
    needed = ("window_under_pointer", "atspi", "atspi_frames", "ask_watcher", "ANSWERERS")
    if not all(callable(getattr(mod, n, None)) or n == "ANSWERERS" and hasattr(getattr(mod, n, None), "match")
               for n in needed):
        return None
    return mod


def atspi_selection(Atspi, frame):
    """(known, text) like pique-peek's selection_in, without its 2000-char cap."""
    known = False
    stack, seen = [(frame, 0)], 0
    while stack and seen < 4000:
        node, depth = stack.pop()
        seen += 1
        try:
            if node.get_text_iface() is not None:
                if Atspi.Text.get_character_count(node) > 0:
                    known = True
                for k in range(Atspi.Text.get_n_selections(node)):
                    r = Atspi.Text.get_selection(node, k)
                    text = Atspi.Text.get_text(node, r.start_offset, r.end_offset).strip()
                    if text:
                        return True, text[:MAX_CHARS]
            if depth < 40:
                count = min(node.get_child_count(), 500)
                stack.extend((node.get_child_at_index(i), depth + 1) for i in range(count))
        except Exception:
            continue
    return known, ""


def resolve():
    pp = load_pique()
    if pp is None:
        return primary()
    try:
        under = pp.window_under_pointer()
    except Exception:
        under = None
    if not under:
        return ""
    client, _x, _y = under

    # GTK/Qt apps answer for themselves. (Browsers are left to the watcher:
    # pique's browser extension answers pique, not us.)
    if not pp.ANSWERERS.match(client.get("class", "")):
        Atspi = pp.atspi()
        frames = pp.atspi_frames(Atspi, client["pid"]) if Atspi else []
        if frames:
            known, text = atspi_selection(Atspi, frames[0])
            if known:
                return text

    reply = pp.ask_watcher("get", client["address"])
    if reply is None:  # watcher not running: no per-window memory
        return primary()
    watched = reply.decode("utf-8", "replace").strip()
    if not watched:
        return ""  # nothing highlighted in this window (or clicked away)
    full = primary().strip()
    if full[:len(watched)] == watched:
        return full  # same highlight, and not cut at 2000 characters
    return watched


def main():
    try:
        text = resolve().strip()
    except Exception:
        # pique changed its helpers (or something else broke): behave as if
        # pique were not installed rather than reading nothing.
        text = primary().strip()
    if not text:
        return 1
    sys.stdout.write(text[:MAX_CHARS])
    return 0


if __name__ == "__main__":
    sys.exit(main())
