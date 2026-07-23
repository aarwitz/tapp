#!/usr/bin/env bash
# Mutation-recall benchmark — DESKTOP APP EDITION.
#
# Same idea as mutation-recall.sh (seeded faults, differential catch, coverage-vs-detection
# decomposition) but the system under test is the REAL desktop pipeline: each run goes through
# `AutoTap.app --verify-run` (OrchestratorService.executeReleaseCheck — the exact code the Run
# button calls: build → install → explore → host-side crash cross-check → vision/enrichment →
# verdict). That matters because the Swift interpretation layer is a SEPARATE implementation
# from the CLI/MCP marker parsing (see CLAUDE.md) — a recall number measured only via
# quick-capture logs says nothing about what the product actually reports.
#
# Scoring is on the verify-run findings JSON: `type` is FindingCategory.rawValue (so harness
# issue types are mapped, e.g. error_surface -> network_error_surface), `screen` names come from
# the run's screensVisited, and each catching finding records its flow so advisory
# ("Vision review") catches are reported separately from deterministic ones.
#
# K repeats (RUNS, default 2): exploration is nondeterministic, so the baseline is the UNION of
# K clean runs (kills false-differentials — a flaky low-severity finding that happens to appear
# only in a mutant run would otherwise read as a catch) and a mutant scores reached/caught if
# ANY of its K runs did. Runs keep their artifacts (--keep-artifacts) so any surprising row can
# be verified against the actual screenshots afterwards — never trust the marker stream alone.
#
# Prereqs: booted simulator; Release AutoTap.app at build/Build/Products/Release/AutoTap.app.
# The curated mutant set below was compile-smoked; a build failure mid-run is recorded, not fatal.
# Ends by rebuilding + reinstalling CLEAN DemoApp so the simulator isn't left with a mutant.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="$ROOT/build/Build/Products/Release/AutoTap.app"
ACTIONS="${ACTIONS:-45}"
RUNS="${RUNS:-2}"
RUN_TIMEOUT="${RUN_TIMEOUT:-1080}"   # seconds per verify-run (build + explore + AI passes)

[[ -d "$APP_BIN" ]] || { echo "❌ build AutoTap first ($APP_BIN missing)"; exit 2; }
UDID="$(xcrun simctl list devices booted -j 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next((x["udid"] for v in d["devices"].values() for x in v if x.get("state")=="Booted"),""))')"
[[ -z "$UDID" ]] && { echo "❌ boot a simulator first"; exit 2; }

WORK="${WORK_DIR:-$(mktemp -d /tmp/mutation-recall-desktop.XXXXXX)}"
echo "▶ work dir: $WORK  (runs per variant: $RUNS, actions: $ACTIONS)"

# Curated mutants: file<TAB>op<TAB>screen<TAB>expected_harness_type_or_-<TAB>in_taxonomy
# (screen = the harness-visible nav title of the mutated site, from mutation_operators.py list)
MUTANTS="$WORK/mutants.tsv"
cat > "$MUTANTS" <<'EOF'
DemoApp/Sources/CounterView.swift	dead_button	Counter	unresponsive_element	1
DemoApp/Sources/DashboardHomeView.swift	infinite_spinner	Dashboard	app_hang	1
DemoApp/Sources/DashboardHomeView.swift	crash_on_appear	Dashboard	crash	1
DemoApp/Sources/SettingsView.swift	inject_error	Settings	error_surface	1
DemoApp/Sources/TodoView.swift	off_by_one	Todo List	-	0
DemoApp/Sources/CounterView.swift	mislabel_button	Counter	-	0
EOF

# One verify-run of the CURRENT DemoApp source tree; waits for the output JSON.
run_verify() {  # $1 = out json path
  local out="$1"
  rm -f "$out"
  pkill -f -- "--verify-run" 2>/dev/null && sleep 3
  open -n "$APP_BIN" --args --verify-run "$ROOT/DemoApp" com.autotap.demoapp \
    --scheme DemoApp --project "$ROOT/DemoApp/DemoApp.xcodeproj" \
    --actions "$ACTIONS" --keep-artifacts --out "$out"
  local waited=0
  while [[ ! -s "$out" && $waited -lt $RUN_TIMEOUT ]]; do sleep 15; waited=$((waited+15)); done
  if [[ ! -s "$out" ]]; then
    echo '{"error":"timeout"}' > "$out"
    pkill -f -- "--verify-run" 2>/dev/null
  fi
  sleep 5   # let the instance fully exit before the next launch
}

run_k() {  # $1 = tag; produces $WORK/<tag>_r{1..RUNS}.json
  for r in $(seq 1 "$RUNS"); do
    SECONDS=0
    run_verify "$WORK/${1}_r${r}.json"
    echo "    ${1} run $r/$RUNS done in ${SECONDS}s"
  done
}

echo "▶ baseline: $RUNS verify-run(s) of clean DemoApp…"
run_k baseline

i=0
while IFS=$'\t' read -r FILE OP SCREEN EXPECTED INTAX; do
  i=$((i+1))
  echo "▶ mutant $i: $OP @ $(basename "$FILE") [$SCREEN]"
  cp "$ROOT/$FILE" "$ROOT/$FILE.bak"
  if python3 "$ROOT/scripts/mutation_operators.py" apply "$ROOT/$FILE" "$OP"; then
    run_k "mut_${i}_${OP}"
  else
    echo "  (operator no-op — skipped)"
    for r in $(seq 1 "$RUNS"); do echo '{"error":"noop"}' > "$WORK/mut_${i}_${OP}_r${r}.json"; done
  fi
  mv "$ROOT/$FILE.bak" "$ROOT/$FILE"    # ALWAYS restore
