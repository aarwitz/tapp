#!/usr/bin/env bash
# Vision false-positive eval — measure how often AutoTap's vision pass invents a defect on a clean
# screen, BEFORE we default it on.
#
# The vision reviewer (VisionInspector.swift) is disabled by default. This runs the SAME prompt/model
# over real captured screens (via scripts/vision_fp_probe.py) and tallies the visual findings. Our
# corpus apps are standard SwiftUI (visually clean — their fixtures are logical/interaction bugs, not
# visual ones), so on that corpus every finding is a candidate FALSE POSITIVE. A low flag rate here
# is the evidence needed to default vision on.
#
# Usage:
#   ANTHROPIC_API_KEY=... scripts/vision-fp-eval.sh                 # capture + review corpus apps
#   ANTHROPIC_API_KEY=... scripts/vision-fp-eval.sh com.acme.app    # specific installed app(s)
#   ANTHROPIC_API_KEY=... scripts/vision-fp-eval.sh --dir path/to/pngs   # review existing PNGs
#   ACTIONS=40 scripts/vision-fp-eval.sh                            # exploration budget per app
#
# Prereqs (capture mode): a booted sim, the harness built (scripts/deploy-and-build.sh --harness),
# apps installed. Writes captures/vision-fp-<timestamp>.json.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTIONS="${ACTIONS:-40}"
TIMEOUT="${TIMEOUT:-420}"
MAX_SCREENS="${MAX_SCREENS:-25}"   # mirrors ExplorationService.visionScreenBudget
DEFAULT_APPS=(com.autotap.demoapp com.autotap.logindemo com.autotap.wizarddemo com.autotap.shopdemo com.autotap.restaurantdemo)

[ -z "${ANTHROPIC_API_KEY:-}" ] && { echo "❌ ANTHROPIC_API_KEY not set."; exit 2; }

TS="$(date +%Y%m%d-%H%M%S)"
REPORT="$ROOT/captures/vision-fp-$TS.json"
mkdir -p "$ROOT/captures"

