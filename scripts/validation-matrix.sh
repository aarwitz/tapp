#!/usr/bin/env bash
# AutoTap harness accuracy benchmark.
#
# Runs the exploration harness against DemoApp (the fixture corpus) and asserts expected outcomes:
#   - the run completes (no crash/abort),
#   - a minimum number of distinct screens are reached (breadth),
#   - each detection fixture, WHEN its screen is reached, produces its expected finding (accuracy),
#   - DemoApp never produces a `crash` finding (no false alarms).
# Then, if RestaurantDemo is installed, a freeze regression: with interactive input ENABLED it must
# NOT pause for input on its (credential-free) item screens — guarding the multi-minute stall fix.
#
# Exploration is non-deterministic, so fixture assertions are conditional on the screen being
# reached. Use --actions to raise the budget for fuller coverage. Exits non-zero on any failure.
#
# Prereqs: a booted simulator, the harness built (scripts/deploy-and-build.sh --harness), and
# DemoApp installed (ruby generate-demoapp-xcodeproj.rb + xcodebuild + simctl install).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTIONS="${1:-70}"
BUNDLE="com.autotap.demoapp"

UDID="$(xcrun simctl list devices booted -j 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((x["udid"] for v in d["devices"].values() for x in v if x.get("state")=="Booted"), ""))')"
[ -z "$UDID" ] && { echo "❌ No booted simulator. Boot one first."; exit 2; }

XCTR="$(find "$HOME/Library/Developer/Xcode/DerivedData/OCQAHarness-"*/Build/Products -name '*.xctestrun' 2>/dev/null | head -1)"
# Fallback: harness built via deploy-and-build.sh --harness lands here
[ -z "$XCTR" ] && XCTR="$(find /tmp/autotap-harness-derived/Build/Products -name '*.xctestrun' 2>/dev/null | head -1)"
[ -z "$XCTR" ] && { echo "❌ Harness not built. Run: scripts/deploy-and-build.sh --harness"; exit 2; }

xcrun simctl get_app_container "$UDID" "$BUNDLE" >/dev/null 2>&1 || { echo "❌ DemoApp not installed on $UDID."; exit 2; }

CFG="/tmp/ocqa-validation-matrix.json"
cat > "$CFG" <<JSON
{ "OCQA_BUNDLE_ID": "$BUNDLE", "OCQA_MAX_ACTIONS": "$ACTIONS", "OCQA_TIMEOUT_SECONDS": "600" }
JSON

LOG="/tmp/ocqa-validation-matrix.log"
echo "Running harness vs DemoApp ($ACTIONS actions, sim $UDID)…"
TEST_RUNNER_OCQA_CONFIG_PATH="$CFG" xcodebuild test-without-building \
  -xctestrun "$XCTR" -destination "platform=iOS Simulator,id=$UDID" \
  -only-testing:"OCQAHarnessUITests/ExplorerTests/testAutonomousExploration" > "$LOG" 2>&1

python3 - "$LOG" <<'PY'
import sys, re, json
log = open(sys.argv[1]).read()
screens, issues, complete = set(), {}, None
for line in log.splitlines():
    m = re.search(r'OCQA_STATE:(\{.*\})', line)
    if m:
        try: screens.add(json.loads(m.group(1)).get("screen",""))
        except: pass
    m = re.search(r'OCQA_ISSUE:(\{.*\})', line)
    if m:
        try:
            d = json.loads(m.group(1)); issues.setdefault(d.get("screen",""), set()).add(d.get("type"))
        except: pass
    m = re.search(r'OCQA_COMPLETE:(\{.*\})', line)
    if m:
        try: complete = json.loads(m.group(1))
        except: pass
screens.discard("")

# fixture screen -> expected finding type (asserted only if the screen was reached)
FIXTURES = [
    ("System Status",   "error_surface"),        # always-on error text
    ("System Status",   "unresponsive_element"),  # dead Retry button on error screen
    ("Live Feed",       "app_hang"),              # perpetual spinner
    ("Dashboard",       "unresponsive_element"),  # dead Sync Now button
    ("Changelog",       "error_surface"),         # error message below the fold
    ("Update Profile",  "error_surface"),         # inline validation error after form submit
    ("Saved Reports",   "unresponsive_element"),  # dead Add Report button on empty state
    ("Queued Tasks",    "unresponsive_element"),  # swipe-only rows invisible to tap-based exploration
]
MIN_SCREENS = 12

