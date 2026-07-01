import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { XCloudClient } from "./client.ts";
import { buildServer, type DestructiveConfig } from "./server.ts";

/** How a destructive test drives the seam: opt-in state + how the client answers elicitation. */
type CallOpts = {
  destructive?: DestructiveConfig;
  /** The client's elicitation reply; omitted means the client offers no consent channel at all. */
  elicit?: "accept" | "decline" | "cancel";
};

/** Drive any tool through the MCP seam against a faked xCloud HTTP boundary. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  handler: http.RequestListener,
  opts: CallOpts = {},
): Promise<CallToolResult> {
  const fake = http.createServer(handler);
  fake.listen(0);
  await once(fake, "listening");
  const { port } = fake.address() as import("node:net").AddressInfo;
  const server = buildServer(
    new XCloudClient("pat-secret-123", `http://127.0.0.1:${port}/api/v1`),
    opts.destructive,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-harness", version: "0" },
    opts.elicit ? { capabilities: { elicitation: {} } } : undefined,
  );
  if (opts.elicit) {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: opts.elicit! }));
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
    // Destroy keep-alive sockets and await the close: fetch (undici) pools
    // connections by host:port, so a lingering socket on a recycled ephemeral
    // port would let the next test's request hit this closed-over handler.
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
}

/** The tool names the model would see, given a destructive opt-in state. No HTTP needed. */
async function toolNames(destructive?: DestructiveConfig): Promise<string[]> {
  const server = buildServer(new XCloudClient("pat", "http://127.0.0.1:1/api/v1"), destructive);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-harness", version: "0" });
  await server.connect(st);
  await client.connect(ct);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

/** `list_servers` takes no arguments — the original tracer-bullet seam. */
const callListServers = (handler: http.RequestListener) => callTool("list_servers", {}, handler);

/** The text payload of a tool result, as the model would receive it. */
function resultText(result: CallToolResult): string {
  return (result.content as { type: string; text: string }[])[0].text;
}

test("list_servers returns the caller's servers and authenticates with the PAT", async () => {
  let seenAuth: string | undefined;
  let seenPath: string | undefined;
  const result = await callListServers((req, res) => {
    seenAuth = req.headers.authorization;
    seenPath = req.url;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Servers retrieved successfully.",
        data: {
          items: [{ uuid: "a1b2", name: "web-1", status: "active", ip_address: "203.0.113.42" }],
          pagination: { total: 1, per_page: 10, current_page: 1, last_page: 1 },
        },
      }),
    );
  });

  // The PAT was injected as a Bearer header on the call to /servers.
  assert.equal(seenPath, "/api/v1/servers");
  assert.equal(seenAuth, "Bearer pat-secret-123");

  // The server is observable in the tool result the model would receive, in the
  // consistent items[] + pagination{} shape (not the documented data/meta).
  const parsed = JSON.parse(resultText(result)) as {
    items: { name: string }[];
    pagination: unknown;
  };
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].name, "web-1");
  assert.deepEqual(parsed.pagination, {
    total: 1,
    per_page: 10,
    current_page: 1,
    last_page: 1,
  });
});

test("list_servers backs off and retries after a 429, then succeeds", async () => {
  let calls = 0;
  const result = await callListServers((req, res) => {
    calls++;
    res.setHeader("content-type", "application/json");
    if (calls === 1) {
      res.statusCode = 429;
      res.setHeader("Retry-After", "0");
      res.end(JSON.stringify({ success: false, message: "Too Many Requests" }));
      return;
    }
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: {
          items: [{ uuid: "a1", name: "web-1" }],
          pagination: { total: 1, per_page: 10, current_page: 1, last_page: 1 },
        },
      }),
    );
  });

  // The 429 triggered exactly one retry, and the retry's success is what the model sees.
  assert.equal(calls, 2);
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { items: { name: string }[] };
  assert.equal(parsed.items[0].name, "web-1");
});

test("list_servers gives up on a persistent 429 with a clean, bounded rate-limit error", async () => {
  let calls = 0;
  const result = await callListServers((req, res) => {
    calls++;
    res.statusCode = 429;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, message: "Too Many Requests" }));
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /rate limit/i);
  // It retried, but a bounded number of times — it did not hammer xCloud forever.
  assert.ok(calls > 1, "should have retried at least once");
  assert.ok(calls <= 4, "retries must be bounded");
});

test("list_servers maps a 504 to a clear transient error without choking on a non-JSON body", async () => {
  const result = await callListServers((req, res) => {
    res.statusCode = 504;
    res.setHeader("content-type", "text/html");
    res.end("<html><body>504 Gateway Timeout</body></html>");
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /timed out|timeout|gateway/i);
});

test("list_servers maps a 405 to a clear method error, not xCloud's misleading 'Server Error'", async () => {
  const result = await callListServers((req, res) => {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, message: "Server Error" }));
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /method/i);
  assert.doesNotMatch(resultText(result), /server error/i);
});

test("list_servers maps a 403 to a clear insufficient-scope error", async () => {
  const result = await callListServers((req, res) => {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, message: "This action is unauthorized." }));
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /scope/i);
});

test("list_servers maps a 404 to a clear not-found error that hints at team scoping", async () => {
  const result = await callListServers((req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain");
    res.end("Not Found");
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.match(resultText(result), /team/i);
});

test("list_servers maps a 422 to a clear validation error", async () => {
  const result = await callListServers((req, res) => {
    res.statusCode = 422;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: false,
        message: "The given data was invalid.",
        errors: { per_page: ["The per page must not be greater than 100."] },
      }),
    );
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /validation|invalid/i);
});

test("list_servers treats a 200 with data:null as 'none' — an empty list, not an error", async () => {
  const result = await callListServers((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "No servers", data: null }));
  });

  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { items: unknown[] };
  assert.deepEqual(parsed.items, []);
});

test("the PAT never leaks into a tool result or a stderr log line", async () => {
  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let result: CallToolResult;
  try {
    result = await callListServers((req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: false, message: "Server Error" }));
    });
  } finally {
    process.stderr.write = original;
  }

  // The token must appear in neither the error the model sees nor anything written to logs.
  assert.equal(result.isError, true);
  assert.doesNotMatch(resultText(result), /pat-secret-123/);
  assert.doesNotMatch(captured.join(""), /pat-secret-123/);
});

const UUID = "1a2b3c4d-5e6f-7890-abcd-ef1234567890";

test("get_server returns a single server's detail for its uuid", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("get_server", { server: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Server retrieved successfully.",
        data: {
          uuid: UUID,
          name: "web-1",
          status: "active",
          stack: "openlitespeed",
          ubuntu_version: "24.04",
          php_version: "8.4",
        },
      }),
    );
  });

  assert.equal(seenPath, `/api/v1/servers/${UUID}`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  const parsed = JSON.parse(resultText(result)) as { name: string; stack: string };
  assert.equal(parsed.name, "web-1");
  assert.equal(parsed.stack, "openlitespeed");
});

test("get_server_health surfaces CPU, memory and disk from the monitoring snapshot", async () => {
  let seenPath: string | undefined;
  const result = await callTool("get_server_health", { server: UUID }, (req, res) => {
    seenPath = req.url;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: {
          cpu: { cores: 4, usedPercent: 17.5, load: [0.2, 0.3, 0.1] },
          memory: { used: 2048, total: 8192, percent: 25 },
          disk: [{ mountPoint: "/", used: 12, total: 80, usedPercent: 15 }],
          recorded_at: "2026-06-30T12:18:31Z",
        },
      }),
    );
  });

  assert.equal(seenPath, `/api/v1/servers/${UUID}/monitoring`);
  const parsed = JSON.parse(resultText(result)) as {
    cpu: { usedPercent: number };
    memory: { percent: number };
    disk: { mountPoint: string }[];
  };
  assert.equal(parsed.cpu.usedPercent, 17.5);
  assert.equal(parsed.memory.percent, 25);
  assert.equal(parsed.disk[0].mountPoint, "/");
});

/** Reply to a paginated list request with one item. */
function oneSite(res: import("node:http").ServerResponse): void {
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      success: true,
      message: "ok",
      data: {
        items: [{ uuid: UUID, name: "blog", type: "wordpress", status: "active" }],
        pagination: { total: 1, per_page: 10, current_page: 1, last_page: 1 },
      },
    }),
  );
}

test("list_sites returns the items[] + pagination{} shape with no filters applied", async () => {
  let seenUrl: string | undefined;
  const result = await callTool("list_sites", {}, (req, res) => {
    seenUrl = req.url;
    oneSite(res);
  });

  // No filters → a bare /sites request, no stray query string.
  assert.equal(seenUrl, "/api/v1/sites");
  const parsed = JSON.parse(resultText(result)) as { items: { name: string }[]; pagination: unknown };
  assert.equal(parsed.items[0].name, "blog");
  assert.ok(parsed.pagination);
});

