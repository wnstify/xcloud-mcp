/** The xCloud REST API client — the single external boundary, and the only place the PAT is used. */

type Pagination = {
  total: number;
  per_page: number;
  current_page: number;
  last_page: number;
};

/** Live `GET /servers` shape: `data.items[]` + `data.pagination{}` (not the documented `data`/`meta`). */
export type ServerList = {
  items: Record<string, unknown>[];
  pagination: Pagination;
};

/** The universal xCloud envelope. */
type Envelope<T> = {
  success: boolean;
  message: string;
  data: T;
};

/** A write's outcome as the model sees it: xCloud's message (the queued/done signal) + its data. */
export type WriteResult = {
  message: string;
  data: unknown;
};

/** How many times a 429 is retried before giving up. */
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reactive backoff: honour the server's `Retry-After` (seconds), else grow per attempt; capped. */
function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : 100 * 2 ** attempt;
  // Cap at 30s so a large server-set Retry-After is honoured, not silently
  // clamped away; the exponential fallback stays well under this.
  return Math.min(ms, 30_000);
}

/** Map xCloud's non-REST status conventions to clear, distinct, token-free tool errors. */
function xcloudError(status: number): Error {
  switch (status) {
    case 429:
      return new Error("Rate limited by xCloud: retry budget exhausted — slow down and try again shortly.");
    case 403:
      return new Error("Forbidden: your xCloud token lacks the required scope for this operation.");
    case 404:
      return new Error("Not found: no such resource, or it belongs to another team.");
    case 405:
      return new Error("Method not allowed for this xCloud endpoint.");
    case 422:
      return new Error("Validation failed: xCloud rejected the request as invalid.");
    case 504:
      return new Error("xCloud's gateway timed out (the endpoint is slow); try again shortly.");
    default:
      return new Error(`xCloud request failed (HTTP ${status}).`);
  }
}

export class XCloudClient {
  #token: string;
  #baseUrl: string;
  #timeoutMs: number;

  constructor(token: string, baseUrl: string, timeoutMs = 30_000) {
    this.#token = token;
    this.#baseUrl = baseUrl;
    this.#timeoutMs = timeoutMs;
  }

