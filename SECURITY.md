# Security

## Reporting

Please report suspected vulnerabilities privately via GitHub Security Advisories
(Security → Report a vulnerability) rather than public issues.

## Posture

- **This policy describes the local and portable product.** Exploration, evidence collection, and
  verdict calculation run on your machine or your selected CI runner—no Tapp telemetry or ambient
  Tapp service calls.
- **No production hosted service yet.** The hosted application is under development. Do not upload
  private repositories, credentials, or customer data to a legacy preview. The future SaaS will
  publish a separate data-flow, retention, subprocessors, and incident-response policy before
  accepting customer repositories.
- **Remote AI is explicit, never ambient.** Optional AI features send selected finding
  metadata (app label, screen names, finding types/titles) to your configured model
  provider. Post-run finding enrichment requires `TAPP_ENABLE_REMOTE_AI=1` — the mere
  presence of an `ANTHROPIC_API_KEY` in your shell never silently enables it. Explicitly
  invoked AI tools (`tapp_flow_generate`, `assert_ai` steps) carry their own consent by
  being called. The local product does not upload screenshots or recordings to Tapp; a model-backed
  feature that sends an image must disclose that payload and require explicit invocation/consent.
- **Credentials**: test credentials passed to runs are typed into the app under test and
  never echoed into tool results, transcripts, or logs. `tapp actor set` and MCP
  `tapp_actor_config` accept only credential-to-environment-variable bindings;
  `.autotap/project.json`, the application model, plan, and CI manifest contain names such as
  `ALICE_EMAIL`, never resolved values. Generated GitHub jobs read same-named repository Secrets
  into the Action environment. The VS Code extension stores remembered values in VS Code
  SecretStorage (OS keychain), never plaintext files.
- **Tokens**: when `TAPP_MCP_TOKEN` is set, all mutating MCP tools
  require it.
