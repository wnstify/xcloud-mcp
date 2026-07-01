# Security

This server runs on your machine, holds one credential, and is driven by an AI agent that can be steered by the content it reads. That last point is the whole reason the design is careful: a tool call the model makes might carry arguments an attacker planted in a web page or a file. So the rule throughout is to treat every tool argument as untrusted and enforce safety where the privilege actually lives, in the token's scope and in a fixed tool allowlist, not by trusting the model to behave.

## The one secret: your xCloud token

The server holds exactly one secret, your xCloud Personal Access Token. Everything about how it's handled follows from keeping that token from ever leaking.

- **It's resolved once, at startup.** Either from the `XCLOUD_API_TOKEN` environment variable, or from a credential-helper command you set in `XCLOUD_TOKEN_CMD`. That command is run one time to fetch the token, directly (no shell involved), so nothing you store in it can be turned into a shell injection.
- **It lives only in memory.** After startup the token sits in the process's memory and is sent as the bearer header on HTTPS calls to `app.xcloud.host`. It is never written to disk by the server.
- **It is never a tool argument.** No tool accepts the token as input, so it can't appear in a tool call, an agent transcript, or a prompt.
- **It is never logged.** As a backstop, the server scrubs the token out of everything it writes to its output streams. If the token ever ended up in a log line by accident, it would come out as `[REDACTED]` instead of the real value.

## Your token's scope is the real boundary

xCloud tokens are scoped (`read:servers`, `read:sites`, `write:servers`, `write:sites`) and bound to one team. The server never widens that. Two things follow:

- **Mint the narrowest token for the job.** If you only want to look, use a read-only token. Then no combination of enabled tools, flags, or agent behavior can change anything. The server literally cannot make a write the token doesn't permit.
- **You only ever see your own team.** A token belongs to one current team, and every call is scoped to it. One install can only reach its owner's team-scoped servers and sites. Run `whoami` to see exactly which account and team you're acting as.

## Secrets are stripped from results before the model sees them

Some xCloud responses carry sensitive material. Before any result reaches the model, the server walks it and removes known secret fields wherever they appear: SSH keypairs, and any password or `*_password` field. The model never sees them.

There's one deliberate exception. The `magic_login` tool exists to hand you a login URL, so that URL is returned to you on purpose. But it carries a login token and works for about ten minutes, so treat it like a password: use it, don't paste it somewhere it'll be stored, and know that the server itself never logs it.

Because that URL is a password-equivalent that reaches the model, `magic_login` is a bit hotter than the other write tools: a prompt-injected agent could mint one and surface it to the transcript or another connected tool. Two things bound the risk — the URL expires in ~10 minutes, and the tool needs a write-capable token to run at all (a read-only PAT can't call it). If you don't want the capability available, don't grant it: mint a token without it, or use a read-only token.

## No shell-out, structurally

The most common class of MCP vulnerability is a tool that builds a shell command out of model-supplied input. This server doesn't have one. Every tool talks to the xCloud REST API over HTTPS. There is no code path from a tool to a shell, so command injection isn't mitigated, it's absent. The single place the server runs an external command is the optional credential-helper at startup, which runs one fixed command you configured, directly rather than through a shell, and is never reachable from a tool or from anything the model says.

## Inputs are validated at the boundary

Every tool validates and length-caps its inputs before anything happens: identifiers are bounded, free-text fields are capped. Identifiers are also percent-encoded into the API path, so a crafted value can't break out of the endpoint it belongs to. A prompt-injected tool call can't smuggle an oversized or malformed argument through.

## Destructive operations are gated in layers

Rebooting a server, restarting a service, and deleting a firewall rule or cron job can take things offline or can't be undone. They're protected by four independent layers, so no single failure exposes them:

1. **Token scope.** They need a `write:` scope. With a read-only token they don't work, full stop.
2. **Off by default.** They aren't even registered unless you set `XCLOUD_ENABLE_DESTRUCTIVE=true`. Turning them on is a deliberate act.
3. **Confirmation at call time.** When one is invoked, the server asks you to confirm before it runs.
4. **Fail closed.** If your harness offers no way to ask you, the operation refuses rather than guessing. You can waive that for headless automation with `XCLOUD_DESTRUCTIVE_NO_CONFIRM=true`, which is an explicit choice to accept the risk.

The server never silently deletes anything, and it never forces a backup on you either. The actions are yours to own. See [USAGE.md](USAGE.md) for how to enable and configure this.

## Local only, with you in the loop

The server runs on your own machine and speaks to your agent over stdio. There's no network listener and no inbound surface, so nothing on the internet can reach it. Your token never leaves your box, and no third party ever sits in the path between your agent and xCloud.

When something goes wrong, errors come back as clear messages ("not found, or it belongs to another team"; "your token lacks the required scope") with no credential in them. It also backs off politely when xCloud rate-limits a burst of activity, rather than hammering the API.

## Verifying what you install

Every published release carries signed build provenance (a SLSA in-toto statement, Sigstore-signed and logged in Rekor) and an attested SPDX SBOM, generated by the publish pipeline. You can confirm a release was built from this source with:

```sh
npm audit signatures
```

and npm verifies that provenance at install time.

The matching GitHub Release attaches the same evidence as files — the tarball, its SPDX SBOM, the SLSA provenance bundle (`*.intoto.jsonl`), the SBOM attestation (`attestation.json`) and a `SHA256SUMS` manifest. You can verify those directly:

```sh
gh attestation verify <tarball> --repo wnstify/xcloud-mcp   # provenance + SBOM attestation
sha256sum -c SHA256SUMS                                     # artifact integrity
```

## Reporting a vulnerability

If you find a security issue, please report it privately rather than opening a public issue: email **dev@webnestify.cloud** with the details and steps to reproduce. We'll acknowledge and work a fix, and credit you if you'd like. Please give us a reasonable window to release before any public disclosure.
