# Contributing to xcloud-mcp

Contributions are welcome. `xcloud-mcp` is released under the [MIT license](LICENSE); by contributing, you agree that your changes are licensed under the same terms.

## Prerequisites

- Node.js 24 or newer (matches `engines.node` in [package.json](package.json)).
- npm 11 or newer (ships with Node 24).

No build toolchain beyond that is required — the server is TypeScript run under Node's native type stripping, and the tests use the built-in `node:test` runner.

## Build and test

Use the npm scripts:

| Script | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` (the published output). |
| `npm run typecheck` | Type-check without emitting. |
| `npm run lint` | Run ESLint. |
| `npm test` | Run the test suite with the 80% coverage floor. |

`npm test` enforces line/branch/function coverage at 80% and writes an lcov report to `coverage/lcov.info`; it also runs `npm audit` first via the `pretest` hook.

GitHub Actions run the required lint, typecheck, test, and audit checks on pull requests and pushes, plus CodeQL and OpenSSF Scorecard. Pull requests are merged by the repository owner after required checks pass and a maintainer other than the author approves the change.

## Making a change

Major functional changes must add or update automated tests for the changed behavior. If a change cannot be covered by an automated test, explain the reason in the pull request and describe the manual verification performed.

Every security fix must ship a regression test that exercises the real validator, redactor, or boundary it protects — never a mock of the protected seam. A test that stubs out the seam it is meant to guard does not prove the fix and lets the bug return silently.

## Project layout

`xcloud-mcp` is a small, single-purpose server under `src/`:

- `index.ts` — entrypoint: load config, install token redaction, build the server, connect over stdio.
- `config.ts` — resolve startup configuration and the PAT (env var or credential-helper command).
- `client.ts` — the xCloud REST API client; the single external boundary and the only place the PAT is used.
- `server.ts` — the MCP tool registry wired to the client.
- `redact.ts` — the egress net that strips secrets from results and scrubs the PAT from output.
- `*.test.ts` — co-located tests for each module.

Keep the boundaries intact: tool arguments are validated at the seam in `server.ts`, all HTTP goes through `client.ts`, and nothing bypasses `redact.ts` on the way back to the model.

## Pull requests

1. Fork the repository and create a topic branch for your change.
2. Keep commits focused and atomic: one logical change per commit, with a clear message.
3. **Sign your commits** (SSH or GPG). GitHub must show them as *Verified*; signed commits are required by branch protection.
4. Run `npm run lint`, `npm run typecheck`, and `npm test` before opening a pull request.
5. Open a pull request against the `dev` branch, describing what changed and why. Releases flow `dev` → `main`.

## Signed commits

This project requires cryptographically **signed** commits rather than a DCO text trailer — the signature already proves provenance. Configure SSH commit signing once:

```sh
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/your_key.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

Then add the same key to your GitHub account as a **signing key** (Settings → SSH and GPG keys → New SSH key → type *Signing*). Branch protection rejects unsigned commits.

## A note on `ADR-NNNN` references

Some code comments reference anchors such as `ADR-0004` or `API-GUIDE §21`. These point to internal design decisions and the xCloud API notes behind `xcloud-mcp`. Those documents are not part of this repository; the anchors are stable references maintainers use, and readers can treat them as informational.

## Code of conduct and security

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md). Please report security issues as described in [SECURITY.md](SECURITY.md) rather than in public issues. For the security design, trust boundaries, external interfaces, and assessed risks, see [SECURITY-DESIGN.md](SECURITY-DESIGN.md).
