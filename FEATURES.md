# Features

The xCloud MCP server exposes 36 tools. Each one is named for something you'd actually want to do, takes typed inputs, and returns a shaped result with secrets stripped. It's a curated set, chosen for the tasks a customer wants to do rather than mechanically mapped onto every xCloud API endpoint.

## How the three classes work

Every tool is one of three kinds, and the kind decides whether your agent can reach it:

- **Read.** Looks, never changes anything. Always available.
- **Safe write.** Changes something, but the change is reversible or doesn't take anything offline (a backup, a scan, a cache purge). Always available.
- **Destructive.** Irreversible, or it affects availability or security (a reboot, a delete). Hidden until you set `XCLOUD_ENABLE_DESTRUCTIVE=true`, and each call asks for your confirmation. See [SECURITY.md](SECURITY.md) and [USAGE.md](USAGE.md).

The **required scope** column is the xCloud PAT scope the call needs. Your token's scope is the real limit: a `read:sites` token can never restart a service no matter what tools are enabled. Mint the narrowest token that does your job.

A few tools read from either a server or a site (cron jobs and metrics live under both). Give exactly one of `server` or `site`, and the tool tells you if you give both or neither.

## Read tools (25)

| Tool | What it does | Scope |
| --- | --- | --- |
| `list_servers` | List the servers in your team. | `read:servers` |
| `get_server` | One server's detail (stack, OS and PHP version) by uuid. | `read:servers` |
| `get_server_health` | A server's current CPU, memory and disk snapshot. | `read:servers` |
| `get_metrics_history` | A server's or site's CPU/RAM/disk trend over 24h or 7d. | `read:servers` or `read:sites` |
| `list_services` | A server's system services, each with its status and whether it can be restarted. | `read:servers` |
| `list_firewall_rules` | A server's firewall rules, each with its uuid, port, protocol and allow/deny direction. | `read:servers` |
| `get_ssh_restriction_status` | Whether a server's SSH is locked to the right IPs, and whether the xCloud infrastructure IPs are whitelisted. | `read:servers` |
| `list_banned_ips` | The IPs fail2ban has banned on a server, and the jail that banned each. | `read:servers` |
| `list_php_versions` | A server's PHP versions: installed, default, and whether a patch is available. | `read:servers` |
| `list_sites` | The sites in your team, optionally filtered by server, type or status. | `read:sites` |
| `get_site` | One site's detail and current status by uuid. | `read:sites` |
| `list_site_domains` | A site's primary domain, its aliases and its redirects. | `read:sites` |
| `list_vulnerabilities` | Vulnerabilities across all your sites, or one site's findings when you name it. | `read:sites` |
| `list_wordpress_updates` | A WordPress site's pending core, plugin and theme updates. | `read:sites` |
| `get_backup_status` | A site's local and remote backup status. | `read:sites` |
| `list_backups` | A site's restore points, each with its time, size and destination. | `read:sites` |
| `get_site_logs` | A site's recent access logs, web-server error log, or events feed. | `read:sites` |
| `list_cron_jobs` | The cron jobs under a server or a site, each with its command, frequency and user. | `read:servers` or `read:sites` |
| `get_cron_job_output` | A single cron job's last-run output. | `read:servers` or `read:sites` |
| `get_pagespeed` | A site's latest PageSpeed scores, mobile and desktop. | `read:sites` |
| `get_cache_settings` | Which cache layers a site has configured: page, object, Redis, Cloudflare edge. | `read:sites` |
| `get_ssl` | A site's SSL certificate: provider, status, expiry and covered hostnames. | `read:sites` |
| `get_wordpress_status` | A WordPress site's health: versions, debug/cron flags, core checksum, item and update counts. | `read:sites` |
| `list_wordpress_extensions` | A WordPress site's installed plugins or themes, with status and versions. | `read:sites` |
| `whoami` | Whose token this is and which team it's scoped to. | any valid token |

## Safe-write tools (7)

All safe-write tools need `write:sites`.

