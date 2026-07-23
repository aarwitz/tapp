#!/usr/bin/env python3
"""Parse harness logs and score mutation-recall (companion to mutation_operators.py).

SKETCH / WIP. Reuses the exact marker-parse shape as validation-matrix.sh / coverage_eval_parse.py
so "caught" means the same thing the product's regression gate means: a finding matched by
`type|screen` (see mcp-server/src/report.js computeRegression, matched by type|screen).

Two subcommands:
  parse  <log>                       -> {"screens":[...], "findings":[["type","screen"],...]}
  report <records.json>              -> human table + machine JSON of the recall decomposition
"""
import sys, re, json


def parse_log(path):
    """-> (set of reached screen names, set of (type, screen) finding keys)."""
    screens, findings = set(), set()
    for line in open(path, encoding="utf-8", errors="replace").read().splitlines():
        m = re.search(r"OCQA_STATE:(\{.*\})", line)
        if m:
            try:
                s = (json.loads(m.group(1)).get("screen") or "").strip()
                if s and s not in ("Unknown", "pending"):
                    screens.add(s)
            except Exception:
                pass
            continue
        m = re.search(r"OCQA_ISSUE:(\{.*\})", line)
        if m:
            try:
                d = json.loads(m.group(1))
                findings.add((d.get("type", "unknown"), (d.get("screen") or "").strip()))
            except Exception:
                pass
    return screens, findings


def score_mutant(injection, baseline_findings, runs):
    """injection: {expected_type, screen, in_taxonomy, ...}
       baseline_findings: set of (type,screen) seen on the CLEAN build (union across baseline runs)
       runs: list of (screens_set, findings_set) — one per repeated run of THIS mutant

    Returns a record with the coverage-vs-detection decomposition, per run and rolled up."""
    scr, typ = injection["screen"], injection["expected_type"]
    key = (typ, scr)

    reached_any = any(scr in s for s, _ in runs)
    # absolute: expected finding present on the mutant (in-taxonomy only — out-of-taxonomy has no
    # expected type, so its only hope is a *differential* finding of any type at the screen).
    def caught_abs(findings):
        if typ is not None:
            return key in findings
        return any(s == scr for _, s in findings)   # any finding at the injected screen
    # differential: caught AND not already in the clean baseline (the real gate signal)
    def caught_diff(findings):
        if typ is not None:
            return key in findings and key not in baseline_findings
        return any(s == scr and (t, s) not in baseline_findings for t, s in findings)

    abs_hits = [caught_abs(f) for _, f in runs]
    diff_hits = [caught_diff(f) for _, f in runs]
    return {
        **{k: injection[k] for k in ("file", "op", "bug_class", "expected_type", "in_taxonomy", "screen")},
        "reached": reached_any,
        "caught_abs_any": any(abs_hits), "caught_abs_all": all(abs_hits),
        "caught_diff_any": any(diff_hits), "caught_diff_all": all(diff_hits),
        "runs": len(runs),
    }


def _rate(num, den):
    return f"{(100*num/den):5.1f}%  ({num}/{den})" if den else "   n/a"


def report(records):
    def bucket(recs, label):
        n = len(recs)
        reached = sum(r["reached"] for r in recs)
        caught = sum(r["caught_diff_any"] for r in recs)          # headline = differential (gate signal)
        detect = sum(r["caught_diff_any"] for r in recs if r["reached"])
        print(f"\n{label}  (n={n})")
        print(f"  recall (caught / all)          {_rate(caught, n)}")
        print(f"  reach_rate (coverage)          {_rate(reached, n)}")
        print(f"  detect|reached (detection)     {_rate(detect, reached)}")

    in_tax = [r for r in records if r["in_taxonomy"]]
    out_tax = [r for r in records if not r["in_taxonomy"]]

    print("=" * 64)
    print("MUTATION-RECALL BENCHMARK  —  differential (gate-equivalent) catch")
    print("=" * 64)
    bucket(records, "OVERALL")
    bucket(in_tax, "IN-TAXONOMY   (detector exists — should be HIGH)")
    bucket(out_tax, "OUT-OF-TAXONOMY (no detector — the honest CEILING)")

    print("\nPer class (in-taxonomy):")
    classes = {}
    for r in in_tax:
        classes.setdefault(r["op"], []).append(r)
    for op, recs in sorted(classes.items()):
        c = sum(x["caught_diff_any"] for x in recs)
        print(f"  {op:18s} {_rate(c, len(recs))}   expects OCQA_ISSUE.type={recs[0]['expected_type']}")

    print("\nMisses that REACHED the screen but weren't detected (need a detector/oracle):")
    for r in records:
        if r["reached"] and not r["caught_diff_any"]:
            tag = "in-tax" if r["in_taxonomy"] else "OUT"
            print(f"  [{tag}] {r['op']:16s} {r['screen']:16s} {r['bug_class']}")

    summary = {
        "overall_recall": sum(r["caught_diff_any"] for r in records) / max(len(records), 1),
        "in_taxonomy_recall": sum(r["caught_diff_any"] for r in in_tax) / max(len(in_tax), 1),
        "out_taxonomy_recall": sum(r["caught_diff_any"] for r in out_tax) / max(len(out_tax), 1),
        "n": len(records),
    }
    print("\nJSON:", json.dumps(summary))
    return summary


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "parse":
        scr, fnd = parse_log(sys.argv[2])
        print(json.dumps({"screens": sorted(scr), "findings": sorted(map(list, fnd))}))
    elif cmd == "report":
        report(json.load(open(sys.argv[2])))
    else:
        print(__doc__); sys.exit(2)
