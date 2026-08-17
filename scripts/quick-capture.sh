#!/usr/bin/env bash
set -euo pipefail

# quick-capture.sh — Fast local screenshot/video capture from iOS simulator
#
# Runs locally on the Mac against the booted simulator.
#
# Usage:
#   quick-capture.sh screenshot [--app <bundleId>]   # Screenshot current sim state
#   quick-capture.sh record [--duration <secs>]      # Record sim video
#   quick-capture.sh explore <bundleId> [--actions N] # Run autonomous exploration + capture
#          [--timeout <secs>]                         # Hard timeout for explore command
#   quick-capture.sh tree <bundleId>                  # Dump accessibility tree
#
# All output goes to the configured Tapp home or the repository capture directory.

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# TAPP_CAPTURE_DIR selects one exact run directory (used by CI so a failed run can never
# accidentally reuse stale markers). TAPP_HOME redirects all writable output otherwise —
# set by the `tapp` CLI when running as an installed npm package, where the package dir
# must stay read-only. Unset (repo dev flow), everything lands in the repo as before.
TAPP_RUNTIME_HOME="${TAPP_HOME:-}"
if [[ -n "${TAPP_CAPTURE_DIR:-}" ]]; then
  CAPTURE_DIR="$TAPP_CAPTURE_DIR"
elif [[ -n "$TAPP_RUNTIME_HOME" ]]; then
  CAPTURE_DIR="$TAPP_RUNTIME_HOME/captures/$(date +%Y%m%d-%H%M%S)"
else
  CAPTURE_DIR="$PROJECT_ROOT/captures/$(date +%Y%m%d-%H%M%S)"
fi
if [[ -n "$TAPP_RUNTIME_HOME" ]]; then
  HARNESS_DERIVED="$TAPP_RUNTIME_HOME/harness-derived"
else
  HARNESS_DERIVED="/tmp/tapp-harness-derived"
fi
HARNESS_PROJECT="$PROJECT_ROOT/Harness/OCQAHarness.xcodeproj"
DEFAULT_BUNDLE="io.github.aarwitz.tapp.demoapp"

get_booted_sim() {
  xcrun simctl list devices booted -j 2>/dev/null \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
for runtime, devices in d.get('devices', {}).items():
    for dev in devices:
        if dev.get('state') == 'Booted':
            print(dev['udid'])
            sys.exit(0)
" 2>/dev/null
}

get_sim_name() {
  xcrun simctl list devices booted -j 2>/dev/null \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
for runtime, devices in d.get('devices', {}).items():
    for dev in devices:
        if dev.get('state') == 'Booted':
            print(dev['name'])
            sys.exit(0)
" 2>/dev/null
}

cleanup_stale_recorders() {
  local udid="$1"
  pkill -f "simctl io $udid recordVideo" 2>/dev/null || true
  sleep 1
}

ensure_harness_built() {
  local sim_name="${1:-iPhone 16 Pro}"
  local udid="${UDID:-}"
  local marker="$HARNESS_DERIVED/.last-sim-udid"
  local last_udid="" last_fp=""
  if [[ -f "$marker" ]]; then
    last_udid=$(sed -n 1p "$marker" 2>/dev/null || true)
    last_fp=$(sed -n 2p "$marker" 2>/dev/null || true)
  fi
  # Fingerprint the harness source so a package update actually reaches users — without this,
  # a warm cache serves the OLD harness forever (npm normalizes mtimes, so hash the content).
  local src_file="$(dirname "$HARNESS_PROJECT")/OCQAHarnessUITests/ExplorerTests.swift"
  local src_fp=$(shasum "$src_file" 2>/dev/null | cut -c1-12)
  local xctestrun=$(find "$HARNESS_DERIVED/Build/Products" -name "*.xctestrun" 2>/dev/null | head -1)

  # Reuse the cached harness ONLY if it was built for the currently-booted simulator AND from
  # the same harness sources. A harness built for a different sim can fail to launch the
  # interactive session; a stale-source harness silently lacks shipped fixes.
  if [[ -n "$xctestrun" && ( -z "$udid" || "$udid" == "$last_udid" ) && "$src_fp" == "$last_fp" ]]; then
    echo "Harness already built for this sim: $xctestrun" >&2
    return 0
  fi
  if [[ -n "$xctestrun" && "$src_fp" != "$last_fp" ]]; then
    echo "Harness sources changed — rebuilding for $sim_name..." >&2
  elif [[ -n "$xctestrun" ]]; then
    echo "Booted simulator changed ($last_udid -> $udid) — rebuilding harness for $sim_name..." >&2
  else
    echo "Building harness for $sim_name..." >&2
  fi
  xcodebuild build-for-testing \
    -project "$HARNESS_PROJECT" \
    -scheme OCQAHarnessUITests \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath "$HARNESS_DERIVED" \
    2>&1 | tail -5 >&2
  # Record which sim + harness sources this build came from so the next run detects both
  # a simulator switch and a package update.
  printf '%s\n%s\n' "$udid" "$src_fp" > "$marker"
}