done < "$MUTANTS"

# Leave the simulator holding a CLEAN build, not the last mutant.
echo "▶ restoring clean DemoApp on the simulator…"
xcodebuild -project "$ROOT/DemoApp/DemoApp.xcodeproj" -scheme DemoApp -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$WORK/clean-build" build >/dev/null 2>&1 \
  && xcrun simctl install "$UDID" \
       "$(find "$WORK/clean-build/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name '*.app' | head -1)" \
  && echo "  clean DemoApp reinstalled" || echo "  ⚠️ clean reinstall failed — run generate/build manually"

echo
python3 - "$WORK" "$MUTANTS" "$RUNS" <<'PY'
import sys, json, os, glob

work, mutants_path, K = sys.argv[1], sys.argv[2], int(sys.argv[3])
# Harness issue type -> FindingCategory.rawValue (ExplorationService's OCQA_ISSUE switch).
CAT = {"unresponsive_element": "unresponsive_element", "app_hang": "app_hang",
       "error_surface": "network_error_surface", "blank_screen": "blank_screen", "crash": "crash"}

def load(p):
    d = json.load(open(p))
    finds = [(f["type"], f.get("screen") or "", f.get("flow") or "", f["title"], f["severity"])
             for f in d.get("findings", [])]
    return d, set(d.get("screens", [])), finds

# Baseline = union across K clean runs.
base_keys, base_screens, base_ok = set(), set(), 0
for r in range(1, K + 1):
    d, screens, finds = load(os.path.join(work, f"baseline_r{r}.json"))
    if "error" in d:
        print(f"⚠️ baseline run {r} failed: {d['error']}")
        continue
    base_ok += 1
    base_screens |= screens
    base_keys |= {(t, s) for t, s, *_ in finds}
if base_ok == 0:
    print("❌ no successful baseline run — cannot score"); sys.exit(1)

rows = []
for i, line in enumerate(open(mutants_path).read().splitlines(), 1):
    file, op, screen, expected, intax = line.split("\t")
    per_run, reached_any, det_any, vis_any, catchers_all, dirs = [], False, False, False, [], []
    verdicts = []
    for r in range(1, K + 1):
        p = os.path.join(work, f"mut_{i}_{op}_r{r}.json")
        d, screens, finds = load(p)
        if "error" in d:
            per_run.append({"run": r, "error": d["error"]}); continue
        reached = screen in screens
        if expected != "-":
            want = CAT[expected]
            if want == "crash":   # crash screen attribution is fuzzy — category match anywhere
                catchers = [f for f in finds if f[0] == "crash" and ("crash", f[1]) not in base_keys]
            else:
                catchers = [f for f in finds if f[0] == want and f[1] == screen
                            and (f[0], f[1]) not in base_keys]
        else:                     # out-of-taxonomy: ANY new finding at the injected screen
            catchers = [f for f in finds if f[1] == screen and (f[0], f[1]) not in base_keys]
        det = [c for c in catchers if c[2] != "Vision review"]
        vis = [c for c in catchers if c[2] == "Vision review"]
        reached_any |= reached; det_any |= bool(det); vis_any |= bool(vis)
        catchers_all += [c for c in catchers if c not in catchers_all]
        verdicts.append(f"{d.get('verdict')}({d.get('confidence')})")
        if d.get("supportDir"): dirs.append(d["supportDir"])
        per_run.append({"run": r, "reached": reached, "det": bool(det), "vis": bool(vis)})
    rows.append({"op": op, "screen": screen, "in_tax": intax == "1",
                 "reached": reached_any, "caught_det": det_any, "caught_vis": vis_any,
                 "verdicts": verdicts, "per_run": per_run, "artifact_dirs": dirs,
                 "catchers": [{"type": c[0], "screen": c[1], "flow": c[2], "title": c[3][:80],
                               "severity": c[4]} for c in catchers_all]})

print("=" * 76)
print(f"MUTATION-RECALL — DESKTOP APP (--verify-run), K={K}, union baseline ({base_ok} ok)")
print("=" * 76)
print(f"baseline screens: {sorted(base_screens)}")
print(f"baseline finding keys: {sorted(base_keys)}")
for r in rows:
    tag = "IN " if r["in_tax"] else "OUT"
    catch = ("DET" if r["caught_det"] else ("VIS" if r["caught_vis"] else
             ("miss(detect)" if r["reached"] else "miss(coverage)")))
    runs_s = " ".join(("E" if "error" in p else f"{'R' if p['reached'] else '-'}{'D' if p['det'] else ''}{'V' if p['vis'] else ''}") for p in r["per_run"])
    print(f"  [{tag}] {r['op']:18s} {r['screen']:12s} catch={catch:14s} runs[{runs_s}] verdicts={','.join(r['verdicts'])}")
    for c in r["catchers"]:
        print(f"        └─ {c['severity']}/{c['type']} [{c['flow']}] {c['title']}")

def rate(xs): return f"{sum(xs)}/{len(xs)}" if xs else "n/a"
ok = rows
it = [r for r in ok if r["in_tax"]]; ot = [r for r in ok if not r["in_tax"]]
print(f"\nIN-TAXONOMY   deterministic recall: {rate([r['caught_det'] for r in it])}   "
      f"reach: {rate([r['reached'] for r in it])}")
print(f"OUT-OF-TAXONOMY deterministic recall: {rate([r['caught_det'] for r in ot])}   "
      f"(+vision-advisory: {rate([r['caught_vis'] for r in ot])})")
json.dump(rows, open(os.path.join(work, "records.json"), "w"), indent=2)
print(f"\nrecords: {work}/records.json   (artifact dirs preserved per run for visual verification)")
PY
