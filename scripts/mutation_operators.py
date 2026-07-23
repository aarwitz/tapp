#!/usr/bin/env python3
"""Mutation operators for the mutation-recall benchmark (scripts/mutation-recall.sh).

SKETCH / WIP — grounded in the real corpus (SwiftUI source in <App>/Sources/*.swift) and the
real detector taxonomy (the OCQA_ISSUE `type` values the harness emits). Each operator injects
ONE seeded fault and declares the ground truth: which detector *class* it should trip (or None
if no detector exists for it). That in/out-of-taxonomy split is the whole point — see
docs/COMPETITIVE-MAP.md §0.

LIMITATIONS (honest):
  - Regex/line transforms, not a real Swift AST. Robust version: swiftsyntax, one mutant per
    (operator, matched node). Here we take the FIRST matching site per (operator, file).
  - Screen attribution is heuristic (nearest .navigationTitle above the site). The fiddliest
    part of honest matching; a wrong screen name shows up as a coverage miss, not a detect miss.

Usage:
  mutation_operators.py list  <App/Sources>              -> JSON array of applicable sites
  mutation_operators.py apply <file> <op_id>  (in place; caller backs up + restores)
"""
import sys, re, json, glob, os
from dataclasses import dataclass
from typing import Callable, Optional


@dataclass
class Op:
    id: str
    bug_class: str            # human label for the fault
    expected_type: Optional[str]  # OCQA_ISSUE `type` a detector should emit; None => out-of-taxonomy
    in_taxonomy: bool
    find: str                 # regex that identifies an applicable site
    apply: Callable[[str], str]  # src -> mutated src (mutates the FIRST match only)


def _sub_first(pattern, repl, src, flags=re.S):
    return re.sub(pattern, repl, src, count=1, flags=flags)