test("list_sites forwards the server / type / status filters as query params", async () => {
  let seenUrl: string | undefined;
  await callTool(
    "list_sites",
    { server: UUID, type: "wordpress", status: "active" },
    (req, res) => {
      seenUrl = req.url;
      oneSite(res);
    },
  );

  const query = new URL(seenUrl!, "http://x").searchParams;
  assert.equal(query.get("server_uuid"), UUID);
  assert.equal(query.get("type"), "wordpress");
  assert.equal(query.get("status"), "active");
});

test("get_site returns a single site's detail including its status", async () => {
  let seenPath: string | undefined;
  const result = await callTool("get_site", { site: UUID }, (req, res) => {
    seenPath = req.url;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: { uuid: UUID, name: "blog", type: "wordpress", status: "active", server_uuid: "srv-1" },
      }),
    );
  });

  assert.equal(seenPath, `/api/v1/sites/${UUID}`);
  const parsed = JSON.parse(resultText(result)) as { name: string; status: string };
  assert.equal(parsed.name, "blog");
  assert.equal(parsed.status, "active");
});

test("get_site redacts ssh_keypairs (credential material) before the model ever sees it", async () => {
  const result = await callTool("get_site", { site: UUID }, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: {
          uuid: UUID,
          name: "blog",
          status: "active",
          ssh_keypairs: [{ uuid: "kp-1", name: "deploy-key", fingerprint: "SHA256:AbCd" }],
        },
      }),
    );
  });

  // The secret-bearing field is gone entirely; the ordinary detail still comes through.
  const text = resultText(result);
  assert.doesNotMatch(text, /ssh_keypairs|deploy-key|SHA256/, "ssh_keypairs must never reach the model");
  const parsed = JSON.parse(text) as { name: string; status: string; ssh_keypairs?: unknown };
  assert.equal(parsed.ssh_keypairs, undefined);
  assert.equal(parsed.name, "blog");
  assert.equal(parsed.status, "active");
});

test("redaction reaches nested auto_generated passwords, keeping non-secret siblings", async () => {
  const result = await callTool("get_site", { site: UUID }, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: {
          uuid: UUID,
          name: "blog",
          auto_generated: { username: "admin", admin_password: "Xc!9pMnK2v#rT", database_password: "Db#7qWnZ4xA!p" },
        },
      }),
    );
  });

  // The passwords are stripped wherever they nest; the non-secret sibling survives.
  const text = resultText(result);
  assert.doesNotMatch(text, /Xc!9pMnK2v#rT|Db#7qWnZ4xA!p|_password/, "auto-generated passwords must not reach the model");
  const parsed = JSON.parse(text) as { name: string; auto_generated: { username: string; admin_password?: string } };
  assert.equal(parsed.auto_generated.admin_password, undefined);
  assert.equal(parsed.auto_generated.username, "admin");
  assert.equal(parsed.name, "blog");
});

test("list_vulnerabilities returns the team-wide rollup (items + summary)", async () => {
  let seenPath: string | undefined;
  const result = await callTool("list_vulnerabilities", {}, (req, res) => {
    seenPath = req.url;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: {
          items: [{ id: "v1", severity: "high", source: "wordfence" }],
          pagination: { total: 1, per_page: 10, current_page: 1, last_page: 1 },
          summary: {
            total: 1,
            by_severity: { high: 1 },
            by_source: { patchstack: 0, wordfence: 1 },
            site_count_with_vulnerabilities: 1,
          },
        },
      }),
    );
  });

  // The team rollup endpoint, not a per-site one.
  assert.equal(seenPath, "/api/v1/vulnerabilities");
  const parsed = JSON.parse(resultText(result)) as {
    items: { severity: string }[];
    summary: { site_count_with_vulnerabilities: number };
  };
  assert.equal(parsed.items[0].severity, "high");
  assert.equal(parsed.summary.site_count_with_vulnerabilities, 1);
});

test("list_vulnerabilities drills into one site's findings when given a site uuid", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("list_vulnerabilities", { site: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: {
          items: [{ id: "v2", severity: "critical", source: "patchstack" }],
          pagination: { total: 1, per_page: 10, current_page: 1, last_page: 1 },
          summary: { total: 1, by_severity: { critical: 1 }, by_source: { patchstack: 1, wordfence: 0 } },
        },
      }),
    );
  });

  // The per-site endpoint, not the team-wide rollup — authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/sites/${UUID}/vulnerabilities`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as {
    items: { severity: string }[];
    summary: { by_severity: { critical: number } };
  };
  assert.equal(parsed.items[0].severity, "critical");
  assert.equal(parsed.summary.by_severity.critical, 1);
});

test("list_vulnerabilities on an unknown site uuid returns a clear not-found tool error", async () => {
  const result = await callTool("list_vulnerabilities", { site: UUID }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain");
    res.end("Not Found");
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
});

test("list_wordpress_updates returns pending core/plugin/theme updates for a site", async () => {
  let seenPath: string | undefined;
  const result = await callTool("list_wordpress_updates", { site: UUID }, (req, res) => {
    seenPath = req.url;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: {
          site_uuid: UUID,
          core: { update_available: false },
          plugins: { total: 1, items: [{ slug: "akismet", available_version: "5.4" }] },
          themes: { total: 0, items: [] },
          summary: { total_pending: 1, security_pending: 0, last_scanned_at: "2026-06-30T12:21:27Z" },
        },
      }),
    );
  });

  assert.equal(seenPath, `/api/v1/sites/${UUID}/wordpress/updates`);
  const parsed = JSON.parse(resultText(result)) as {
    plugins: { items: { slug: string }[] };
    summary: { total_pending: number };
  };
  assert.equal(parsed.plugins.items[0].slug, "akismet");
  assert.equal(parsed.summary.total_pending, 1);
});

test("get_backup_status returns the site's local and remote backup state", async () => {
  let seenPath: string | undefined;
  const result = await callTool("get_backup_status", { site: UUID }, (req, res) => {
    seenPath = req.url;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: {
          local: { configured: true, active: true, status: "ok", last_backup_at: "2026-06-30T01:00:00Z" },
          remote: { configured: false, storage_provider: null },
        },
      }),
    );
  });

  assert.equal(seenPath, `/api/v1/sites/${UUID}/backup-status`);
  const parsed = JSON.parse(resultText(result)) as {
    local: { status: string };
    remote: { configured: boolean };
  };
  assert.equal(parsed.local.status, "ok");
  assert.equal(parsed.remote.configured, false);
});

test("get_cache_settings returns a site's caching configuration for its uuid", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("get_cache_settings", { site: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Cache settings retrieved successfully.",
        data: {
          stack: "openlitespeed",
          page_cache: { enabled: true, source: "lsws", plugin: "litespeed-cache" },
          object_cache: { redis: true, object_cache_pro: false },
          cloudflare_edge_cache: { enabled: false },
        },
      }),
    );
  });

  // A read GET against the site's cache-settings endpoint, authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/sites/${UUID}/cache/settings`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The caching configuration reaches the model in the captured shape.
  const parsed = JSON.parse(resultText(result)) as {
    stack: string;
    page_cache: { enabled: boolean; source: string };
    object_cache: { redis: boolean };
    cloudflare_edge_cache: { enabled: boolean };
  };
  assert.equal(parsed.stack, "openlitespeed");
  assert.equal(parsed.page_cache.enabled, true);
  assert.equal(parsed.page_cache.source, "lsws");
  assert.equal(parsed.object_cache.redis, true);
  assert.equal(parsed.cloudflare_edge_cache.enabled, false);
});

test("get_cache_settings on an unknown/other-team site uuid returns a clear, token-free not-found error", async () => {
  const result = await callTool("get_cache_settings", { site: UUID }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain");
    res.end("Not Found");
  });

  // Team scoping surfaces as a clean not-found tool error that never leaks the PAT.
  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.doesNotMatch(resultText(result), /pat-secret-123/);
});

test("get_ssh_restriction_status returns a server's SSH lockdown posture, missing_ips and all", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("get_ssh_restriction_status", { server: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "SSH restriction status retrieved successfully.",
        data: {
          caller_ip: "203.0.113.42",
          caller_ip_whitelisted: false,
          xcloud_ips_status: {
            all_whitelisted: false,
            missing_ips: ["1.2.3.4", "5.6.7.8"],
            not_configured: false,
          },
          jumpbox_ip: "1.2.3.4",
        },
      }),
    );
  });

  // A read GET against the server's ssh-restriction-status endpoint, authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/servers/${UUID}/firewall/ssh-restriction-status`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The lockdown posture — including which xCloud IPs are still missing — reaches the model.
  const parsed = JSON.parse(resultText(result)) as {
    caller_ip: string;
    caller_ip_whitelisted: boolean;
    xcloud_ips_status: { all_whitelisted: boolean; missing_ips: string[]; not_configured: boolean };
    jumpbox_ip: string;
  };
  assert.equal(parsed.caller_ip, "203.0.113.42");
  assert.equal(parsed.caller_ip_whitelisted, false);
  assert.equal(parsed.xcloud_ips_status.all_whitelisted, false);
  assert.deepEqual(parsed.xcloud_ips_status.missing_ips, ["1.2.3.4", "5.6.7.8"]);
  assert.equal(parsed.jumpbox_ip, "1.2.3.4");
});

