# Usage

Everything the server needs comes from a handful of environment variables set in your agent's MCP config. This page covers all of them, how to keep your token out of a plaintext file, the client config to copy, and how to turn on the destructive tools.

## Environment variables

| Variable | Required | What it does |
| --- | --- | --- |
| `XCLOUD_API_TOKEN` | Yes* | Your xCloud Personal Access Token. |
| `XCLOUD_TOKEN_CMD` | No | A command that prints your token to stdout. Set this instead of `XCLOUD_API_TOKEN` to fetch the token from your own secret store. Takes precedence when both are set. |
| `XCLOUD_API_BASE` | No | Override the xCloud API base URL. Defaults to `https://app.xcloud.host/api/v1`. |
| `XCLOUD_ENABLE_DESTRUCTIVE` | No | Set to exactly `true` to expose the destructive tools. Off by default. |
| `XCLOUD_DESTRUCTIVE_NO_CONFIRM` | No | Set to exactly `true` to let destructive tools run without a confirmation prompt. Only meaningful with the flag above. |

\* You need either `XCLOUD_API_TOKEN` or `XCLOUD_TOKEN_CMD`, one of the two. The server won't start without a token.

The two flags only switch on for the exact string `true`. Any other value leaves them off, so a fat-fingered `TRUE` or `1` can't accidentally enable destructive operations.

## Setting your token

### The simple way: an environment variable

Put your PAT straight into the config's `env` block:

```json
"env": { "XCLOUD_API_TOKEN": "your-xcloud-pat" }
```

This works everywhere and needs nothing else. The tradeoff is that the token sits in a config file in plaintext. If that's fine for your setup, you're done.

### The better way: pull it from your secret store

Set `XCLOUD_TOKEN_CMD` to a command that prints your token. The server runs it once at startup and keeps the token in memory, so it never lands in a config file.

```json
"env": { "XCLOUD_TOKEN_CMD": "gopass show company/xcloud/pat" }
```

**One important detail:** the command is split on spaces and run directly, without a shell. Each space-separated piece is a separate argument. There's no quoting and no shell features: no pipes, no `$variables`, no redirection. That's deliberate, and it's what makes the helper safe from injection. If your retrieval needs any of that (or an argument with a space in it), put it in a small script and point `XCLOUD_TOKEN_CMD` at the script.

Examples by tool and platform:

```sh
# macOS Keychain
XCLOUD_TOKEN_CMD=security find-generic-password -w -s xcloud-pat

# gopass (Linux, macOS, headless servers)
XCLOUD_TOKEN_CMD=gopass show company/xcloud/pat

# 1Password CLI (cross-platform)
XCLOUD_TOKEN_CMD=op read op://Private/xcloud/token

# HashiCorp Vault (cross-platform)
XCLOUD_TOKEN_CMD=vault kv get -field=token secret/xcloud

# Windows: a small script that reads Credential Manager
XCLOUD_TOKEN_CMD=pwsh -File C:\Scripts\get-xcloud-pat.ps1
```

For the Windows example, the script does the work that can't fit on one shell-free line, like reading your token from PowerShell SecretManagement (which can front Windows Credential Manager via the CredMan vault extension):

```powershell
# C:\Scripts\get-xcloud-pat.ps1
Get-Secret -Name xcloud-pat -AsPlainText
```

Whatever the source, the rule is the same: the command must print the token, and nothing else, to stdout.

## Adding the server to your agent

### Claude Code (one line, once published)

```sh
claude mcp add xcloud -s user --env XCLOUD_API_TOKEN='your-xcloud-pat' -- npx -y @webnestify/xcloud-mcp@1.0.1
```

`-s user` installs it for every project; drop it to add only to the current one. Keep the single quotes around the token — xCloud PATs contain a `|`, which an unquoted shell would treat as a pipe (the command would fail with `missing required argument 'commandOrUrl'`).

The forms below go in your harness's `mcpServers` block (Claude Desktop's `claude_desktop_config.json`, Claude Code's MCP config, and so on; check your harness's docs for the exact file).

### Pinned npx (once published)

```json
{
  "mcpServers": {
    "xcloud": {
      "command": "npx",
      "args": ["-y", "@webnestify/xcloud-mcp@1.0.1"],
      "env": { "XCLOUD_API_TOKEN": "your-xcloud-pat" }
    }
  }
}
```

### From a local checkout (for development)

Build it first with `npm install && npm run build`, then point your harness at the built entrypoint:

```json
{
  "mcpServers": {
    "xcloud": {
      "command": "node",
      "args": ["/absolute/path/to/xcloud-mcp/dist/index.js"],
      "env": { "XCLOUD_API_TOKEN": "your-xcloud-pat" }
    }
  }
}
```

A copy of the pinned config lives in [`examples/mcp-config.json`](examples/mcp-config.json).

Restart your agent after editing the config. Ask it to run `whoami` to confirm the token resolved and see which team you're scoped to.

## Enabling the destructive tools

By default your agent can't reboot a server, restart a service, or delete a firewall rule or cron job. Those tools aren't even loaded. To allow them, add the flag:

```json
"env": {
  "XCLOUD_API_TOKEN": "your-xcloud-pat",
  "XCLOUD_ENABLE_DESTRUCTIVE": "true"
}
```

With that set, the four destructive tools appear, and each one asks you to confirm before it runs. Two things still hold:

- The token does the real gating. A destructive tool needs a `write:` scope; a read-only token can't run one even with the flag on.
- If your harness can't show you a confirmation prompt, the operation refuses rather than running blind.

For unattended use (CI, a headless box) where there's no one to confirm, you can waive the prompt:

```json
"env": {
  "XCLOUD_API_TOKEN": "your-xcloud-pat",
  "XCLOUD_ENABLE_DESTRUCTIVE": "true",
  "XCLOUD_DESTRUCTIVE_NO_CONFIRM": "true"
}
```

That's an explicit decision to let destructive operations run without asking. Only set it when you mean it. The safety writeup is in [SECURITY.md](SECURITY.md).

## Working with tools that run in the background

A few write tools kick off work that finishes after the call returns: scans, WordPress updates, cache purges. The tool hands back a "queued" acknowledgement, not the finished result. To see the outcome, read the matching tool a moment later:

- `run_pagespeed_scan` then read the score with `get_pagespeed`
- `run_vulnerability_scan` then read findings with `list_vulnerabilities`
- `create_backup` then confirm the restore point with `list_backups`
- `apply_wordpress_updates` then check progress with `get_wordpress_status` or `list_wordpress_updates`

The full tool list is in [FEATURES.md](FEATURES.md).
