# xCloud MCP

A local [MCP](https://modelcontextprotocol.io) server that lets you manage your own xCloud servers and sites from inside your AI agent: Claude Code, Claude Desktop, Codex CLI, or any other MCP-speaking harness.

You give it one xCloud Personal Access Token. It calls the xCloud REST API on your behalf and hands your agent a curated set of tools: list your fleet, check a server's health, read a site's logs, trigger a backup, apply WordPress updates, purge a cache, and so on. It runs on your own machine over stdio. Nothing about your account leaves your box except the calls you already make to xCloud.

## Why you might want it

- **Ask your agent about your infrastructure.** "Which of my sites have pending WordPress updates?" "Is this server's disk filling up?" "Show me the last hour of access logs for example.com."
- **Act on it, safely.** Create a restore point before a risky change, run a vulnerability scan, purge a cache after a deploy, all without leaving the agent or pasting credentials into a prompt.
- **Secure by default.** You configure nothing to make it safe. Read and safe-write tools work out of the box; anything destructive is hidden until you deliberately turn it on, and then asks before it runs. See [SECURITY.md](SECURITY.md).

## Requirements

- **Node.js 24 or newer.**
- **An xCloud Personal Access Token (PAT).** Mint one at `app.xcloud.host` under Account, then API Tokens. Scope it as narrowly as the work needs. The token is your real safety boundary, so a read-only token can only ever read. See [USAGE.md](USAGE.md) for how to store it.

## Quick start

> [!CAUTION]
> Keeping the token out of a plaintext config file (pulling it from macOS Keychain, Windows Credential Manager, gopass, 1Password, or Vault) is a one-line change covered in [USAGE.md](USAGE.md).

**Claude Code** — one command (`-s user` installs for every project; drop it to scope to the current project only):

```sh
claude mcp add xcloud -s user --env XCLOUD_API_TOKEN=your-xcloud-pat -- npx -y @webnestify/xcloud-mcp@1.0.1
```

**Other harnesses** (Claude Desktop, Codex CLI, and anything else that speaks MCP) — add the server to your agent's MCP config and set your token. Most use an `mcpServers` block like this:

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

Pinning the version (`@1.0.1`) means you always run a known build rather than whatever is newest.

> The package is not published to npm yet. Until it is, run it from a local checkout instead. Clone the repository, then build it:
>
> ```sh
> npm install && npm run build
> ```
>
> ```json
> {
>   "mcpServers": {
>     "xcloud": {
>       "command": "node",
>       "args": ["/absolute/path/to/xcloud-mcp/dist/index.js"],
>       "env": { "XCLOUD_API_TOKEN": "your-xcloud-pat" }
>     }
>   }
> }
> ```

Restart your agent, and the xCloud tools appear. Ask it to run `whoami` to confirm which account and team your token is scoped to.

## What you can do

36 tools, grouped by how much they can change:

- **25 read tools.** List and inspect servers, sites, services, firewall rules, backups, logs, SSL, vulnerabilities, WordPress status, and more. Available by default.
- **7 safe-write tools.** Create a backup, run a scan, purge a cache, apply WordPress updates, mint a magic-login link. Reversible or non-disruptive, and available by default.
- **4 destructive tools.** Reboot a server, restart a service, delete a firewall rule or cron job. Hidden until you opt in, and each one asks before it runs.

The full catalog, with every tool's classification and required token scope, is in [FEATURES.md](FEATURES.md).

## Documentation

- **[USAGE.md](USAGE.md)** covers environment variables, per-OS credential setup, the example client config, and how to enable destructive tools.
- **[FEATURES.md](FEATURES.md)** is the complete tool catalog, plus what was deliberately left out and why.
- **[SECURITY.md](SECURITY.md)** covers the trust model, secret handling, redaction guarantees, the destructive-op gate, and how to report a vulnerability.

## Status

v1, built and tested locally. Not yet published to npm; install from source as shown above. When it is published, releases will carry signed build provenance you can verify (see [SECURITY.md](SECURITY.md)).

## About xCloud

[xCloud](https://xcloud.host/) is a third-party server and site management platform. This is an independent, community-built MCP server for the public xCloud REST API — it is **not** an official xCloud product and is not affiliated with or endorsed by xCloud. "xCloud" and related marks belong to their respective owner.

## License

[MIT](LICENSE) © Simon Gajdosik, Webnestify s.r.o.