test("get_ssh_restriction_status on an unknown/other-team server uuid returns a clear, token-free not-found error", async () => {
  const result = await callTool("get_ssh_restriction_status", { server: UUID }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain");
    res.end("Not Found");
  });

  // Team scoping surfaces as a clean not-found tool error that never leaks the PAT.
  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.doesNotMatch(resultText(result), /pat-secret-123/);
});

test("get_site_logs defaults to access logs (type=access on the access-logs endpoint)", async () => {
  let seenUrl: string | undefined;
  const result = await callTool("get_site_logs", { site: UUID }, (req, res) => {
    seenUrl = req.url;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: { site: UUID, type: "access", limit: 100, entry_count: 1, entries: [{ ip: "203.0.113.7", path: "/" }] },
      }),
    );
  });

  const url = new URL(seenUrl!, "http://x");
  assert.equal(url.pathname, `/api/v1/sites/${UUID}/access-logs`);
  assert.equal(url.searchParams.get("type"), "access");
  const parsed = JSON.parse(resultText(result)) as { entries: { path: string }[] };
  assert.equal(parsed.entries[0].path, "/");
});

test("get_site_logs type=nginx reads the web-server error log via the access-logs endpoint", async () => {
  let seenUrl: string | undefined;
  await callTool("get_site_logs", { site: UUID, type: "nginx" }, (req, res) => {
    seenUrl = req.url;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "ok", data: { entries: [] } }));
  });

  const url = new URL(seenUrl!, "http://x");
  assert.equal(url.pathname, `/api/v1/sites/${UUID}/access-logs`);
  assert.equal(url.searchParams.get("type"), "nginx");
});

test("get_site_logs rejects an invalid log type (e.g. 'error') at the boundary", async () => {
  let reached = false;
  const result = await callTool("get_site_logs", { site: UUID, type: "error" }, () => {
    reached = true;
  });

  // 'error' is not a real xCloud log type — it is caught at the seam, never sent.
  assert.equal(result.isError, true);
  assert.equal(reached, false);
});

test("get_site_logs type=events reads the site events endpoint, not access-logs", async () => {
  let seenPath: string | undefined;
  const result = await callTool("get_site_logs", { site: UUID, type: "events" }, (req, res) => {
    seenPath = req.url;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: {
          items: [{ uuid: "e1", action: "backup", output: null }],
          pagination: { total: 1, per_page: 10, current_page: 1, last_page: 1 },
        },
      }),
    );
  });

  assert.equal(seenPath, `/api/v1/sites/${UUID}/events`);
  const parsed = JSON.parse(resultText(result)) as { items: { action: string }[] };
  assert.equal(parsed.items[0].action, "backup");
});

/** Read a request body to a string (write tools POST a JSON body). */
async function readBody(req: http.IncomingMessage): Promise<string> {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data;
}

test("create_backup POSTs a local backup and returns xCloud's confirmation message", async () => {
  const seen: { path?: string; method?: string; auth?: string; body?: string } = {};
  const result = await callTool("create_backup", { site: UUID }, async (req, res) => {
    seen.path = req.url;
    seen.method = req.method;
    seen.auth = req.headers.authorization;
    seen.body = await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "Backup started successfully", data: null }));
  });

  // A POST to the site's backup endpoint, authenticated, defaulting to a local backup.
  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/sites/${UUID}/backup`);
  assert.equal(seen.auth, "Bearer pat-secret-123");
  assert.deepEqual(JSON.parse(seen.body!), { type: "local" });

  // The model receives xCloud's own confirmation message, not an error.
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { message: string };
  assert.match(parsed.message, /backup started/i);
});

test("run_vulnerability_scan queues a scan (202) and returns a state the model can explain", async () => {
  const seen: { path?: string; method?: string; body?: string } = {};
  const result = await callTool("run_vulnerability_scan", { site: UUID }, async (req, res) => {
    seen.path = req.url;
    seen.method = req.method;
    seen.body = await readBody(req);
    res.statusCode = 202;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Vulnerability scan queued.",
        data: { site: { uuid: UUID, name: "blog" }, scan_queued_at: "2026-06-30T12:30:00Z" },
      }),
    );
  });

  // A bodyless POST to the scan endpoint; the 202 is a success, not an error.
  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/sites/${UUID}/vulnerability-scan`);
  assert.equal(seen.body, "");
  assert.notEqual(result.isError, true);

  // The queued signal (message + when) reaches the model.
  const parsed = JSON.parse(resultText(result)) as { message: string; data: { scan_queued_at: string } };
  assert.match(parsed.message, /queued/i);
  assert.equal(parsed.data.scan_queued_at, "2026-06-30T12:30:00Z");
});

test("run_pagespeed_scan queues a mobile+desktop scan (202) and returns its scan_uuid", async () => {
  const seen: { path?: string; method?: string; body?: string } = {};
  const result = await callTool("run_pagespeed_scan", { site: UUID }, async (req, res) => {
    seen.path = req.url;
    seen.method = req.method;
    seen.body = await readBody(req);
    res.statusCode = 202;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "PageSpeed scan queued.",
        data: {
          site: { uuid: UUID, name: "blog" },
          scan_uuid: "f8a9c2d1-1234-4abc-9def-1234567890ab",
          strategies: ["mobile", "desktop"],
          scan_queued_at: "2026-06-30T12:31:00Z",
        },
      }),
    );
  });

  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/sites/${UUID}/pagespeed/scan`);
  assert.equal(seen.body, "");
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as {
    message: string;
    data: { scan_uuid: string; strategies: string[] };
  };
  assert.match(parsed.message, /queued/i);
  assert.equal(parsed.data.scan_uuid, "f8a9c2d1-1234-4abc-9def-1234567890ab");
  assert.deepEqual(parsed.data.strategies, ["mobile", "desktop"]);
});

test("purge_cache dispatches a full-page purge (202, data:null) and relays the message, not an error", async () => {
  const seen: { path?: string; method?: string } = {};
  const result = await callTool("purge_cache", { site: UUID }, async (req, res) => {
    seen.path = req.url;
    seen.method = req.method;
    res.statusCode = 202;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "Cache purge dispatched", data: null }));
  });

  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/sites/${UUID}/cache/purge`);

  // data is null for this op, so the message carries the whole signal — and a null
  // data must not be mistaken for an error.
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { message: string; data: unknown };
  assert.match(parsed.message, /purge/i);
  assert.equal(parsed.data, null);
});

test("purge_cache with layers=all dispatches a purge-all (202) and returns the per-layer cache map", async () => {
  const seen: { path?: string; method?: string; body?: string } = {};
  const result = await callTool("purge_cache", { site: UUID, layers: "all" }, async (req, res) => {
    seen.path = req.url;
    seen.method = req.method;
    seen.body = await readBody(req);
    res.statusCode = 202;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "All caches purge dispatched",
        data: {
          site: { uuid: UUID, name: "blog" },
          caches: {
            object_cache: "queued",
            cloudflare_edge: "skipped",
            redis_object_cache: "queued",
            object_cache_pro: "skipped",
          },
        },
      }),
    );
  });

  // layers=all routes to the per-layer purge-all endpoint with a bodyless POST.
  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/sites/${UUID}/cache/purge-all`);
  assert.equal(seen.body, "");
  assert.notEqual(result.isError, true);

  // The per-layer queued|skipped map reaches the model verbatim.
  const parsed = JSON.parse(resultText(result)) as {
    message: string;
    data: { caches: { object_cache: string; cloudflare_edge: string } };
  };
  assert.match(parsed.message, /purge/i);
  assert.equal(parsed.data.caches.object_cache, "queued");
  assert.equal(parsed.data.caches.cloudflare_edge, "skipped");
});

test("purge_cache layers=all on an unknown/other-team site uuid returns a clear, token-free not-found error", async () => {
  const result = await callTool("purge_cache", { site: UUID, layers: "all" }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain");
    res.end("Not Found");
  });

  // Team scoping surfaces as a clean not-found tool error that never leaks the PAT.
  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.doesNotMatch(resultText(result), /pat-secret-123/);
});

test("apply_wordpress_updates queues an update for the named slugs and returns the operation", async () => {
  const seen: { path?: string; method?: string; body?: string } = {};
  const result = await callTool(
    "apply_wordpress_updates",
    { site: UUID, type: "plugin", slugs: ["woocommerce"] },
    async (req, res) => {
      seen.path = req.url;
      seen.method = req.method;
      seen.body = await readBody(req);
      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          success: true,
          message: "WordPress update queued.",
          data: {
            operation: { uuid: "8c5d7e8a-1234-4abc-9def-1234567890ab", status: "queued", operation_type: "update" },
            queued_items: [{ slug: "woocommerce", type: "plugin" }],
            skipped_items: [],
            backup_before_update: false,
          },
        }),
      );
    },
  );

  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/sites/${UUID}/wordpress/update`);
  assert.deepEqual(JSON.parse(seen.body!), { type: "plugin", slugs: ["woocommerce"] });
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { message: string; data: { operation: { uuid: string } } };
  assert.match(parsed.message, /queued/i);
  assert.equal(parsed.data.operation.uuid, "8c5d7e8a-1234-4abc-9def-1234567890ab");
});

