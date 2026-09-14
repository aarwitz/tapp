#!/usr/bin/env python3
"""Flow helpers for run-flow.sh: convert a .yml/.json Flow to the harness's OCQA_FLOW_JSON, and
parse the harness's OCQA_FLOW_STEP / OCQA_FLOW_RESULT markers into a scannable pass/fail report.

Usage:
  flow_lib.py to-json  <flow.yml|flow.json>          # prints {steps:[...], name, vars, ...} JSON
  flow_lib.py raw-json <flow.yml|flow.json>          # prints the complete repository spec as JSON
  flow_lib.py to-yaml  '<flow-json-string>'          # prints tidy YAML (for saving a recorded flow)
  flow_lib.py report   <harness.log>                 # prints a human-readable pass/fail report
  flow_lib.py report --json <harness.log>            # prints machine JSON {passed,total,failed,steps}
"""
import json
import re
import sys


def load_flow(path):
    raw = open(path, encoding="utf-8").read()
    if path.endswith(".json"):
        return json.loads(raw)
    import yaml
    return yaml.safe_load(raw)


def to_yaml(json_str):
    """Emit a recorded/inline Flow (JSON string) as tidy YAML for saving to .tapp/flows/*.yml."""
    import yaml
    flow = json.loads(json_str)
    # Order keys for readability. `platform` + `url` make the same repository-native
    # Flow format portable across the XCUITest, Playwright, and Android drivers.
    ordered = {}
    for k in ("name", "platform", "app", "url", "vars", "reset"):
        if flow.get(k):
            ordered[k] = flow[k]
    ordered["steps"] = flow.get("steps", [])
    print(yaml.safe_dump(ordered, sort_keys=False, default_flow_style=False, allow_unicode=True, width=100).rstrip())


def to_json(path):
    flow = load_flow(path) or {}
    # Steps pass through as-is — the harness normalizes both sugar ({tap: X}) and explicit
    # ({action: tap, target: X}) forms, so no rewriting is needed here.
    out = {
        "name": flow.get("name", "flow"),
        "kind": flow.get("kind", "flow"),
        "platform": flow.get("platform", ""),
        "app": flow.get("app", ""),
        "url": flow.get("url", ""),
        "steps": flow.get("steps", []),
        "vars": flow.get("vars", {}),
        "reset": flow.get("reset", "launch"),
        "continueOnFailure": bool(flow.get("continueOnFailure", False)),
    }
    # Multi-actor Scenarios deliberately reuse the Flow step language and marker
    # protocol, while preserving actor/session and lifecycle orchestration.
    for key in ("actors", "setup", "teardown", "timeoutMs", "taskPlan", "releaseContract"):
        if key in flow:
            out[key] = flow[key]
    print(json.dumps(out))


def raw_json(path):
    print(json.dumps(load_flow(path) or {}))


ABORT_PATTERNS = [
    r"Failed to synthesize event: [^\n]*",
    r"Neither element nor any descendant has keyboard focus[^\n]*",
    r"Test Case '[^']*' failed \([^)]*\)",
    r"Error Domain=[^\n]*",
    r"Unable to (?:find|launch|boot)[^\n]*",
    r"App state is [^\n]*",
    r"Timed out [^\n]*",
    r"Testing failed:[^\n]*",
    r"error: [^\n]*",
    r"\*\* TEST (?:EXECUTE )?FAILED \*\*",
]


def harness_abort_reason(log):
    """First XCTest/xcodebuild line that explains why a run ended before step 1."""
    for pat in ABORT_PATTERNS:
        m = re.search(pat, log)
        if m:
            return m.group(0).strip()[:300]
    return None


