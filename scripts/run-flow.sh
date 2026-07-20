#!/usr/bin/env bash
# Run an AutoTap Flow — a deterministic, authored/recorded E2E test (see docs/flows-architecture.md).
#
# Replays the flow's steps against an app on the BOOTED simulator with wait-for-condition timing and
# poll-with-timeout assertions (no sleeps), then prints a scannable pass/fail report. Deterministic by
# default; `assert_ai` steps are judged host-side only when ANTHROPIC_API_KEY is set (else skipped).
#
# Usage:
#   scripts/run-flow.sh <flow.yml|flow.json> [bundleId]
#   OCQA_TEST_EMAIL=… OCQA_TEST_PASSWORD=… scripts/run-flow.sh flow.yml
#
# bundleId defaults to the flow's `app:` field. The app must be installed on the booted sim.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

FLOW="${1:?usage: run-flow.sh <flow.yml|flow.json> [bundleId]}"
[ -f "$FLOW" ] || { echo "❌ Flow not found: $FLOW"; exit 2; }

# App bundle id: explicit arg, else the flow's `app:` field.
APP="${2:-}"
[ -z "$APP" ] && APP="$(python3 -c "import sys,yaml,json; f=('$FLOW'); d=(json.load(open(f)) if f.endswith('.json') else yaml.safe_load(open(f))); print(d.get('app','') or '')" 2>/dev/null)"
[ -z "$APP" ] && { echo "❌ No bundleId (pass one or set 'app:' in the flow)"; exit 2; }

UDID="$(xcrun simctl list devices booted -j 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((x["udid"] for v in d["devices"].values() for x in v if x.get("state")=="Booted"), ""))')"
[ -z "$UDID" ] && { echo "❌ No booted simulator."; exit 2; }
# When run through the `autotap` CLI (installed npm package), the harness cache lives under
# AUTOTAP_HOME — check there first, then the repo-dev locations.
XCTR=""
[ -n "${AUTOTAP_HOME:-}" ] && XCTR="$(find "$AUTOTAP_HOME/harness-derived/Build/Products" -name '*.xctestrun' 2>/dev/null | head -1)"
[ -z "$XCTR" ] && XCTR="$(find "$HOME/Library/Developer/Xcode/DerivedData/OCQAHarness-"*/Build/Products -name '*.xctestrun' 2>/dev/null | head -1)"
[ -z "$XCTR" ] && XCTR="$(find /tmp/autotap-harness-derived/Build/Products -name '*.xctestrun' 2>/dev/null | head -1)"
[ -z "$XCTR" ] && XCTR="$(find /tmp/harness-build/Build/Products -name '*.xctestrun' 2>/dev/null | head -1)"
[ -z "$XCTR" ] && { echo "❌ Harness not built. Run: scripts/deploy-and-build.sh --harness"; exit 2; }

FLOW_JSON="$(python3 "$ROOT/scripts/flow_lib.py" to-json "$FLOW")" || { echo "❌ Could not parse flow"; exit 2; }
NAME="$(python3 -c "import sys,json;print(json.loads(sys.argv[1]).get('name','flow'))" "$FLOW_JSON")"
echo "▶️  Running flow \"$NAME\" against $APP …"

TOKEN="$(date +%s)"
CFG="/tmp/ocqa-flow-$TOKEN.json"
AI_RESP="/tmp/ocqa-flow-ai-$TOKEN.json"
AI_DIR="/tmp/ocqa-flow-ai-$TOKEN"
python3 - "$CFG" "$APP" "$FLOW_JSON" "$AI_RESP" "$AI_DIR" <<'PY'
import json, os, sys
cfg, app, flow_json, ai_resp, ai_dir = sys.argv[1:6]
d = {
  "OCQA_BUNDLE_ID": app,
  "OCQA_FLOW_JSON": flow_json,
  "OCQA_TEST_EMAIL": os.environ.get("OCQA_TEST_EMAIL", "test@example.com"),
  "OCQA_TEST_PASSWORD": os.environ.get("OCQA_TEST_PASSWORD", "TestPass123!"),
}
if os.environ.get("ANTHROPIC_API_KEY"):
    d["OCQA_FLOW_AI_RESPONSE_PATH"] = ai_resp
    d["OCQA_FLOW_AI_IMAGE_DIR"] = ai_dir
open(cfg, "w").write(json.dumps(d))
PY

LOG="${FLOW_LOG:-/tmp/ocqa-flow-$TOKEN.log}"
# assert_ai judge sidecar (only when a key is present) — same file-channel as vision escalation.
RESPONDER_PID=""
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  mkdir -p "$AI_DIR"; : > "$LOG"
  python3 "$ROOT/scripts/flow_ai_judge.py" "$LOG" "$AI_RESP" > "/tmp/ocqa-flow-judge-$TOKEN.log" 2>&1 &
  RESPONDER_PID=$!
fi

TEST_RUNNER_OCQA_CONFIG_PATH="$CFG" xcodebuild test-without-building \
  -xctestrun "$XCTR" -destination "platform=iOS Simulator,id=$UDID" \
  -only-testing:"OCQAHarnessUITests/ExplorerTests/testReplayFlow" > "$LOG" 2>&1
[ -n "$RESPONDER_PID" ] && { kill "$RESPONDER_PID" 2>/dev/null; wait "$RESPONDER_PID" 2>/dev/null; }

echo ""
python3 "$ROOT/scripts/flow_lib.py" report "$LOG"
exit $?