test("apply_wordpress_updates omits slugs to update all of a type, forwarding backup_before_update", async () => {
  let seenBody: string | undefined;
  await callTool(
    "apply_wordpress_updates",
    { site: UUID, type: "core", backup_before_update: true },
    async (req, res) => {
      seenBody = await readBody(req);
      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, message: "WordPress update queued.", data: { operation: {} } }));
    },
  );

  // No slugs key at all (omitted → xCloud updates every updatable item of the type); the
  // backup flag is forwarded as given.
  assert.deepEqual(JSON.parse(seenBody!), { type: "core", backup_before_update: true });
});

test("apply_wordpress_updates rejects an empty slugs list at the boundary (xCloud would 422 it)", async () => {
  let reached = false;
  const result = await callTool(
    "apply_wordpress_updates",
    { site: UUID, type: "plugin", slugs: [] },
    () => {
      reached = true;
    },
  );

  // minItems is enforced at the seam: an empty slugs array never reaches xCloud.
  assert.equal(result.isError, true);
  assert.equal(reached, false);
});

test("activate_wordpress_extensions queues an activate for the named slugs and returns the operation", async () => {
  const seen: { path?: string; method?: string; body?: string } = {};
  const result = await callTool(
    "activate_wordpress_extensions",
    { site: UUID, type: "plugin", slugs: ["woocommerce"] },
    async (req, res) => {
      seen.path = req.url;
      seen.method = req.method;
      seen.body = await readBody(req);
      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          success: true,
          message: "WordPress activation queued.",
          data: {
            operation: {
              uuid: "8c5d7e8a-1234-4abc-9def-1234567890ab",
              status: "queued",
              operation_type: "toggle",
              action: "activate",
            },
            queued_items: [{ slug: "woocommerce", title: "WooCommerce", type: "plugin" }],
            skipped_items: [],
            backup_before_action: false,
          },
        }),
      );
    },
  );

  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/sites/${UUID}/wordpress/activate`);
  // No backup_before_action key when the caller didn't ask for one (matches the sibling's omit).
  assert.deepEqual(JSON.parse(seen.body!), { type: "plugin", slugs: ["woocommerce"] });
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { message: string; data: { operation: { uuid: string } } };
  assert.match(parsed.message, /queued/i);
  assert.equal(parsed.data.operation.uuid, "8c5d7e8a-1234-4abc-9def-1234567890ab");
});

test("activate_wordpress_extensions forwards backup_before_action when asked to back up first", async () => {
  let seenBody: string | undefined;
  await callTool(
    "activate_wordpress_extensions",
    { site: UUID, type: "theme", slugs: ["twentytwentyfour"], backup_before_action: true },
    async (req, res) => {
      seenBody = await readBody(req);
      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, message: "WordPress activation queued.", data: { operation: {} } }));
    },
  );

  // The backup flag rides along in the body verbatim.
  assert.deepEqual(JSON.parse(seenBody!), { type: "theme", slugs: ["twentytwentyfour"], backup_before_action: true });
});

test("activate_wordpress_extensions surfaces skipped_items with their reasons (already-active and unknown slug)", async () => {
  const result = await callTool(
    "activate_wordpress_extensions",
    { site: UUID, type: "plugin", slugs: ["woocommerce", "akismet", "nonexistent-plugin"] },
    (_req, res) => {
      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          success: true,
          message: "WordPress activation queued.",
          data: {
            operation: { uuid: "op-1", status: "queued", operation_type: "toggle", action: "activate" },
            queued_items: [{ slug: "woocommerce", type: "plugin" }],
            skipped_items: [
              { slug: "akismet", reason: "already_active" },
              { slug: "nonexistent-plugin", reason: "cannot_activate" },
            ],
            backup_before_action: false,
          },
        }),
      );
    },
  );

  assert.notEqual(result.isError, true);
  // The model must see *why* each item didn't activate — the reasons pass through untouched.
  const parsed = JSON.parse(resultText(result)) as {
    data: { skipped_items: { slug: string; reason: string }[] };
  };
  assert.deepEqual(parsed.data.skipped_items, [
    { slug: "akismet", reason: "already_active" },
    { slug: "nonexistent-plugin", reason: "cannot_activate" },
  ]);
});

test("activate_wordpress_extensions rejects an empty slugs list at the boundary (xCloud would 422 it)", async () => {
  let reached = false;
  const result = await callTool(
    "activate_wordpress_extensions",
    { site: UUID, type: "plugin", slugs: [] },
    () => {
      reached = true;
    },
  );

  // minItems is enforced at the seam: an empty slugs array never reaches xCloud.
  assert.equal(result.isError, true);
  assert.equal(reached, false);
});

const MAGIC_URL =
  "https://blog.example/wp-admin/wp-login.php?xcloud_magic_login_token=eyJhbGc.SECRET&auth_token=Xa3p9q&v=1742212211";

test("magic_login returns the login URL to the model but never writes it to a log", async () => {
  const seen: { path?: string; method?: string } = {};
  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let result: CallToolResult;
  try {
    result = await callTool("magic_login", { site: UUID }, (req, res) => {
      seen.path = req.url;
      seen.method = req.method;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          success: true,
          message: "Magic login URL generated",
          data: { url: MAGIC_URL, expires_at: "2026-06-30T13:00:00Z", admin_user: "admin" },
        }),
      );
    });
  } finally {
    process.stderr.write = original;
  }

  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/sites/${UUID}/magic-login`);

  // The URL IS the intended output — it reaches the model verbatim, unredacted.
  const parsed = JSON.parse(resultText(result)) as { data: { url: string } };
  assert.equal(parsed.data.url, MAGIC_URL);

  // …but it is sensitive: nothing wrote it to a log line.
  assert.doesNotMatch(captured.join(""), /xcloud_magic_login_token/);
});

test("magic_login forwards login_as when delegating, and sends no body otherwise", async () => {
  let delegatedBody: string | undefined;
  await callTool("magic_login", { site: UUID, login_as: "editor_user" }, async (req, res) => {
    delegatedBody = await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "ok", data: { url: MAGIC_URL } }));
  });
  assert.deepEqual(JSON.parse(delegatedBody!), { login_as: "editor_user" });

  let plainBody: string | undefined;
  await callTool("magic_login", { site: UUID }, async (req, res) => {
    plainBody = await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "ok", data: { url: MAGIC_URL } }));
  });
  // No login_as → a bodyless POST (logs in as the site's own admin).
  assert.equal(plainBody, "");
});

test("an over-long uuid is rejected at the boundary before any HTTP call", async () => {
  let reached = false;
  const result = await callTool("get_site", { site: "x".repeat(101) }, () => {
    reached = true;
  });

  // The length cap bit at the seam: a validation error, and the faked xCloud was never contacted.
  assert.equal(result.isError, true);
  assert.match(resultText(result), /validation/i);
  assert.equal(reached, false);
});

test("a uuid carrying path traversal is percent-encoded into a single safe path segment", async () => {
  let seenPath: string | undefined;
  await callTool("get_site", { site: "a/../../user" }, (req, res) => {
    seenPath = req.url;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "ok", data: {} }));
  });

  // The slashes are encoded, so the value stays one segment under /sites/ — it can
  // never escape to another endpoint like /user.
  assert.equal(seenPath, "/api/v1/sites/a%2F..%2F..%2Fuser");
  assert.doesNotMatch(seenPath!, /\/\.\.\//);
});

