# Security

## Secrets

Use session-only API keys whenever possible. Writer never writes provider keys
to project folders, exports, revisions, privacy receipts, or backups. Browser
storage is not an operating-system keychain and should not be used for secrets
on shared machines.

Never paste access tokens into issues, pull requests, commits, chat messages,
or test fixtures. Revoke any credential that has been disclosed.

## Reporting

Report vulnerabilities privately to the repository owner. Include the affected
version, reproduction steps, impact, and whether source files or credentials
may be exposed.
