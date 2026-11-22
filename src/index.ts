import { OAuthProvider, AuthorizationError, CimdFetchError, insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { env as workerEnv } from "cloudflare:workers";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { analyzeLiveReport, simulateAllocation, DESTINATIONS, type Destination, type LivePage, type PlatformMap, type RawRecord } from "./optimizer";

// Owner-only, read-only MCP gateway. Meta system-user token remains in the existing Meta REST Worker.
const OWNER_GITHUB_ID = 359685372;
const MCP_RESOURCE = "https://music-campaign-optimizer-mcp.waynecatoe3.workers.dev/mcp";
const META_REST_ORIGIN = "https://odd-hall-a184.waynecatoe3.workers.dev";

type Identity = { githubId: number; login: string };
type GatewayEnv = Env & {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: any;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  MUSIC_API_KEY?: string;
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function consentHtml(
  details: { clientName: string; clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean; scope: string[] },
  handle: string,
) {
  const domain = details.clientDomain
    ? `Verified client domain: ${escapeHtml(details.clientDomain)}`
    : "This client's display name is not verified.";
  const scopes = details.scope
    .map((scope) => `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`)
    .join("<div></div>");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Authorize Music Campaign Optimizer</title></head><body>
    <h1>Authorize ${escapeHtml(details.clientName)}</h1>
    <p>${domain}</p>
    <p>Access will be sent to: <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
    ${details.redirectIsLoopback ? "<p><strong>Warning: this destination is on your own computer.</strong></p>" : ""}
    <p>Grant only if you initiated this connection.</p>
    <form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
    <fieldset><legend>Requested permissions</legend>${scopes}</fieldset>
    <button type="submit" name="decision" value="approve">Authorize</button>
    <button type="submit" name="decision" value="deny">Deny</button></form>
    </body></html>`;
}


type MetricLevel = "campaign" | "adset" | "ad";
type DatePreset = "yesterday" | "last_3d" | "last_7d" | "last_14d" | "last_28d" | "last_30d";

function toolText(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function fetchReporting(path: "/api/campaigns" | "/api/adsets" | "/api/ads" | "/api/insights", params?: URLSearchParams) {
  const env = workerEnv as unknown as GatewayEnv;
  if (!env.MUSIC_API_KEY) {
    return toolText({ error: "reporting_not_configured" }, true);
  }
  const url = new URL(path, META_REST_ORIGIN);
  if (params) url.search = params.toString();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.MUSIC_API_KEY}`,
        Accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (response.status >= 300 && response.status < 400) {
      return toolText({ error: "reporting_redirect_rejected" }, true);
    }
    if (!response.ok) {
      // Never relay arbitrary upstream response bodies or messages.
      return toolText({ error: "reporting_request_failed", upstream_status: response.status }, true);
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
      return toolText({ error: "unexpected_reporting_response" }, true);
    }
    return toolText(payload);
  } catch {
    return toolText({ error: "reporting_service_unreachable" }, true);
  }
}


type ReadPageResult = { ok: true; page: LivePage } | { ok: false; reason: string };
async function readAllReporting(path: "/api/adsets" | "/api/ads" | "/api/insights", input: URLSearchParams = new URLSearchParams()): Promise<ReadPageResult> {
  const data: RawRecord[] = [];
  let after: string | null = null;
  for (let pages = 0; pages < 10; pages++) {
    const params = new URLSearchParams(input);
    if (after) params.set("after", after);
    const raw = await fetchReporting(path, params);
    let payload: unknown;
    try { payload = JSON.parse(raw.content[0].text); }
    catch { return { ok: false, reason: "unexpected_gateway_response" }; }
    if ("isError" in raw && raw.isError) return { ok: false, reason: "upstream_reporting_failure" };
    if (!payload || typeof payload !== "object" || !("data" in payload) ||
        !Array.isArray(payload.data)) return { ok: false, reason: "unrecognized_meta_response" };
    const page = payload as { data: unknown[]; has_more?: unknown; next_cursor?: unknown };
    for (const record of page.data) {
      if (record && typeof record === "object" && !Array.isArray(record)) data.push(record as RawRecord);
    }
    if (page.has_more !== true) return { ok: true, page: { data, has_more: false, next_cursor: null } };
    const cursor = page.next_cursor;
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512 || ![...cursor].every((ch) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-+=/".includes(ch))) {
      return { ok: false, reason: "unusable_pagination_cursor" };
    }
    after = cursor;
  }
  // Never treat a truncated paginated report as complete.
  return { ok: true, page: { data, has_more: true, next_cursor: after } };
}
const emptyPage: LivePage = { data: [], has_more: false, next_cursor: null };

function createServer() {
  const server = new McpServer({ name: "Music Campaign Optimizer", version: "0.3.0" });
  const identity = getMcpAuthContext()?.props as Identity | undefined;
  // Even if the OAuth provider is misconfigured, tool registration is owner-only.
  if (!identity || identity.githubId !== OWNER_GITHUB_ID) return server;

  server.registerTool(
    "get_connection_status",
    {
      description: "Verify the owner-only MCP gateway and whether reporting configuration is present. Does not query Meta.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => toolText({
      status: "authenticated",
      mode: "read_only",
      reporting_key_configured: Boolean((workerEnv as unknown as GatewayEnv).MUSIC_API_KEY),
      reporting_connection_verified: false,
      available_reporting_tools: 6,
    }),
  );

  server.registerTool(
    "get_campaigns",
    { description: "Read Meta campaigns in the Thomas Catoe Music advertising account.", inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
    async () => fetchReporting("/api/campaigns"),
  );
  server.registerTool(
    "get_adsets",
    { description: "Read Meta ad sets, budgets and targeting configurations without changing them.", inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
    async () => fetchReporting("/api/adsets"),
  );
  server.registerTool(
    "get_ads",
    { description: "Read Meta ads and creative identifiers without changing them.", inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
    async () => fetchReporting("/api/ads"),
  );
  server.registerTool(
    "get_insights",
    {
      description: "Read Meta campaign/adset/ad metrics; optionally break down by Facebook/Instagram placement. These are not attributable music streams.",
      inputSchema: z.object({
        level: z.enum(["campaign", "adset", "ad"]).default("adset"),
        date_preset: z.enum(["yesterday", "last_3d", "last_7d", "last_14d", "last_28d", "last_30d"]).default("last_7d"),
        breakdown: z.enum(["none", "placement"]).default("none"),
        after: z.string().min(1).max(512).regex(/^[A-Za-z0-9_\-+=/]+$/).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ level, date_preset, breakdown, after }: {
      level: MetricLevel;
      date_preset: DatePreset;
      breakdown: "none" | "placement";
      after?: string;
    }) => {
      const params = new URLSearchParams({ level, date_preset, breakdown });
      if (after) params.set("after", after);
      return fetchReporting("/api/insights", params);
    },
  );


  server.registerTool(
    "analyze_live_efficiency",
    {
      description: "Retrieve current read-only Meta ad set, creative and placement performance and compute provisional royalty-weighted scores. Requires explicit adset-to-service mapping and USD confirmation; never changes budgets.",
      inputSchema: z.object({
        adset_platform_map: z.array(z.object({
          adset_id: z.string().regex(/^\\d{1,30}$/),
          platform: z.enum(DESTINATIONS),
        })).max(4).default([]),
        currency_confirmed_usd: z.boolean().default(false),
        date_preset: z.enum(["last_7d", "last_14d", "last_30d"]).default("last_7d"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ adset_platform_map, currency_confirmed_usd, date_preset }) => {
      const adsets = await readAllReporting("/api/adsets");
      if (!adsets.ok) return toolText({ status: "source_unavailable", code: adsets.reason }, true);
      if (!adsets.page.data.length || !adset_platform_map.length) {
        return toolText(analyzeLiveReport(
          adsets.page, emptyPage, emptyPage, emptyPage, emptyPage,
          adset_platform_map as PlatformMap[], currency_confirmed_usd, date_preset,
        ));
      }
      const query = (level: "adset" | "ad", breakdown: "none" | "placement") =>
        new URLSearchParams({ level, breakdown, date_preset });
      const [ads, adsetsInsights, adsInsights, placements] = await Promise.all([
        readAllReporting("/api/ads"),
        readAllReporting("/api/insights", query("adset", "none")),
        readAllReporting("/api/insights", query("ad", "none")),
        readAllReporting("/api/insights", query("ad", "placement")),
      ]);
      const responses = [ads, adsetsInsights, adsInsights, placements];
      const error = responses.find((r) => !r.ok);
      if (error && !error.ok) return toolText({ status: "source_unavailable", code: error.reason }, true);
      if (!ads.ok || !adsetsInsights.ok || !adsInsights.ok || !placements.ok)
        return toolText({ status: "source_unavailable" }, true);
      return toolText(analyzeLiveReport(
        adsets.page, adsetsInsights.page, ads.page, adsInsights.page, placements.page,
        adset_platform_map as PlatformMap[], currency_confirmed_usd, date_preset,
      ));
    },
  );

  server.registerTool(
    "simulate_budget_allocation",
    {
      description: "What-if only: propose daily ad-set budgets using royalty-weighted outbound CPC scores, 5–7 complete-day/30-click gates, exploration floors, 50% share caps, Meta minimum budgets, and ±20% change limits. Does not make Meta changes.",
      inputSchema: z.object({
        proposed_total_daily_budget_usd: z.number().positive().max(100000),
        confirmed_usd_currency: z.boolean(),
        observed_complete_days: z.number().int().min(0).max(31),
        data_complete_and_unpaginated: z.boolean(),
        measurements: z.array(z.object({
          platform: z.enum(DESTINATIONS),
          spend_usd: z.number().nonnegative().max(1000000),
          outbound_clicks: z.number().int().nonnegative().max(100000000),
          current_daily_budget_usd: z.number().positive().max(100000),
          minimum_daily_budget_usd: z.number().nonnegative().max(100000),
          royalty_per_1000_usd: z.number().positive().max(1000).optional(),
        })).length(4),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => toolText(simulateAllocation(args)),
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

const apiHandler = {
  fetch(request: Request, env: GatewayEnv, ctx: ExecutionContext) {
    // OAuthProvider invokes this handler only after token validation.
    // It augments the ordinary execution context with verified auth metadata.
    const verified = ctx as OAuthResourceContext<Identity>;
    if (!verified.auth) return new Response("Unauthorized", { status: 401 });
    if (!verified.auth.scope.includes("mcp:read")) {
      return insufficientScope(verified.auth, ["mcp:read"]);
    }
    if (verified.props?.githubId !== OWNER_GITHUB_ID) {
      return new Response("Forbidden", { status: 403 });
    }
    return mcpHandler(request, env, ctx);
  },
};

async function authorize(request: Request, env: GatewayEnv) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.OAUTH_KV) {
    return new Response("OAuth is not configured.", { status: 503 });
  }
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(consentHtml(details, consent.handle), { headers: consent.headers });
    }
    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") || "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, {
        scope: form.getAll("scope").map(String),
      });
      const upstream = await oauth.beginUpstream(approved.request, { headers: approved.headers });
      const githubUrl = new URL("https://github.com/login/oauth/authorize");
      githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      githubUrl.searchParams.set("redirect_uri", new URL("/callback", request.url).toString());
      githubUrl.searchParams.set("scope", "read:user");
      githubUrl.searchParams.set("state", upstream.state);
      upstream.headers.set("Location", githubUrl.toString());
      return new Response(null, { status: 302, headers: upstream.headers });
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      return new Response("OAuth authorization could not be validated.", { status: 400 });
    }
    throw error;
  }
}

async function githubCallback(request: Request, env: GatewayEnv) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.OAUTH_KV) {
    return new Response("OAuth is not configured.", { status: 503 });
  }
  const oauth = env.OAUTH_PROVIDER;
  const finished = await oauth.finishUpstream(request);
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return new Response("GitHub authorization was not completed.", { status: 403 });

  // GitHub's web OAuth token exchange expects form-encoded parameters.
  // Never log the authorization code, client secret, or access token.
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "music-campaign-optimizer-mcp",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/callback", request.url).toString(),
    }).toString(),
    redirect: "manual",
  });
  if (!response.ok) {
    console.error("GitHub OAuth token exchange returned an unsuccessful HTTP status", { status: response.status });
    return new Response("GitHub sign-in failed.", { status: 502 });
  }
  const tokenBody = await response.json() as { access_token?: string; error?: string }; 
  if (tokenBody.error) {
    console.error("GitHub OAuth rejected the token exchange", { error: tokenBody.error });
    return new Response("GitHub authorization was rejected.", { status: 403 });
  }
  if (!tokenBody.access_token) return new Response("GitHub did not grant authorization.", { status: 403 });

  const profileResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "music-campaign-optimizer-mcp",
    },
    redirect: "manual",
  });
  if (!profileResponse.ok) return new Response("GitHub identity verification failed.", { status: 403 });
  const profile = await profileResponse.json() as { id?: number; login?: string };
  if (profile.id !== OWNER_GITHUB_ID) return new Response("This MCP service is restricted to its owner.", { status: 403 });

  const { redirectTo } = await oauth.completeAuthorization({
    request: finished.request,
    userId: String(profile.id),
    scope: finished.request.scope,
    metadata: { label: "Music Campaign Optimizer owner" },
    // Store only identity; discard GitHub's upstream token after verification.
    props: { githubId: profile.id, login: profile.login ?? "" } satisfies Identity,
  });
  finished.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: finished.headers });
}

const defaultHandler = {
  fetch(request: Request, env: GatewayEnv) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/authorize") return authorize(request, env);
    if (pathname === "/callback" && request.method === "GET") return githubCallback(request, env);
    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider<GatewayEnv>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp:read"],
  requiredScopes: ["mcp:read"],
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: ["https://music-campaign-optimizer-mcp.waynecatoe3.workers.dev"],
  },
});