test("list_cron_jobs returns a server's cron jobs, with each job's uuid reaching the model", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("list_cron_jobs", { server: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        data: {
          items: [
            {
              uuid: CRON_UUID,
              command: "php artisan schedule:run",
              user: "root",
              frequency: "every_minute",
              frequency_label: "Every Minute",
              pattern: "* * * * *",
              status: "active",
            },
          ],
          pagination: { total: 1, per_page: 10, current_page: 1, last_page: 1 },
        },
      }),
    );
  });

  // A read GET against the server's cron-jobs collection, authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/servers/${UUID}/cron-jobs`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The job — including the uuid delete_cron_job needs — is in the tool result the model sees.
  const parsed = JSON.parse(resultText(result)) as {
    items: { uuid: string; command: string }[];
    pagination: { total: number };
  };
  assert.equal(parsed.pagination.total, 1);
  assert.equal(parsed.items[0].uuid, CRON_UUID);
  assert.equal(parsed.items[0].command, "php artisan schedule:run");
});

test("list_cron_jobs reads a site's cron collection when given a site instead of a server", async () => {
  let seenPath: string | undefined;
  const result = await callTool("list_cron_jobs", { site: UUID }, (req, res) => {
    seenPath = req.url;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        data: {
          items: [
            {
              uuid: CRON_UUID,
              command: "wp cron event run --due-now",
              user: "blog_user",
              frequency: "every_five_minutes",
              frequency_label: "Every Five Minutes",
              pattern: "4,9,14,19,24,29,34,39,44,49,54,59 * * * *",
              status: "active",
            },
          ],
          pagination: { total: 1, per_page: 10, current_page: 1, last_page: 1 },
        },
      }),
    );
  });

  // The site base, not the server base — cron jobs live under both.
  assert.equal(seenPath, `/api/v1/sites/${UUID}/cron-jobs`);
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { items: { uuid: string }[] };
  assert.equal(parsed.items[0].uuid, CRON_UUID);
});

test("list_cron_jobs requires exactly one of server or site — rejects both and neither at the seam", async () => {
  let reached = false;
  const record = (): void => {
    reached = true;
  };

  const neither = await callTool("list_cron_jobs", {}, record);
  assert.equal(neither.isError, true);
  assert.match(resultText(neither), /server|site/i);

  const both = await callTool("list_cron_jobs", { server: UUID, site: UUID }, record);
  assert.equal(both.isError, true);

  // Neither malformed call was ever sent to xCloud.
  assert.equal(reached, false);
});

test("list_cron_jobs maps xCloud's 'none' (200 + data:null) to an empty config collection, not a bare null", async () => {
  const result = await callTool("list_cron_jobs", { server: UUID }, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "No cron jobs", data: null }));
  });

  // A parent with no cron jobs reads as an empty collection the model can reason about.
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { items: unknown[]; pagination: { total: number } };
  assert.deepEqual(parsed.items, []);
  assert.equal(parsed.pagination.total, 0);
});

test("get_cron_job_output returns a server-scoped cron job's last-run output", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool(
    "get_cron_job_output",
    { server: UUID, cron_job: CRON_UUID },
    (req, res) => {
      seenPath = req.url;
      seenAuth = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          success: true,
          message: "Success",
          data: { output: "Mon Jun 30 12:00:01 UTC 2026\nschedule:run done\n" },
        }),
      );
    },
  );

  // A read GET against the server-scoped cron job's output endpoint, authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/servers/${UUID}/cron-jobs/${CRON_UUID}/output`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The job's output string reaches the model in the captured `{output}` shape.
  const parsed = JSON.parse(resultText(result)) as { output: string };
  assert.match(parsed.output, /schedule:run done/);
});

test("get_cron_job_output reads a site's cron output when given a site instead of a server", async () => {
  let seenPath: string | undefined;
  const result = await callTool(
    "get_cron_job_output",
    { site: UUID, cron_job: CRON_UUID },
    (req, res) => {
      seenPath = req.url;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          success: true,
          message: "Success",
          data: { output: "wp cron ran\n" },
        }),
      );
    },
  );

  // The site base, not the server base — cron jobs live under both.
  assert.equal(seenPath, `/api/v1/sites/${UUID}/cron-jobs/${CRON_UUID}/output`);
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { output: string };
  assert.match(parsed.output, /wp cron ran/);
});

test("get_cron_job_output requires exactly one of server or site — rejects both and neither at the seam", async () => {
  let reached = false;
  const record = (): void => {
    reached = true;
  };

  const neither = await callTool("get_cron_job_output", { cron_job: CRON_UUID }, record);
  assert.equal(neither.isError, true);
  assert.match(resultText(neither), /server|site/i);

  const both = await callTool(
    "get_cron_job_output",
    { server: UUID, site: UUID, cron_job: CRON_UUID },
    record,
  );
  assert.equal(both.isError, true);

  // Neither malformed call was ever sent to xCloud.
  assert.equal(reached, false);
});

test("get_cron_job_output surfaces the 'not found' body of a never-run job as output, not an error", async () => {
  const result = await callTool(
    "get_cron_job_output",
    { server: UUID, cron_job: CRON_UUID },
    (req, res) => {
      res.setHeader("content-type", "application/json");
      // A job that has not run yet: xCloud still 200s with the literal string as `output`.
      res.end(
        JSON.stringify({
          success: true,
          message: "Success",
          data: { output: "Cron job output file not found" },
        }),
      );
    },
  );

  // The literal "not found" string is legitimate output, never mistaken for a 404 tool error.
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { output: string };
  assert.equal(parsed.output, "Cron job output file not found");
});

// ---- Destructive tools + consent gate (ADR-0004) ----

const ENABLED_NO_CONFIRM: DestructiveConfig = { enabled: true, noConfirm: true };

test("reboot_server (enabled, no consent channel + NO_CONFIRM) POSTs the reboot authenticated", async () => {
  const seen: { path?: string; method?: string; auth?: string } = {};
  const result = await callTool(
    "reboot_server",
    { server: UUID },
    (req, res) => {
      seen.path = req.url;
      seen.method = req.method;
      seen.auth = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, message: "Server reboot initiated", data: null }));
    },
    { destructive: ENABLED_NO_CONFIRM },
  );

  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/servers/${UUID}/reboot`);
  assert.equal(seen.auth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);
  assert.match(JSON.parse(resultText(result)).message, /reboot/i);
});

const DESTRUCTIVE_TOOLS = ["reboot_server", "restart_service", "delete_firewall_rule", "delete_cron_job"];

test("destructive tools are hidden unless the destructive opt-in is set", async () => {
  const off = await toolNames();
  for (const name of DESTRUCTIVE_TOOLS) {
    assert.ok(!off.includes(name), `${name} must be hidden by default`);
  }
  // …while the ordinary read/safe-write tools are still there.
  for (const name of ["list_servers", "get_site", "create_backup", "magic_login"]) {
    assert.ok(off.includes(name), `${name} should still be available`);
  }
});

test("a destructive op with no consent channel fails closed and never reaches xCloud", async () => {
  let reached = false;
  const result = await callTool(
    "reboot_server",
    { server: UUID },
    () => {
      reached = true;
    },
    { destructive: { enabled: true, noConfirm: false } },
  );

  // No elicitation channel and no NO_CONFIRM override → refuse, and the box is never rebooted.
  assert.equal(result.isError, true);
  assert.match(resultText(result), /destructive|confirm/i);
  assert.equal(reached, false);
});

test("with a consent channel, an elicitation 'accept' lets the destructive op run", async () => {
  let reached = false;
  const result = await callTool(
    "reboot_server",
    { server: UUID },
    (req, res) => {
      reached = true;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, message: "Server reboot initiated", data: null }));
    },
    { destructive: { enabled: true, noConfirm: false }, elicit: "accept" },
  );

  assert.equal(reached, true);
  assert.notEqual(result.isError, true);
  assert.match(JSON.parse(resultText(result)).message, /reboot/i);
});

test("with a consent channel, an elicitation 'decline' cancels the op without touching xCloud", async () => {
  let reached = false;
  const result = await callTool(
    "reboot_server",
    { server: UUID },
    () => {
      reached = true;
    },
    { destructive: { enabled: true, noConfirm: false }, elicit: "decline" },
  );

  assert.equal(reached, false);
  assert.match(resultText(result), /cancel/i);
  assert.notEqual(result.isError, true);
});

test("a destructive op on a read-only PAT surfaces a clear insufficient-scope error, not a partial action", async () => {
  let calls = 0;
  const result = await callTool(
    "reboot_server",
    { server: UUID },
    (req, res) => {
      calls++;
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: false, message: "This action is unauthorized." }));
    },
    { destructive: ENABLED_NO_CONFIRM },
  );

  // Consent passed; the token scope is the real boundary — one call, one clean scope error.
  assert.equal(result.isError, true);
  assert.match(resultText(result), /scope/i);
  assert.equal(calls, 1);
});

test("restart_service POSTs the named service to the restart endpoint once consented", async () => {
  const seen: { path?: string; method?: string; body?: string } = {};
  const result = await callTool(
    "restart_service",
    { server: UUID, service: "redis" },
    async (req, res) => {
      seen.path = req.url;
      seen.method = req.method;
      seen.body = await readBody(req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, message: "Service restart dispatched", data: null }));
    },
    { destructive: { enabled: true, noConfirm: false }, elicit: "accept" },
  );

  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/servers/${UUID}/services/restart`);
  assert.deepEqual(JSON.parse(seen.body!), { service: "redis" });
  assert.notEqual(result.isError, true);
});

