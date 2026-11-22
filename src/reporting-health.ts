// Safe read-only health probe for the separate Meta REST Worker's daily report route.
// Never includes secrets, upstream response bodies or Meta row-level data in its result.
export type DailyRestProbeStatus =
  "available" | "endpoint_missing" | "unauthorized" | "upstream_error" |
  "invalid_response" | "not_configured" | "unreachable";
export interface DailyRestProbe {
  daily_reporting_endpoint_status: DailyRestProbeStatus;
  daily_reporting_endpoint_verified: boolean;
}
export async function probeDailyRest(
  origin: string, key: string | undefined,
  get: typeof fetch = fetch,
): Promise<DailyRestProbe> {
  if (!key) return { daily_reporting_endpoint_status: "not_configured", daily_reporting_endpoint_verified: false };
  const u = new URL("/api/daily-insights?days=7", origin);
  if (u.protocol !== "https:") return { daily_reporting_endpoint_status: "unreachable", daily_reporting_endpoint_verified: false };
  try {
    const res = await get(u.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 405)
      return { daily_reporting_endpoint_status: "endpoint_missing", daily_reporting_endpoint_verified: false };
    if (res.status === 401 || res.status === 403)
      return { daily_reporting_endpoint_status: "unauthorized", daily_reporting_endpoint_verified: false };
    if (!res.ok || res.status >= 300)
      return { daily_reporting_endpoint_status: "upstream_error", daily_reporting_endpoint_verified: false };
    const body: unknown = await res.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { daily_reporting_endpoint_status: "invalid_response", daily_reporting_endpoint_verified: false };
    }
    const o = body as Record<string, unknown>;
    if (o.schema_version !== "1" || o.level !== "adset" || o.time_increment !== 1 ||
        o.pagination_complete !== true || !Array.isArray(o.rows) ||
        typeof o.account_id !== "string" || typeof o.account_currency !== "string" ||
        typeof o.account_timezone !== "string" || typeof o.fetched_at !== "string" ||
        typeof o.since !== "string" || typeof o.until !== "string") {
      return { daily_reporting_endpoint_status: "invalid_response", daily_reporting_endpoint_verified: false };
    }
    return { daily_reporting_endpoint_status: "available", daily_reporting_endpoint_verified: true };
  } catch {
    return { daily_reporting_endpoint_status: "unreachable", daily_reporting_endpoint_verified: false };
  }
}
