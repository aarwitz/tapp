#!/usr/bin/env bash
# AutoTap penetration / coverage eval — the "real-app scoreboard".
#
# Unlike validation-matrix.sh (which asserts *expected findings* against DemoApp, i.e. accuracy on a
# known fixture), this measures how far AutoTap actually PENETRATES an arbitrary app: did it get past
# launch, did it hit a login wall, how many distinct screens it reached, how much of its budget went
# to productive exploration vs. stuck/recovery flailing, and what it found. There is no ground truth —
# this is a diagnostic you point at real apps to see where they stall, so coverage work is measurable.
#
# Usage:
#   scripts/coverage-eval.sh [bundleId ...]        # defaults to the local corpus apps
#   scripts/coverage-eval.sh com.acme.app          # a real app (must be installed on the booted sim)
#   ACTIONS=120 scripts/coverage-eval.sh com.acme.app
#   VISION_ESCALATION=1 ANTHROPIC_API_KEY=... scripts/coverage-eval.sh com.acme.app
#     # opt-in: when the a11y tree goes blank or exploration gets stuck, a sidecar
#     # (vision_escalation_responder.py) answers the harness's OCQA_VISION_QUERY with a
#     # model-chosen next move — same channel the desktop app serves.
#
# Prereqs: a booted simulator, the harness built (scripts/deploy-and-build.sh --harness), and each
# app installed on the sim. Writes a JSON report to captures/coverage-eval-<timestamp>.json.
#
# NOTE: auth sessions stored in the keychain (Firebase et al) SURVIVE app reinstall — a "fresh"
# run may silently resume the previous account. For a genuinely fresh login:
#   xcrun simctl keychain <udid> reset
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTIONS="${ACTIONS:-70}"
TIMEOUT="${TIMEOUT:-600}"
DEFAULT_APPS=(com.autotap.demoapp com.autotap.logindemo com.autotap.wizarddemo com.autotap.shopdemo com.autotap.restaurantdemo)
APPS=("$@"); [ ${#APPS[@]} -eq 0 ] && APPS=("${DEFAULT_APPS[@]}")

UDID="$(xcrun simctl list devices booted -j 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((x["udid"] for v in d["devices"].values() for x in v if x.get("state")=="Booted"), ""))')"
[ -z "$UDID" ] && { echo "❌ No booted simulator. Boot one first."; exit 2; }

XCTR="$(find "$HOME/Library/Developer/Xcode/DerivedData/OCQAHarness-"*/Build/Products -name '*.xctestrun' 2>/dev/null | head -1)"
[ -z "$XCTR" ] && XCTR="$(find /tmp/autotap-harness-derived/Build/Products -name '*.xctestrun' 2>/dev/null | head -1)"
[ -z "$XCTR" ] && XCTR="$(find /tmp/harness-build/Build/Products -name '*.xctestrun' 2>/dev/null | head -1)"
[ -z "$XCTR" ] && { echo "❌ Harness not built. Run: scripts/deploy-and-build.sh --harness"; exit 2; }

TS="$(date +%Y%m%d-%H%M%S)"
REPORT="$ROOT/captures/coverage-eval-$TS.json"
mkdir -p "$ROOT/captures"
echo "AutoTap coverage eval — $ACTIONS actions/app, sim $UDID"
echo "Apps: ${APPS[*]}"
echo ""

RESULTS_JSON="["
FIRST=1
for APP in "${APPS[@]}"; do
  if ! xcrun simctl get_app_container "$UDID" "$APP" >/dev/null 2>&1; then
    printf "  %-32s ⏭  not installed — skipping\n" "$APP"
    continue
  fi
  CFG="/tmp/ocqa-coverage-$APP.json"
  LOG="/tmp/ocqa-coverage-$APP.log"
  RESPONDER_PID=""
  # Real test credentials (OCQA_TEST_EMAIL / OCQA_TEST_PASSWORD env) let the heuristic login
  # preamble get PAST a real auth wall — the single biggest coverage unlock on gated apps.
  CREDS_LINE=""
  [ -n "${OCQA_TEST_EMAIL:-}" ] && CREDS_LINE=",
  \"OCQA_TEST_EMAIL\": \"$OCQA_TEST_EMAIL\", \"OCQA_TEST_PASSWORD\": \"${OCQA_TEST_PASSWORD:-}\""
  if [ "${VISION_ESCALATION:-0}" = "1" ] && [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    VRESP="/tmp/ocqa-vision-response-eval-$APP.json"
    VDIR="/tmp/ocqa-vision-eval-$APP"; mkdir -p "$VDIR"
    cat > "$CFG" <<JSON
{ "OCQA_BUNDLE_ID": "$APP", "OCQA_MAX_ACTIONS": "$ACTIONS", "OCQA_TIMEOUT_SECONDS": "$TIMEOUT",
  "OCQA_VISION_ESCALATION": "1", "OCQA_VISION_RESPONSE_PATH": "$VRESP",
  "OCQA_VISION_IMAGE_DIR": "$VDIR", "OCQA_VISION_BUDGET": "4", "OCQA_VISION_WAIT_TIMEOUT": "60"$CREDS_LINE }
JSON
    : > "$LOG"
    python3 "$ROOT/scripts/vision_escalation_responder.py" "$LOG" "$VRESP" > "/tmp/ocqa-vision-responder-$APP.log" 2>&1 &
    RESPONDER_PID=$!
  else
    cat > "$CFG" <<JSON
{ "OCQA_BUNDLE_ID": "$APP", "OCQA_MAX_ACTIONS": "$ACTIONS", "OCQA_TIMEOUT_SECONDS": "$TIMEOUT"$CREDS_LINE }
JSON
  fi
  TEST_RUNNER_OCQA_CONFIG_PATH="$CFG" xcodebuild test-without-building \
    -xctestrun "$XCTR" -destination "platform=iOS Simulator,id=$UDID" \
    -only-testing:"OCQAHarnessUITests/ExplorerTests/testAutonomousExploration" > "$LOG" 2>&1
  if [ -n "$RESPONDER_PID" ]; then kill "$RESPONDER_PID" 2>/dev/null; wait "$RESPONDER_PID" 2>/dev/null; fi

  ROW="$(python3 "$ROOT/scripts/coverage_eval_parse.py" "$LOG" "$APP")"
  echo "$ROW" | python3 -c 'import sys,json; d=json.load(sys.stdin); ca=d.get("crash_action") or {}; print("  %-32s screens=%-3s launch=%-3s login_wall=%-3s stuck=%-4s findings=%s%s" % (d["app"], d["screens"], "ok" if d["launch_ok"] else "NO", "YES" if d["login_wall"] else "no", d["stuck_ratio"], d["findings_total"], ("  ⚠️ CRASHED on %s %s" % (ca.get("type",""), ca.get("screen","")) if d.get("crashed") else "")))'
  [ $FIRST -eq 0 ] && RESULTS_JSON+=","
  RESULTS_JSON+="$ROW"; FIRST=0
done
RESULTS_JSON+="]"
echo "$RESULTS_JSON" | python3 -m json.tool > "$REPORT" 2>/dev/null || echo "$RESULTS_JSON" > "$REPORT"
echo ""
echo "Report: $REPORT"
