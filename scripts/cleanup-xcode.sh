#!/usr/bin/env bash
# Reclaim disk space consumed by Xcode build artifacts.
#
# Default run (no flags): deletes unavailable simulators and stale DerivedData
# from unrelated projects.  Flags unlock more aggressive passes.
#
# Usage:
#   scripts/cleanup-xcode.sh              # safe defaults
#   scripts/cleanup-xcode.sh --dry-run    # preview only, nothing deleted
#   scripts/cleanup-xcode.sh --device-support  # also wipe iOS DeviceSupport caches
#   scripts/cleanup-xcode.sh --all        # everything above + Xcode caches
#
# AutoTap-related DerivedData (OCQAHarness, DemoApp, LoginDemo, etc.) is always
# preserved.  The local build/ directory in this repo is never touched.
set -uo pipefail

DRY_RUN=0
CLEAN_DEVICE_SUPPORT=0
CLEAN_ALL=0

for arg in "$@"; do
    case "$arg" in
        --dry-run)        DRY_RUN=1 ;;
        --device-support) CLEAN_DEVICE_SUPPORT=1 ;;
        --all)            CLEAN_DEVICE_SUPPORT=1; CLEAN_ALL=1 ;;
        -h|--help)
            sed -n '/^# /s/^# //p' "$0" | head -15
            exit 0 ;;
        *) echo "Unknown flag: $arg  (try --help)"; exit 1 ;;
    esac
done

DERIVED="$HOME/Library/Developer/Xcode/DerivedData"
SIMS="$HOME/Library/Developer/CoreSimulator/Devices"
DEVICE_SUPPORT="$HOME/Library/Developer/Xcode/iOS DeviceSupport"
XCODE_CACHES="$HOME/Library/Caches/com.apple.dt.Xcode"

# Projects to preserve in DerivedData (all AutoTap-related build products).
KEEP_PREFIXES=("AutoTap" "OCQAHarness" "DemoApp" "LoginDemo" "WizardDemo"
               "ShopDemo" "RestaurantDemo" "SymbolCache")

hr() { printf '%0.s─' {1..60}; echo; }
human() { du -sh "$1" 2>/dev/null | cut -f1; }

run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "  [dry-run] $*"
    else
        eval "$@"
    fi
}

echo ""
hr
echo "  Xcode Cleanup  $(date '+%Y-%m-%d %H:%M')"
[[ $DRY_RUN -eq 1 ]] && echo "  DRY RUN — nothing will be deleted"
hr

# ── Before snapshot ──────────────────────────────────────────────────────────
echo ""
echo "Before:"
printf "  %-38s %s\n" "CoreSimulator/Devices"  "$(human "$SIMS")"
printf "  %-38s %s\n" "Xcode/DerivedData"      "$(human "$DERIVED")"
printf "  %-38s %s\n" "Xcode/iOS DeviceSupport" "$(human "$DEVICE_SUPPORT")"
printf "  %-38s %s\n" "Xcode caches"            "$(human "$XCODE_CACHES")"
echo ""

# ── 1. Unavailable simulators ─────────────────────────────────────────────────
echo "1/3  Removing unavailable simulators …"
UNAVAIL=$(xcrun simctl list devices --json 2>/dev/null | \
    python3 -c '
import sys, json
d = json.load(sys.stdin)
n = sum(1 for v in d["devices"].values() for x in v if not x.get("isAvailable", True))
print(n)
')
echo "     Found $UNAVAIL unavailable device(s)."
if [[ "$UNAVAIL" -gt 0 ]]; then
    run "xcrun simctl delete unavailable"
fi

# ── 2. Unrelated DerivedData ──────────────────────────────────────────────────
echo ""
echo "2/3  Scanning DerivedData for unrelated projects …"
STALE=()
if [[ -d "$DERIVED" ]]; then
    while IFS= read -r -d '' entry; do
        base="$(basename "$entry")"
        keep=0
        for prefix in "${KEEP_PREFIXES[@]}"; do
            if [[ "$base" == "$prefix"* ]]; then
                keep=1; break
            fi
        done
        [[ $keep -eq 0 ]] && STALE+=("$entry")
    done < <(find "$DERIVED" -maxdepth 1 -mindepth 1 -type d -print0)
fi

if [[ ${#STALE[@]} -eq 0 ]]; then
    echo "     Nothing to remove."
else
    echo "     Will remove ${#STALE[@]} unrelated build folder(s):"
    for entry in "${STALE[@]}"; do
        printf "       %-8s %s\n" "$(human "$entry")" "$(basename "$entry")"
    done
    for entry in "${STALE[@]}"; do
        run "rm -rf \"$entry\""
    done
fi

# ── 3. iOS DeviceSupport (optional) ──────────────────────────────────────────
echo ""
echo "3/3  iOS DeviceSupport …"
if [[ $CLEAN_DEVICE_SUPPORT -eq 1 ]]; then
    if [[ -d "$DEVICE_SUPPORT" ]]; then
        echo "     Removing $(human "$DEVICE_SUPPORT") of device symbol caches …"
        echo "     (Xcode re-downloads these automatically when a device is connected.)"
        run "rm -rf \"$DEVICE_SUPPORT\""
    else
        echo "     Directory not found — nothing to do."
    fi
else
    SIZE=$(human "$DEVICE_SUPPORT")
    echo "     Skipped ($SIZE on disk). Pass --device-support to remove."
fi

# ── 4. Xcode caches (--all only) ─────────────────────────────────────────────
if [[ $CLEAN_ALL -eq 1 ]]; then
    echo ""
    echo "4/4  Xcode caches …"
    if [[ -d "$XCODE_CACHES" ]]; then
        echo "     Removing $(human "$XCODE_CACHES") …"
        run "rm -rf \"$XCODE_CACHES\""
    fi
fi

# ── Simulator data cache (always safe) ───────────────────────────────────────
SIM_CACHES="$HOME/Library/Developer/CoreSimulator/Caches"
if [[ -d "$SIM_CACHES" ]] && [[ "$(du -sk "$SIM_CACHES" 2>/dev/null | cut -f1)" -gt 0 ]]; then
    echo ""
    echo "     Removing simulator caches ($(human "$SIM_CACHES")) …"
    run "rm -rf \"$SIM_CACHES\""
fi

# ── After snapshot ─────────────────────────────────────────────────────────────
echo ""
if [[ $DRY_RUN -eq 0 ]]; then
    hr
    echo "After:"
    printf "  %-38s %s\n" "CoreSimulator/Devices"   "$(human "$SIMS")"
    printf "  %-38s %s\n" "Xcode/DerivedData"       "$(human "$DERIVED")"
    printf "  %-38s %s\n" "Xcode/iOS DeviceSupport"  "$(human "$DEVICE_SUPPORT")"
    printf "  %-38s %s\n" "Xcode caches"             "$(human "$XCODE_CACHES")"
    echo ""
fi

echo "Done."
