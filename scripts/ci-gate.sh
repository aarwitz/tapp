#!/usr/bin/env bash
# Tapp CI gate — one command that answers "should this merge?" for iOS, Android, or web.
#
# Boots a simulator if needed, installs the app build under test, runs the autonomous exploration
# harness, replays every committed Flow (deterministic E2E tests), diffs the findings against a
# stored baseline, writes a GitHub Actions step summary, and exits non-zero when the gate fails
# (new high/critical findings vs. baseline, or any failed Flow). Wrapped by ../action.yml for
# GitHub Actions; equally usable from any other CI or locally.
#
# Usage:
#   scripts/ci-gate.sh [--platform ios] --app <path/to/App.app> [--bundle-id <com.example.app>]
#   scripts/ci-gate.sh --platform android --apk <path/to/app.apk> --app-id <com.example.app>
#   scripts/ci-gate.sh --platform web [--url <http(s)://owned-app>]
#                      # omit --url with --project-dir to detect/build/start/stop one owned web target
#                      # bundle id is detected from the .app when omitted
#                      [--actions N]              # exploration budget (default 40)
#                      [--timeout S]              # exploration watchdog (default 600)
#                      [--flows <glob>]           # Flow YAMLs to replay (default: <app repo>/.autotap/flows/*.yml if --project-dir given)
#                      [--scenarios <glob>]       # Multi-actor Scenario YAMLs (web; default: <app repo>/.autotap/scenarios/*.yml)
#                      [--contracts <glob>]       # TypeScript release contracts (default: <app repo>/.autotap/contracts/*.contract.ts)
#                      [--project-dir <dir>]      # the app repo checkout (for flows + baseline defaults)
#                      [--pr-base <git-ref>]      # select critical + diff-relevant contracts from base...head
#                      [--pr-head <git-ref>]      # default HEAD
#                      [--changed-files-file <json|newline file>] # CI-provided PR paths; includes renamed paths
#                      [--pr-plan-out <file.json>] # persist the reviewable selection plan
#                      [--baseline <file.json>]   # prior report to diff against (skipped if absent)
#                      [--target-key <stable-id>] # isolates target-specific baselines in monorepos
#                      [--fail-on gate|blocked|any]  # gate policy (default gate; see ci-report.js)
#                      [--json-out <file.json>]   # write the full report (use as the next baseline)
#                      [--md-out <file.md>]       # write the rendered markdown report (for a PR comment)
#                      [--device <name>]          # simulator device to boot if none is (default "iPhone 16 Pro")
#
# The app must be a SIMULATOR build (xcodebuild ... -destination 'generic/platform=iOS Simulator').
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

PLATFORM="ios" APP_PATH="" BUNDLE_ID="" APK_PATH="" APP_ID="" URL="" WEB_TARGET="" TARGET_KEY="" SERIAL="" ACTIONS=40 TIMEOUT=600 FLOWS="" SCENARIOS="" CONTRACTS="" PROJECT_DIR="" BASELINE="" FAIL_ON="gate" JSON_OUT="" MD_OUT="" DEVICE="iPhone 16 Pro" PR_BASE="" PR_HEAD="HEAD" CHANGED_FILES_FILE="" PR_PLAN_OUT=""
IOS_PR_TARGET_JSON=""
FLOWS_EXPLICIT=false SCENARIOS_EXPLICIT=false CONTRACTS_EXPLICIT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --app) APP_PATH="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --apk) APK_PATH="$2"; shift 2 ;;
    --app-id) APP_ID="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --web-target) WEB_TARGET="$2"; shift 2 ;;
    --target-key) TARGET_KEY="$2"; shift 2 ;;
    --serial) SERIAL="$2"; shift 2 ;;
    --actions) ACTIONS="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --flows) FLOWS="$2"; FLOWS_EXPLICIT=true; shift 2 ;;
    --scenarios) SCENARIOS="$2"; SCENARIOS_EXPLICIT=true; shift 2 ;;
    --contracts) CONTRACTS="$2"; CONTRACTS_EXPLICIT=true; shift 2 ;;
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --pr-base) PR_BASE="$2"; shift 2 ;;
    --pr-head) PR_HEAD="$2"; shift 2 ;;
    --changed-files-file) CHANGED_FILES_FILE="$2"; shift 2 ;;
    --pr-plan-out) PR_PLAN_OUT="$2"; shift 2 ;;
    --baseline) BASELINE="$2"; shift 2 ;;
    --fail-on) FAIL_ON="$2"; shift 2 ;;
    --json-out) JSON_OUT="$2"; shift 2 ;;
    --md-out) MD_OUT="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$PLATFORM" == "ios" || "$PLATFORM" == "android" || "$PLATFORM" == "web" ]] || { echo "❌ --platform must be ios|android|web" >&2; exit 2; }
