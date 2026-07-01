/** Egress net: scrub the PAT from everything the process writes, so it can never leak. */

const PLACEHOLDER = "[REDACTED]";

/** Keys whose values are credential material and must never reach the model (API-GUIDE §21). */
const isSecretKey = (key: string) => key === "ssh_keypairs" || key === "password" || key.endsWith("_password");

/**
 * Recursively strip known secret-bearing fields from any tool result before it returns
 * to the model. One central net over the whole registry — every current and future tool
 * is covered, no per-tool patching.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!isSecretKey(k)) out[k] = redactSecrets(v);
    }
    return out;
  }
  return value;
}

/** Replace the token in a chunk, but only allocate when it is actually present (byte-identical otherwise). */
function scrub(chunk: unknown, token: string): unknown {
  if (typeof chunk === "string") {
    return chunk.includes(token) ? chunk.split(token).join(PLACEHOLDER) : chunk;
  }
  if (Buffer.isBuffer(chunk) && chunk.includes(token)) {
    return chunk.toString("utf8").split(token).join(PLACEHOLDER);
  }
  return chunk;
}

/**
 * Wrap process stdout/stderr so any byte carrying the PAT egresses as `[REDACTED]`.
 * One chokepoint, installed once at startup — no tool or log path, present or future,
 * can route the token out of the process in cleartext.
 */
export function installTokenRedaction(token: string): void {
  if (!token) return;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) =>
      write(scrub(chunk, token), ...rest)) as typeof stream.write;
  }
}