rows, ok = [], True
def check(name, passed, detail=""):
    global ok
    ok = ok and passed
    rows.append((("PASS ✅" if passed else "FAIL ❌"), name, detail))

check("run completed (no abort/crash)", complete is not None, "" if complete else "no OCQA_COMPLETE")
check(f">= {MIN_SCREENS} distinct screens reached", len(screens) >= MIN_SCREENS, f"reached {len(screens)}")
crashed = any("crash" in t for t in issues.values())
check("no spurious 'crash' finding", not crashed)
for screen, expected in FIXTURES:
    if screen in screens:
        check(f"[{screen}] → {expected}", expected in issues.get(screen, set()), f"found {sorted(issues.get(screen,set()))}")
    else:
        rows.append(("SKIP ⏭ ", f"[{screen}] → {expected}", "screen not reached this run"))

print("\n=== AutoTap Validation Matrix ===")
for status, name, detail in rows:
    print(f"  {status}  {name}" + (f"   ({detail})" if detail else ""))
print(f"\nScreens: {', '.join(sorted(screens))}")
sys.exit(0 if ok else 1)
PY
RESULT=$?

# ===== RestaurantDemo: interactive-input freeze regression =====
# RestaurantDemo has form fields (e.g. "Special Instructions") but NO credential screens, so with
# interactive input ENABLED it must NOT pause (OCQA_AWAIT_INPUT) — that pause once froze runs for
# ~180s on item detail screens. Guards the credential-only gate + short fallback.
RD_BUNDLE="com.autotap.restaurantdemo"
RD_RESULT=0
if xcrun simctl get_app_container "$UDID" "$RD_BUNDLE" >/dev/null 2>&1; then
  RD_CFG="/tmp/ocqa-restaurant-regression.json"
  rm -f /tmp/ocqa-rd-noresp.json
  cat > "$RD_CFG" <<JSON
{ "OCQA_BUNDLE_ID": "$RD_BUNDLE", "OCQA_MAX_ACTIONS": "20", "OCQA_TIMEOUT_SECONDS": "240", "OCQA_INTERACTIVE_INPUT": "1", "OCQA_INPUT_RESPONSE_PATH": "/tmp/ocqa-rd-noresp.json", "OCQA_INPUT_WAIT_TIMEOUT": "30" }
JSON
  RD_LOG="/tmp/ocqa-restaurant-regression.log"
  echo ""; echo "Running RestaurantDemo freeze-regression (interactive input ON, $UDID)…"
  TEST_RUNNER_OCQA_CONFIG_PATH="$RD_CFG" xcodebuild test-without-building \
    -xctestrun "$XCTR" -destination "platform=iOS Simulator,id=$UDID" \
    -only-testing:"OCQAHarnessUITests/ExplorerTests/testAutonomousExploration" > "$RD_LOG" 2>&1
  python3 - "$RD_LOG" <<'PY'
import sys, re
log = open(sys.argv[1]).read()
pauses = len(re.findall(r'OCQA_AWAIT_INPUT', log))
screens = set(re.findall(r'OCQA_STATE:\{"screen":"([^"]*)"', log))
completed = "OCQA_COMPLETE" in log
ok = True
def check(name, passed, detail=""):
    global ok; ok = ok and passed
    print(f"  {'PASS ✅' if passed else 'FAIL ❌'}  {name}" + (f"   ({detail})" if detail else ""))
print("\n=== RestaurantDemo freeze regression ===")
check("no interactive-input pause (0 OCQA_AWAIT_INPUT)", pauses == 0, f"{pauses} pause(s)")
check("reached Menu", "Menu" in screens)
check("reached a menu-item detail", any(s in screens for s in ("Bruschetta","Tiramisu","Charcuterie Board")), f"screens={sorted(screens)}")
check("run completed", completed)
sys.exit(0 if ok else 1)
PY
  RD_RESULT=$?
else
  echo ""; echo "⏭  RestaurantDemo not installed — skipping freeze regression"
  echo "    (ruby generate-demo-named.rb RestaurantDemo + xcodebuild + simctl install to enable)"
fi

echo ""
if [ $RESULT -eq 0 ] && [ "$RD_RESULT" -eq 0 ]; then
  echo "✅ Validation matrix PASSED"; exit 0
else
  echo "❌ Validation matrix FAILED (DemoApp log: $LOG)"; exit 1
fi
