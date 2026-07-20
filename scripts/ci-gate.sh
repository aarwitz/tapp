#!/usr/bin/env bash
# AutoTap CI gate — one command that answers "should this merge?" for an iOS PR.
#
# Boots a simulator if needed, installs the app build under test, runs the autonomous exploration
# harness, replays every committed Flow (deterministic E2E tests), diffs the findings against a
# stored baseline, writes a GitHub Actions step summary, and exits non-zero when the gate fails
# (new high/critical findings vs. baseline, or any failed Flow). Wrapped by ../action.yml for
# GitHub Actions; equally usable from any other CI or locally.
#
# Usage:
#   scripts/ci-gate.sh --app <path/to/App.app> --bundle-id <com.example.app>
#                      [--actions N]              # exploration budget (default 40)
#                      [--timeout S]              # exploration watchdog (default 600)
#                      [--flows <glob>]           # Flow YAMLs to replay (default: <app repo>/.autotap/flows/*.yml if --project-dir given)
#                      [--project-dir <dir>]      # the app repo checkout (for flows + baseline defaults)
#                      [--baseline <file.json>]   # prior report to diff against (skipped if absent)
#                      [--fail-on gate|blocked|any]  # gate policy (default gate; see ci-report.js)
#                      [--json-out <file.json>]   # write the full report (use as the next baseline)
#                      [--md-out <file.md>]       # write the rendered markdown report (for a PR comment)
#                      [--device <name>]          # simulator device to boot if none is (default "iPhone 16 Pro")
#
# The app must be a SIMULATOR build (xcodebuild ... -destination 'generic/platform=iOS Simulator').
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

APP_PATH="" BUNDLE_ID="" ACTIONS=40 TIMEOUT=600 FLOWS="" PROJECT_DIR="" BASELINE="" FAIL_ON="gate" JSON_OUT="" MD_OUT="" DEVICE="iPhone 16 Pro"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP_PATH="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --actions) ACTIONS="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --flows) FLOWS="$2"; shift 2 ;;
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --baseline) BASELINE="$2"; shift 2 ;;
    --fail-on) FAIL_ON="$2"; shift 2 ;;
    --json-out) JSON_OUT="$2"; shift 2 ;;
    --md-out) MD_OUT="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$BUNDLE_ID" ]] || { echo "❌ Required: --bundle-id" >&2; exit 2; }
[[ -n "$APP_PATH" && -d "$APP_PATH" ]] || { echo "❌ Required: --app <path/to/App.app> (a simulator build)" >&2; exit 2; }
[[ -z "$FLOWS" && -n "$PROJECT_DIR" && -d "$PROJECT_DIR/.autotap/flows" ]] && FLOWS="$PROJECT_DIR/.autotap/flows/*.yml"
[[ -z "$BASELINE" && -n "$PROJECT_DIR" && -f "$PROJECT_DIR/.autotap/baseline.json" ]] && BASELINE="$PROJECT_DIR/.autotap/baseline.json"

step() { echo ""; echo "━━━ $1"; }

# ── Simulator: reuse a booted one, else boot (creating from the newest runtime if necessary).
step "Simulator"
UDID="$(xcrun simctl list devices booted -j | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((x["udid"] for v in d["devices"].values() for x in v if x.get("state")=="Booted"), ""))')"
if [[ -z "$UDID" ]]; then
  UDID="$(xcrun simctl list devices available -j | python3 -c "
import sys, json
d = json.load(sys.stdin)
want = '''$DEVICE'''
cands = [(rt, x) for rt, v in d['devices'].items() for x in v if x.get('isAvailable', True)]
named = [x['udid'] for rt, x in cands if x['name'] == want]
iphones = [x['udid'] for rt, x in sorted(cands, key=lambda p: p[0], reverse=True) if x['name'].startswith('iPhone')]
print(named[0] if named else (iphones[0] if iphones else ''))
")"
  if [[ -z "$UDID" ]]; then
    RUNTIME="$(xcrun simctl list runtimes -j | python3 -c 'import sys,json; rts=[r for r in json.load(sys.stdin)["runtimes"] if r.get("isAvailable") and r["platform"]=="iOS"]; print(rts[-1]["identifier"] if rts else "")')"
    [[ -n "$RUNTIME" ]] || { echo "❌ No iOS simulator runtime available" >&2; exit 1; }
    UDID="$(xcrun simctl create "AutoTap CI" "$DEVICE" "$RUNTIME")" || { echo "❌ Could not create simulator" >&2; exit 1; }
  fi
  echo "Booting $UDID …"
  xcrun simctl boot "$UDID" || true
  xcrun simctl bootstatus "$UDID" -b || { echo "❌ Simulator failed to boot" >&2; exit 1; }
fi
echo "Simulator: $UDID"

# ── Install the app build under test.
step "Install $BUNDLE_ID"
xcrun simctl install "$UDID" "$APP_PATH" || { echo "❌ simctl install failed — is $APP_PATH a SIMULATOR build?" >&2; exit 1; }

# ── Autonomous exploration (quick-capture builds the harness itself if needed).
step "Explore ($ACTIONS actions, ${TIMEOUT}s watchdog)"
set +e
"$ROOT/scripts/quick-capture.sh" explore "$BUNDLE_ID" --actions "$ACTIONS" --timeout "$TIMEOUT"
set -e
CAPTURE_DIR="$(ls -td "$ROOT"/captures/*/ 2>/dev/null | head -1)"
MARKERS="$CAPTURE_DIR/ocqa-markers.txt"
[[ -f "$MARKERS" ]] || { echo "❌ Exploration produced no markers ($MARKERS)" >&2; exit 1; }
echo "Markers: $MARKERS"

# ── Replay committed Flows (each failure becomes a gate reason).
FLOW_LOG_ARGS=()
if [[ -n "$FLOWS" ]]; then
  step "Flows"
  FLOW_LOG_DIR="$(mktemp -d /tmp/autotap-ci-flows.XXXXXX)"
  shopt -s nullglob
  for flow in $FLOWS; do
    name="$(basename "$flow" .yml)"
    log="$FLOW_LOG_DIR/$name.log"
    echo "▶️  $name"
    FLOW_LOG="$log" "$ROOT/scripts/run-flow.sh" "$flow" "$BUNDLE_ID" || true # verdict comes from the log
    FLOW_LOG_ARGS+=(--flow-log "$log")
  done
  shopt -u nullglob
fi

# ── Report + gate.
step "Gate"
BASELINE_ARGS=()
[[ -n "$BASELINE" ]] && BASELINE_ARGS=(--baseline "$BASELINE")
JSON_ARGS=()
[[ -n "$JSON_OUT" ]] && JSON_ARGS=(--json-out "$JSON_OUT")
MD_ARGS=()
[[ -n "$MD_OUT" ]] && MD_ARGS=(--md-out "$MD_OUT")
node "$ROOT/mcp-server/src/ci-report.js" --markers "$MARKERS" --fail-on "$FAIL_ON" \
  ${BASELINE_ARGS[@]+"${BASELINE_ARGS[@]}"} ${JSON_ARGS[@]+"${JSON_ARGS[@]}"} ${MD_ARGS[@]+"${MD_ARGS[@]}"} ${FLOW_LOG_ARGS[@]+"${FLOW_LOG_ARGS[@]}"}