| Tool | What it does |
| --- | --- |
| `create_backup` | Trigger an on-demand backup of a site: a restore point before a risky change. Local by default, or remote if you've configured storage. |
| `run_vulnerability_scan` | Queue a fresh vulnerability scan of a site. |
| `run_pagespeed_scan` | Queue a PageSpeed scan of a site, mobile and desktop. |
| `purge_cache` | Purge a site's cache. Just the page cache by default, or every configured layer with `layers: all`. |
| `apply_wordpress_updates` | Apply pending WordPress updates on a site: core, a plugin, or a theme. Update specific items, or everything of that type. |
| `activate_wordpress_extensions` | Activate one or more WordPress plugins or themes on a site. (Activate only; there's no deactivate.) |
| `magic_login` | Mint a short-lived login URL into a site's WordPress admin, so you can jump into wp-admin without a password. The URL is sensitive (see [SECURITY.md](SECURITY.md)). |

Several of these run asynchronously: the tool returns a "queued" acknowledgement, and the result shows up a little later on the matching read tool. Queue a scan with `run_pagespeed_scan`, then read the score with `get_pagespeed`. Trigger `create_backup`, then confirm the restore point with `list_backups`. Every write tool has a read tool that discovers its target or shows its result.

## Destructive tools (4)

Hidden unless `XCLOUD_ENABLE_DESTRUCTIVE=true`. Each one asks for confirmation at call time, and fails closed if your harness can't ask (unless you've explicitly waived that, see [USAGE.md](USAGE.md)). Even with everything enabled, a read-only token still can't run them.

| Tool | What it does | Scope |
| --- | --- | --- |
| `reboot_server` | Reboot a server. It and everything on it goes offline while it restarts. | `write:servers` |
| `restart_service` | Restart a system service (redis, mysql, php-fpm, …) on a server. Briefly unavailable while it restarts. | `write:servers` |
| `delete_firewall_rule` | Delete a firewall rule from a server. Irreversible, and removing an allow rule can lock traffic out, including your own. | `write:servers` |
| `delete_cron_job` | Delete a cron job under a server or a site. Irreversible. | `write:servers` or `write:sites` |

---

## Not included (and why)

The tool set is deliberately bounded. Some things the xCloud API can do are left out on purpose; others were folded into an existing tool rather than given their own.

### Out of scope by design

- **Remote / hosted / multi-tenant mode.** This server is local stdio only. There's no internet-facing version that would hold many customers' keys. That's a scope decision, not a missing feature.
- **A bundled secret store.** The server doesn't ship its own keychain. It reads your token from the environment or from a credential-helper command you point it at, so your existing tool owns the secret.
- **Site provisioning**, and anything the xCloud API itself forbids or keeps panel-only, like **deleting a site** or **uninstalling a plugin**.
- **The most dangerous server operations**, even where the API allows them: disabling a service, disabling a firewall rule, installing/uninstalling/patching PHP, creating or deleting sudo users, deleting an SSL certificate, deleting an API token. A reboot or a targeted delete is as far as the destructive set goes.
- **Cloudflare and other integration management, and blueprints.** Outside "manage my own infrastructure."

### Folded into another tool instead of standing alone

- **Site redirects** arrive inside `list_site_domains`, so there's no separate redirects tool.
- **Per-site vulnerabilities** are a parameter on `list_vulnerabilities`, not a second tool.
- **Plugins and themes** share one `list_wordpress_extensions` (pick `type`), and server and site history share one `get_metrics_history`.
- A site's current status is part of `get_site`, so there's no standalone status tool.
- Left out as redundant: vulnerability and backup **counts** (already in each result's summary), and a few recon endpoints your agent doesn't need to act.

### Not built in this version

- **Site health as its own tool.** The live monitoring endpoint returns a flat CPU/RAM/disk time-series that's already covered by `get_metrics_history`, so a separate tool would only duplicate it.
- Left to the panel or a later pass: fail2ban ban/unban, PHP set-default and opcache controls, git deploy and its settings, SSH-config writes, firewall whitelist writes, web rules, custom nginx, IP access, site scripts, snapshots (they overlap restore points), staging sites, supervisor processes, and listing sudo users.
