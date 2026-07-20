#!/usr/bin/env python3
"""Parse a harness exploration log into penetration/coverage diagnostics for the coverage eval.
Emits one JSON object describing how far AutoTap got into the app. No ground truth — diagnostics only."""
import sys, re, json

log = open(sys.argv[1], encoding="utf-8", errors="replace").read()
app = sys.argv[2] if len(sys.argv) > 2 else "?"

# Reasons / action types that mean "flailing to escape / not making forward progress".
RECOVERY_REASONS = ("escape", "exhausted", "blind", "stuck", "discover", "drawer",
                    "carousel", "probe", "dismiss", "recovery", "back_failed", "trap", "rotation")
RECOVERY_TYPES = {"back", "swipe_dismiss", "tab_rotation", "forced_escape", "swipe_back", "swipe"}

screens, findings, actions = set(), {}, 0
recovery_actions = 0
saw_secure_field = False
completed = False
test_failed = False
last_action = None  # (type, screen, step) of the most recent action

for line in log.splitlines():
    m = re.search(r"OCQA_STATE:(\{.*\})", line)
    if m:
        try:
            d = json.loads(m.group(1))
            s = (d.get("screen") or "").strip()
            if s and s not in ("Unknown", "pending"):
                screens.add(s)
            for inp in d.get("inputs", []) or []:
                if inp.get("secure"):
                    saw_secure_field = True
        except Exception:
            pass
        continue
    m = re.search(r"OCQA_ACTION:(\{.*\})", line)
    if m:
        actions += 1
        try:
            d = json.loads(m.group(1))
            reason = str(d.get("reason", "")).lower()
            atype = str(d.get("type", "")).lower()
            last_action = (atype, (d.get("screen") or "").strip(), d.get("step"))
            if atype in RECOVERY_TYPES or any(k in reason for k in RECOVERY_REASONS):
                recovery_actions += 1
        except Exception:
            pass
        continue
    m = re.search(r"OCQA_ISSUE:(\{.*\})", line)
    if m:
        try:
            t = json.loads(m.group(1)).get("type", "unknown")
            findings[t] = findings.get(t, 0) + 1
        except Exception:
            pass
        continue
    if line.startswith("OCQA_COMPLETE"):
        completed = True
    elif "TEST EXECUTE FAILED" in line or re.search(r"Executed 1 test, with [1-9]\d* failure", line):
        test_failed = True

# ---- Host-side crash detection ----
# A crash DURING an action kills the test's connection to the app and aborts the harness before
# any in-harness detector can run (found on Wikipedia: WMFCaptchaViewController.refreshImage
# assertionFailure crashes the app on login). The signal is unambiguous: the test FAILED and the
# harness never emitted OCQA_COMPLETE, with actions performed — i.e. it died mid-run. Attribute the
# crash to the last action and surface it as a critical finding (the whole point of the tool).
crashed = test_failed and not completed and actions > 0
if crashed and "crash" not in findings:
    findings["crash"] = findings.get("crash", 0) + 1

n_screens = len(screens)
launch_ok = n_screens >= 2
# Login wall: a password field was present but the explorer never got past a handful of screens.
login_present = saw_secure_field
login_wall = login_present and n_screens <= 3
stuck_ratio = round(recovery_actions / actions, 2) if actions else 0.0
findings_total = sum(findings.values())

print(json.dumps({
    "app": app,
    "screens": n_screens,
    "screen_names": sorted(screens),
    "launch_ok": launch_ok,
    "login_present": login_present,
    "login_wall": login_wall,
    "actions": actions,
    "recovery_actions": recovery_actions,
    "stuck_ratio": stuck_ratio,           # 0=all productive, 1=all flailing
    "findings_total": findings_total,
    "findings_by_type": findings,
    "completed": completed,
    "crashed": crashed,
    "crash_action": ({"type": last_action[0], "screen": last_action[1], "step": last_action[2]}
                     if crashed and last_action else None),
}))
