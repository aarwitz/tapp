#!/usr/bin/env python3
"""Host-side responder for in-loop vision escalation — lets script runs (coverage-eval.sh) exercise
OCQA_VISION_QUERY without the AutoTap desktop app.

Tails the harness log for OCQA_VISION_QUERY markers, sends the screenshot to the vision model with
the SAME next-move prompt AnthropicVisionInspector.decideNextAction uses (kept in sync with
VisionInspector.swift), and writes the {requestId, action, x, y} decision to the response file the
harness polls. On any failure it writes action="none" so the harness falls back to its bail path
promptly instead of blocking to its timeout.

Usage (run alongside xcodebuild, kill when the run ends):
    ANTHROPIC_API_KEY=... python3 vision_escalation_responder.py <harness.log> <response_path>
"""
import base64
import json
import os
import ssl
import sys
import time
import urllib.request


def _ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


_SSL_CTX = _ssl_context()
MODEL = os.environ.get("AUTOTAP_VISION_MODEL", "claude-haiku-4-5-20251001")

# Mirror of AnthropicVisionInspector.navPrompt (VisionInspector.swift).
NAV_PROMPT = (
    "You are guiding an automated iOS UI explorer that is STUCK on the screen shown — either its "
    "accessibility tree is empty (custom-drawn/canvas/WebView UI) or it has been looping without "
    "reaching anything new. Look at the screenshot and choose the SINGLE next action a real user "
    "would take to make forward progress (reveal new content or navigate onward). Respond with ONLY "
    "JSON: {\"action\":\"tap|swipe_up|swipe_down|back|none\",\"x\":<0..1>,\"y\":<0..1>,\"reason\":"
    "\"<brief>\"}. For \"tap\", x and y are NORMALIZED coordinates (0=left/top, 1=right/bottom) of "
    "the point to tap — aim at the center of a primary button or an unexplored item. Use "
    "\"swipe_up\" to scroll for more, \"back\" to leave a dead-end, and \"none\" only if truly "
    "nothing is actionable."
)


def parse_action(text):
    """Mirror of parseVisionAction — tolerant, clamps coords, tap-without-coords -> none."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(text[start:end + 1])
    except Exception:
        return None
    raw = str(obj.get("action", "none")).lower().strip()
    aliases = {"swipeup": "swipe_up", "swipe up": "swipe_up", "scroll_up": "swipe_up", "scroll up": "swipe_up",
               "swipedown": "swipe_down", "swipe down": "swipe_down", "scroll_down": "swipe_down", "scroll down": "swipe_down"}
    kind = raw if raw in ("tap", "swipe_up", "swipe_down", "back", "none") else aliases.get(raw, "none")

    def num(v):
        try:
            return float(v)
        except Exception:
            return None
    x, y = num(obj.get("x")), num(obj.get("y"))
    if kind == "tap" and (x is None or y is None):
        kind = "none"
    return {"action": kind,
            "x": min(max(x if x is not None else 0.5, 0.0), 1.0),
            "y": min(max(y if y is not None else 0.5, 0.0), 1.0),
            "reason": str(obj.get("reason", ""))[:120]}


def decide(image_path, screen, reason, key):
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    body = {
        "model": MODEL, "max_tokens": 300, "system": NAV_PROMPT,
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
            {"type": "text", "text": f"Screen title: {screen}. The explorer got stuck ({reason}). Choose the single best next action as the JSON object."},
        ]}],
    }
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
                                 method="POST", headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                                         "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=45, context=_SSL_CTX) as resp:
        data = json.load(resp)
    text = "\n".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    return parse_action(text)


def main():
    if len(sys.argv) < 3:
        print("usage: vision_escalation_responder.py <harness.log> <response_path>", file=sys.stderr)
        return 2
    log_path, response_path = sys.argv[1], sys.argv[2]
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        print("ANTHROPIC_API_KEY not set", file=sys.stderr)
        return 2

    handled = set()
    pos = 0
    while True:
        time.sleep(0.4)
        try:
            with open(log_path, errors="ignore") as f:
                f.seek(pos)
                chunk = f.read()
                pos = f.tell()
        except FileNotFoundError:
            continue
        for line in chunk.splitlines():
            idx = line.find("OCQA_VISION_QUERY:{")
            if idx < 0:
                continue
            try:
                q = json.loads(line[idx + len("OCQA_VISION_QUERY:"):])
            except Exception:
                continue
            rid = q.get("requestId", "")
            if not rid or rid in handled:
                continue
            handled.add(rid)
            decision = None
            try:
                decision = decide(q.get("image", ""), q.get("screen", "?"), q.get("reason", "stuck"), key)
            except Exception as e:
                print(f"responder: decide failed for {rid}: {e}", file=sys.stderr, flush=True)
            out = {"requestId": rid,
                   "action": (decision or {}).get("action", "none"),
                   "x": (decision or {}).get("x", 0.5),
                   "y": (decision or {}).get("y", 0.5)}
            tmp = response_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(out, f)
            os.replace(tmp, response_path)  # atomic — harness never sees a partial file
            print(f"responder: {rid[:8]} on '{q.get('screen','?')}' ({q.get('reason','')}) -> "
                  f"{out['action']} ({out['x']:.2f},{out['y']:.2f}) {(decision or {}).get('reason','')}",
                  flush=True)


if __name__ == "__main__":
    sys.exit(main())
