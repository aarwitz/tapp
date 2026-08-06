# Security

## Reporting

Please report suspected vulnerabilities privately via GitHub Security Advisories
(Security → Report a vulnerability) rather than public issues.

## Posture

- **Core is local.** Exploration, evidence collection, and verdict calculation run
  entirely on your Mac — no telemetry, no phoning home.
- **Remote AI is explicit, never ambient.** Optional AI features send selected finding
  metadata (app label, screen names, finding types/titles) to your configured model
  provider. Post-run finding enrichment requires `TAPP_ENABLE_REMOTE_AI=1` — the mere
  presence of an `ANTHROPIC_API_KEY` in your shell never silently enables it. Explicitly
  invoked AI tools (`tapp_flow_generate`, `assert_ai` steps) carry their own consent by
  being called. Screenshots and recordings never leave your machine.
- **Credentials**: test credentials passed to runs are typed into the app under test and
  never echoed into tool results, transcripts, or logs. `tapp actor set` and MCP
  `tapp_actor_config` accept only credential-to-environment-variable bindings;
  `.autotap/project.json`, the application model, plan, and CI manifest contain names such as
  `ALICE_EMAIL`, never resolved values. Generated GitHub jobs read same-named repository Secrets
  into the Action environment. The VS Code extension stores remembered values in VS Code
  SecretStorage (OS keychain), never plaintext files.
- **Tokens**: when `AUTOTAP_MCP_TOKEN`/`TAPP_MCP_TOKEN` is set, all mutating MCP tools
  require it.
