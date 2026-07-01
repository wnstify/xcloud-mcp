# Roadmap

This roadmap describes what `xcloud-mcp` intends to do, and explicitly not do, over roughly the next year. It is a statement of direction, not a commitment to dates; priorities shift with maintainer capacity and security needs. Live planning happens in [GitHub issues](https://github.com/wnstify/xcloud-mcp/issues); this file is the higher-level summary.

The current stable release is `v1.0.0`. See [CHANGELOG.md](CHANGELOG.md) for shipped work and [GOVERNANCE.md](GOVERNANCE.md) for how decisions are made.

## Under consideration (not committed)

Candidate tools left out of v1.0.0, to be added case by case where they earn their place in the curated set (see the "Not built in this version" section of [FEATURES.md](FEATURES.md)):

- **fail2ban ban / unban** — act on a banned IP, not just list them.
- **PHP management** — set the default version and opcache controls.
- **Firewall whitelist writes** — add SSH-allow rules (complementing the read-only lockdown status).
- **Git deploy** and its settings for sites that deploy from a repository.
- Quality-of-life improvements to existing tools driven by user-reported issues.

New tool requests and feature ideas are triaged in the [issue tracker](https://github.com/wnstify/xcloud-mcp/issues); acceptance is at maintainer discretion per [GOVERNANCE.md](GOVERNANCE.md).

## Ongoing (continuous, every release)

- **Security first.** Coordinated vulnerability disclosure, secret redaction, layered destructive-op gating, and release-blocking audit/CodeQL/Scorecard gates as documented in [SECURITY.md](SECURITY.md) and [SECURITY-DESIGN.md](SECURITY-DESIGN.md).
- **Dependencies and runtime.** Keep Node, the supported version matrix, and dependencies current; track and patch advisories via Dependabot and `npm audit`.
- **Verified releases.** Every published release carries SLSA provenance via npm OIDC trusted publishing; commits and tags are signed.
- **Documentation in sync.** Keep README, USAGE, SECURITY, and design docs consistent with the shipped package.

## Out of scope (not planned)

To keep the project focused and safe, `xcloud-mcp` does **not** intend to:

- Run as a remote, hosted, or multi-tenant service — it is local stdio only, and never holds many customers' keys.
- Ship a bundled secret store — it reads your token from the environment or a credential-helper command you point it at.
- Provision sites, or expose operations the xCloud API keeps panel-only (deleting a site, uninstalling a plugin).
- Expose the most dangerous server operations even where the API allows them — disabling a service or firewall rule, installing/patching PHP, managing sudo users, deleting SSL certificates or API tokens. A reboot or a targeted delete is as far as the destructive set goes.
- Manage Cloudflare or other integrations, or blueprints — outside "manage my own infrastructure."
- Provide commercial support or an SLA; support is self-service and community-based.
