#!/usr/bin/env bash
# Mutation-recall benchmark — the HONEST recall scoreboard (docs/COMPETITIVE-MAP.md §0).
#
# Unlike validation-matrix.sh (which only tests bug classes we built detectors for, so it scores
# near-100% and flatters us), this INJECTS seeded faults — including out-of-taxonomy ones we have
# no detector for — and measures what fraction the harness actually catches, decomposed into
# coverage (did we reach the screen?) vs detection (did we flag it once reached?).
#
# Loop per mutant:  back up source -> apply ONE mutation -> regenerate xcodeproj -> build ->
#                   install -> run `explore` K times -> parse markers -> restore source.
# Then mutation_lib.py rolls the records into the recall table.
#
# Cost note: one xcodebuild per mutant (~30-90s). Start SMALL: --app DemoApp --per-op 1 --runs 2.
# Mutants are independent -> the full version fans out across simulators; this sketch is 1 sim.
#
# SKETCH / WIP: the source backup/restore + per-app regenerate seams are marked TODO where a
# corpus app needs its own generator. Prereqs mirror validation-matrix.sh (booted sim + built
# harness). Exits 0 always (it's a measurement, not a gate) unless setup is missing.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

APP="DemoApp"; RUNS=2; PER_OP=1; ACTIONS=70; OPS_FILTER=""
while [[ $# -gt 0 ]]; do case "$1" in
  --app) APP="$2"; shift 2;;
  --runs) RUNS="$2"; shift 2;;          # K repeats per mutant (non-determinism)
  --per-op) PER_OP="$2"; shift 2;;      # sites per operator (sketch uses first match => 1)
  --actions) ACTIONS="$2"; shift 2;;
  --ops) OPS_FILTER="$2"; shift 2;;     # comma list, e.g. dead_button,off_by_one
  *) echo "unknown arg $1"; exit 2;;
esac; done

SRC_DIR="$ROOT/$APP/Sources"
BUNDLE="com.autotap.$(echo "$APP" | tr '[:upper:]' '[:lower:]')"
[[ -d "$SRC_DIR" ]] || { echo "❌ no $SRC_DIR"; exit 2; }

UDID="$(xcrun simctl list devices booted -j 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next((x["udid"] for v in d["devices"].values() for x in v if x.get("state")=="Booted"),""))')"
[[ -z "$UDID" ]] && { echo "❌ boot a simulator first"; exit 2; }

WORK="$(mktemp -d)"; RECORDS="$WORK/records.json"; echo "[]" > "$RECORDS"
trap 'rm -rf "$WORK"' EXIT

# --- regenerate + build + install the CURRENT source of $APP, return 0 on success ------------
build_install() {
  case "$APP" in
    DemoApp) ( cd "$ROOT" && ruby generate-demoapp-xcodeproj.rb ) >/dev/null 2>&1 ;;
    *)       ( cd "$ROOT" && ruby generate-demo-named.rb "$APP" ) >/dev/null 2>&1 ;;  # LoginDemo/WizardDemo
    # TODO: ShopDemo/RestaurantDemo have bespoke generators — add cases as needed.
  esac
  local proj="$ROOT/$APP/$APP.xcodeproj"
  xcodebuild -project "$proj" -scheme "$APP" -configuration Debug \
    -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$WORK/build" build >/dev/null 2>&1 || return 1
  local appdir; appdir="$(find "$WORK/build/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name '*.app' | head -1)"
  [[ -n "$appdir" ]] && xcrun simctl install "$UDID" "$appdir" >/dev/null 2>&1
}

# --- run explore K times against the installed build, echo the K log paths -------------------
explore_k() {
  local tag="$1" logs=()
  for i in $(seq 1 "$RUNS"); do
    local log="$WORK/${tag}_run$i.log"
    "$ROOT/scripts/quick-capture.sh" explore "$BUNDLE" --actions "$ACTIONS" >/dev/null 2>&1
    cp "$(ls -td "$ROOT"/captures/*/harness-output.txt 2>/dev/null | head -1)" "$log" 2>/dev/null || echo "" > "$log"
    logs+=("$log")
  done
  echo "${logs[@]}"
}

# 1) BASELINE — pristine build, K runs, union of findings = "pre-existing" (never counts as caught)
echo "▶ baseline: build + $RUNS explore run(s) of clean $APP…"
build_install || { echo "❌ baseline build failed"; exit 2; }
BASE_LOGS=($(explore_k baseline))
BASE_JSON="$WORK/baseline.json"
python3 "$ROOT/scripts/mutation_lib.py" parse "${BASE_LOGS[0]}" > "$BASE_JSON"   # sketch: 1st run; full: union K

# 2) enumerate applicable mutation sites
SITES="$WORK/sites.json"
python3 "$ROOT/scripts/mutation_operators.py" list "$SRC_DIR" > "$SITES"
COUNT="$(python3 -c "import json;print(len(json.load(open('$SITES'))))")"
echo "▶ $COUNT mutation site(s) in $APP"

# 3) per-mutant loop
python3 - "$SITES" "$OPS_FILTER" <<'PY' | while IFS=$'\t' read -r FILE OP SCREEN; do
import sys, json
sites = json.load(open(sys.argv[1]))
flt = set(filter(None, sys.argv[2].split(",")))
for s in sites:
    if flt and s["op"] not in flt: continue
    print(f"{s['file']}\t{s['op']}\t{s['screen']}")
PY
  echo "  ↳ mutate $OP @ $(basename "$FILE") [$SCREEN]"
  cp "$FILE" "$FILE.bak"                                   # back up
  if python3 "$ROOT/scripts/mutation_operators.py" apply "$FILE" "$OP"; then
    if build_install; then
      MUT_LOGS=($(explore_k "mut_${OP}"))
      # append a record: baseline + this mutant's K logs -> mutation_lib.score_mutant
      python3 - "$ROOT/scripts" "$RECORDS" "$SITES" "$OP" "$FILE" "$BASE_JSON" "${MUT_LOGS[@]}" <<'PY'
import sys, json
sys.path.insert(0, sys.argv[1])          # scripts/ dir, so `import mutation_lib` resolves
from mutation_lib import parse_log, score_mutant
records_path, sites_path, op, file, base_path = sys.argv[2:7]
mut_logs = sys.argv[7:]
sites = json.load(open(sites_path))
inj = next(s for s in sites if s["op"] == op and s["file"] == file)
base = json.load(open(base_path))
base_findings = set(tuple(x) for x in base["findings"])
runs = [parse_log(p) for p in mut_logs]
rec = score_mutant(inj, base_findings, runs)
recs = json.load(open(records_path)); recs.append(rec); json.dump(recs, open(records_path, "w"))
PY
    else
      echo "    (build failed — mutant likely uncompilable; recorded as skipped)"
    fi
  else
    echo "    (operator no-op here — skipped)"
  fi
  mv "$FILE.bak" "$FILE"                                   # ALWAYS restore
done

# 4) restore pristine build + report
build_install >/dev/null 2>&1
echo; python3 "$ROOT/scripts/mutation_lib.py" report "$RECORDS"