# ---- Direct-directory mode: review a folder of PNGs, no capture ----
if [ "${1:-}" = "--dir" ]; then
  DIR="${2:?--dir needs a path}"
  PNGS=()  # macOS ships bash 3.2 (no mapfile) — read into the array portably.
  while IFS= read -r p; do [ -n "$p" ] && PNGS+=("$p"); done < <(find "$DIR" -iname '*.png' | sort)
  [ ${#PNGS[@]} -eq 0 ] && { echo "❌ No PNGs under $DIR"; exit 2; }
  echo "Reviewing ${#PNGS[@]} screenshot(s) from $DIR ..."
  python3 "$ROOT/scripts/vision_fp_probe.py" "${PNGS[@]}" > "$REPORT"
  python3 -c '
import sys, json
d = json.load(open(sys.argv[1]))
if d.get("errors"): print("⚠️  %d/%d calls FAILED (e.g. %s) — not clean screens." % (d["errors"], d["reviewed"], (d.get("first_error") or "")[:80]))
print("reviewed=%s succeeded=%s flagged=%s findings=%s by_sev=%s fp_rate=%s" % (d["reviewed"], d["succeeded"], d["flagged"], d["findings_total"], d["by_severity"], d["fp_rate_screens"]))
' "$REPORT"
  echo "Report: $REPORT"
  exit 0
fi

# ---- Capture mode: drive corpus apps through the harness, extract distinct screens, review ----
APPS=("$@"); [ ${#APPS[@]} -eq 0 ] && APPS=("${DEFAULT_APPS[@]}")

UDID="$(xcrun simctl list devices booted -j 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((x["udid"] for v in d["devices"].values() for x in v if x.get("state")=="Booted"), ""))')"
[ -z "$UDID" ] && { echo "❌ No booted simulator. Boot one first."; exit 2; }
XCTR="$(find "$HOME/Library/Developer/Xcode/DerivedData/OCQAHarness-"*/Build/Products -name '*.xctestrun' 2>/dev/null | head -1)"
[ -z "$XCTR" ] && XCTR="$(find /tmp/autotap-harness-derived/Build/Products -name '*.xctestrun' 2>/dev/null | head -1)"
[ -z "$XCTR" ] && XCTR="$(find /tmp/harness-build/Build/Products -name '*.xctestrun' 2>/dev/null | head -1)"
[ -z "$XCTR" ] && { echo "❌ Harness not built. Run: scripts/deploy-and-build.sh --harness"; exit 2; }

echo "Vision FP eval — $ACTIONS actions/app, sim $UDID"
echo "Apps: ${APPS[*]}"
echo ""

ALL_PNGS=()
TITLE_MAP="/tmp/vision-fp-titlemap-$TS.json"
SUMMARY_MAP="/tmp/vision-fp-summarymap-$TS.json"   # basename -> a11y summary (mirrors runVisionPass)
echo "{}" > "$TITLE_MAP"; echo "{}" > "$SUMMARY_MAP"

for APP in "${APPS[@]}"; do
  if ! xcrun simctl get_app_container "$UDID" "$APP" >/dev/null 2>&1; then
    printf "  %-32s ⏭  not installed — skipping\n" "$APP"; continue
  fi
  CFG="/tmp/ocqa-visfp-$APP.json"
  cat > "$CFG" <<JSON
{ "OCQA_BUNDLE_ID": "$APP", "OCQA_MAX_ACTIONS": "$ACTIONS", "OCQA_TIMEOUT_SECONDS": "$TIMEOUT" }
JSON
  XCRESULT="/tmp/ocqa-visfp-$APP.xcresult"; rm -rf "$XCRESULT"
  OUTDIR="/tmp/ocqa-visfp-shots-$APP"; rm -rf "$OUTDIR"; mkdir -p "$OUTDIR"
  LOG="/tmp/ocqa-visfp-$APP.log"   # harness stdout; carries OCQA_STATE settled flags per action
  printf "  %-32s exploring...\n" "$APP"
  TEST_RUNNER_OCQA_CONFIG_PATH="$CFG" xcodebuild test-without-building \
    -xctestrun "$XCTR" -destination "platform=iOS Simulator,id=$UDID" \
    -resultBundlePath "$XCRESULT" \
    -only-testing:"OCQAHarnessUITests/ExplorerTests/testAutonomousExploration" > "$LOG" 2>&1

  xcrun xcresulttool export attachments --path "$XCRESULT" --output-path "$OUTDIR" >/dev/null 2>&1 || true

  # Dedup to distinct SCREENS and pick ONE representative per title, PREFERRING a settled capture —
  # mirrors ExplorationService.runVisionPass. The harness names shots "state_<action>_<Title>_<n>_
  # <uuid>.png"; the action count joins to the "settled" flag on that step from the harness log
  # (OCQA_STATE). Bounded by MAX_SCREENS. Kept apostrophe-free (heredoc nested in $()).
  SELECTED="$(APP="$APP" OUTDIR="$OUTDIR" MAX_SCREENS="$MAX_SCREENS" TITLE_MAP="$TITLE_MAP" SUMMARY_MAP="$SUMMARY_MAP" LOG="$LOG" SETTLED_MODE="${SETTLED_MODE:-prefer}" python3 - <<'PY'
import os, re, json, glob
outdir = os.environ["OUTDIR"]; app = os.environ["APP"]
maxs = int(os.environ["MAX_SCREENS"]); tmpath = os.environ["TITLE_MAP"]; smpath = os.environ["SUMMARY_MAP"]
logpath = os.environ.get("LOG", ""); mode = os.environ.get("SETTLED_MODE", "prefer")

# action -> settled(bool) and action -> a11y context (summary + full text inventory), parsed from
# the harness log OCQA_STATE lines. Context mirrors ExplorationService.visionContext.
settled_by_action = {}
summary_by_action = {}
if logpath and os.path.exists(logpath):
    for line in open(logpath, errors="ignore"):
        if line.startswith("OCQA_STATE:{"):
            try:
                o = json.loads(line[len("OCQA_STATE:"):])
                if "action" not in o:
                    continue
                act = int(o["action"])
                if "settled" in o:
                    settled_by_action[act] = bool(o["settled"])
                ctx = o.get("summary", "")
                texts = [t for t in (o.get("atext") or []) if isinstance(t, str)]
                if texts:
                    ctx += ("\n" if ctx else "") + "Full visible text (from accessibility): " + " | ".join(texts)
                if ctx:
                    summary_by_action[act] = ctx
            except Exception:
                pass

def parse_name(nm):
    m = re.match(r"(?:final_)?state_(\d+)_(.+?)_\d+_[0-9A-Fa-f-]{8,}\.png$", nm)
    if m:
        return int(m.group(1)), m.group(2).replace("_", " ").strip()
    if nm.startswith("final_state"):
        return 10**9, "final state"
    return -1, os.path.splitext(nm)[0]

entries = []  # (path, title, action, settled)
manifest = os.path.join(outdir, "manifest.json")
if os.path.exists(manifest):
    try:
        data = json.load(open(manifest))
        for test in data if isinstance(data, list) else []:
            for att in test.get("attachments", []):
                fn = att.get("exportedFileName"); nm = att.get("suggestedHumanReadableName") or fn or ""
                if not (fn and fn.lower().endswith(".png")):
                    continue
                action, title = parse_name(nm)
                st = settled_by_action.get(action, True)
                entries.append((os.path.join(outdir, fn), title, action, st))
    except Exception:
        pass
if not entries:
    entries = [(p, "Screen %d" % (i + 1), -1, True)
               for i, p in enumerate(sorted(glob.glob(os.path.join(outdir, "*.png"))))]

# One representative per title. mode=prefer upgrades an unsettled pick to a settled one.
best = {}  # title -> [path, settled, order, action]
order = 0
for path, title, action, st in sorted(entries, key=lambda e: e[2] if e[2] >= 0 else 10**9):
    if title.lower() in ("unknown", ""):
        continue
    order += 1
    if title in best:
        if mode == "prefer" and (not best[title][1]) and st:
            best[title][0] = path; best[title][1] = True; best[title][3] = action
    else:
        best[title] = [path, st, order, action]

chosen = sorted(best.items(), key=lambda kv: kv[1][2])[:maxs]
tmap = json.load(open(tmpath)) if os.path.exists(tmpath) else {}
smap = json.load(open(smpath)) if os.path.exists(smpath) else {}
paths = []
for title, (path, st, _o, action) in chosen:
    paths.append(path)
    tmap[os.path.basename(path)] = ("%s: %s" % (app, title)) + ("" if st else " [unsettled]")
    smap[os.path.basename(path)] = summary_by_action.get(action, "")
json.dump(tmap, open(tmpath, "w"))
json.dump(smap, open(smpath, "w"))
print("\n".join(paths))
PY
)"
  CNT=0
  while IFS= read -r line; do [ -n "$line" ] && { ALL_PNGS+=("$line"); CNT=$((CNT+1)); }; done <<< "$SELECTED"
  printf "  %-32s %s distinct screen(s) captured\n" "$APP" "$CNT"
done

[ ${#ALL_PNGS[@]} -eq 0 ] && { echo "❌ No screenshots captured — is the harness built and are apps installed?"; exit 2; }

echo ""
echo "Reviewing ${#ALL_PNGS[@]} distinct screen(s) with the vision model..."
python3 "$ROOT/scripts/vision_fp_probe.py" --title-map "$TITLE_MAP" --summary-map "$SUMMARY_MAP" "${ALL_PNGS[@]}" > "$REPORT"

python3 -c '
import sys, json
d = json.load(open(sys.argv[1]))
print("")
print("  reviewed screens : %d" % d["reviewed"])
print("  succeeded calls  : %d" % d["succeeded"])
if d.get("errors"):
    print("  ⚠️  FAILED calls  : %d  (e.g. %s)" % (d["errors"], (d.get("first_error") or "")[:70]))
    print("      Failed calls are NOT clean screens — fix connectivity and re-run before trusting the rate.")
print("  flagged screens  : %d" % d["flagged"])
print("  total findings   : %d  (by severity: %s)" % (d["findings_total"], d["by_severity"]))
rate = d["fp_rate_screens"]
print("  screen flag rate : %s  (over succeeded calls; on a visually-clean corpus this ~= false-positive rate)" % ("n/a" if rate is None else "%.1f%%" % (100*rate)))
if d["flagged"]:
    print("\n  flagged (inspect each — real defect or false positive?):")
    for img in d["images"]:
        for f in img["findings"]:
            print("    - [%s/%s] %s — %s :: %s" % (f["severity"], f["category"], img["title"], f["title"], f["detail"][:80]))
' "$REPORT"
echo ""
echo "Report: $REPORT"
