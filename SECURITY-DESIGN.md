# Security Design

This document describes the actors, actions, trust boundaries, external interfaces, and main security risks for `xcloud-mcp`. It complements [SECURITY.md](SECURITY.md), which is the user-facing summary and the vulnerability-reporting policy.

## Scope

`xcloud-mcp` is a local [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent manage the operator's own xCloud servers and sites. It runs on the operator's machine and speaks to the agent over stdio; it exposes no network listener.

Its defining security property is that it is driven by an AI agent that can be steered by the content it reads. A tool call the model makes may carry arguments an attacker planted in a web page, a file, or another tool's output. The design therefore treats every tool argument as untrusted and enforces safety where the privilege actually lives — in the token's scope and a fixed tool allowlist — rather than trusting the model to behave.

## Actors

| Actor | Role | Trust level |
| --- | --- | --- |
| Operator | Runs the server, mints the token, enables/confirms destructive operations, owns the infrastructure. | Trusted local operator. |
| AI agent / MCP host | Issues tool calls over stdio. Its inputs may be influenced by untrusted content it has read. | Semi-trusted: allowed to call the registered tools, never trusted to self-limit. |
| Local OS user account | Provides the process environment, the credential-helper command, and the stdio pipe. | Trusted only as the invoking user. |
| xCloud REST API | Serves and mutates the operator's team-scoped servers and sites over HTTPS. | External service; responses are parsed and treated as untrusted input, and secrets are stripped before the model sees them. |
| Credential helper | Optional operator-configured command that prints the PAT to stdout. | Trusted as configured by the operator; run once, directly, never from a tool. |
| GitHub Actions | Builds, tests, and publishes the package. | Trusted only through pinned workflows, scoped permissions, and tag-gated release. |
| npm registry / Sigstore | Distributes the package and its provenance attestation. | External trust services; provenance is verifiable by consumers. |
| Project maintainer | Reviews changes, controls repository settings, and configures publishing. | Trusted project operator. |

## Main Actions

| Action | Initiator | Security controls |
| --- | --- | --- |
| Resolve the token | Startup | Read once from `XCLOUD_API_TOKEN` or the `XCLOUD_TOKEN_CMD` helper (run via `execFile`, no shell). Kept in memory only, never written to disk. |
| Read tools (list/get) | AI agent | Validated, length-capped arguments; identifiers percent-encoded into the API path; results pass through the redaction net. |
| Safe-write tools | AI agent | Require a `write:` scope; reversible or non-availability-affecting (backup, scan, cache purge). |
| Destructive tools | AI agent | Four layers: `write:` scope, off unless `XCLOUD_ENABLE_DESTRUCTIVE=true`, per-call confirmation via MCP elicitation, and fail-closed when no confirmation channel exists. |
| `magic_login` | AI agent | Returns a short-lived login URL by design; the URL is sensitive, is never logged, and expires quickly. |
| Publish release | Maintainer via Git tag | Runs only on a `refs/tags/v*` push to `wnstify/xcloud-mcp`; publishes via OIDC trusted publishing with automatic provenance; the full test/lint/typecheck/audit gate (including the coverage floor) must pass. |
| Run CI | GitHub Actions | Pinned actions, read-only default token permissions, CodeQL, lint, tests, `npm audit`, and protected-branch required checks. |

## External Interfaces

| Interface | Direction | Purpose |
| --- | --- | --- |
| Terminal stdio (JSON-RPC) | agent ↔ server | MCP tool calls and results. |
| HTTPS to `app.xcloud.host` | server → xCloud | All server/site read and write operations, authenticated with the bearer token. |
| Credential-helper subprocess | server → helper | One-time PAT retrieval at startup, `execFile` with argument array, stderr captured never inherited. |
| Process stdout/stderr | server → operator/agent | Human and protocol output, with the token scrubbed to `[REDACTED]` at the stream. |
| npm registry / Sigstore | consumer → trust services | Package download and provenance verification (`npm audit signatures`). |
| GitHub Actions | repository → CI runners | Build, test, security scan, and tag-gated publish. |

The server does not expose a network listener and has no inbound surface.

## Trust Boundaries

The important trust boundaries are:

- tool arguments (from the model, possibly attacker-influenced) crossing into API calls;
- the credential-helper command crossing into process execution;
- the token crossing toward any output sink or the model;
- xCloud responses crossing back toward the model;
- release artifacts crossing into what consumers install.

Each boundary has a narrow control:

- Zod schemas validate and length-cap every tool argument; identifiers are percent-encoded into the path so a crafted value cannot break out of its endpoint.
- The helper is run once with `execFile` (no shell), so no tool-supplied or model-supplied value can reach a shell — command injection is absent, not merely mitigated.
- The token is never a tool argument, never written to disk, and is scrubbed from every byte the process writes.
- Known secret fields (`ssh_keypairs`, `password`, `*_password`) are stripped from every result before it reaches the model.
- Releases publish only from the tag-gated workflow and carry Sigstore-backed provenance.

## Threat Modeling and Attack Surface Analysis

The assessment focuses on the critical paths: model-supplied tool arguments, token handling, destructive operations, the credential helper, and the release pipeline. Maintainers update this analysis when the project adds an external interface, a new tool that mutates state, or a change to how arguments, the token, or release artifacts cross a boundary.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Prompt-injected tool call | Agent invokes an unintended or oversized/malformed operation. | Fixed tool allowlist, Zod validation and length caps at the seam, and token scope as the hard limit — the server cannot perform an action the token does not permit. |
| Token disclosure in logs or transcripts | xCloud credential exposed. | Token is never a tool argument, never on disk, and scrubbed to `[REDACTED]` at every output stream. |
| Abuse of destructive operations | A reboot/restart/delete taken without consent. | Requires `write:` scope, explicit `XCLOUD_ENABLE_DESTRUCTIVE=true`, per-call confirmation, and fail-closed when no confirmation channel exists. |
| Command injection via a tool | Local code execution. | No tool path reaches a shell; the only subprocess is the operator-configured helper, run via `execFile`. |
| Scope or team escalation | Reaching another team's resources. | The token is bound to one team; every call is team-scoped and the server never widens scope. |
| Secret leakage from xCloud responses | Keys/passwords shown to the model. | Central redaction net strips secret fields from every result; `magic_login`'s URL is the one intentional, documented exception. |
| Malicious or tampered release | Consumers install attacker code. | Tag-gated publish with OIDC provenance (SLSA/Sigstore/Rekor), verifiable via `npm audit signatures`. |
| Vulnerable dependency | Known vulnerability reaches users. | Exact-pinned dependencies, Dependabot, and `npm audit` as a release-blocking gate; CodeQL and Scorecard in CI. |

Security assessment is continuous: CI runs lint, typecheck, tests with the coverage floor, `npm audit`, CodeQL, and Scorecard; releases require passing that gate plus provenance; repository rules protect `dev`, `main`, and release tags with required checks and signatures.

## Maintainer Responsibilities

The project maintainer is responsible for:

- reviewing code and release-workflow changes;
- keeping branch and tag protection active;
- keeping the npm trusted-publisher configuration correct and least-privilege;
- triaging private vulnerability reports;
- publishing GitHub Security Advisories for confirmed vulnerabilities when disclosure is appropriate.

## Collaborator Access Review

Before granting write, admin, or repository-settings access, the maintainer reviews the collaborator's identity, need, requested permission level, and expected duration of access. Access must use the least privilege that allows the work to be done, and escalated access is removed when it is no longer needed. Repository security settings remain maintainer-controlled unless a future governance change documents a different owner and review process.

## Two-Maintainer Review Posture

The project has more than one human maintainer with Write access (the `@wnstify/webnestify-dev` team). Independent human approval is required: branch-protection rules on `dev` and `main` require one approving review from the team, self-approval does not count, and the same rules apply to the owner's own pull requests. Merges into `dev` and `main` are restricted to the repository owner, so another maintainer can approve but not merge.

Controls are independent two-person review, public pull requests, **signed commits and signed release tags**, required CI (lint, typecheck, test with coverage floor, audit), CodeQL, Scorecard, protected `dev`/`main`, immutable protected release tags, provenance-signed releases, and public issue/security reporting.
