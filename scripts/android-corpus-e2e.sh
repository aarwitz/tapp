#!/usr/bin/env bash
# Build and exercise every native Android fixture through the same release gate
# customers use. A connected, booted emulator/device is required.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORPUS="$ROOT/AndroidCorpus"
SERIAL="${1:-${ANDROID_SERIAL:-}}"
SERIAL_ARGS=()
[[ -n "$SERIAL" ]] && SERIAL_ARGS=(--serial "$SERIAL")

"$CORPUS/gradlew" -p "$CORPUS" \
  :demoapp:assembleDebug :logindemo:assembleDebug :shopdemo:assembleDebug --no-daemon --quiet

run_fixture() {
  local module="$1" app_id="$2" flow="$3"
  local apk="$CORPUS/$module/build/outputs/apk/debug/$module-debug.apk"
  local output_dir="${RUNNER_TEMP:-/tmp}/tapp-android-corpus-$module"
  mkdir -p "$output_dir"
  echo "Testing Android corpus fixture: $module ($app_id)"
  "$ROOT/scripts/ci-gate.sh" --platform android --apk "$apk" --app-id "$app_id" \
    "${SERIAL_ARGS[@]}" --actions 12 --timeout 180 --flows "$CORPUS/$module/.tapp/flows/$flow" \
    --project-dir "$CORPUS/$module" --json-out "$output_dir/report.json" --md-out "$output_dir/report.md"
}

run_fixture demoapp io.tapp.corpus.demo smoke.yml
run_fixture logindemo io.tapp.corpus.login sign-in.yml
run_fixture shopdemo io.tapp.corpus.shop checkout.yml

echo "All Android corpus gates passed."