const RULE_UUID = "9f8e7d6c-1234-4abc-9def-0987654321ba";

test("delete_firewall_rule DELETEs the rule under its server once consented", async () => {
  const seen: { path?: string; method?: string } = {};
  const result = await callTool(
    "delete_firewall_rule",
    { server: UUID, firewall_rule: RULE_UUID },
    (req, res) => {
      seen.path = req.url;
      seen.method = req.method;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, message: "Firewall rule deleted", data: null }));
    },
    { destructive: { enabled: true, noConfirm: false }, elicit: "accept" },
  );

  assert.equal(seen.method, "DELETE");
  assert.equal(seen.path, `/api/v1/servers/${UUID}/firewall-rules/${RULE_UUID}`);
  assert.notEqual(result.isError, true);
  assert.match(JSON.parse(resultText(result)).message, /deleted/i);
});

const CRON_UUID = "3c2b1a09-1234-4abc-9def-abcdef012345";

test("delete_cron_job DELETEs a server-scoped cron job once consented", async () => {
  const seen: { path?: string; method?: string } = {};
  const result = await callTool(
    "delete_cron_job",
    { server: UUID, cron_job: CRON_UUID },
    (req, res) => {
      seen.path = req.url;
      seen.method = req.method;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, message: "Cron job deleted", data: null }));
    },
    { destructive: { enabled: true, noConfirm: false }, elicit: "accept" },
  );

  assert.equal(seen.method, "DELETE");
  assert.equal(seen.path, `/api/v1/servers/${UUID}/cron-jobs/${CRON_UUID}`);
  assert.notEqual(result.isError, true);
});

test("delete_cron_job DELETEs a site-scoped cron job when given a site instead of a server", async () => {
  let seenPath: string | undefined;
  await callTool(
    "delete_cron_job",
    { site: UUID, cron_job: CRON_UUID },
    (req, res) => {
      seenPath = req.url;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, message: "Cron job deleted", data: null }));
    },
    { destructive: { enabled: true, noConfirm: false }, elicit: "accept" },
  );

  assert.equal(seenPath, `/api/v1/sites/${UUID}/cron-jobs/${CRON_UUID}`);
});

test("delete_cron_job requires exactly one of server or site — rejects both and neither at the seam", async () => {
  let reached = false;
  const record = (): void => {
    reached = true;
  };

  const neither = await callTool("delete_cron_job", { cron_job: CRON_UUID }, record, {
    destructive: ENABLED_NO_CONFIRM,
  });
  assert.equal(neither.isError, true);
  assert.match(resultText(neither), /server|site/i);

  const both = await callTool(
    "delete_cron_job",
    { server: UUID, site: UUID, cron_job: CRON_UUID },
    record,
    { destructive: ENABLED_NO_CONFIRM },
  );
  assert.equal(both.isError, true);

  // Neither malformed call was ever sent to xCloud.
  assert.equal(reached, false);
});

test("opting in exposes exactly the four destructive tools", async () => {
  const on = await toolNames(ENABLED_NO_CONFIRM);
  for (const name of DESTRUCTIVE_TOOLS) {
    assert.ok(on.includes(name), `${name} should be exposed when enabled`);
  }
});

test("get_pagespeed returns a site's latest mobile and desktop scores", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("get_pagespeed", { site: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        data: {
          mobile: { score: 72, lcp: 2.4, cls: 0.01, inp: 180 },
          desktop: { score: 95, lcp: 1.1, cls: 0.0, inp: 40 },
        },
      }),
    );
  });

  // A read GET against the site's pagespeed endpoint, authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/sites/${UUID}/pagespeed`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The scores the scan measured — the whole point of run_pagespeed_scan — reach the model.
  const parsed = JSON.parse(resultText(result)) as {
    mobile: { score: number };
    desktop: { score: number };
  };
  assert.equal(parsed.mobile.score, 72);
  assert.equal(parsed.desktop.score, 95);
});

test("get_pagespeed passes null scores through (no scan run yet) without inventing a message", async () => {
  const result = await callTool("get_pagespeed", { site: UUID }, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "Success", data: { mobile: null, desktop: null } }));
  });

  assert.notEqual(result.isError, true);
  // The raw null is the answer ("no scan yet"); the tool must not fabricate a friendlier shape.
  const parsed = JSON.parse(resultText(result)) as { mobile: unknown; desktop: unknown };
  assert.equal(parsed.mobile, null);
  assert.equal(parsed.desktop, null);
});

test("whoami returns the caller's identity and current team, authenticated with the PAT", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("whoami", {}, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        data: {
          uuid: "u-123",
          name: "Ada Lovelace",
          email: "ada@example.com",
          current_team_uuid: "team-abc",
        },
      }),
    );
  });

  // A read GET against /user — the identity endpoint, never /user/tokens — authed with the PAT.
  assert.equal(seenPath, "/api/v1/user");
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The identity + team-isolation boundary reaches the model; the PAT itself never echoes back.
  const text = resultText(result);
  assert.doesNotMatch(text, /pat-secret-123/, "the PAT must never appear in a tool result");
  const parsed = JSON.parse(text) as { name: string; email: string; current_team_uuid: string };
  assert.equal(parsed.name, "Ada Lovelace");
  assert.equal(parsed.email, "ada@example.com");
  assert.equal(parsed.current_team_uuid, "team-abc");
});

test("list_services returns a server's services with name and can_restart intact", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("list_services", { server: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        data: {
          items: [
            { name: "redis", label: "Redis", status: "running", is_required: false, can_restart: true },
            { name: "mysql", label: "MySQL", status: "running", is_required: true, can_restart: true },
          ],
          count: 2,
        },
      }),
    );
  });

  // A read GET against the server's services collection, authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/servers/${UUID}/services`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The name + can_restart that restart_service needs to target a service reach the model.
  const parsed = JSON.parse(resultText(result)) as {
    items: { name: string; can_restart: boolean }[];
    count: number;
  };
  assert.equal(parsed.count, 2);
  assert.equal(parsed.items[0].name, "redis");
  assert.equal(parsed.items[0].can_restart, true);
});

test("list_firewall_rules returns a server's firewall rules with rule uuids intact", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("list_firewall_rules", { server: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        data: {
          items: [
            { uuid: "fw-1", name: "Allow SSH", port: 22, protocol: "tcp", traffic: "allow", is_active: true },
            { uuid: "fw-2", name: "Deny 3306", port: 3306, protocol: "tcp", traffic: "deny", is_active: true },
          ],
          counts: { allow: 1, deny: 1, active: 2, total: 2 },
        },
      }),
    );
  });

  // A read GET against the server's firewall-rules collection, authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/servers/${UUID}/firewall-rules`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The rule uuid delete_firewall_rule needs, plus the allow/deny counts, reach the model.
  const parsed = JSON.parse(resultText(result)) as {
    items: { uuid: string; traffic: string }[];
    counts: { allow: number; deny: number };
  };
  assert.equal(parsed.items[0].uuid, "fw-1");
  assert.equal(parsed.counts.deny, 1);
});

test("list_banned_ips returns the IPs fail2ban has banned on a server (read-only GET)", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  let seenMethod: string | undefined;
  const result = await callTool("list_banned_ips", { server: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    seenMethod = req.method;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        // Live shape: each entry is a {ip, jail} object, not a bare string.
        data: { banned_ips: [{ ip: "45.148.10.240", jail: "sshd" }, { ip: "203.0.113.99", jail: "sshd" }] },
      }),
    );
  });

  // A read GET against the server's fail2ban banned-ips collection, authenticated with the PAT.
  assert.equal(seenMethod, "GET");
  assert.equal(seenPath, `/api/v1/servers/${UUID}/fail2ban/banned-ips`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The banned IPs with the jail that banned each — the whole point ("is my IP banned, and why?")
  // — reach the model intact.
  const parsed = JSON.parse(resultText(result)) as { banned_ips: { ip: string; jail: string }[] };
  assert.deepEqual(parsed.banned_ips, [
    { ip: "45.148.10.240", jail: "sshd" },
    { ip: "203.0.113.99", jail: "sshd" },
  ]);
});

test("list_banned_ips maps xCloud's 'none' (200 + data:null) to an empty banned_ips list, not a bare null", async () => {
  const result = await callTool("list_banned_ips", { server: UUID }, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "No banned IPs", data: null }));
  });

  // A server with nothing banned reads as the same { banned_ips: [] } shape, never a bare null.
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { banned_ips: unknown[] };
  assert.deepEqual(parsed.banned_ips, []);
});