run_harness_test() {
  local test_method="$1"
  local sim_name="${2:-iPhone 16 Pro}"
  local bundle_id="${3:-$DEFAULT_BUNDLE}"
  local max_actions="${4:-25}"
  local timeout_secs="${5:-300}"

  # Optional deterministic input overrides — a JSON object string passed via
  # OCQA_INPUT_OVERRIDES_JSON, e.g. '{"id:email_field":"user@example.com"}'.
  # Keys are 'id:<identifier>' / 'label:<label>' or 'screen:<title>|id:<identifier>'.
  local overrides_line=""
  # Interactive mid-run input: when the host can prompt a human (desktop app, VS Code
  # extension), the harness pauses at input screens and polls the response path.
  local interactive_line=""
  if [[ "${OCQA_INTERACTIVE_INPUT:-}" == "1" && -n "${OCQA_INPUT_RESPONSE_PATH:-}" ]]; then
    interactive_line=",
  \"OCQA_INTERACTIVE_INPUT\": \"1\",
  \"OCQA_INPUT_RESPONSE_PATH\": \"${OCQA_INPUT_RESPONSE_PATH}\""
  fi
  if [[ -n "${OCQA_INPUT_OVERRIDES_JSON:-}" ]]; then
    overrides_line=",
  \"OCQA_INPUT_OVERRIDES\": ${OCQA_INPUT_OVERRIDES_JSON}"
  fi

  # Optional app launch arguments / environment (e.g. backend override, login bypass) so the
  # harness can drive real apps that need them. JSON array / object strings respectively.
  local launch_args_line=""
  if [[ -n "${OCQA_APP_LAUNCH_ARGS_JSON:-}" ]]; then
    launch_args_line=",
  \"OCQA_APP_LAUNCH_ARGS\": ${OCQA_APP_LAUNCH_ARGS_JSON}"
  fi
  local launch_env_line=""
  if [[ -n "${OCQA_APP_LAUNCH_ENV_JSON:-}" ]]; then
    launch_env_line=",
  \"OCQA_APP_LAUNCH_ENV\": ${OCQA_APP_LAUNCH_ENV_JSON}"
  fi

  # Optional explicit login replay — a JSON array of {action,target,value?,timeoutMs?} steps run
  # before exploration, for custom login UIs the heuristic preamble can't parse.
  local login_steps_line=""
  if [[ -n "${OCQA_LOGIN_STEPS_JSON:-}" ]]; then
    login_steps_line=",
  \"OCQA_LOGIN_STEPS\": ${OCQA_LOGIN_STEPS_JSON}"
  fi

  # One bounded, sanitized PR target compiled from the persistent UI Map. It is
  # inserted as JSON data (never evaluated as shell source) and consumed by the
  # native harness before ordinary breadth exploration.
  local pr_target_line=""
  if [[ -n "${OCQA_PR_TARGET_JSON:-}" ]]; then
    TAPP_PR_TARGET_JSON="$OCQA_PR_TARGET_JSON" python3 -c 'import json,os,sys; sys.exit(0 if isinstance(json.loads(os.environ["TAPP_PR_TARGET_JSON"]), dict) else 1)' \
      || { echo "ERROR: OCQA_PR_TARGET_JSON must be a JSON object" >&2; return 2; }
    pr_target_line=",
  \"OCQA_PR_TARGET\": ${OCQA_PR_TARGET_JSON}"
  fi

  cat > /tmp/ocqa-run-config.json << CONF
{
  "OCQA_BUNDLE_ID": "$bundle_id",
  "OCQA_MAX_ACTIONS": "$max_actions",
  "OCQA_TIMEOUT_SECONDS": "$timeout_secs",
  "OCQA_TEST_EMAIL": "${OCQA_TEST_EMAIL:-qa@example.com}",
  "OCQA_TEST_PASSWORD": "${OCQA_TEST_PASSWORD:-Tapp123!}"$interactive_line$overrides_line$launch_args_line$launch_env_line$login_steps_line$pr_target_line
}
CONF

  local xctestrun=$(find "$HARNESS_DERIVED/Build/Products" -name "*.xctestrun" 2>/dev/null | head -1)
  if [[ -z "$xctestrun" ]]; then
    echo "ERROR: No xctestrun found. Run: tapp install" >&2
    return 1
  fi

  # Forward the config path explicitly so the harness reads exactly this file
  # (authoritative over any stale /tmp file), matching the app's delivery path.
  export TEST_RUNNER_OCQA_CONFIG_PATH=/tmp/ocqa-run-config.json

  xcodebuild test-without-building \
    -xctestrun "$xctestrun" \
    -destination "platform=iOS Simulator,id=$UDID" \
    -only-testing:"OCQAHarnessUITests/ExplorerTests/$test_method" \
    -resultBundlePath "$CAPTURE_DIR/result.xcresult" \
    2>&1
}

