#!/usr/bin/env bash
# Corpus sweep — run a list of real open-source iOS apps through the tapp pipeline and
# produce a friction scoreboard. Failures ARE the data: every app gets a row recording
# how far it got (clone → detect → build → install → explore) and why it stopped.
#
# Usage: scripts/corpus-sweep.sh <urls-file> [--actions N] [--out <dir>]
#   urls-file: one git URL per line (# comments ok)
#
# Needs a booted simulator. Rows land in <out>/scoreboard.tsv; per-app logs in <out>/<app>/.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

URLS_FILE="${1:?usage: corpus-sweep.sh <urls-file> [--actions N] [--out dir]}"; shift
ACTIONS=25
OUT="/tmp/tapp-corpus"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --actions) ACTIONS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"
BOARD="$OUT/scoreboard.tsv"
[[ -f "$BOARD" ]] || echo -e "app\tstage\tbackend_signals\tbundle\tscreens\tactions\tfindings\tverdict\tnote" > "$BOARD"

UDID="$(xcrun simctl list devices booted -j | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((x["udid"] for v in d["devices"].values() for x in v if x.get("state")=="Booted"), ""))')"
[[ -n "$UDID" ]] || { echo "❌ boot a simulator first" >&2; exit 1; }

row() { echo -e "$1\t$2\t$3\t$4\t$5\t$6\t$7\t$8\t$9" >> "$BOARD"; }

# Cheap backend-class signals from the repo tree (feeds the classifier's rules).
backend_signals() {
  local dir="$1" sig=()
  [[ -n "$(find "$dir" -maxdepth 4 -name 'GoogleService-Info.plist' -print -quit 2>/dev/null)" ]] && sig+=("firebase-plist")
  grep -rqli "firebase" "$dir"/Podfile "$dir"/*/Package.resolved "$dir"/Package.resolved 2>/dev/null && sig+=("firebase-dep")
  grep -rqli "supabase" "$dir"/Podfile "$dir"/*/Package.resolved "$dir"/Package.resolved 2>/dev/null && sig+=("supabase-dep")
  [[ -n "$(find "$dir" -maxdepth 2 -name 'docker-compose.y*ml' -print -quit 2>/dev/null)" ]] && sig+=("in-repo-backend")
  grep -rqli "mastodon" "$dir"/Package.resolved 2>/dev/null && sig+=("mastodon-client")
  grep -rql "YOUR_API_KEY\|INSERT_API_KEY\|<API_KEY>" --include="*.xcconfig" --include="*.plist" --include="*.swift" "$dir" 2>/dev/null | head -1 | grep -q . && sig+=("key-placeholder")
  local IFS=","; echo "${sig[*]:-none}"
}

while IFS= read -r url; do
  [[ -z "$url" || "$url" == \#* ]] && continue
  name="$(basename "$url" .git)"
  dir="$OUT/$name"
  log="$OUT/$name.log"
  echo "━━━ $name"

  # 1. clone
  if [[ ! -d "$dir" ]]; then
    git clone --depth 1 --recurse-submodules --shallow-submodules "$url" "$dir" >"$log" 2>&1 \
      || { row "$name" clone none - - - - - "git clone failed"; continue; }
  fi
  signals="$(backend_signals "$dir")"

  # 2. detect workspace/project + scheme (workspace wins; ignore Pods)
  target="$(find "$dir" -maxdepth 3 -name '*.xcworkspace' -not -path '*/Pods/*' -not -path '*/.*' | head -1)"
  flag="-workspace"
  if [[ -z "$target" ]]; then
    target="$(find "$dir" -maxdepth 3 -name '*.xcodeproj' -not -path '*/Pods/*' | head -1)"
    flag="-project"
  fi
  [[ -n "$target" ]] || { row "$name" detect "$signals" - - - - - "no xcworkspace/xcodeproj found"; continue; }
  schemes="$(xcodebuild -list -json $flag "$target" 2>>"$log" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); o=d.get("workspace") or d.get("project") or {}
  print("\n".join(o.get("schemes") or []))
except Exception: pass')"
  scheme="$(echo "$schemes" | grep -ix "$name" | head -1)"
  [[ -z "$scheme" ]] && scheme="$(echo "$schemes" | grep -iv "test\|uitests\|widget\|extension\|notification\|clip\|watch\|mac" | head -1)"
  [[ -z "$scheme" ]] && scheme="$(echo "$schemes" | head -1)"
  [[ -n "$scheme" ]] || { row "$name" detect "$signals" - - - - - "no schemes listed"; continue; }
  echo "  scheme: $scheme"

  # 3. build for simulator (20 min cap; perl alarm — stock macOS has no `timeout`)
  dd="$OUT/dd-$name"
  if ! perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild $flag "$target" -scheme "$scheme" \
      -destination 'generic/platform=iOS Simulator' -derivedDataPath "$dd" \
      CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO \
      build >>"$log" 2>&1; then
    reason="$(grep -m1 -E "error: |xcodebuild: error" "$log" | tail -c 120 || true)"
    row "$name" build "$signals" - - - - - "build failed: ${reason:-see log}"
    continue
  fi
  app="$(find "$dd/Build/Products" -maxdepth 2 -name '*.app' -path '*iphonesimulator*' | head -1)"
  [[ -n "$app" ]] || { row "$name" build "$signals" - - - - - "built but no simulator .app (macOS-only scheme?)"; continue; }
  bundle="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist" 2>/dev/null || echo "?")"

  # 4. install
  xcrun simctl install "$UDID" "$app" >>"$log" 2>&1 \
    || { row "$name" install "$signals" "$bundle" - - - - "simctl install failed"; continue; }

  # 5. explore + report
  "$ROOT/scripts/quick-capture.sh" explore "$bundle" --actions "$ACTIONS" --timeout 420 >>"$log" 2>&1
  cap="$(ls -td "$ROOT"/captures/*/ 2>/dev/null | head -1)"
  if [[ ! -f "$cap/ocqa-markers.txt" ]]; then
    row "$name" explore "$signals" "$bundle" - - - - "exploration produced no markers"
    continue
  fi
  json="$OUT/$name-report.json"
  node "$ROOT/mcp-server/src/ci-report.js" --markers "$cap/ocqa-markers.txt" --json-out "$json" >>"$log" 2>&1 || true
  read -r screens acted findings verdict <<< "$(python3 -c "
import json,sys
try:
  r=json.load(open('$json'))
  print(r.get('screensExplored','?'), r.get('actionsPerformed','?'), r.get('findingCounts',{}).get('total','?'), r.get('verdict','?'))
except Exception: print('? ? ? ?')")"
  row "$name" explored "$signals" "$bundle" "$screens" "$acted" "$findings" "$verdict" "capture: $(basename "$cap")"
  echo "  ✅ $verdict — $screens screens"
done < "$URLS_FILE"

echo ""
echo "═══ scoreboard: $BOARD ═══"
column -t -s $'\t' "$BOARD"