test("list_banned_ips maps an unknown or other-team server (404) to a clear, token-free not-found error", async () => {
  const result = await callTool("list_banned_ips", { server: UUID }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, message: "Resource not found." }));
  });

  // Team isolation: a uuid outside your team is indistinguishable from a nonexistent one, and the
  // error never leaks the PAT.
  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.match(resultText(result), /team/i);
  assert.doesNotMatch(resultText(result), /pat-secret-123/);
});

test("get_ssl returns a site's certificate provider, status, expiry and hostnames", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("get_ssl", { site: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        data: {
          provider: "letsencrypt",
          status: "active",
          expires_at: "2026-09-28T00:00:00Z",
          hostnames: ["blog.example", "www.blog.example"],
        },
      }),
    );
  });

  // A read GET against the site's ssl endpoint, authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/sites/${UUID}/ssl`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The expiry answer — "is my certificate about to expire?" — reaches the model.
  const parsed = JSON.parse(resultText(result)) as {
    provider: string;
    status: string;
    expires_at: string;
    hostnames: string[];
  };
  assert.equal(parsed.status, "active");
  assert.equal(parsed.expires_at, "2026-09-28T00:00:00Z");
  assert.deepEqual(parsed.hostnames, ["blog.example", "www.blog.example"]);
});

test("get_ssl surfaces 'no SSL configured' (200 + data:null) as a null result, not an error", async () => {
  const result = await callTool("get_ssl", { site: UUID }, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "No SSL configured", data: null }));
  });

  // A site without SSL reads as a plain null "none" — never mistaken for a tool error.
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(resultText(result)), null);
});

test("get_ssl maps an unknown or foreign site (404) to a structured not-found error", async () => {
  const result = await callTool("get_ssl", { site: UUID }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, message: "Not Found" }));
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.match(resultText(result), /team/i);
});

test("list_backups returns a site's restore points with their timestamp, destination and total", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("list_backups", { site: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        data: {
          items: [
            {
              id: 12465972,
              file_name: "duplicity-full.20260630T122922Z.manifest",
              file_size: "29.68 MB",
              type: "incremental_full",
              status: "processed",
              is_remote: false,
              created_at: "2026-06-30T12:28:54.000000Z",
            },
          ],
          pagination: { total: 2, per_page: 10, current_page: 1, last_page: 1 },
        },
      }),
    );
  });

  // A read GET against the site's backups collection, authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/sites/${UUID}/backups`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // A restore point (when + local/remote) and the honest "how many backups" total reach the model.
  const parsed = JSON.parse(resultText(result)) as {
    items: { created_at: string; is_remote: boolean }[];
    pagination: { total: number };
  };
  assert.equal(parsed.items[0].created_at, "2026-06-30T12:28:54.000000Z");
  assert.equal(parsed.items[0].is_remote, false);
  assert.equal(parsed.pagination.total, 2);
});

test("list_backups maps a site with no backups (200 + data:null) to an empty paginated list, not a bare null", async () => {
  const result = await callTool("list_backups", { site: UUID }, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "No backups", data: null }));
  });

  // A site that has never been backed up reads as an empty collection with total 0 the model can reason about.
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { items: unknown[]; pagination: { total: number } };
  assert.deepEqual(parsed.items, []);
  assert.equal(parsed.pagination.total, 0);
});

test("list_backups maps an unknown or foreign site (404) to a structured not-found error", async () => {
  const result = await callTool("list_backups", { site: UUID }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, message: "Not Found" }));
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.match(resultText(result), /team/i);
});

test("get_wordpress_status returns a site's WP triage snapshot with the prod-footgun flags intact", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("get_wordpress_status", { site: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        data: {
          wordpress_version: "6.4.2",
          php_version: "8.3",
          multisite_enabled: false,
          wp_debug_enabled: true,
          wp_cron_enabled: false,
          checksum_status: "mismatch",
          last_checksum_at: "2026-06-30T08:00:00Z",
          items_count: { plugins: 7, themes: 3, core: 1 },
          updates_pending: { core: false, plugins: 1, themes: 2 },
          ssl: { enabled: true, provider: "xcloud", expires_at: "2026-08-28T14:10:34+00:00" },
        },
      }),
    );
  });

  // A read GET against the site's wordpress/status endpoint, authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/sites/${UUID}/wordpress/status`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The footguns this tool exists to catch — debug left on, dead wp-cron, bad checksum,
  // pending updates — all reach the model.
  const parsed = JSON.parse(resultText(result)) as {
    wp_debug_enabled: boolean;
    wp_cron_enabled: boolean;
    checksum_status: string;
    updates_pending: { plugins: number };
  };
  assert.equal(parsed.wp_debug_enabled, true);
  assert.equal(parsed.wp_cron_enabled, false);
  assert.equal(parsed.checksum_status, "mismatch");
  assert.equal(parsed.updates_pending.plugins, 1);
});

test("get_wordpress_status maps an unknown or foreign site (404) to a structured not-found error", async () => {
  // A non-WordPress site that exists still 200s with a snapshot (confirmed live); the only
  // real failure path is a site that isn't yours or doesn't exist — xCloud 404s it.
  const result = await callTool("get_wordpress_status", { site: UUID }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, message: "Resource not found." }));
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.match(resultText(result), /team/i);
});

test("list_wordpress_extensions type=plugin lists a site's plugins with slug, status and versions", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("list_wordpress_extensions", { site: UUID, type: "plugin" }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        data: {
          items: [
            {
              slug: "woocommerce",
              name: "WooCommerce",
              status: "active",
              current_version: "8.5.1",
              available_version: "8.6.0",
              update_available: true,
              is_must_use: false,
              is_dropin: false,
              last_checked_at: "2026-06-30T08:00:00Z",
            },
          ],
          pagination: { total: 1, per_page: 10, current_page: 1, last_page: 1 },
          summary: { total: 1, active: 1, with_updates: 1 },
        },
      }),
    );
  });

  // A read GET against the site's wordpress/plugins collection, authenticated with the PAT.
  assert.equal(seenPath, `/api/v1/sites/${UUID}/wordpress/plugins`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The discovery surface for plugin management — slug + active/inactive status + versions —
  // plus the summary reach the model.
  const parsed = JSON.parse(resultText(result)) as {
    items: { slug: string; status: string; update_available: boolean }[];
    summary: { active: number; with_updates: number };
  };
  assert.equal(parsed.items[0].slug, "woocommerce");
  assert.equal(parsed.items[0].status, "active");
  assert.equal(parsed.items[0].update_available, true);
  assert.equal(parsed.summary.with_updates, 1);
});

test("list_wordpress_extensions type=theme routes to the themes endpoint, not plugins", async () => {
  let seenPath: string | undefined;
  const result = await callTool("list_wordpress_extensions", { site: UUID, type: "theme" }, (req, res) => {
    seenPath = req.url;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        data: {
          items: [{ slug: "twentytwentyfour", name: "Twenty Twenty-Four", status: "active", update_available: false }],
          pagination: { total: 1, per_page: 10, current_page: 1, last_page: 1 },
          summary: { total: 1, active: 1, with_updates: 0 },
        },
      }),
    );
  });

  // The `type` discriminator picks the themes collection — a theme request must never read
  // the plugins endpoint and vice versa.
  assert.equal(seenPath, `/api/v1/sites/${UUID}/wordpress/themes`);
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { items: { slug: string }[] };
  assert.equal(parsed.items[0].slug, "twentytwentyfour");
});

test("list_wordpress_extensions maps 'none' (200 + data:null) to an empty collection, not a bare null", async () => {
  const result = await callTool("list_wordpress_extensions", { site: UUID, type: "plugin" }, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "No plugins", data: null }));
  });

  // A site with no extensions of this kind reads as an empty collection with total 0 the model
  // can reason about — including a zeroed summary, so the shape matches the populated case.
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as {
    items: unknown[];
    pagination: { total: number };
    summary: { total: number; active: number; with_updates: number };
  };
  assert.deepEqual(parsed.items, []);
  assert.equal(parsed.pagination.total, 0);
  assert.deepEqual(parsed.summary, { total: 0, active: 0, with_updates: 0 });
});

test("list_wordpress_extensions maps an unknown or foreign site (404) to a structured not-found error", async () => {
  const result = await callTool("list_wordpress_extensions", { site: UUID, type: "plugin" }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, message: "Resource not found." }));
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.match(resultText(result), /team/i);
});