[[ "$ACTIONS" =~ ^[1-9][0-9]*$ ]] || { echo "❌ --actions must be a positive integer" >&2; exit 2; }
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "❌ --timeout must be a positive integer" >&2; exit 2; }
[[ "$FAIL_ON" == "gate" || "$FAIL_ON" == "blocked" || "$FAIL_ON" == "any" ]] || { echo "❌ --fail-on must be gate|blocked|any" >&2; exit 2; }
if [[ -n "$PROJECT_DIR" ]]; then
  [[ -d "$PROJECT_DIR" ]] || { echo "❌ Project directory not found: $PROJECT_DIR" >&2; exit 2; }
  PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
fi
[[ -z "$FLOWS" && -n "$PROJECT_DIR" && -d "$PROJECT_DIR/.autotap/flows" ]] && FLOWS="$PROJECT_DIR/.autotap/flows/*.yml"
[[ "$PLATFORM" == "web" && -z "$SCENARIOS" && -n "$PROJECT_DIR" && -d "$PROJECT_DIR/.autotap/scenarios" ]] && SCENARIOS="$PROJECT_DIR/.autotap/scenarios/*.yml"
[[ -z "$CONTRACTS" && -n "$PROJECT_DIR" && -d "$PROJECT_DIR/.autotap/contracts" ]] && CONTRACTS="$PROJECT_DIR/.autotap/contracts/*.contract.ts"
[[ -z "$BASELINE" && -n "$PROJECT_DIR" && -f "$PROJECT_DIR/.autotap/baseline.json" ]] && BASELINE="$PROJECT_DIR/.autotap/baseline.json"
[[ -z "$BASELINE" || -f "$BASELINE" ]] || { echo "❌ Baseline not found: $BASELINE" >&2; exit 2; }
if [[ -n "$BASELINE" ]]; then
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$BASELINE" 2>/dev/null \
    || { echo "❌ Baseline is not valid JSON: $BASELINE" >&2; exit 2; }
fi
CONTRACT_FILES=()
if [[ -n "$CONTRACTS" ]]; then
  shopt -s nullglob
  for contract in $CONTRACTS; do CONTRACT_FILES+=("$contract"); done
  shopt -u nullglob
  if [[ "${#CONTRACT_FILES[@]}" -eq 0 && "$CONTRACTS_EXPLICIT" == true ]]; then
    echo "❌ --contracts matched no files: $CONTRACTS" >&2
    exit 2
  fi
fi

validate_json_env() {
  local name="$1" expected="$2" value="${!1:-}"
  [[ -z "$value" ]] && return 0
  TAPP_JSON_VALUE="$value" TAPP_JSON_EXPECTED="$expected" python3 -c '
import json, os, sys
value = json.loads(os.environ["TAPP_JSON_VALUE"])
expected = list if os.environ["TAPP_JSON_EXPECTED"] == "array" else dict
sys.exit(0 if isinstance(value, expected) else 1)
' || { echo "❌ $name must be a valid JSON $expected" >&2; exit 2; }
}
validate_json_env OCQA_APP_LAUNCH_ARGS_JSON array
validate_json_env OCQA_APP_LAUNCH_ENV_JSON object
validate_json_env OCQA_LOGIN_STEPS_JSON array

FLOW_FILES=()
if [[ -n "$FLOWS" ]]; then
  shopt -s nullglob
  for flow in $FLOWS; do FLOW_FILES+=("$flow"); done
  shopt -u nullglob
  if [[ "${#FLOW_FILES[@]}" -eq 0 && "$FLOWS_EXPLICIT" == true ]]; then
    echo "❌ --flows matched no files: $FLOWS" >&2
    exit 2
  fi
