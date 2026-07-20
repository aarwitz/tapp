#!/usr/bin/env python3
"""Host-side judge for a Flow's `assert_ai` steps (see docs/flows-architecture.md).

Tails the harness log for OCQA_FLOW_AI_QUERY markers, shows the screenshot + the claim to a vision
model, and writes {index, pass, reason} to the response file the harness polls. The model call stays
HOST-side (the harness only screenshots + asks). On any error it writes pass=false with the error so
a broken judge can't silently green a flow.

Usage: ANTHROPIC_API_KEY=... python3 flow_ai_judge.py <harness.log> <response_path>
"""
import base64
import json
import os
import ssl
import sys
import time
import urllib.request


def _ctx():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


SSL_CTX = _ctx()
MODEL = os.environ.get("AUTOTAP_VISION_MODEL", "claude-haiku-4-5-20251001")
SYSTEM = (
    "You are a QA test oracle. You are shown one iOS app screenshot and a CLAIM the test asserts about "
    "it. Decide if the claim is TRUE of what is actually visible. Be strict and literal — only pass if "
    "the screenshot clearly supports the claim. Respond with ONLY JSON: "
    '{"pass": true|false, "reason": "<one concise sentence>"}.'
)


def judge(image_path, claim, key):
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    body = {
        "model": MODEL, "max_tokens": 200, "system": SYSTEM,
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
            {"type": "text", "text": f"CLAIM: {claim}\nIs this claim true of the screenshot? Respond as the JSON object."},
        ]}],
    }
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
                                 method="POST", headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                                         "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=45, context=SSL_CTX) as resp:
        data = json.load(resp)
    text = "\n".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    s, e = text.find("{"), text.rfind("}")
    obj = json.loads(text[s:e + 1]) if s >= 0 and e > s else {}
    return bool(obj.get("pass", False)), str(obj.get("reason", ""))[:200]


def main():
    if len(sys.argv) < 3:
        print("usage: flow_ai_judge.py <harness.log> <response_path>", file=sys.stderr)
        return 2
    log_path, response_path = sys.argv[1], sys.argv[2]
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
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
            i = line.find("OCQA_FLOW_AI_QUERY:{")
            if i < 0:
                continue
            try:
                q = json.loads(line[i + len("OCQA_FLOW_AI_QUERY:"):])
            except Exception:
                continue
            idx = q.get("index")
            if idx in handled:
                continue
            handled.add(idx)
            try:
                ok, reason = judge(q.get("image", ""), q.get("claim", ""), key)
            except Exception as ex:
                ok, reason = False, f"judge error: {ex}"
            tmp = response_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"index": idx, "pass": ok, "reason": reason}, f)
            os.replace(tmp, response_path)
            print(f"judge: #{idx} → {'PASS' if ok else 'FAIL'} — {reason}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
