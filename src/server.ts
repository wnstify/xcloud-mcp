import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { XCloudClient } from "./client.ts";
import { redactSecrets } from "./redact.ts";

/** The destructive-op opt-in (ADR-0004 L2/L3): expose them at all, and whether to skip the prompt. */
export type DestructiveConfig = {
  enabled: boolean;
  noConfirm: boolean;
};

/** Wrap a tool's data as the single text result the model receives, secrets stripped centrally. */
const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(redactSecrets(data)) }],
});

/** A plain-text tool result, optionally flagged as an error (used by the consent gate). */
const text = (body: string, isError?: true): CallToolResult => ({
  content: [{ type: "text", text: body }],
  isError,
});

/** A resource uuid: required, length-capped at the boundary (defence against hostile args). */
const uuid = z.string().min(1).max(100);

/**
 * ADR-0004 L3 — ask the human before a destructive op. Returns a result to short-circuit with
 * when the op must NOT run (refused / declined), or undefined to proceed. The consent channel is
 * MCP elicitation; with no channel we fail closed unless the operator waived it via NO_CONFIRM.
 */
async function confirmDestructive(
  server: McpServer,
  noConfirm: boolean,
  summary: string,
): Promise<CallToolResult | undefined> {
  if (!server.server.getClientCapabilities()?.elicitation) {
    return noConfirm
      ? undefined
      : text(
          `Refused: ${summary} is destructive and this client offers no confirmation channel. ` +
            "Set XCLOUD_DESTRUCTIVE_NO_CONFIRM=true to run destructive ops unattended.",
          true,
        );
  }
  const { action } = await server.server.elicitInput({
    mode: "form",
    message: `Confirm destructive operation — ${summary}. This may be irreversible. Proceed?`,
    requestedSchema: { type: "object", properties: {} },
  });
  return action === "accept" ? undefined : text(`Cancelled: ${summary} was not run (consent ${action}).`);
}

