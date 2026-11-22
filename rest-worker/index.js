/**
 * Music Campaign Optimizer: read-only Meta REST Worker.
 * Cloudflare Worker: odd-hall-a184
 * This source is intentionally separate from the owner-authenticated MCP gateway.
 * Required existing bindings: MUSIC_API_KEY and META_ACCESS_TOKEN (secrets),
 * META_AD_ACCOUNT_ID (plain string variable). No secret values in source.
 */
const GRAPH_ORIGIN = "https://graph.facebook.com";
const GRAPH_VERSION = "v27.0";
const ALLOWED_LEVELS = new Set(["campaign", "adset", "ad"]);
const ALLOWED_PRESETS = new Set(["yesterday", "last_3d", "last_7d", "last_14d", "last_28d", "last_30d"]);
const CURSOR_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-+=/";
const MAX_PAGES = 20;
const MAX_DAILY_ROWS = 1000;
function respond(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}
function cleanAdAccountId(input) {
  if (typeof input !== "string") return null;
  const val = input.trim();
  if (/^act_\d{1,30}$/.test(val)) return val;
  if (/^\d{1,30}$/.test(val)) return "act_" + val;
  return null;
}
function safeCursor(input) {
  return typeof input === "string" && input.length > 0 && input.length <= 512 &&
    [...input].every(ch => CURSOR_CHARS.includes(ch)) ? input : null;
}
function graphUrl(edge, params) {
  const url = new URL("/" + GRAPH_VERSION + "/" + edge, GRAPH_ORIGIN);
  if (params) url.search = params.toString();
  return url;
}
async function graphJson(env, edge, params) {
  const res = await fetch(graphUrl(edge, params), {
    method: "GET",
    headers: {
      "authorization": "Bearer " + env.META_ACCESS_TOKEN,
      "accept": "application/json",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  // Do not relay Meta error bodies or paging URLs; they could reveal credentials.
  if (!res.ok || res.status >= 300) throw new Error("meta_fetch_failed");
  const data = await res.json();
  if (!data || typeof data !== "object" || Array.isArray(data) || data.error) {
    throw new Error("invalid_meta_json");
  }
  return data;
}
async function graphPage(env, edge, params) {
  const data = await graphJson(env, edge, params);
  if (!Array.isArray(data.data)) throw new Error("meta_missing_page_data");
  const hasMore = typeof data.paging?.next === "string";
  const nextCursor = hasMore ? safeCursor(data.paging?.cursors?.after) : null;
  if (hasMore && !nextCursor) throw new Error("meta_invalid_cursor");
  return respond({data: data.data, has_more: hasMore, next_cursor: nextCursor});
}
function validDate(val) {
  if (typeof val !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const date = new Date(val + "T00:00:00.000Z");
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0,10) === val;
}
function dayOffset(date, n) {
  const time = Date.parse(date + "T00:00:00.000Z");
  return new Date(time + 86400000*n).toISOString().slice(0,10);
}
function todayInTimezone(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const get = kind => parts.find(p => p.type === kind)?.value ?? "";
    const value = get("year") + "-" + get("month") + "-" + get("day");
    return validDate(value) ? value : null;
  } catch { return null; }
}
async function metaDaily(env, account, days) {
  const metadata = await graphJson(env, account,
    new URLSearchParams({fields: "account_id,currency,timezone_name"}));
  const accountId = account.slice(4);
  if (metadata.account_id !== accountId ||
      typeof metadata.currency !== "string" ||
      typeof metadata.timezone_name !== "string") throw new Error("meta_account_mismatch");
  const today = todayInTimezone(metadata.timezone_name);
  if (!today) throw new Error("invalid_timezone");
  // Two-day lag to avoid the current and immediately prior account-local day.
  const until = dayOffset(today,-2), since = dayOffset(until,1-days);
  const baseParams = new URLSearchParams({
    fields: "account_id,account_currency,adset_id,date_start,date_stop,spend,outbound_clicks",
    level: "adset", time_increment: "1", time_range: JSON.stringify({since,until}), limit: "250",
  });
  let after = null, complete = false;
  const cursors = new Set(), rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams(baseParams);
    if (after) params.set("after",after);
    const result = await graphJson(env, account + "/insights", params);
    if (!Array.isArray(result.data)) throw new Error("invalid_meta_daily_page");
    for (const raw of result.data) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
          raw.account_id !== accountId || raw.account_currency !== metadata.currency ||
          !/^\d{1,30}$/.test(raw.adset_id || "") ||
          !validDate(raw.date_start) || raw.date_stop !== raw.date_start ||
          raw.date_start < since || raw.date_start > until ||
          typeof raw.spend !== "string" || !/^\d+(?:\.\d+)?$/.test(raw.spend)) {
        throw new Error("invalid_daily_row");
      }
      rows.push({
        adset_id: raw.adset_id,
        date_start: raw.date_start, date_stop: raw.date_stop,
        spend: raw.spend, outbound_clicks: raw.outbound_clicks ?? null,
        account_currency: metadata.currency,
      });
      if (rows.length > MAX_DAILY_ROWS) throw new Error("daily_row_limit_exceeded");
    }
    if (typeof result.paging?.next !== "string") { complete = true; break; }
    const cursor = safeCursor(result.paging?.cursors?.after);
    if (!cursor || cursors.has(cursor)) throw new Error("invalid_daily_page_cursor");
    cursors.add(cursor);
    after = cursor;
  }
  if (!complete) throw new Error("daily_pagination_incomplete");
  return respond({
    schema_version: "1",
    account_id: accountId,
    account_currency: metadata.currency,
    account_timezone: metadata.timezone_name,
    fetched_at: new Date().toISOString(),
    level: "adset",
    time_increment: 1,
    since, until, pagination_complete: true, rows,
  });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return respond({error:"GET requests only"},405,{allow:"GET"});
    if (url.pathname === "/health")
      return respond({status:"ok", service:"music-campaign-optimizer",mode:"read-only"});
    if (url.pathname === "/")
      return respond({service:"music-campaign-optimizer",status:"running",health:"/health"});
    if (!url.pathname.startsWith("/api/")) return respond({error:"not_found"},404);
    // Gate every /api endpoint, including daily insights, before any Meta fetch.
    if (!env.MUSIC_API_KEY) return respond({error:"not_configured"},503);
    if (request.headers.get("authorization") !== "Bearer " + env.MUSIC_API_KEY)
      return respond({error:"unauthorized"},401,{"www-authenticate":"Bearer"});
    const account = cleanAdAccountId(env.META_AD_ACCOUNT_ID);
    if (!account || !env.META_ACCESS_TOKEN) return respond({error:"meta_not_configured"},503);
    if (url.pathname === "/api/daily-insights") {
      const days = url.searchParams.get("days") ?? "7";
      if (!["5","6","7"].includes(days) ||
          [...url.searchParams.keys()].some(x=>x!=="days"))
        return respond({error:"invalid_daily_parameters",allowed_days:[5,6,7]},400);
      try { return await metaDaily(env,account,Number(days)); }
      catch { return respond({error:"meta_daily_unavailable"},502); }
    }
    const params = new URLSearchParams({limit:"100"});
    let edge;
    if (url.pathname === "/api/campaigns") {
      edge = account + "/campaigns";
      params.set("fields","id,name,status,objective");
    } else if (url.pathname === "/api/adsets") {
      edge = account + "/adsets";
      params.set("fields","id,name,campaign_id,status,daily_budget,lifetime_budget,targeting");
    } else if (url.pathname === "/api/ads") {
      edge = account + "/ads";
      params.set("fields","id,name,adset_id,campaign_id,status,creative{id,name}");
    } else if (url.pathname === "/api/insights") {
      const level = url.searchParams.get("level") || "adset";
      const preset = url.searchParams.get("date_preset") || "last_7d";
      const breakdown = url.searchParams.get("breakdown") || "none";
      if (!ALLOWED_LEVELS.has(level) || !ALLOWED_PRESETS.has(preset) ||
          !["none","placement"].includes(breakdown))
        return respond({error:"invalid_parameters"},400);
      edge = account + "/insights";
      params.set("fields","campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,outbound_clicks");
      params.set("level",level);
      params.set("date_preset",preset);
      if (breakdown === "placement") params.set("breakdowns","publisher_platform,platform_position");
    } else return respond({error:"not_found"},404);
    const cursorInput = url.searchParams.get("after");
    if (cursorInput !== null) {
      const cursor = safeCursor(cursorInput);
      if (!cursor) return respond({error:"invalid_cursor"},400);
      params.set("after",cursor);
    }
    try { return await graphPage(env,edge,params); }
    catch { return respond({error:"meta_unreachable"},502); }
  },
};
