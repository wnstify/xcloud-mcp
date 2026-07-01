import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { XCloudClient } from "./client.ts";

/** Run `fn` against a local HTTP server using `handler`, tearing it down after. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address() as import("node:net").AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/api/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a request that outlasts the timeout fails closed with a clean, token-free error", async () => {
  // A server that accepts the connection but never responds within the timeout window.
  await withServer(
    () => {
      /* never call res.end — hang forever */
    },
    async (baseUrl) => {
      const client = new XCloudClient("pat-secret-123", baseUrl, 50);
      await assert.rejects(client.whoami(), (err: Error) => {
        assert.match(err.message, /timed out/i);
        assert.doesNotMatch(err.message, /pat-secret-123/);
        return true;
      });
    },
  );
});