fi
SCENARIO_FILES=()
if [[ -n "$SCENARIOS" ]]; then
  shopt -s nullglob
  for scenario in $SCENARIOS; do SCENARIO_FILES+=("$scenario"); done
  shopt -u nullglob
  if [[ "${#SCENARIO_FILES[@]}" -eq 0 && "$SCENARIOS_EXPLICIT" == true ]]; then
    echo "❌ --scenarios matched no files: $SCENARIOS" >&2
    exit 2
  fi
  if [[ "$PLATFORM" != "web" && "${#SCENARIO_FILES[@]}" -gt 0 ]]; then
    echo "❌ Multi-actor Scenarios currently require --platform web" >&2
    exit 2
  fi
fi

# Platform-filter both default and explicitly supplied suites before any real
# surface is launched. Default discovery may legitimately find only another
# target's Flows in a monorepo; an explicit all-mismatched suite is a config
# error. Legacy platform-less Flows resolve to iOS, never "all platforms".
if [[ "${#FLOW_FILES[@]}" -gt 0 ]]; then
  PLATFORM_FLOW_FILES=()
  PLATFORM_FLOW_COUNT=0
  for flow in "${FLOW_FILES[@]}"; do
    flow_platform="$(node "$ROOT/scripts/flow-platform.js" "$flow")" || exit 2
    if [[ "$flow_platform" == "$PLATFORM" ]]; then
      PLATFORM_FLOW_FILES+=("$flow")
      PLATFORM_FLOW_COUNT=$((PLATFORM_FLOW_COUNT + 1))
    fi
  done
  if [[ "$PLATFORM_FLOW_COUNT" -eq 0 && "$FLOWS_EXPLICIT" == true ]]; then
    echo "❌ None of the supplied Flows target platform '$PLATFORM'" >&2
    exit 2
  fi
  FLOW_FILES=()
  [[ "$PLATFORM_FLOW_COUNT" -gt 0 ]] && FLOW_FILES=("${PLATFORM_FLOW_FILES[@]}")
fi

# A PR plan is an execution manifest, not advisory prose: only critical/always
# and reviewed diff-relevant contracts advance to replay. Unknown files and
# mapped-but-uncovered UI states remain explicit in the report.
PR_PLAN_PATH=""
if [[ -n "$PR_BASE" || -n "$CHANGED_FILES_FILE" ]]; then
  [[ -n "$PROJECT_DIR" && -d "$PROJECT_DIR" ]] || { echo "❌ PR selection requires --project-dir <repository>" >&2; exit 2; }
  [[ -z "$PR_BASE" || -z "$CHANGED_FILES_FILE" ]] || { echo "❌ Use either --pr-base or --changed-files-file, not both" >&2; exit 2; }
  [[ -z "$CHANGED_FILES_FILE" || -f "$CHANGED_FILES_FILE" ]] || { echo "❌ Changed-files file not found: $CHANGED_FILES_FILE" >&2; exit 2; }
  PR_PLAN_PATH="$PR_PLAN_OUT"
  [[ -n "$PR_PLAN_PATH" ]] || PR_PLAN_PATH="$(mktemp "${TMPDIR:-/tmp}/tapp-pr-plan.XXXXXX")"
  PR_SELECTION_PATH="$(mktemp "${TMPDIR:-/tmp}/tapp-pr-selection.XXXXXX")"
  PR_TARGET_PATH="$(mktemp "${TMPDIR:-/tmp}/tapp-pr-target.XXXXXX")"
  PR_ARGS=(--project-dir "$PROJECT_DIR" --platform "$PLATFORM" --head "$PR_HEAD" --json-out "$PR_PLAN_PATH" --selection-out "$PR_SELECTION_PATH" --exploration-target-out "$PR_TARGET_PATH")
  [[ -n "$PR_BASE" ]] && PR_ARGS+=(--base "$PR_BASE")
  [[ -n "$CHANGED_FILES_FILE" ]] && PR_ARGS+=(--changed-files-file "$CHANGED_FILES_FILE")
  for contract in ${CONTRACT_FILES[@]+"${CONTRACT_FILES[@]}"}; do PR_ARGS+=(--contract "$contract"); done
  node "$ROOT/scripts/pr-plan.js" "${PR_ARGS[@]}" || exit 2
  SELECTED_CONTRACT_FILES=()
  SELECTED_CONTRACT_COUNT=0
  while IFS= read -r -d '' contract; do SELECTED_CONTRACT_FILES+=("$contract"); SELECTED_CONTRACT_COUNT=$((SELECTED_CONTRACT_COUNT + 1)); done < <(
    python3 -c 'import json,sys; [sys.stdout.buffer.write(str(p).encode()+b"\0") for p in json.load(open(sys.argv[1]))]' "$PR_SELECTION_PATH"
  )
  CONTRACT_FILES=()
  for contract in ${SELECTED_CONTRACT_FILES[@]+"${SELECTED_CONTRACT_FILES[@]}"}; do CONTRACT_FILES+=("$contract"); done
  if [[ "$PLATFORM" == "ios" ]]; then
    IOS_PR_TARGET_JSON="$(python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); print(json.dumps(value, separators=(",", ":")) if isinstance(value, dict) else "")' "$PR_TARGET_PATH")" || exit 2
  fi
  echo "PR selection: $SELECTED_CONTRACT_COUNT release contract(s); plan: $PR_PLAN_PATH"
