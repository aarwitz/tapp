# Browser Release Studio

Status: current local-product contract as of 2026-08-08.

The browser Release Studio is an **optional local workspace**, not the current launch surface — the
**npm package (CLI + MCP + the GitHub Action) is the current objective** (ADR-0005). The Studio, the
VS Code extension, the desktop app, and the future managed SaaS are separate/paused tracks. Web is
also one application target beside iOS and Android; it is not a separate QA product. CLI, MCP, VS
Code, the Action, desktop, and future managed SaaS all adapt the shared product operations described
in [`PRODUCT-ENGINE.md`](PRODUCT-ENGINE.md).

## Start locally

```bash
npx -y @aarwitz/tapp@latest app
```

Tapp prints an authenticated one-time launch URL and opens it in the default browser. Use
`--no-open` when copying the URL manually and `--port 4317` only when a fixed loopback port is
needed. Drag/drop or Browse Folder copies source into a Tapp-owned workspace. Connect GitHub lists
repositories authorized to the local `gh` session and makes a shallow isolated clone.
`tapp app /path/to/repo` intentionally works directly in that checkout.

The local server binds to `127.0.0.1`. It owns workspace paths; browser requests cannot submit an
arbitrary server path. Mutations require an `HttpOnly` same-site session cookie, the exact local
Origin, and an in-memory CSRF token. Application runtimes, repository credentials, and evidence stay
in the local process/filesystem. This is a local trust boundary, not hosted multi-tenancy.

## Product journey

1. **Connect** a copied folder, an explicit checkout, or a repository authorized by local `gh`.
2. **Detect and choose** an iOS, Android, or web target. Continue automatically only when the target
   and configuration are conclusive.
3. **Build, launch, and explore** the real simulator, emulator/device, or browser surface.
4. **Understand the UI Map** through observed states, transitions, controls, provenance, and gaps.
5. **Review intent** by approving, rejecting, deferring, or constraining a compact release plan.
6. **Generate drafts** of Tasks and contracts. Drafts remain visibly untrusted.
7. **Validate** approved drafts deterministically against the real target.
8. **Promote** only validated artifacts into the canonical suite and refreshed Application Model.
9. **Gate** with autonomous evidence plus the promoted deterministic suite.
10. **Baseline** only a passing, conclusive, target-scoped gate.
11. **Install CI** by previewing and writing a reviewable repository patch. Tapp does not commit,
    push, create GitHub secrets, or enable branch protection.

Successful semantic actions can be saved in `.tapp/flows/`; credential values are templated to
environment references. Long-lived repository artifacts store binding names, not resolved secret
values.

## Verified reference journey

`tests/browser-journey.test.js` drives the visible local browser against a fresh CommerceDemo copy.
It exercises startup, a real live web surface and semantic action, UI Map creation, Flow recording
and replay, proposal review, generation, deterministic validation, promotion, a first gate,
baseline-aware rerun, and CI preview.

The opt-in `tests/browser-native-journey.test.js` passed on 2026-08-06 against a booted iOS
simulator: the browser built and installed a disposable DemoApp checkout, ran shared target
preparation and exploration, rendered an observed UI Map, drove the live surface, and saved a
repository-native iOS Flow. The equivalent Android browser journey was not verified in that audit
because no emulator/device was connected.

This evidence proves representative local journeys. It does not prove arbitrary frameworks,
production credentials, third-party services, hosted execution, or complete inference of business
intent.

## Hosted relationship

The future hosted application will present the same product journey through a different adapter: application
accounts/organizations, GitHub App repository authorization, private storage, a durable queue, and
isolated managed workers. It cannot reuse the loopback session, local `gh` authority, filesystem
boundary, or in-memory ownership assumptions.

The old hosted preview and `cloud/` prototype do not satisfy this boundary. The managed SaaS is a
separate, paused track (see the private source repository); do not market or accept private
repositories until its readiness gate passes.
