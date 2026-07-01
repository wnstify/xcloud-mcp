/** Resolve startup configuration. The PAT is read once here and never logged. */

import { execFileSync } from "node:child_process";

const DEFAULT_BASE_URL = "https://app.xcloud.host/api/v1";

export type Config = {
  token: string;
  baseUrl: string;
  destructive: { enabled: boolean; noConfirm: boolean };
};

/** An opt-in flag: on only for the exact string "true" — no fat-fingered value enables it. */
const flag = (name: string): boolean => process.env[name] === "true";

/**
 * Run the operator-set credential-helper once and return its stdout as the PAT.
 * ADR-0001's single sanctioned shell-out: `execFile` (no shell → no injection), args
 * split off the command string on whitespace — so the executable path and its arguments
 * must not contain spaces (documented in .env.example). stdin is ignored (our stdin is the JSON-RPC pipe) and
 * stderr is captured, never inherited, so a noisy helper cannot spill onto our stderr.
 * On failure we surface only the exit code / spawn error — never the command, its stdout
 * or its stderr, any of which could carry the very secret we are fetching.
 */
function runHelper(command: string): string {
  const [file, ...args] = command.trim().split(/\s+/);
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const cause = err as { code?: string; status?: number | null };
    const detail = cause.code ?? `exit ${cause.status}`;
    // eslint-disable-next-line preserve-caught-error -- `cause` would carry the helper's stdout/stderr, which can contain the PAT; we deliberately surface only the code/status.
    throw new Error(`XCLOUD_TOKEN_CMD failed (${detail}) — no PAT obtained from the helper command.`);
  }
}

/** Resolve the PAT: from the XCLOUD_TOKEN_CMD helper if set, else from XCLOUD_API_TOKEN. */
function resolveToken(): string | undefined {
  const command = process.env.XCLOUD_TOKEN_CMD;
  return command ? runHelper(command) : process.env.XCLOUD_API_TOKEN;
}

export function loadConfig(): Config {
  const token = resolveToken();
  if (!token) {
    throw new Error(
      "No xCloud PAT — set XCLOUD_API_TOKEN, or XCLOUD_TOKEN_CMD to a command that prints it to stdout.",
    );
  }
  return {
    token,
    baseUrl: process.env.XCLOUD_API_BASE ?? DEFAULT_BASE_URL,
    destructive: {
      enabled: flag("XCLOUD_ENABLE_DESTRUCTIVE"),
      noConfirm: flag("XCLOUD_DESTRUCTIVE_NO_CONFIRM"),
    },
  };
}