  /** The single external boundary: fetch, react to 429, unwrap the envelope, return the whole thing. */
  async #send(path: string, init?: RequestInit): Promise<Envelope<unknown>> {
    for (let attempt = 0; ; attempt++) {
      // Fresh per-attempt deadline so a hung or slow endpoint can't stall the tool call forever.
      const res = await this.#fetch(path, init);
      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep(retryAfterMs(res, attempt));
        continue;
      }
      if (!res.ok) throw xcloudError(res.status);
      const body = (await res.json()) as Envelope<unknown>;
      if (!body.success) throw new Error(body.message);
      return body;
    }
  }

  /** fetch with a per-request timeout; a blown deadline surfaces as a clean, token-free error. */
  async #fetch(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: "application/json",
          ...init?.headers,
        },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new Error(`xCloud request timed out after ${this.#timeoutMs}ms; try again shortly.`, { cause: err });
      }
      throw err;
    }
  }

  /** A read: return just the envelope's `data`. */
  async #request(path: string): Promise<unknown> {
    return (await this.#send(path)).data;
  }

  /** A write: POST (JSON body when given) and hand back xCloud's message + data as the queued/done state. */
  async #post(path: string, body?: unknown): Promise<WriteResult> {
    const init: RequestInit =
      body === undefined
        ? { method: "POST" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    const { message, data } = await this.#send(path, init);
    return { message, data };
  }

  /** A destructive delete: synchronous 200 + `data:null`; the message is the whole signal. */
  async #delete(path: string): Promise<WriteResult> {
    const { message, data } = await this.#send(path, { method: "DELETE" });
    return { message, data };
  }

  async listServers(): Promise<ServerList> {
    // `data: null` + 200 is xCloud's "none", not an error — surface it as an empty list.
    const data = (await this.#request("/servers")) as ServerList | null;
    return data ?? { items: [], pagination: { total: 0, per_page: 0, current_page: 1, last_page: 1 } };
  }

  /** A single server's detail (stack, ubuntu/php version, …). */
  async getServer(uuid: string): Promise<unknown> {
    return this.#request(`/servers/${encodeURIComponent(uuid)}`);
  }

  /** A server's current monitoring snapshot: `cpu{}`, `memory{}`, `disk[]`, `recorded_at`. */
  async getServerHealth(uuid: string): Promise<unknown> {
    return this.#request(`/servers/${encodeURIComponent(uuid)}/monitoring`);
  }

  /**
   * A server's or site's monitoring history: `{server|site{}, range, samples[]{cpu_usage,
   * ram_usage, disk_usage, time_at, sampled_at}}` — the trend complement to the getServerHealth
   * snapshot. History lives under both a server and a site; `range` (24h | 7d, validated at the
   * seam) is forwarded as a query param.
   */
  async getMetricsHistory(scope: { server?: string; site?: string }, range: string): Promise<unknown> {
    const base = scope.server
      ? `/servers/${encodeURIComponent(scope.server)}`
      : `/sites/${encodeURIComponent(scope.site!)}`;
    return this.#request(`${base}/monitoring/history?range=${range}`);
  }

  /** A server's services (`items[]` + `count`): each carries `name`, `status`, `can_restart`, … */
  async listServices(server: string): Promise<unknown> {
    return this.#request(`/servers/${encodeURIComponent(server)}/services`);
  }

  /** A server's firewall rules (`items[]` + `counts{allow,deny,active,total}`): each item's uuid targets delete_firewall_rule. */
  async listFirewallRules(server: string): Promise<unknown> {
    return this.#request(`/servers/${encodeURIComponent(server)}/firewall-rules`);
  }

  /**
   * A server's SSH firewall lockdown posture: `{caller_ip, caller_ip_whitelisted,
   * xcloud_ips_status{all_whitelisted, missing_ips[], not_configured}, jumpbox_ip}`. A single
   * object (a server always has a firewall status), so no empty-collection guard. Carries no
   * secrets — the read to gauge lockout risk before tightening SSH rules.
   */
  async getSshRestrictionStatus(server: string): Promise<unknown> {
    return this.#request(`/servers/${encodeURIComponent(server)}/firewall/ssh-restriction-status`);
  }

  /** The IPs fail2ban has banned on a server: the bespoke `{banned_ips[]}` shape (each entry `{ip, jail}`; not items/pagination). */
  async listBannedIps(server: string): Promise<unknown> {
    // A server with nothing banned can read as `data:null`+200 "none"; surface the empty
    // { banned_ips: [] } shape so the model never sees a bare null.
    const data = (await this.#request(`/servers/${encodeURIComponent(server)}/fail2ban/banned-ips`)) as {
      banned_ips: unknown[];
    } | null;
    return data ?? { banned_ips: [] };
  }

  /**
   * A server's PHP inventory — the `available` list, a bare array where each version carries its
   * installed `status`, the `is_default` flag and the `patch_available` signal. That one endpoint
   * already answers installed + default + patch, so we never touch the slow `/php-versions/patch-info`
   * (it 504s at the gateway). The list is always the full selectable set, so no empty-collection guard.
   */
  async listPhpVersions(server: string): Promise<unknown> {
    return this.#request(`/servers/${encodeURIComponent(server)}/php-versions/available`);
  }

  /** The team's sites (`items[]` + `pagination{}`), optionally filtered by server, type or status. */
  async listSites(filters: { server?: string; type?: string; status?: string }): Promise<unknown> {
    const q = new URLSearchParams();
    if (filters.server) q.set("server_uuid", filters.server);
    if (filters.type) q.set("type", filters.type);
    if (filters.status) q.set("status", filters.status);
    const qs = q.toString();
    return this.#request(qs ? `/sites?${qs}` : "/sites");
  }

  /** A single site's detail, including its current status. */
  async getSite(uuid: string): Promise<unknown> {
    return this.#request(`/sites/${encodeURIComponent(uuid)}`);
  }

  /**
   * A site's hostnames: `{primary, aliases[], redirects[], counts{aliases, redirects, total}}`.
   * A site always has a primary, so the endpoint always returns the full shape (empty arrays /
   * zero counts when bare) — never `data:null`, so no empty-collection guard is needed. Redirects
   * arrive here too, which is why there is no separate redirections read.
   */
  async listSiteDomains(uuid: string): Promise<unknown> {
    return this.#request(`/sites/${encodeURIComponent(uuid)}/domains`);
  }

  /**
   * Vulnerabilities as `items[]` + `pagination{}` + `summary{}`: the team-wide rollup by default,
   * or one site's findings when `site` is given (the per-site read complement to a scan).
   */
  async listVulnerabilities(site?: string): Promise<unknown> {
    return this.#request(site ? `/sites/${encodeURIComponent(site)}/vulnerabilities` : "/vulnerabilities");
  }

  /** A WordPress site's pending updates: `core{}`, `plugins{}`, `themes{}`, `summary{}`. */
  async listWordpressUpdates(uuid: string): Promise<unknown> {
    return this.#request(`/sites/${encodeURIComponent(uuid)}/wordpress/updates`);
  }

  /** A site's backup state: `local{}` and `remote{}`. */
  async getBackupStatus(uuid: string): Promise<unknown> {
    return this.#request(`/sites/${encodeURIComponent(uuid)}/backup-status`);
  }

  /** A site's restore points (`items[]` + `pagination{}`): each backup's when + local/remote destination. */
  async listBackups(uuid: string): Promise<unknown> {
    // A site with no backups can read as `data:null`+200 "none"; surface it as an empty collection.
    const data = (await this.#request(`/sites/${encodeURIComponent(uuid)}/backups`)) as ServerList | null;
    return data ?? { items: [], pagination: { total: 0, per_page: 0, current_page: 1, last_page: 1 } };
  }

  /** List cron jobs under a parent — a server or a site (cron lives under both); a paginated collection. */
  async listCronJobs(scope: { server?: string; site?: string }): Promise<unknown> {
    const base = scope.server
      ? `/servers/${encodeURIComponent(scope.server)}`
      : `/sites/${encodeURIComponent(scope.site!)}`;
    // Live shape is `items[]` + `pagination{}` (like /servers); guard xCloud's `data:null`+200 "none".
    const data = (await this.#request(`${base}/cron-jobs`)) as ServerList | null;
    return data ?? { items: [], pagination: { total: 0, per_page: 0, current_page: 1, last_page: 1 } };
  }

  /** A single cron job's last-run output (`data.{output}`) under its parent — a server or a site. */
  async getCronJobOutput(scope: { server?: string; site?: string }, cronJob: string): Promise<unknown> {
    const base = scope.server
      ? `/servers/${encodeURIComponent(scope.server)}`
      : `/sites/${encodeURIComponent(scope.site!)}`;
    return this.#request(`${base}/cron-jobs/${encodeURIComponent(cronJob)}/output`);
  }

  /** A site's recent logs: parsed access / web-server (nginx|lsws) entries, or the events feed. */
  async getSiteLogs(uuid: string, type: "access" | "nginx" | "lsws" | "events"): Promise<unknown> {
    const id = encodeURIComponent(uuid);
    return type === "events"
      ? this.#request(`/sites/${id}/events`)
      : this.#request(`/sites/${id}/access-logs?type=${type}`);
  }

  /** A site's latest PageSpeed scores: `{mobile, desktop}` — each null until a scan has run. */
  async getPagespeed(uuid: string): Promise<unknown> {
    return this.#request(`/sites/${encodeURIComponent(uuid)}/pagespeed`);
  }

  /**
   * A site's caching configuration: `{stack, page_cache{}, object_cache{redis, object_cache_pro},
   * cloudflare_edge_cache{}}`. A single object (a site always has a stack), so no empty-collection
   * guard — the read complement to purge_cache: what is configured before you purge it.
   */
  async getCacheSettings(uuid: string): Promise<unknown> {
    return this.#request(`/sites/${encodeURIComponent(uuid)}/cache/settings`);
  }

  /** A site's SSL certificate: `{provider, status, expires_at, hostnames}`; `data:null` = no SSL. */
  async getSsl(uuid: string): Promise<unknown> {
    return this.#request(`/sites/${encodeURIComponent(uuid)}/ssl`);
  }

  /** A WordPress site's health snapshot: version/debug/cron flags, checksum, item + pending-update counts. */
  async getWordpressStatus(uuid: string): Promise<unknown> {
    return this.#request(`/sites/${encodeURIComponent(uuid)}/wordpress/status`);
  }

  /**
   * A WordPress site's installed plugins or themes (`items[] + pagination{} + summary{total,active,with_updates}`):
   * each item carries slug, active/inactive `status`, current + available version. `type` picks the endpoint.
   */
  async listWordpressExtensions(uuid: string, type: "plugin" | "theme"): Promise<unknown> {
    const kind = type === "plugin" ? "plugins" : "themes";
    // A site with none of this kind can read as `data:null`+200 "none"; surface it as an empty
    // collection whose shape (items + pagination + summary) matches the populated case.
    const data = (await this.#request(`/sites/${encodeURIComponent(uuid)}/wordpress/${kind}`)) as ServerList | null;
    return (
      data ?? {
        items: [],
        pagination: { total: 0, per_page: 0, current_page: 1, last_page: 1 },
        summary: { total: 0, active: 0, with_updates: 0 },
      }
    );
  }

  /** The caller's identity + `current_team_uuid` (the team-isolation boundary). Never `/user/tokens`. */
  async whoami(): Promise<unknown> {
    return this.#request("/user");
  }

  /** Trigger a backup (a restore point). `local` or `remote` (remote needs storage configured). Returns 200. */
  async createBackup(uuid: string, type: "local" | "remote"): Promise<WriteResult> {
    return this.#post(`/sites/${encodeURIComponent(uuid)}/backup`, { type });
  }

  /** Queue a fresh vulnerability scan of a site. Async (202) — poll the site's vulnerabilities to see results. */
  async runVulnerabilityScan(uuid: string): Promise<WriteResult> {
    return this.#post(`/sites/${encodeURIComponent(uuid)}/vulnerability-scan`);
  }

  /** Queue a PageSpeed scan (mobile + desktop) of a site. Async (202) — poll pagespeed for the scores. */
  async runPagespeedScan(uuid: string): Promise<WriteResult> {
    return this.#post(`/sites/${encodeURIComponent(uuid)}/pagespeed/scan`);
  }

  /**
   * Purge a site's cache. `page` → the full-page endpoint (async 202, `data:null` — the message
   * is the whole signal); `all` → purge-all (async 202, a per-layer `queued|skipped` map).
   */
  async purgeCache(uuid: string, layers: "page" | "all"): Promise<WriteResult> {
    const endpoint = layers === "all" ? "cache/purge-all" : "cache/purge";
    return this.#post(`/sites/${encodeURIComponent(uuid)}/${endpoint}`);
  }

  /**
   * Apply pending WordPress updates. `type` is plugin | theme | core; omit `slugs` to update
   * every updatable item of that type. Async (202) — poll the site's WordPress state afterwards.
   */
  async applyWordpressUpdates(
    uuid: string,
    body: { type: "plugin" | "theme" | "core"; slugs?: string[]; backup_before_update?: boolean },
  ): Promise<WriteResult> {
    return this.#post(`/sites/${encodeURIComponent(uuid)}/wordpress/update`, body);
  }

  /**
   * Activate one or more WordPress plugins or themes by slug. Activate-only (the API has no
   * deactivate endpoint). Async (202) — the result carries `queued_items` + `skipped_items`
   * (with a reason each); poll the site's extensions afterwards for the status flip.
   */
  async activateWordpressExtensions(
    uuid: string,
    body: { type: "plugin" | "theme"; slugs: string[]; backup_before_action?: boolean },
  ): Promise<WriteResult> {
    return this.#post(`/sites/${encodeURIComponent(uuid)}/wordpress/activate`, body);
  }

  /**
   * Mint a short-lived magic-login URL into a site's WordPress admin. Synchronous (200). The
   * returned `url` carries a login token — it is the intended output, but it is sensitive and
   * must never be logged. `login_as` optionally delegates the login to another WP user.
   */
  async magicLogin(uuid: string, login_as?: string): Promise<WriteResult> {
    const path = `/sites/${encodeURIComponent(uuid)}/magic-login`;
    return login_as === undefined ? this.#post(path) : this.#post(path, { login_as });
  }

  /** Reboot a server (destructive — it goes offline while it restarts). */
  async rebootServer(uuid: string): Promise<WriteResult> {
    return this.#post(`/servers/${encodeURIComponent(uuid)}/reboot`);
  }

  /** Restart a system service on a server (destructive — briefly unavailable). `disable` is never exposed. */
  async restartService(uuid: string, service: string): Promise<WriteResult> {
    return this.#post(`/servers/${encodeURIComponent(uuid)}/services/restart`, { service });
  }

  /** Delete a firewall rule from a server (destructive, irreversible — can drop an allow rule). */
  async deleteFirewallRule(server: string, rule: string): Promise<WriteResult> {
    return this.#delete(`/servers/${encodeURIComponent(server)}/firewall-rules/${encodeURIComponent(rule)}`);
  }

  /** Delete a cron job (destructive) under its parent — a server or a site (cron lives under both). */
  async deleteCronJob(scope: { server?: string; site?: string }, cronJob: string): Promise<WriteResult> {
    const base = scope.server
      ? `/servers/${encodeURIComponent(scope.server)}`
      : `/sites/${encodeURIComponent(scope.site!)}`;
    return this.#delete(`${base}/cron-jobs/${encodeURIComponent(cronJob)}`);
  }
}