/** Build the xCloud MCP server with its curated tool registry wired to the API client. */
export function buildServer(
  xcloud: XCloudClient,
  destructive: DestructiveConfig = { enabled: false, noConfirm: false },
): McpServer {
  const server = new McpServer({ name: "xcloud-mcp", version: "1.0.0" });

  server.registerTool(
    "list_servers",
    {
      title: "List servers",
      description: "List the xCloud servers in your team.",
    },
    async () => json(await xcloud.listServers()),
  );

  server.registerTool(
    "get_server",
    {
      title: "Get server",
      description: "Get one xCloud server's detail (stack, OS and PHP version, …) by its uuid.",
      inputSchema: { server: uuid },
    },
    async ({ server }) => json(await xcloud.getServer(server)),
  );

  server.registerTool(
    "get_server_health",
    {
      title: "Get server health",
      description: "Get a server's current health snapshot — CPU, memory and disk usage — by its uuid.",
      inputSchema: { server: uuid },
    },
    async ({ server }) => json(await xcloud.getServerHealth(server)),
  );

  server.registerTool(
    "get_metrics_history",
    {
      title: "Get metrics history",
      description:
        "Read a server's or a site's monitoring history over a time window — a CPU/RAM/disk trend series, not just the current snapshot. Give exactly one of `server` or `site` (history lives under both) plus a `range` of 24h or 7d (default 24h). The trend complement to get_server_health.",
      inputSchema: {
        server: uuid.optional(),
        site: uuid.optional(),
        range: z.enum(["24h", "7d"]).default("24h"),
      },
    },
    async ({ server: serverUuid, site, range }) => {
      // Exactly one parent, validated at the boundary before any HTTP call.
      if (Boolean(serverUuid) === Boolean(site)) {
        return text("Provide exactly one of `server` or `site` — the resource to read history for.", true);
      }
      return json(await xcloud.getMetricsHistory({ server: serverUuid, site }, range));
    },
  );

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description:
        "List the system services on a server by its uuid — each with its name, status and whether it can be restarted. Use it to find the service name and can_restart flag that restart_service needs.",
      inputSchema: { server: uuid },
    },
    async ({ server: serverUuid }) => json(await xcloud.listServices(serverUuid)),
  );

  server.registerTool(
    "list_firewall_rules",
    {
      title: "List firewall rules",
      description:
        "List the firewall rules on a server by its uuid — each with its uuid, name, port, protocol and allow/deny direction, plus allow/deny counts. Use it to find the rule uuid that delete_firewall_rule needs.",
      inputSchema: { server: uuid },
    },
    async ({ server: serverUuid }) => json(await xcloud.listFirewallRules(serverUuid)),
  );

  server.registerTool(
    "get_ssh_restriction_status",
    {
      title: "Get SSH restriction status",
      description:
        "Get a server's SSH firewall lockdown posture by its uuid — `caller_ip` and whether it is whitelisted (`caller_ip_whitelisted`), plus `xcloud_ips_status{all_whitelisted, missing_ips[], not_configured}` and the `jumpbox_ip`. Answers whether SSH is locked to the right IPs and whether the xCloud infrastructure IPs are whitelisted; check it before tightening SSH rules to gauge lockout risk. Read-only, returns no secrets.",
      inputSchema: { server: uuid },
    },
    async ({ server: serverUuid }) => json(await xcloud.getSshRestrictionStatus(serverUuid)),
  );

  server.registerTool(
    "list_banned_ips",
    {
      title: "List banned IPs",
      description:
        "List the IPs fail2ban has banned on a server by its uuid — `banned_ips[]`, each entry an `{ip, jail}` (the jail, e.g. sshd, is why it was banned). Answers whether your (or a customer's) IP is currently banned; an empty list means nothing is banned.",
      inputSchema: { server: uuid },
    },
    async ({ server: serverUuid }) => json(await xcloud.listBannedIps(serverUuid)),
  );

  server.registerTool(
    "list_php_versions",
    {
      title: "List PHP versions",
      description:
        "List a server's PHP versions by its uuid — a bare array, each entry with its `version`, whether it is installed (`status`), the default (`is_default`) and whether a patch is available (`patch_available`). Reads the `/php-versions/available` inventory in a single call (it already carries the default and patch signals), so it never touches the slow patch-info endpoint. Read-only.",
      inputSchema: { server: uuid },
    },
    async ({ server: serverUuid }) => json(await xcloud.listPhpVersions(serverUuid)),
  );

  server.registerTool(
    "list_sites",
    {
      title: "List sites",
      description:
        "List the sites in your team. Optionally filter by server uuid, site type (e.g. wordpress) or status.",
      inputSchema: {
        server: uuid.optional(),
        type: z.string().max(50).optional(),
        status: z.string().max(50).optional(),
      },
    },
    async (filters) => json(await xcloud.listSites(filters)),
  );

  server.registerTool(
    "get_site",
    {
      title: "Get site",
      description: "Get one site's detail, including its current status, by its uuid.",
      inputSchema: { site: uuid },
    },
    async ({ site }) => json(await xcloud.getSite(site)),
  );

  server.registerTool(
    "list_site_domains",
    {
      title: "List site domains",
      description:
        "List a site's hostnames by its uuid — its `primary` domain plus `aliases[]` (also served by the site) and `redirects[]` (forward to primary), with `counts{aliases, redirects, total}`. One read for every hostname pointing at the site; the redirects arrive here too, so there is no separate redirections tool.",
      inputSchema: { site: uuid },
    },
    async ({ site }) => json(await xcloud.listSiteDomains(site)),
  );

  server.registerTool(
    "list_vulnerabilities",
    {
      title: "List vulnerabilities",
      description:
        "List vulnerabilities (merged from Patchstack and Wordfence). Omit `site` for the team-wide rollup across all your sites; give a site uuid to drill into that one site's findings. Same items[] + pagination{} + summary{} shape either way — the per-site read complement to run_vulnerability_scan.",
      inputSchema: { site: uuid.optional() },
    },
    async ({ site }) => json(await xcloud.listVulnerabilities(site)),
  );

  server.registerTool(
    "list_wordpress_updates",
    {
      title: "List WordPress updates",
      description: "List a WordPress site's pending core, plugin and theme updates by its uuid.",
      inputSchema: { site: uuid },
    },
    async ({ site }) => json(await xcloud.listWordpressUpdates(site)),
  );

  server.registerTool(
    "get_backup_status",
    {
      title: "Get backup status",
      description: "Get a site's local and remote backup status by its uuid.",
      inputSchema: { site: uuid },
    },
    async ({ site }) => json(await xcloud.getBackupStatus(site)),
  );

  server.registerTool(
    "list_backups",
    {
      title: "List backups",
      description:
        "List a site's restore points by its uuid — each backup's timestamp, size and local/remote destination, plus the total in `pagination.total`. The read complement to create_backup, and the honest answer to whether backups are actually running and how many exist.",
      inputSchema: { site: uuid },
    },
    async ({ site }) => json(await xcloud.listBackups(site)),
  );

  server.registerTool(
    "get_site_logs",
    {
      title: "Get site logs",
      description:
        "Read a site's recent logs by its uuid: access logs (type=access), the web-server error log (type=nginx or type=lsws, matching the site's stack), or the events activity feed (type=events). Defaults to access.",
      inputSchema: { site: uuid, type: z.enum(["access", "nginx", "lsws", "events"]).default("access") },
    },
    async ({ site, type }) => json(await xcloud.getSiteLogs(site, type)),
  );

  server.registerTool(
    "list_cron_jobs",
    {
      title: "List cron jobs",
      description:
        "List the cron jobs under one parent — a server or a site (cron lives under both) — so you can see each job's uuid, command, frequency and user. Give exactly one of `server` or `site`.",
      inputSchema: { server: uuid.optional(), site: uuid.optional() },
    },
    async ({ server: serverUuid, site }) => {
      // Exactly one parent, validated at the boundary before any HTTP call.
      if (Boolean(serverUuid) === Boolean(site)) {
        return text("Provide exactly one of `server` or `site` — the cron jobs' parent.", true);
      }
      return json(await xcloud.listCronJobs({ server: serverUuid, site }));
    },
  );

  server.registerTool(
    "get_cron_job_output",
    {
      title: "Get cron job output",
      description:
        "Get a single cron job's last-run output by its uuid. A cron job lives under a server or a site, so give exactly one of `server` or `site` (its parent) plus `cron_job`. Output is empty until the job has run.",
      inputSchema: { server: uuid.optional(), site: uuid.optional(), cron_job: uuid },
    },
    async ({ server: serverUuid, site, cron_job }) => {
      // Exactly one parent, validated at the boundary before any HTTP call.
      if (Boolean(serverUuid) === Boolean(site)) {
        return text("Provide exactly one of `server` or `site` — the cron job's parent.", true);
      }
      return json(await xcloud.getCronJobOutput({ server: serverUuid, site }, cron_job));
    },
  );

  server.registerTool(
    "get_pagespeed",
    {
      title: "Get PageSpeed",
      description:
        "Get a site's latest PageSpeed scores (mobile and desktop) by its uuid — the result of the most recent scan. Both are null until a scan has run; queue one with run_pagespeed_scan first.",
      inputSchema: { site: uuid },
    },
    async ({ site }) => json(await xcloud.getPagespeed(site)),
  );

  server.registerTool(
    "get_cache_settings",
    {
      title: "Get cache settings",
      description:
        "Get a site's caching configuration by its uuid — its `stack`, `page_cache{enabled, source, plugin}`, `object_cache{redis, object_cache_pro}` and `cloudflare_edge_cache{enabled}`. The read complement to purge_cache: see which cache layers are configured before you purge them.",
      inputSchema: { site: uuid },
    },
    async ({ site }) => json(await xcloud.getCacheSettings(site)),
  );

  server.registerTool(
    "get_ssl",
    {
      title: "Get SSL",
      description:
        "Get a site's SSL certificate by its uuid — provider, status, expiry date and covered hostnames — to answer whether the certificate is valid or about to expire. Returns null when the site has no SSL configured.",
      inputSchema: { site: uuid },
    },
    async ({ site }) => json(await xcloud.getSsl(site)),
  );

  server.registerTool(
    "get_wordpress_status",
    {
      title: "Get WordPress status",
      description:
        "Get a WordPress site's health snapshot by its uuid — WP and PHP version, multisite/debug/cron flags, core checksum status, plugin/theme/core counts and pending-update counts. The WordPress analogue of get_server_health: one call to catch prod footguns like WP_DEBUG left on, a dead wp-cron, or a failed core checksum.",
      inputSchema: { site: uuid },
    },
    async ({ site }) => json(await xcloud.getWordpressStatus(site)),
  );

  server.registerTool(
    "list_wordpress_extensions",
    {
      title: "List WordPress extensions",
      description:
        "List a WordPress site's installed plugins or themes by its uuid — set `type` to plugin or theme. Each item carries its slug, active/inactive status and current + available version, plus a summary{total, active, with_updates}. The discovery surface (slug + status) for plugin/theme management.",
      inputSchema: { site: uuid, type: z.enum(["plugin", "theme"]) },
    },
    async ({ site, type }) => json(await xcloud.listWordpressExtensions(site, type)),
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Confirm whose xCloud account this key is, and which team it is scoped to — returns your name, email and current_team_uuid. The team is the isolation boundary: the server can only ever see servers and sites in that one team.",
    },
    async () => json(await xcloud.whoami()),
  );

  server.registerTool(
    "create_backup",
    {
      title: "Create backup",
      description:
        "Trigger an on-demand backup of a site by its uuid — a restore point before a risky change. Destination is local (default) or remote (remote needs a configured storage provider).",
      inputSchema: { site: uuid, type: z.enum(["local", "remote"]).default("local") },
    },
    async ({ site, type }) => json(await xcloud.createBackup(site, type)),
  );

  server.registerTool(
    "run_vulnerability_scan",
    {
      title: "Run vulnerability scan",
      description:
        "Queue a fresh vulnerability scan of a site by its uuid. Runs asynchronously; read the site's vulnerabilities afterwards to see the results.",
      inputSchema: { site: uuid },
    },
    async ({ site }) => json(await xcloud.runVulnerabilityScan(site)),
  );

  server.registerTool(
    "run_pagespeed_scan",
    {
      title: "Run PageSpeed scan",
      description:
        "Queue a PageSpeed Insights scan (mobile and desktop) of a site by its uuid. Runs asynchronously; read the site's pagespeed results afterwards to see the scores.",
      inputSchema: { site: uuid },
    },
    async ({ site }) => json(await xcloud.runPagespeedScan(site)),
  );

  server.registerTool(
    "purge_cache",
    {
      title: "Purge cache",
      description:
        "Purge a site's cache by its uuid, forcing fresh content after a change. `layers` picks the scope: `page` (default) purges just the full-page cache; `all` purges every configured layer (object cache, Redis, Cloudflare edge) and returns a per-layer queued|skipped map. Runs asynchronously.",
      inputSchema: { site: uuid, layers: z.enum(["page", "all"]).default("page") },
    },
    async ({ site, layers }) => json(await xcloud.purgeCache(site, layers)),
  );

  server.registerTool(
    "apply_wordpress_updates",
    {
      title: "Apply WordPress updates",
      description:
        "Apply pending WordPress updates on a site by its uuid. `type` is plugin, theme or core; give `slugs` to update specific items, or omit it to update every pending item of that type. Set `backup_before_update` to take a pre-update backup (needs remote backup configured). Runs asynchronously.",
      inputSchema: {
        site: uuid,
        type: z.enum(["plugin", "theme", "core"]),
        slugs: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
        backup_before_update: z.boolean().optional(),
      },
    },
    async ({ site, type, slugs, backup_before_update }) =>
      json(await xcloud.applyWordpressUpdates(site, { type, slugs, backup_before_update })),
  );

  server.registerTool(
    "activate_wordpress_extensions",
    {
      title: "Activate WordPress extensions",
      description:
        "Activate one or more WordPress plugins or themes on a site by its uuid — `type` is plugin or theme, `slugs` the item slugs to activate (from list_wordpress_extensions). Activate-only: there is no deactivate. Runs asynchronously; the result's queued_items and skipped_items (each with a reason, e.g. already_active) tell you what took — confirm the status flip via list_wordpress_extensions.",
      inputSchema: {
        site: uuid,
        type: z.enum(["plugin", "theme"]),
        slugs: z.array(z.string().min(1).max(200)).min(1).max(100),
        backup_before_action: z.boolean().optional(),
      },
    },
    async ({ site, type, slugs, backup_before_action }) =>
      json(await xcloud.activateWordpressExtensions(site, { type, slugs, backup_before_action })),
  );

  server.registerTool(
    "magic_login",
    {
      title: "Magic login",
      description:
        "Generate a short-lived magic-login URL into a WordPress site's admin by its uuid, so you can jump into wp-admin without a password. The URL carries a login token and expires in ~10 minutes; treat it as sensitive. Optionally log in as another WordPress user with login_as.",
      inputSchema: { site: uuid, login_as: z.string().min(1).max(64).optional() },
    },
    async ({ site, login_as }) => json(await xcloud.magicLogin(site, login_as)),
  );

  // Destructive ops (ADR-0004): registered only on explicit opt-in (L2), each gated at call time (L3).
  if (destructive.enabled) {
    server.registerTool(
      "reboot_server",
      {
        title: "Reboot server",
        description:
          "Reboot an xCloud server by its uuid. Destructive: the server and everything on it goes offline while it restarts.",
        inputSchema: { server: uuid },
      },
      async ({ server: serverUuid }) => {
        const refused = await confirmDestructive(server, destructive.noConfirm, `reboot server ${serverUuid}`);
        return refused ?? json(await xcloud.rebootServer(serverUuid));
      },
    );

    server.registerTool(
      "restart_service",
      {
        title: "Restart service",
        description:
          "Restart a system service (e.g. redis, mysql, php-fpm) on a server by its uuid. Destructive: the service is briefly unavailable while it restarts.",
        inputSchema: { server: uuid, service: z.string().min(1).max(50) },
      },
      async ({ server: serverUuid, service }) => {
        const refused = await confirmDestructive(
          server,
          destructive.noConfirm,
          `restart service ${service} on server ${serverUuid}`,
        );
        return refused ?? json(await xcloud.restartService(serverUuid, service));
      },
    );

    server.registerTool(
      "delete_firewall_rule",
      {
        title: "Delete firewall rule",
        description:
          "Delete a firewall rule from a server, given the server uuid and the rule uuid. Destructive and irreversible: removing an allow rule can lock traffic out (including your own IP).",
        inputSchema: { server: uuid, firewall_rule: uuid },
      },
      async ({ server: serverUuid, firewall_rule }) => {
        const refused = await confirmDestructive(
          server,
          destructive.noConfirm,
          `delete firewall rule ${firewall_rule} on server ${serverUuid}`,
        );
        return refused ?? json(await xcloud.deleteFirewallRule(serverUuid, firewall_rule));
      },
    );

    server.registerTool(
      "delete_cron_job",
      {
        title: "Delete cron job",
        description:
          "Delete a cron job by its uuid. A cron job lives under a server or a site, so give exactly one of `server` or `site` (its parent) plus `cron_job`. Destructive and irreversible.",
        inputSchema: { server: uuid.optional(), site: uuid.optional(), cron_job: uuid },
      },
      async ({ server: serverUuid, site, cron_job }) => {
        // Exactly one parent, validated at the boundary before any consent prompt or HTTP call.
        if (Boolean(serverUuid) === Boolean(site)) {
          return text("Provide exactly one of `server` or `site` — the cron job's parent.", true);
        }
        const where = serverUuid ? `server ${serverUuid}` : `site ${site}`;
        const refused = await confirmDestructive(
          server,
          destructive.noConfirm,
          `delete cron job ${cron_job} on ${where}`,
        );
        return refused ?? json(await xcloud.deleteCronJob({ server: serverUuid, site }, cron_job));
      },
    );
  }

  return server;
}