def report(path, as_json=False):
    log = open(path, encoding="utf-8", errors="replace").read()
    steps = []
    result = None
    name = "flow"
    kind = "flow"
    for line in log.splitlines():
        line = line.strip()
        if line.startswith("OCQA_FLOW_STEP:"):
            try:
                steps.append(json.loads(line[len("OCQA_FLOW_STEP:"):]))
            except Exception:
                pass
        elif line.startswith("OCQA_FLOW_RESULT:started"):
            m = re.search(r"name=(.*)$", line)
            if m:
                name = m.group(1).split(" kind=", 1)[0]
            km = re.search(r"\bkind=([^ ]+)", line)
            if km:
                kind = km.group(1)
        elif line.startswith("OCQA_FLOW_RESULT:{"):
            try:
                result = json.loads(line[len("OCQA_FLOW_RESULT:"):])
                kind = result.get("kind", kind)
            except Exception:
                pass

    total = (result or {}).get("total", len(steps))
    failed = (result or {}).get("failed", sum(1 for s in steps if s.get("status") == "fail"))
    passed = (result or {}).get("passed", failed == 0 and bool(steps))

    executed = (result or {}).get("executed", len(steps))
    passed_steps = sum(1 for s in steps if s.get("status") == "pass")

    # A run that died before step 1 used to print `0 passed · 0 failed · 0/0 executed` and
    # nothing else; the XCTest reason lived only in flow.log (feedback #1). Surface it as the
    # failure of the first step so the scoreboard says why instead of looking like a crash.
    abort_reason = None
    if not steps and not passed:
        abort_reason = harness_abort_reason(log)
        steps.append({"index": 1, "action": "harness", "target": "", "status": "fail",
                      "detail": abort_reason or "the harness exited before the first step; see flow.log"})
        failed = max(failed, 1)

    if as_json:
        print(json.dumps({"name": name, "kind": kind, "passed": passed, "total": total, "executed": executed, "failed": failed,
                          **({"abortReason": abort_reason} if abort_reason else {}), "steps": steps}))
        return 0 if passed else 1

    icon = {"pass": "✅", "fail": "❌", "skip": "⚪️"}
    verb = {"tap": "👆 tap", "type": "⌨️  type", "login": "🔐 sign in", "swipe": "↔️  swipe", "back": "◀️  back",
            "wait": "⏳ wait", "wait_for": "⏳ wait for", "assert_screen": "🔎 screen is",
            "assert_exists": "🔎 exists", "assert_absent": "🔎 absent", "assert_text": "🔎 text",
            "assert_ai": "🤖 ai"}
    label = "RELEASE CONTRACT" if kind == "release-contract" else ("SCENARIO" if kind == "scenario" else "FLOW")
    progress = f"{passed_steps}/{total} steps" if passed else f"{passed_steps} passed · {failed} failed · {executed}/{total} executed"
    head = f"### {'🟢 ' + label + ' PASSED' if passed else '🔴 ' + label + ' FAILED'} — {name}  ·  {progress}"
    print(head)
    print("")
    for s in steps:
        st = s.get("status", "?")
        label = verb.get(s.get("action", ""), s.get("action", ""))
        tgt = s.get("target", "")
        actor = s.get("actor", "")
        line = f"{icon.get(st, '•')}" + (f" **{actor}**" if actor else "") + f" {label}" + (f" `{tgt}`" if tgt else "")
        if st != "pass" and s.get("detail"):
            line += f" — {s['detail']}"
        print(line)
    if not passed:
        print("")
        bad = next((s for s in steps if s.get("status") == "fail"), None)
        if bad:
            print(f"**First failure:** step {bad.get('index')} ({bad.get('action')}) — {bad.get('detail','')}")
    return 0 if passed else 1


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    if cmd == "to-json":
        to_json(sys.argv[2])
        return 0
    if cmd == "raw-json":
        raw_json(sys.argv[2])
        return 0
    if cmd == "to-yaml":
        to_yaml(sys.argv[2])
        return 0
    if cmd == "report":
        as_json = "--json" in sys.argv
        path = [a for a in sys.argv[2:] if not a.startswith("--")][0]
        return report(path, as_json=as_json)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