fi

# Web and Android share the report/gate with iOS but do not need the Xcode
# simulator orchestration below. Pass already-expanded Flow paths as argv—not a
# shell expression—to keep CI inputs inert.
if [[ "$PLATFORM" != "ios" ]]; then
  PLATFORM_ARGS=(--platform "$PLATFORM" --actions "$ACTIONS" --timeout "$TIMEOUT" --fail-on "$FAIL_ON")
  [[ -n "$URL" ]] && PLATFORM_ARGS+=(--url "$URL")
  [[ -n "$PROJECT_DIR" ]] && PLATFORM_ARGS+=(--project-dir "$PROJECT_DIR")
  [[ -n "$WEB_TARGET" ]] && PLATFORM_ARGS+=(--web-target "$WEB_TARGET")
  [[ -n "$TARGET_KEY" ]] && PLATFORM_ARGS+=(--target-key "$TARGET_KEY")
  [[ -n "$APP_ID" ]] && PLATFORM_ARGS+=(--app-id "$APP_ID")
  [[ -n "$APK_PATH" ]] && PLATFORM_ARGS+=(--apk "$APK_PATH")
  [[ -n "$SERIAL" ]] && PLATFORM_ARGS+=(--serial "$SERIAL")
  [[ -n "$BASELINE" ]] && PLATFORM_ARGS+=(--baseline "$BASELINE")
  [[ -n "$JSON_OUT" ]] && PLATFORM_ARGS+=(--json-out "$JSON_OUT")
  [[ -n "$MD_OUT" ]] && PLATFORM_ARGS+=(--md-out "$MD_OUT")
  [[ -n "$PR_PLAN_PATH" ]] && PLATFORM_ARGS+=(--pr-plan "$PR_PLAN_PATH")
  for flow in ${FLOW_FILES[@]+"${FLOW_FILES[@]}"}; do PLATFORM_ARGS+=(--flow "$flow"); done
  for scenario in ${SCENARIO_FILES[@]+"${SCENARIO_FILES[@]}"}; do PLATFORM_ARGS+=(--scenario "$scenario"); done
  for contract in ${CONTRACT_FILES[@]+"${CONTRACT_FILES[@]}"}; do PLATFORM_ARGS+=(--contract "$contract"); done
  exec node "$ROOT/scripts/platform-gate.js" "${PLATFORM_ARGS[@]}"
fi

# Compile only iOS-applicable contracts before spending simulator time. The
# compiler exits 3 for reviewed contracts that target another platform.
CONTRACT_COMPILED_FILES=()
if [[ "${#CONTRACT_FILES[@]}" -gt 0 ]]; then
  CONTRACT_BUILD_DIR="$(mktemp -d /tmp/tapp-ci-contracts.XXXXXX)"
  for contract in "${CONTRACT_FILES[@]}"; do
    compiled="$CONTRACT_BUILD_DIR/$(basename "$contract" .contract.ts).json"
    set +e
    node "$ROOT/scripts/compile-contract.js" "$contract" ios "$compiled"
    contract_status=$?
    set -e
    [[ "$contract_status" -eq 3 ]] && continue
    [[ "$contract_status" -eq 0 ]] || { echo "❌ Could not compile release contract: $contract" >&2; exit 2; }
    CONTRACT_COMPILED_FILES+=("$compiled")
  done
fi

