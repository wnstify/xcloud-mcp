# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-01

Initial public release. A local, stdio-only MCP server that lets an AI agent
manage your own xCloud servers and sites through a curated, typed tool set —
with your Personal Access Token as the real safety boundary.

### Added

- **36 curated tools** across three access classes:
  - **25 read tools** — servers, health, metrics history, services, firewall
    rules, SSH restriction status, banned IPs, PHP versions, sites, domains,
    vulnerabilities, WordPress updates/status/extensions, backups and backup
    status, logs, cron jobs and output, PageSpeed, cache settings, SSL, and
    `whoami`.
  - **7 safe-write tools** — `create_backup`, `run_vulnerability_scan`,
    `run_pagespeed_scan`, `purge_cache`, `apply_wordpress_updates`,
    `activate_wordpress_extensions`, `magic_login`.
  - **4 destructive tools** — `reboot_server`, `restart_service`,
    `delete_firewall_rule`, `delete_cron_job`. Hidden unless
    `XCLOUD_ENABLE_DESTRUCTIVE=true`, confirmed per call, and fail closed when
    no confirmation channel exists.
- **Team isolation** — every call is scoped to the token's team; the PAT scope
  is the hard limit on what any tool can do.
- **Secret redaction** — a central egress net strips credential-bearing fields
  from every tool result and scrubs the PAT from anything the process writes.
- **Credential-helper support** — resolve the PAT from `XCLOUD_API_TOKEN` or
  from an `XCLOUD_TOKEN_CMD` command (run once via `execFile`, no shell), so
  your existing secret store owns the token.
- **Resilient API client** — honours `Retry-After` on 429, maps xCloud's
  non-REST status conventions to clear token-free errors, and normalizes
  empty (`data: null`) responses to typed empty collections.
- **Input validation at the seam** — Zod schemas cap and constrain every tool
  argument before any HTTP call.

### Security

- Destructive operations gated behind explicit opt-in plus per-call
  confirmation (MCP elicitation), failing closed by default.
- No bundled secret store and no remote/multi-tenant mode by design — the
  server runs locally over stdio only.

[1.0.0]: https://github.com/wnstify/xcloud-mcp/releases/tag/v1.0.0