# --- Main ---
MODE="${1:-screenshot}"
shift || true

APP_BUNDLE="$DEFAULT_BUNDLE"
DURATION=30
MAX_ACTIONS=25
EXPLORE_TIMEOUT=600

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP_BUNDLE="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --actions) MAX_ACTIONS="$2"; shift 2 ;;
    --timeout) EXPLORE_TIMEOUT="$2"; shift 2 ;;
    *) APP_BUNDLE="$1"; shift ;;
  esac
done

mkdir -p "$CAPTURE_DIR"
UDID=$(get_booted_sim)
SIM_NAME=$(get_sim_name)

if [[ -z "$UDID" ]]; then
  echo "ERROR: No booted simulator found. Boot one first:"
  echo "  xcrun simctl boot 'iPhone 16 Pro'"
  exit 1
fi
echo "Simulator: $SIM_NAME ($UDID)"
echo "Output: $CAPTURE_DIR"
echo ""

case "$MODE" in
  screenshot)
    echo "Taking screenshot..."
    xcrun simctl io "$UDID" screenshot "$CAPTURE_DIR/screenshot.png"
    echo "Saved: $CAPTURE_DIR/screenshot.png"
    ls -lh "$CAPTURE_DIR/screenshot.png"
    ;;

  record)
    echo "Recording for ${DURATION}s... (Ctrl+C to stop early)"
    cleanup_stale_recorders "$UDID"
    RECORD_PID=""
    if xcrun simctl io "$UDID" recordVideo --codec=h264 "$CAPTURE_DIR/recording.mov" & then
      RECORD_PID=$!
    fi
    if ! kill -0 "$RECORD_PID" 2>/dev/null; then
      echo "ERROR: Unable to start simulator recording (resource busy)."
      exit 1
    fi
    sleep "$DURATION"
    kill -INT $RECORD_PID 2>/dev/null || true
    wait $RECORD_PID 2>/dev/null || true
    sleep 1

    if [[ -f "$CAPTURE_DIR/recording.mov" ]]; then
      echo "Converting to WebM..."
      ffmpeg -hide_banner -loglevel error -y \
        -i "$CAPTURE_DIR/recording.mov" \
        -c:v libvpx-vp9 -crf 36 -b:v 0 -row-mt 1 -an \
        "$CAPTURE_DIR/recording.webm"
      echo "Saved: $CAPTURE_DIR/recording.webm ($(du -h "$CAPTURE_DIR/recording.webm" | cut -f1))"
      echo "Raw:   $CAPTURE_DIR/recording.mov ($(du -h "$CAPTURE_DIR/recording.mov" | cut -f1))"
    fi
    ;;

  explore)
    echo "Running autonomous exploration ($MAX_ACTIONS actions, timeout: ${EXPLORE_TIMEOUT}s, app: $APP_BUNDLE)..."
    ensure_harness_built "$SIM_NAME"

    # XCUITest can block inside `app.launch()` until the outer watchdog when the target dies in its
    # initializer, producing a misleading timeout after minutes. For an ordinary unconfigured
    # launch, probe the target directly first and verify that the returned PID survives a short
    # settle window. (Configured launch args/env skip this probe because simctl would not reproduce
    # that launch contract.) The harness still performs its own fresh launch for healthy apps.
    PREFLIGHT_CRASH=0
    PREFLIGHT_OUTPUT=""
    if [[ -z "${OCQA_APP_LAUNCH_ARGS_JSON:-}" && -z "${OCQA_APP_LAUNCH_ENV_JSON:-}" ]]; then
      xcrun simctl terminate "$UDID" "$APP_BUNDLE" >/dev/null 2>&1 || true
      PREFLIGHT_OUTPUT="$(xcrun simctl launch "$UDID" "$APP_BUNDLE" 2>&1 || true)"
      PREFLIGHT_PID="$(echo "$PREFLIGHT_OUTPUT" | sed -n 's/.*: \([0-9][0-9]*\)$/\1/p' | tail -1)"
      if [[ -n "$PREFLIGHT_PID" ]]; then
        sleep 2
        if ! kill -0 "$PREFLIGHT_PID" 2>/dev/null; then PREFLIGHT_CRASH=1; fi
      fi
      xcrun simctl terminate "$UDID" "$APP_BUNDLE" >/dev/null 2>&1 || true
    fi

    local_output_file="$CAPTURE_DIR/harness-output.txt"
    TIMED_OUT=0
    RECORD_PID=""
    if [[ "$PREFLIGHT_CRASH" -eq 1 ]]; then
      OUTPUT="OCQA_ISSUE:{\"type\":\"crash\",\"severity\":\"critical\",\"title\":\"App crashed during launch preflight\",\"screen\":\"Launch\",\"step\":0}
