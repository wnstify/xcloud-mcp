import test from "node:test";
import assert from "node:assert/strict";
import { installTokenRedaction, redactSecrets } from "./redact.ts";

test("redactSecrets strips credential-named keys (token, secret, api_key, private_key…), case-insensitive", () => {
  const out = redactSecrets({
    name: "blog",
    token: "t0ken",
    Access_Token: "a1",
    refresh_token: "r1",
    client_secret: "c1",
    API_KEY: "k1",
    private_key: "-----BEGIN-----",
    nested: { auth_token: "n1", keeper: "keep" },
  }) as Record<string, unknown>;

  assert.deepEqual(Object.keys(out).sort(), ["name", "nested"]);
  assert.equal(out.name, "blog");
  assert.deepEqual(out.nested, { keeper: "keep" });
});

test("installed redaction scrubs the PAT from everything written to stdout and stderr", () => {
  const token = "pat-secret-egress-9f3";
  const seenOut: string[] = [];
  const seenErr: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = ((c: unknown) => (seenOut.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => (seenErr.push(String(c)), true)) as typeof process.stderr.write;

  try {
    installTokenRedaction(token);
    // Simulate any present-or-future code path that lets the token reach an egress:
    process.stdout.write(`{"content":[{"type":"text","text":"url?token=${token}"}]}\n`); // a tool result
    process.stderr.write(`fetch failed: Authorization: Bearer ${token}\n`); // a stray log line
    process.stdout.write(Buffer.from(`buffered ${token}\n`)); // even a raw Buffer write
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }

  const all = seenOut.join("") + seenErr.join("");
  assert.doesNotMatch(all, new RegExp(token), "the PAT must never reach an egress");
  assert.ok(seenOut.join("").includes("[REDACTED]"), "stdout leak should be redacted");
  assert.ok(seenErr.join("").includes("[REDACTED]"), "stderr leak should be redacted");
});
