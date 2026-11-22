// Production-ready helper for upgrading the SEPARATE Meta REST Worker.
// This module is not yet connected to odd-hall-a184: do not claim that it is.
// It uses only GET requests and never has an MCP OAuth or budget-write role.

import { requiredDailyWindow, type DailyEvidence, type DailyRow } from "./daily-safety.ts";

export type MetaGetter = (url: string, init: RequestInit) => Promise<Response>;
export interface MetaDailyCredentials {
  metaAccessToken: string;
  metaAdAccountId: string; // act_4694...
}
type JsonMap = Record<string, unknown>;
const cursorCharacters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-+=/";
const isObject = (v: unknown): v is JsonMap => !!v && typeof v === "object" && !Array.isArray(v);
const isDigits = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= 30 && [...s].every((x) => "0123456789".includes(x));
const validCursor = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= 512 &&
  [...s].every((x) => cursorCharacters.includes(x));

// Call only after the original REST Worker's MUSIC_API_KEY bearer check.
export async function collectAuthenticatedMetaDaily(
  secrets: MetaDailyCredentials,
  days: 5 | 6 | 7,
  now: Date = new Date(),
  get: MetaGetter = fetch,
): Promise<DailyEvidence> {
  const accountRef = secrets.metaAdAccountId;
  if (!/^act_\d{1,30}$/.test(accountRef) || !secrets.metaAccessToken ||
      ![5, 6, 7].includes(days)) throw new Error("invalid_reporting_configuration");
  const headers = {
    Authorization: `Bearer ${secrets.metaAccessToken}`,
    Accept: "application/json",
  };
  const graphRoot = "https://graph.facebook.com/v27.0/";
  async function metaGet(url: URL): Promise<JsonMap> {
    if (url.origin !== "https://graph.facebook.com")
      throw new Error("graph_origin_not_allowed");
    const response = await get(url.toString(), {
      method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || response.status >= 300) throw new Error("meta_daily_api_unavailable");
    const payload: unknown = await response.json();
    if (!isObject(payload) || isObject(payload.error)) throw new Error("meta_daily_invalid_response");
    return payload;
  }
  const accountUrl = new URL(accountRef, graphRoot);
  accountUrl.searchParams.set("fields", "account_id,currency,timezone_name");
  const account = await metaGet(accountUrl);
  const id = account.account_id;
  const tz = account.timezone_name;
  const currency = account.currency;
  if (!isDigits(id) || id !== accountRef.slice(4) ||
      typeof tz !== "string" || typeof currency !== "string") {
    throw new Error("meta_account_identity_or_settings_missing");
  }
  const window = requiredDailyWindow(now, tz, days);
  if (!window) throw new Error("unsupported_meta_account_timezone");
  const insights = new URL(accountRef + "/insights", graphRoot);
  insights.searchParams.set("level", "adset");
  insights.searchParams.set("time_increment", "1");
  insights.searchParams.set("time_range", JSON.stringify({
    since: window.since, until: window.until,
  }));
  insights.searchParams.set("fields",
    "account_id,account_currency,adset_id,date_start,date_stop,spend,outbound_clicks");
  insights.searchParams.set("limit", "250");
  const rows: DailyRow[] = [];
  let cursor: string | null = null;
  let done = false;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const url = new URL(insights.toString());
    if (cursor) url.searchParams.set("after", cursor);
    const payload = await metaGet(url);
    if (!Array.isArray(payload.data)) throw new Error("invalid_meta_insights_rows");
    for (const raw of payload.data) {
      if (!isObject(raw)) throw new Error("invalid_meta_insights_row");
      if (raw.account_id !== id || raw.account_currency !== currency ||
          !isDigits(raw.adset_id) || typeof raw.date_start !== "string" ||
          typeof raw.date_stop !== "string" || typeof raw.spend !== "string") {
        throw new Error("invalid_meta_insights_row_metadata");
      }
      // Do not translate missing outbound click metrics into fabricated zeros.
      rows.push({
        adset_id: raw.adset_id,
        date_start: raw.date_start,
        date_stop: raw.date_stop,
        spend: raw.spend,
        outbound_clicks: raw.outbound_clicks,
        account_currency: currency,
      });
      if (rows.length > 1000) throw new Error("meta_daily_rows_limit_exceeded");
    }
    const paging = payload.paging;
    const next = isObject(paging) ? paging.next : undefined;
    if (next === undefined || next === null) { done = true; break; }
    const cursors = isObject(paging) ? paging.cursors : null;
    const after = isObject(cursors) ? cursors.after : null;
    // Ignore Meta's arbitrary paging.next URL (which may include secrets).
    // Reconstruct a constant-origin Insights GET using only its bounded cursor.
    if (typeof next !== "string" || !validCursor(after) || seen.has(after))
      throw new Error("meta_daily_pagination_unverifiable");
    seen.add(after);
    cursor = after;
  }
  if (!done) throw new Error("meta_daily_pagination_limit_exceeded");
  return {
    schema_version: "1", account_id: id, account_currency: currency,
    account_timezone: tz, fetched_at: now.toISOString(),
    level: "adset", time_increment: 1,
    since: window.since, until: window.until,
    pagination_complete: true, rows,
  };
}