test("get_metrics_history returns a server's monitoring trend series, forwarding range (read:servers)", async () => {
  let seenUrl: string | undefined;
  let seenAuth: string | undefined;
  const result = await callTool("get_metrics_history", { server: UUID, range: "7d" }, (req, res) => {
    seenUrl = req.url;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Monitoring history retrieved successfully.",
        data: {
          server: { uuid: UUID, name: "web-1" },
          range: "7d",
          samples: [
            { cpu_usage: 12.4, ram_usage: 68.1, disk_usage: 34.7, time_at: "10:00 AM", sampled_at: "2026-06-30T10:00:00Z" },
          ],
        },
      }),
    );
  });

  // A read GET against the server's monitoring/history endpoint, range forwarded, authed with the PAT.
  const url = new URL(seenUrl!, "http://x");
  assert.equal(url.pathname, `/api/v1/servers/${UUID}/monitoring/history`);
  assert.equal(url.searchParams.get("range"), "7d");
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The trend series (not just the current snapshot) reaches the model.
  const parsed = JSON.parse(resultText(result)) as {
    range: string;
    samples: { cpu_usage: number; sampled_at: string }[];
  };
  assert.equal(parsed.range, "7d");
  assert.equal(parsed.samples[0].cpu_usage, 12.4);
});

test("get_metrics_history reads a site's history when given a site instead of a server (read:sites)", async () => {
  let seenUrl: string | undefined;
  const result = await callTool("get_metrics_history", { site: UUID, range: "7d" }, (req, res) => {
    seenUrl = req.url;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "ok",
        data: {
          site: { uuid: UUID, name: "blog" },
          range: "7d",
          samples: [{ cpu_usage: 8.3, ram_usage: 12.5, disk_usage: 25.1, time_at: "09:00 AM", sampled_at: "2026-06-30T09:00:00Z" }],
        },
      }),
    );
  });

  // The site base, not the server base — monitoring history lives under both.
  const url = new URL(seenUrl!, "http://x");
  assert.equal(url.pathname, `/api/v1/sites/${UUID}/monitoring/history`);
  assert.equal(url.searchParams.get("range"), "7d");
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as { samples: { ram_usage: number }[] };
  assert.equal(parsed.samples[0].ram_usage, 12.5);
});

test("get_metrics_history defaults range to 24h when it is omitted", async () => {
  let seenUrl: string | undefined;
  await callTool("get_metrics_history", { server: UUID }, (req, res) => {
    seenUrl = req.url;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, message: "ok", data: { server: { uuid: UUID }, range: "24h", samples: [] } }));
  });

  // No range given → the tool's own default (the recent 24h window), forwarded to xCloud.
  const url = new URL(seenUrl!, "http://x");
  assert.equal(url.searchParams.get("range"), "24h");
});

test("get_metrics_history rejects an out-of-enum range at the boundary before any HTTP call", async () => {
  let reached = false;
  const result = await callTool("get_metrics_history", { server: UUID, range: "30d" }, () => {
    reached = true;
  });

  // 30d is not an accepted window — caught at the seam, never sent to xCloud.
  assert.equal(result.isError, true);
  assert.equal(reached, false);
});

test("get_metrics_history requires exactly one of server or site — rejects both and neither at the seam", async () => {
  let reached = false;
  const record = (): void => {
    reached = true;
  };

  const neither = await callTool("get_metrics_history", {}, record);
  assert.equal(neither.isError, true);
  assert.match(resultText(neither), /server|site/i);

  const both = await callTool("get_metrics_history", { server: UUID, site: UUID }, record);
  assert.equal(both.isError, true);

  // Neither malformed call was ever sent to xCloud.
  assert.equal(reached, false);
});

test("get_metrics_history maps an unknown or foreign resource (404) to a structured not-found error", async () => {
  const result = await callTool("get_metrics_history", { server: UUID }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, message: "Resource not found." }));
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.match(resultText(result), /team/i);
});

test("list_site_domains returns a site's primary, aliases, redirects and counts (read-only GET)", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  let seenMethod: string | undefined;
  const result = await callTool("list_site_domains", { site: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    seenMethod = req.method;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Domains retrieved successfully.",
        data: {
          primary: "example.com",
          aliases: ["www.example.com", "shop.example.com"],
          redirects: ["old.example.com"],
          counts: { aliases: 2, redirects: 1, total: 3 },
        },
      }),
    );
  });

  // A read GET against the site's domains endpoint, authenticated with the PAT — never a mutation.
  assert.equal(seenPath, `/api/v1/sites/${UUID}/domains`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.equal(seenMethod, "GET");
  assert.notEqual(result.isError, true);

  // Every hostname pointing at the site — primary, aliases and redirects — reaches the model,
  // with the counts it can reason about (redirects arrive here, so no separate redirections tool).
  const parsed = JSON.parse(resultText(result)) as {
    primary: string;
    aliases: string[];
    redirects: string[];
    counts: { aliases: number; redirects: number; total: number };
  };
  assert.equal(parsed.primary, "example.com");
  assert.deepEqual(parsed.aliases, ["www.example.com", "shop.example.com"]);
  assert.deepEqual(parsed.redirects, ["old.example.com"]);
  assert.deepEqual(parsed.counts, { aliases: 2, redirects: 1, total: 3 });
});

test("list_site_domains returns the same shape for a bare site: empty aliases/redirects, zero counts", async () => {
  const result = await callTool("list_site_domains", { site: UUID }, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Domains retrieved successfully.",
        data: {
          primary: "only.example.com",
          aliases: [],
          redirects: [],
          counts: { aliases: 0, redirects: 0, total: 0 },
        },
      }),
    );
  });

  // A site with only its primary reads as the same shape as the populated case — empty arrays and
  // zero counts, never a bare null or a missing field the model would have to special-case.
  assert.notEqual(result.isError, true);
  const parsed = JSON.parse(resultText(result)) as {
    primary: string;
    aliases: string[];
    redirects: string[];
    counts: { aliases: number; redirects: number; total: number };
  };
  assert.equal(parsed.primary, "only.example.com");
  assert.deepEqual(parsed.aliases, []);
  assert.deepEqual(parsed.redirects, []);
  assert.deepEqual(parsed.counts, { aliases: 0, redirects: 0, total: 0 });
});

test("list_site_domains maps an unknown or foreign site (404) to a structured not-found error", async () => {
  const result = await callTool("list_site_domains", { site: UUID }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, message: "Not Found" }));
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.match(resultText(result), /team/i);
});

test("list_php_versions returns a server's PHP inventory — version, installed status, default and patch signal (read-only GET)", async () => {
  let seenPath: string | undefined;
  let seenAuth: string | undefined;
  let seenMethod: string | undefined;
  const result = await callTool("list_php_versions", { server: UUID }, (req, res) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    seenMethod = req.method;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        message: "Success",
        // Live shape: the `available` inventory — a bare array, each version carrying its
        // installed `status`, the `is_default` flag and the patch signal (`patch_available` is the
        // patched version string when one is available, else null). This one call answers the whole
        // question, so the tool never touches the slow patch-info endpoint. 8.3 is installed, the
        // default, and has a patch waiting (8.3.30 → 8.3.31); 8.2 is installed and current; 8.4 is
        // selectable but not installed.
        data: [
          { version: "8.4", status: null, is_default: false, current_version: null, patch_available: null },
          { version: "8.3", status: "installed", is_default: true, current_version: "8.3.30", patch_available: "8.3.31" },
          { version: "8.2", status: "installed", is_default: false, current_version: "8.2.20", patch_available: null },
        ],
      }),
    );
  });

  // A single read GET against the server's php-versions/available inventory (never the slow
  // patch-info), authenticated with the PAT.
  assert.equal(seenMethod, "GET");
  assert.equal(seenPath, `/api/v1/servers/${UUID}/php-versions/available`);
  assert.equal(seenAuth, "Bearer pat-secret-123");
  assert.notEqual(result.isError, true);

  // The whole question — which versions are installed, which is default, and where a patch is
  // available (and to what version) — reaches the model from that one call.
  const parsed = JSON.parse(resultText(result)) as {
    version: string;
    status: string | null;
    is_default: boolean;
    current_version: string | null;
    patch_available: string | null;
  }[];
  assert.deepEqual(parsed, [
    { version: "8.4", status: null, is_default: false, current_version: null, patch_available: null },
    { version: "8.3", status: "installed", is_default: true, current_version: "8.3.30", patch_available: "8.3.31" },
    { version: "8.2", status: "installed", is_default: false, current_version: "8.2.20", patch_available: null },
  ]);
});

test("list_php_versions maps an unknown or other-team server (404) to a clear, token-free not-found error", async () => {
  const result = await callTool("list_php_versions", { server: UUID }, (req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, message: "Resource not found." }));
  });

  // Team isolation: a uuid outside your team is indistinguishable from a nonexistent one, and the
  // error never leaks the PAT.
  assert.equal(result.isError, true);
  assert.match(resultText(result), /not found/i);
  assert.match(resultText(result), /team/i);
  assert.doesNotMatch(resultText(result), /pat-secret-123/);
});