OPS = [
    # ---------- IN-TAXONOMY: a detector class exists; measures "do we catch what we claim?" ----------
    # Skips labels the harness's isSelectionOrValueControl deliberately EXCLUDES from dead-control
    # detection (increment/decrement — steppers legitimately no-op at boundaries). Measured: a
    # gutted 'Decrement' is invisible 4/4 runs BY DESIGN (the FP guard), so mutating it measures
    # the documented precision/recall trade, not the detector. This operator measures what the
    # detector claims to catch; a future dead_stepper op can price the known gap explicitly.
    Op("dead_button", "button action gutted (dead control)", "unresponsive_element", True,
       r'Button\("(?![^"]*(?:ncrement|ecrement))([^"]+)"\)\s*\{.*?\}',
       lambda s: _sub_first(r'(Button\("(?![^"]*(?:ncrement|ecrement))[^"]+"\)\s*\{).*?(\})',
                            r'\1 /* MUT: no-op */ \2', s)),

    Op("infinite_spinner", "loading flag never cleared (perpetual spinner)", "app_hang", True,
       r'(isLoading|loaded|isReady)\s*=\s*false',   # the line that would END loading
       lambda s: _sub_first(r'((?:isLoading|loaded|isReady)\s*=\s*false)', r'/* MUT */ // \1', s)),

    # NOTE: must attach to a view that actually RENDERS. The first sketch inserted
    # `let _mut = Text(...)` after `var body {` — a local never added to the view tree, so the
    # "fault" was invisible to the a11y tree and the benchmark misread it as a detector miss.
    # Overlaying the .navigationTitle-bearing view guarantees the error text is really on screen.
    Op("inject_error", "always-visible error surface", "error_surface", True,
       r'\.navigationTitle\("[^"]+"\)',
       lambda s: _sub_first(r'(\.navigationTitle\("[^"]+"\))',
                            r'\1.overlay(Text("Something went wrong. Error 500.")) /* MUT */', s)),

    Op("broken_nav", "NavigationLink destination blanked", "blank_screen", True,
       r'NavigationLink\s*\{[^}]*\}',
       lambda s: _sub_first(r'(NavigationLink\s*\{)[^}]*(\})', r'\1 EmptyView() /* MUT */ \2', s)),

    # Same inert-let lesson as inject_error: fatalError must live inside a closure that FIRES.
    # Injecting into an existing .task/.onAppear guarantees it runs when the screen appears.
    Op("crash_on_appear", "fatalError on screen appear", "crash", True,
       r'\.(?:task|onAppear)\s*\{',
       lambda s: _sub_first(r'(\.(?:task|onAppear)\s*\{)',
                            r'\1 fatalError("MUT crash"); ', s)),

    # ---------- OUT-OF-TAXONOMY: no detector; measures the CEILING of deterministic detection ----------
    # These should score ~0. That number is the argument for regression-diff + oracle/Flows.
    Op("mislabel_button", "button label typo (still works, wrong text)", None, False,
       r'Button\("[A-Za-z]{4,}"\)',
       lambda s: _sub_first(r'Button\("([A-Za-z])([A-Za-z])([A-Za-z]+)"\)',
                            r'Button("\2\1\3")', s)),   # transpose first two letters

    Op("wrong_arithmetic", "arithmetic operator flipped (wrong number, UI fine)", None, False,
       r'\w+\s*\+\s*\w+',
       lambda s: _sub_first(r'(\w+)\s*\+\s*(\w+)', r'\1 - \2', s)),

    # Skip `Enum.allCases` sites (static pickers/segments) so the mutation lands on real DATA
    # (e.g. ForEach(filteredItems)) — dropping the last row of a data list is the silent-loss
    # bug this operator exists to model; dropping the last segment of a picker is much weaker.
    Op("off_by_one", "list drops its last row (silent data loss)", None, False,
       r'ForEach\((?![A-Za-z_][\w\.]*\.allCases\))([A-Za-z_][\w\.]*)\)',
       lambda s: _sub_first(r'ForEach\((?![A-Za-z_][\w\.]*\.allCases\))([A-Za-z_][\w\.]*)\)',
                            r'ForEach(\1.dropLast())', s)),

    Op("swap_fields", "two field bindings swapped (wrong wiring)", None, False,
       r'TextField\(',   # NOTE: real swap needs 2 sites; sketch marks it, apply is a TODO
       lambda s: s),  # TODO: locate two adjacent TextField bindings and swap $values
]

OPS_BY_ID = {o.id: o for o in OPS}


def infer_screen(src: str, upto: int) -> str:
    """Nearest .navigationTitle("X") at or above char offset `upto` — the harness names screens
    by nav title, so this is our ground-truth screen for match. Fallback: last title in file."""
    titles = [(m.start(), m.group(1)) for m in re.finditer(r'\.navigationTitle\("([^"]+)"\)', src)]
    above = [t for pos, t in titles if pos <= upto] or [t for _, t in titles]
    return above[-1] if above else "?"


def list_sites(sources_dir: str):
    sites = []
    for path in sorted(glob.glob(os.path.join(sources_dir, "*.swift"))):
        src = open(path, encoding="utf-8", errors="replace").read()
        for op in OPS:
            m = re.search(op.find, src, flags=re.S)
            if not m:
                continue
            sites.append({
                "file": path, "op": op.id, "bug_class": op.bug_class,
                "expected_type": op.expected_type, "in_taxonomy": op.in_taxonomy,
                "screen": infer_screen(src, m.start()),
            })
    return sites


def apply(path: str, op_id: str) -> bool:
    op = OPS_BY_ID[op_id]
    src = open(path, encoding="utf-8", errors="replace").read()
    mutated = op.apply(src)
    if mutated == src:
        return False   # no-op (e.g. swap_fields TODO) — caller skips
    open(path, "w", encoding="utf-8").write(mutated)
    return True


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "list":
        print(json.dumps(list_sites(sys.argv[2]), indent=2))
    elif cmd == "apply":
        ok = apply(sys.argv[2], sys.argv[3])
        sys.exit(0 if ok else 3)
    else:
        print(__doc__); sys.exit(2)
