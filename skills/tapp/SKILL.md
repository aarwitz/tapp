---
name: tapp
description: Use Tapp to see, drive, explore, and verify real application surfaces on iOS simulators, Android emulators/devices, or the web. Use when a user asks an agent to test an app or UI change, find bugs, inspect or screenshot a screen, exercise a journey, create a replayable flow, gather release evidence, or run the deterministic Tapp gate. Also use when the user mentions Tapp, @aarwitz/tapp, tapp_* tools, .tapp artifacts, or asks whether agent-authored UI actually works.
---

# Tapp

Use Tapp as the app's hands and eyes. Work on the real UI surface and show evidence; do not claim a
screen or journey works from source inspection alone.

## Choose the smallest operation

| Intent | Operation |
|---|---|
| See or screenshot one screen | `open` / `tapp_open_app` |
| Inspect controls on the current screen | `tree` / `tapp_ui_tree` |
| Drive a specific journey | MCP session start → act → end |
| Find bugs autonomously | `explore` / `tapp_explore` |
| Preserve a journey | record and save a Flow; replay it deterministically |
| Decide whether a merge passes policy | `ci`; exploration never decides this |

Prefer connected `tapp_*` MCP tools when available: they keep interactive sessions alive and return
screenshots inline. Otherwise run `npx -y @aarwitz/tapp@latest` from the app repository. Do not require MCP,
an account, an API key, or a global install for the core workflow.

## Start source-connected

When the user asks for a general first test of a repository:

1. If `.tapp/application-model.json` exists, run `npx -y @aarwitz/tapp@latest explore`.
2. Otherwise run `npx -y @aarwitz/tapp@latest init . --explore` or call `tapp_init` with
   `{operation:"explore", projectDir:"."}`.
3. If Tapp returns `target-selection-required`, present its actual choices and ask the user to pick.
   Never guess among multiple targets. Re-run with the selected platform/target exactly as Tapp
   instructs.
4. If a prerequisite is missing, call `tapp_health` when MCP is connected or run
   `npx -y @aarwitz/tapp@latest doctor`, apply only the stated remediation that is in scope, and
   retry once.

For a focused request, use the requested target directly rather than forcing repository onboarding.
Targets may be a repository path, Xcode container, `.app`, iOS bundle id, APK plus Android app id,
or owned HTTP(S) URL. Never explore a third-party web property without authorization: exploration
clicks and types.

## Observe honestly

Exploration returns findings, coverage, evidence, and `inconclusive`; it does not return a score or
ship verdict. Report:

- target and platform;
- screens/actions and whether coverage was conclusive;
- deterministic versus advisory finding counts;
- each important finding and its evidence/report path;
- what Tapp explicitly did not check.

If `inconclusive: true`, explain the blocker. A login wall or missing test data is not a pass. Ask for
credentials or launch configuration instead of rerunning blindly. Do not infer content accuracy,
privacy, brand consistency, or business guarantees from a generic crawl; those require a reviewed
Flow, Scenario, contract, verifier, or human review.

When a screenshot path is printed, open it with the client's image-reading tool before describing
the screen. For web, use `--watch` when the human wants to follow Tapp's controlled browser. For iOS,
point the human to the report's exploration recording when available.

## Drive safely

For an interactive MCP session, read returned `elements[]` before every action, target accessibility
ids or visible labels, check `hittable`, tap a field before typing, and wait for navigation or async
content. Use coordinates only as a last resort. End the session when finished.

Do not edit the app merely because testing found a defect unless the user also asked for a fix. State
what the evidence proves and what remains untested.

Read [references/commands.md](references/commands.md) only when exact CLI/MCP syntax, Flow replay,
credentials, or platform prerequisites are needed.
