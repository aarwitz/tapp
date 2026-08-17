# Contributing to tapp

## The 60-second architecture

```
Harness/ExplorerTests.swift            ← the fingers: a generic XCUITest that drives any app
        ↑ OCQA_* marker protocol (stdout lines — the platform seam)
mcp-server/src/                        ← the brain: sessions, exploration orchestration, the gate,
                                          regression, target resolution, formatting
        ↑
bin/tapp.js (CLI) · `tapp mcp` (MCP) · the VS Code extension     ← the mouths
```

One engine, several surfaces: the CLI imports the engine's exported functions, and MCP
serves the same functions as tools. Fix behavior in the engine or the harness — never in a
surface — and every consumer gets it.

## Developing

```bash
npm install
npm test          # gate/regression unit tests, engine import-safety, CLI + MCP smoke
```

The harness rebuilds automatically when its source changes (content-fingerprinted cache in
`~/.tapp/harness-derived`). To exercise the full pipeline you need macOS + Xcode with a
simulator runtime; the fastest end-to-end check is `node bin/tapp.js explore <bundleId>` against
any installed app.

## About this repository's history

This public repo is a curated mirror of a private development repo (the private history
contains client-specific material that can't be published). Public commits carry the
upstream commit's subject line, and CHANGELOG.md tracks what changed per release. PRs are
welcome here — a maintainer folds accepted changes upstream and credits you in the synced
commit.

## Expectations for changes

- Engine or harness behavior changes need a test (deterministic parts) or a demonstrated
  run (exploration parts — paste the relevant output in the PR).
- The gate's invariants are non-negotiable: exploration observes (no verdict/score) and the gate
  judges `pass`/`fail`/`inconclusive`; the same evidence + contracts + baseline → the same gate
  outcome; a shallow run is `inconclusive`, never a pass; no LLM in the decision loop; typed secrets never appear
  in transcripts, logs, or tool results.
- Exploration is adaptive; don't write tests that assume a fixed traversal path.