[[ -n "$APP_PATH" && -d "$APP_PATH" ]] || { echo "❌ Required: --app <path/to/App.app> (a simulator build)" >&2; exit 2; }
if [[ -z "$BUNDLE_ID" ]]; then
  BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_PATH/Info.plist" 2>/dev/null || true)"
  [[ -n "$BUNDLE_ID" ]] || { echo "❌ Could not detect CFBundleIdentifier from $APP_PATH/Info.plist; pass --bundle-id" >&2; exit 2; }
  echo "Detected bundle id: $BUNDLE_ID"
fi

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
CAPTURE_ROOT="${AUTOTAP_HOME:-$ROOT}/captures"
mkdir -p "$CAPTURE_ROOT"
CAPTURE_DIR="$(mktemp -d "$CAPTURE_ROOT/ci.XXXXXX")"
TAPP_CAPTURE_DIR="$CAPTURE_DIR" OCQA_PR_TARGET_JSON="$IOS_PR_TARGET_JSON" "$ROOT/scripts/quick-capture.sh" explore "$BUNDLE_ID" --actions "$ACTIONS" --timeout "$TIMEOUT"
set -e
MARKERS="$CAPTURE_DIR/ocqa-markers.txt"
[[ -f "$MARKERS" ]] || { echo "❌ Exploration produced no markers ($MARKERS)" >&2; exit 1; }
echo "Markers: $MARKERS"

# ── Replay committed Flows (each failure becomes a gate reason).
FLOW_LOG_ARGS=()
if [[ "${#FLOW_FILES[@]}" -gt 0 ]]; then
  step "Flows"
  FLOW_LOG_DIR="$(mktemp -d /tmp/autotap-ci-flows.XXXXXX)"
  for flow in "${FLOW_FILES[@]}"; do
    name="$(basename "$flow" .yml)"
    log="$FLOW_LOG_DIR/$name.log"
    echo "▶️  $name"
    FLOW_LOG="$log" "$ROOT/scripts/run-flow.sh" "$flow" "$BUNDLE_ID" || true # verdict comes from the log
    FLOW_LOG_ARGS+=(--flow-log "$log")
  done
elif [[ -n "$FLOWS" ]]; then
  echo "No committed Flows found; continuing with autonomous exploration only."
fi

if [[ "${#CONTRACT_COMPILED_FILES[@]}" -gt 0 ]]; then
  step "Release Contracts"
  CONTRACT_LOG_DIR="$(mktemp -d /tmp/tapp-ci-contract-logs.XXXXXX)"
  for contract in "${CONTRACT_COMPILED_FILES[@]}"; do
    name="$(basename "$contract" .json)"
    log="$CONTRACT_LOG_DIR/$name.log"
    echo "▶️  $name"
    FLOW_LOG="$log" "$ROOT/scripts/run-flow.sh" "$contract" "$BUNDLE_ID" || true
    FLOW_LOG_ARGS+=(--contract-log "$log")
  done
fi

# ── Report + gate.
step "Gate"
BASELINE_ARGS=()
[[ -n "$BASELINE" ]] && BASELINE_ARGS=(--baseline "$BASELINE")
JSON_ARGS=()
[[ -n "$JSON_OUT" ]] && JSON_ARGS=(--json-out "$JSON_OUT")
MD_ARGS=()
[[ -n "$MD_OUT" ]] && MD_ARGS=(--md-out "$MD_OUT")
PR_PLAN_ARGS=()
[[ -n "$PR_PLAN_PATH" ]] && PR_PLAN_ARGS=(--pr-plan "$PR_PLAN_PATH")
TARGET_KEY_ARGS=()
[[ -n "$TARGET_KEY" ]] && TARGET_KEY_ARGS=(--target-key "$TARGET_KEY")
node "$ROOT/mcp-server/src/ci-report.js" --markers "$MARKERS" --fail-on "$FAIL_ON" \
  --html-dir "$CAPTURE_DIR" --label "$BUNDLE_ID" \
  ${BASELINE_ARGS[@]+"${BASELINE_ARGS[@]}"} ${JSON_ARGS[@]+"${JSON_ARGS[@]}"} ${MD_ARGS[@]+"${MD_ARGS[@]}"} ${PR_PLAN_ARGS[@]+"${PR_PLAN_ARGS[@]}"} ${TARGET_KEY_ARGS[@]+"${TARGET_KEY_ARGS[@]}"} ${FLOW_LOG_ARGS[@]+"${FLOW_LOG_ARGS[@]}"}
