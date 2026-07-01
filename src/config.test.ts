import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";

/** The env keys loadConfig reads — snapshotted and restored around every test. */
const KEYS = [
  "XCLOUD_TOKEN_CMD",
  "XCLOUD_API_TOKEN",
  "XCLOUD_API_BASE",
  "XCLOUD_ENABLE_DESTRUCTIVE",
  "XCLOUD_DESTRUCTIVE_NO_CONFIRM",
] as const;

/** Run `fn` with exactly the given values for our keys, restoring the prior env after. */
function withEnv(env: Partial<Record<(typeof KEYS)[number], string>>, fn: () => void): void {
  const saved = KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

/** A real credential-helper: node itself, executed with no shell, running `script`. */
const helper = (script: string) => `${process.execPath} -e ${script}`;

test("XCLOUD_TOKEN_CMD: the PAT is the helper command's stdout, trimmed", () => {
  withEnv({ XCLOUD_TOKEN_CMD: helper("process.stdout.write('tok-from-helper\\n')") }, () => {
    assert.equal(loadConfig().token, "tok-from-helper");
  });
});

test("XCLOUD_API_TOKEN: the env-var path resolves the PAT with no helper set", () => {
  withEnv({ XCLOUD_API_TOKEN: "tok-from-env" }, () => {
    assert.equal(loadConfig().token, "tok-from-env");
  });
});

test("XCLOUD_TOKEN_CMD: the helper's stderr is not inherited onto process.stderr", () => {
  // execFileSync pipes a child's stderr to the parent's by default — and at startup the
  // token-scrub egress net is not yet installed, so any such spill would be raw. The helper
  // succeeds but writes a secret to stderr; none of it may reach our stderr.
  const noisy = helper("process.stderr.write('STDERR_SECRET');process.stdout.write('the-pat')");
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return original(chunk as string, ...(rest as []));
  }) as typeof process.stderr.write;
  try {
    withEnv({ XCLOUD_TOKEN_CMD: noisy }, () => {
      assert.equal(loadConfig().token, "the-pat");
    });
  } finally {
    process.stderr.write = original;
  }
  assert.ok(!written.some((c) => c.includes("STDERR_SECRET")), "helper stderr reached process.stderr");
});

test("destructive opt-in flags default off, and only the exact string 'true' turns them on", () => {
  withEnv({ XCLOUD_API_TOKEN: "t" }, () => {
    assert.deepEqual(loadConfig().destructive, { enabled: false, noConfirm: false });
  });
  withEnv(
    { XCLOUD_API_TOKEN: "t", XCLOUD_ENABLE_DESTRUCTIVE: "true", XCLOUD_DESTRUCTIVE_NO_CONFIRM: "true" },
    () => {
      assert.deepEqual(loadConfig().destructive, { enabled: true, noConfirm: true });
    },
  );
  // Not "1", not "TRUE" — a fat-fingered value must not silently enable destructive ops.
  withEnv({ XCLOUD_API_TOKEN: "t", XCLOUD_ENABLE_DESTRUCTIVE: "1" }, () => {
    assert.equal(loadConfig().destructive.enabled, false);
  });
});

test("XCLOUD_TOKEN_CMD: a failing helper errors clearly, without leaking its output", () => {
  // A helper that spills a secret to stdout+stderr then exits non-zero. execFileSync's own
  // error appends the child's stderr and echoes the command line — none of that may surface.
  const noisy = helper(
    "process.stdout.write('LEAK_STDOUT');process.stderr.write('LEAK_STDERR');process.exit(3)",
  );
  withEnv({ XCLOUD_TOKEN_CMD: noisy }, () => {
    assert.throws(loadConfig, (err: Error) => {
      assert.match(err.message, /XCLOUD_TOKEN_CMD failed/);
      assert.doesNotMatch(err.message, /LEAK_STDOUT|LEAK_STDERR/);
      return true;
    });
  });
});
