# Security

## Reporting

Please report suspected vulnerabilities privately via GitHub Security Advisories
(Security → Report a vulnerability) rather than public issues.

## Posture

- **Everything runs locally.** tapp drives your simulator on your Mac; no telemetry, no
  phoning home, nothing leaves your machine.
- **Credentials**: test credentials passed to runs are typed into the app under test and
  never echoed into tool results, transcripts, or logs. The VS Code extension stores
  remembered values in VS Code SecretStorage (OS keychain), never plaintext files.
- **Tokens**: when `AUTOTAP_MCP_TOKEN`/`TAPP_MCP_TOKEN` is set, all mutating MCP tools
  require it.