OCQA_COMPLETE:{\"actions\":0,\"states\":0,\"issues\":1,\"screens\":\"\",\"outcome\":\"launch_crash\"}"
      printf '%s\n%s\n' "$PREFLIGHT_OUTPUT" "$OUTPUT" > "$local_output_file"
      echo "WARNING: Target process exited during launch preflight; recorded a crash instead of waiting for the exploration timeout." >&2
    else

      # Start video recording in background
      cleanup_stale_recorders "$UDID"
      if xcrun simctl io "$UDID" recordVideo --codec=h264 "$CAPTURE_DIR/exploration.mov" & then
        RECORD_PID=$!
      fi
      sleep 0.5
      if ! kill -0 "$RECORD_PID" 2>/dev/null; then
        echo "WARNING: Could not start simulator video recording. Continuing without video." >&2
        RECORD_PID=""
      fi

      # Run exploration with watchdog timeout to avoid silent hangs.
      run_harness_test "testAutonomousExploration" "$SIM_NAME" "$APP_BUNDLE" "$MAX_ACTIONS" "$EXPLORE_TIMEOUT" > "$local_output_file" 2>&1 &
      HARNESS_PID=$!

      START_TS=$(date +%s)
      while kill -0 "$HARNESS_PID" 2>/dev/null; do
        NOW_TS=$(date +%s)
        ELAPSED=$((NOW_TS - START_TS))
        if [[ "$ELAPSED" -ge "$EXPLORE_TIMEOUT" ]]; then
          TIMED_OUT=1
          kill -TERM "$HARNESS_PID" 2>/dev/null || true
          sleep 2
          kill -KILL "$HARNESS_PID" 2>/dev/null || true
          break
        fi
        sleep 2
      done

      wait "$HARNESS_PID" 2>/dev/null || true
      OUTPUT="$(cat "$local_output_file" 2>/dev/null || true)"

      # Stop recording
      if [[ -n "$RECORD_PID" ]]; then
        kill -INT "$RECORD_PID" 2>/dev/null || true
        wait "$RECORD_PID" 2>/dev/null || true
      fi
      sleep 1
    fi

    # Parse OCQA_ markers
    echo "$OUTPUT" | grep "^OCQA_" > "$CAPTURE_DIR/ocqa-markers.txt" || true
    if [[ "$TIMED_OUT" -eq 1 ]]; then
      # The caller's wall-clock budget expiring means the evidence is partial; it is not proof that
      # the app itself is slow or hung. Preserve observed coverage in the terminal marker and let
      # report.js classify the run as inconclusive instead of inventing an app finding.
      TIMED_ACTIONS="$(echo "$OUTPUT" | sed -n 's/^OCQA_PROGRESS:{"action":\([0-9][0-9]*\).*/\1/p' | tail -1)"
      TIMED_STATES="$(echo "$OUTPUT" | sed -n 's/^OCQA_PROGRESS:.*"states":\([0-9][0-9]*\).*/\1/p' | tail -1)"
      TIMED_ISSUES="$(echo "$OUTPUT" | grep -c '^OCQA_ISSUE:' || true)"
      TIMED_ACTIONS="${TIMED_ACTIONS:-0}"
      TIMED_STATES="${TIMED_STATES:-0}"
      TIMED_ISSUES="${TIMED_ISSUES:-0}"
      echo "OCQA_COMPLETE:{\"actions\":$TIMED_ACTIONS,\"states\":$TIMED_STATES,\"issues\":$TIMED_ISSUES,\"screens\":\"\",\"timedOut\":true,\"timeoutSeconds\":$EXPLORE_TIMEOUT}" >> "$CAPTURE_DIR/ocqa-markers.txt"
      echo "WARNING: Exploration reached its ${EXPLORE_TIMEOUT}s time budget; evidence is partial" >&2
    fi
    echo "$OUTPUT" > "$CAPTURE_DIR/full-output.txt"

    COMPLETE_LINE=$(grep "OCQA_COMPLETE" "$CAPTURE_DIR/ocqa-markers.txt" | tail -1 || true)
    if [[ -n "$COMPLETE_LINE" ]]; then
      echo ""
      echo "Exploration complete: $COMPLETE_LINE"
    fi

    # Extract screenshots from xcresult
    if [[ -d "$CAPTURE_DIR/result.xcresult" ]]; then
      mkdir -p "$CAPTURE_DIR/screenshots"
      xcrun xcresulttool export attachments \
        --path "$CAPTURE_DIR/result.xcresult" \
        --output-path "$CAPTURE_DIR/screenshots" 2>/dev/null || true
      SC_COUNT=$(find "$CAPTURE_DIR/screenshots" -name "*.png" 2>/dev/null | wc -l | xargs)
      echo "Extracted $SC_COUNT screenshots from xcresult"
    fi

    # Convert video
    if [[ -f "$CAPTURE_DIR/exploration.mov" && -x "$(command -v ffmpeg 2>/dev/null || true)" ]]; then
      echo "Converting exploration video to WebM..."
      ffmpeg -hide_banner -loglevel error -y \
        -i "$CAPTURE_DIR/exploration.mov" \
        -c:v libvpx-vp9 -crf 36 -b:v 0 -row-mt 1 -an \
        "$CAPTURE_DIR/exploration.webm"
      echo "Video: $CAPTURE_DIR/exploration.webm ($(du -h "$CAPTURE_DIR/exploration.webm" | cut -f1))"
    elif [[ -f "$CAPTURE_DIR/exploration.mov" ]]; then
      echo "Video: $CAPTURE_DIR/exploration.mov (ffmpeg unavailable; keeping the original recording)"
    fi

    echo ""
    echo "All artifacts in: $CAPTURE_DIR/"
    ls -lh "$CAPTURE_DIR/"
    ;;

  tree)
    echo "Dumping accessibility tree for $APP_BUNDLE..."
    ensure_harness_built "$SIM_NAME"
    OUTPUT=$(run_harness_test "testDumpUITree" "$SIM_NAME" "$APP_BUNDLE" "1" "60")

    echo "$OUTPUT" | sed -n '/OCQA_UITREE_START/,/OCQA_UITREE_END/p' | grep -v "OCQA_UITREE" > "$CAPTURE_DIR/uitree.json" || true
    echo "$OUTPUT" > "$CAPTURE_DIR/full-output.txt"

    if [[ -s "$CAPTURE_DIR/uitree.json" ]]; then
      ELEMENTS=$(python3 -c "import json; d=json.load(open('$CAPTURE_DIR/uitree.json')); print(len(d.get('elements',[])))" 2>/dev/null || echo "?")
      echo "Tree saved: $CAPTURE_DIR/uitree.json ($ELEMENTS elements)"
    else
      echo "WARNING: No tree JSON extracted. Check $CAPTURE_DIR/full-output.txt"
    fi
    ;;

  session)
    # Persistent interactive session: launch the app once, then service single commands written to
    # OCQA_SESSION_CMD_PATH (the MCP drives this), emitting the fresh accessibility tree after each.
    # Streams the harness stdout LIVE via exec so the client sees trees in real time.
    ensure_harness_built "$SIM_NAME" >&2
    SESS_CMD="${OCQA_SESSION_CMD_PATH:-/tmp/ocqa-session-cmd.json}"
    SESS_RES="${OCQA_SESSION_RESULT_PATH:-/tmp/ocqa-session-result.json}"
    SESS_TIMEOUT="${OCQA_SESSION_TIMEOUT:-1800}"
    sess_args_line=""
    [[ -n "${OCQA_APP_LAUNCH_ARGS_JSON:-}" ]] && sess_args_line=",
  \"OCQA_APP_LAUNCH_ARGS\": ${OCQA_APP_LAUNCH_ARGS_JSON}"
    sess_env_line=""
    [[ -n "${OCQA_APP_LAUNCH_ENV_JSON:-}" ]] && sess_env_line=",
  \"OCQA_APP_LAUNCH_ENV\": ${OCQA_APP_LAUNCH_ENV_JSON}"
    cat > /tmp/ocqa-run-config.json << CONF
{
  "OCQA_BUNDLE_ID": "$APP_BUNDLE",
  "OCQA_SESSION_CMD_PATH": "$SESS_CMD",
  "OCQA_SESSION_RESULT_PATH": "$SESS_RES",
  "OCQA_SESSION_TIMEOUT": "$SESS_TIMEOUT",
  "OCQA_TEST_EMAIL": "${OCQA_TEST_EMAIL:-qa@example.com}",
  "OCQA_TEST_PASSWORD": "${OCQA_TEST_PASSWORD:-Tapp123!}"$sess_args_line$sess_env_line
}
CONF
    xctestrun=$(find "$HARNESS_DERIVED/Build/Products" -name "*.xctestrun" 2>/dev/null | head -1)
    if [[ -z "$xctestrun" ]]; then
      echo "ERROR: No xctestrun. Run: tapp install" >&2
      exit 1
    fi
    export TEST_RUNNER_OCQA_CONFIG_PATH=/tmp/ocqa-run-config.json
    exec xcodebuild test-without-building \
      -xctestrun "$xctestrun" \
      -destination "platform=iOS Simulator,id=$UDID" \
      -only-testing:"OCQAHarnessUITests/ExplorerTests/testInteractiveSession" \
      -resultBundlePath "$CAPTURE_DIR/session.xcresult" 2>&1
    ;;

  build-harness)
    # Just (re)build the harness cache for the booted sim — used by `tapp install`
    # for a fast first tool call later. No capture output.
    ensure_harness_built "$SIM_NAME"
    rmdir "$CAPTURE_DIR" 2>/dev/null || true
    echo "Harness ready: $(find "$HARNESS_DERIVED/Build/Products" -name '*.xctestrun' 2>/dev/null | head -1)"
    ;;

  *)
    echo "Usage: quick-capture.sh <screenshot|record|explore|tree|session|build-harness> [options]"
    echo ""
    echo "  screenshot [--app <id>]            Screenshot current simulator state"
    echo "  record [--duration <secs>]         Record simulator video (default 30s)"
    echo "  explore <bundleId> [--actions N] [--timeout S]   Autonomous exploration + capture"
    echo "  tree <bundleId>                    Dump accessibility tree JSON"
    echo "  build-harness                      Prebuild the exploration harness for the booted sim"
    exit 1
    ;;
esac
