// Read-only, fail-closed verification of Meta's day-scoped ad-set Insights.
// The trusted flag is set by the gateway only after authenticated REST fetch;
// callers of this pure function cannot enable Meta spending or write actions.
import { DESTINATIONS, asId, finiteNonNegative, outboundClicks, type Destination } from "./optimizer";

export interface DailyRow {
  adset_id: string;
  date_start: string;
  date_stop: string;
  spend: string | number;
  outbound_clicks: unknown;
  account_currency?: string;
}
export interface DailyEvidence {
  schema_version: "1";
  account_id: string;
  account_currency: string;
  account_timezone: string;
  fetched_at: string;
  level: "adset";
  time_increment: 1;
  since: string;
  until: string;
  pagination_complete: boolean;
  rows: DailyRow[];
}
export interface DailyMap {
  adset_id: string;
  platform: Destination;
}
export interface DailyEvaluation {
  status: "ready_for_read_only_simulation" | "blocked";
  reasons: string[];
  source: "authenticated_rest_worker" | "caller_supplied";
  automatic_budget_changes_allowed: false;
  expected_window: { since: string; until: string; days: number; reporting_lag_days: 2 } | null;
  summaries: {
    platform: Destination;
    adset_id: string | null;
    days_observed: number;
    spend_usd: number | null;
    outbound_clicks: number | null;
    outbound_cpc_usd: number | null;
    sample_sufficient: boolean;
  }[];
  cautions: string[];
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
function validDate(d: string): boolean {
  if (!datePattern.test(d)) return false;
  const dt = new Date(d + "T00:00:00.000Z");
  return Number.isFinite(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}
function shiftDate(date: string, shift: number): string {
  return new Date(Date.parse(date + "T00:00:00.000Z") + shift * 86400000).toISOString().slice(0, 10);
}
function localDate(now: Date, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const x = (part: string) => parts.find((p) => p.type === part)?.value ?? "";
    const date = x("year") + "-" + x("month") + "-" + x("day");
    return validDate(date) ? date : null;
  } catch {
    return null;
  }
}

// Shared account-local reporting window contract used by the REST collector.
export function requiredDailyWindow(
  now: Date, timezone: string, days: 5 | 6 | 7,
): { since: string; until: string; days: number; reporting_lag_days: 2 } | null {
  const today = localDate(now, timezone);
  if (!today || ![5, 6, 7].includes(days)) return null;
  const until = shiftDate(today, -2);
  return { since: shiftDate(until, 1 - days), until, days, reporting_lag_days: 2 };
}

export function evaluateDailyEvidence(
  report: DailyEvidence,
  mapping: DailyMap[],
  now: Date = new Date(),
  fromAuthenticatedWorker = false,
): DailyEvaluation {
  const reasons: string[] = [];
  const cautions = [
    "This is validation of paid-ad reporting, not observation of music streams or attributable royalties.",
    "Complete daily rows do not guarantee that Meta will not restate late events; two local days of reporting lag are excluded.",
    "Even a passing validation cannot enable Meta budget changes: no write permission, approvals, cap enforcement or scheduler exist.",
  ];
  const today = localDate(now, report.account_timezone);
  const unique = new Map<Destination, string>();
  const ids = new Set<string>();
  for (const m of mapping) {
    if (!asId(m.adset_id) || !DESTINATIONS.includes(m.platform) ||
        unique.has(m.platform) || ids.has(m.adset_id)) reasons.push("invalid_or_duplicate_adset_mapping");
    unique.set(m.platform, m.adset_id);
    ids.add(m.adset_id);
  }
  if (mapping.length !== 4 || unique.size !== 4) reasons.push("requires_four_unique_service_mappings");
  if (!asId(report.account_id)) reasons.push("invalid_ad_account");
  if (report.account_currency !== "USD") reasons.push("account_must_be_verified_usd");
  if (!today) reasons.push("unrecognized_account_timezone");
  if (report.schema_version !== "1" || report.level !== "adset" || report.time_increment !== 1)
    reasons.push("daily_source_contract_not_verified");
  if (report.pagination_complete !== true) reasons.push("pagination_incomplete");
  const fetched = Date.parse(report.fetched_at);
  if (!Number.isFinite(fetched) || fetched > now.getTime() + 300000 ||
      now.getTime() - fetched > 24 * 3600000) reasons.push("stale_or_invalid_fetch_timestamp");
  if (!Array.isArray(report.rows) || report.rows.length > 1000) reasons.push("invalid_or_oversized_daily_rows");

  // One complete account-local day is not a stable finalized window; withhold
  // yesterday and today by requiring a two-day reporting lag.
  const end = today ? shiftDate(today, -2) : null;
  const days = (end && validDate(report.since) && validDate(report.until))
    ? Math.round((Date.parse(report.until + "T00:00:00Z") -
        Date.parse(report.since + "T00:00:00Z")) / 86400000) + 1
    : 0;
  const window = end && days >= 5 && days <= 7
    ? { since: shiftDate(end, 1 - days), until: end, days, reporting_lag_days: 2 as const }
    : null;
  if (!window || report.since !== window.since || report.until !== window.until)
    reasons.push("window_must_be_five_to_seven_consecutive_complete_local_days");

  const expectedDays = window
    ? Array.from({ length: window.days }, (_, i) => shiftDate(window.since, i))
    : [];
  const rowMap = new Map<string, {spend:number;clicks:number}>();
  if (Array.isArray(report.rows)) for (const row of report.rows) {
    if (!row || typeof row !== "object") { reasons.push("invalid_daily_row"); continue; }
    if (!asId(row.adset_id) || !ids.has(row.adset_id) ||
        !validDate(row.date_start) || row.date_stop !== row.date_start ||
        !expectedDays.includes(row.date_start)) {
      reasons.push("unexpected_adset_or_daily_date"); continue;
    }
    if (row.account_currency !== undefined && row.account_currency !== report.account_currency)
      reasons.push("daily_row_currency_mismatch");
    const spend = finiteNonNegative(row.spend);
    const clicks = outboundClicks(row.outbound_clicks);
    if (spend === null || clicks === null) { reasons.push("missing_or_ambiguous_daily_metrics"); continue; }
    const key = row.adset_id + ":" + row.date_start;
    if (rowMap.has(key)) { reasons.push("duplicate_daily_row"); continue; }
    rowMap.set(key, { spend, clicks });
  }
  const summaries = DESTINATIONS.map((platform) => {
    const id = unique.get(platform) ?? null;
    const observations = id ? expectedDays.map((d) => rowMap.get(id + ":" + d)) : [];
    const complete = observations.length === expectedDays.length &&
      observations.length > 0 && observations.every((v) => v !== undefined);
    if (id && !complete) reasons.push("missing_daily_adset_rows");
    const spend = complete ? observations.reduce((s, r) => s + r!.spend, 0) : null;
    const clicks = complete ? observations.reduce((s, r) => s + r!.clicks, 0) : null;
    const sufficient = clicks !== null && clicks >= 30 && spend !== null && spend > 0;
    if (complete && !sufficient) reasons.push("insufficient_platform_click_sample");
    return {
      platform, adset_id: id,
      days_observed: observations.filter(Boolean).length,
      spend_usd: spend === null ? null : Number(spend.toFixed(2)),
      outbound_clicks: clicks,
      outbound_cpc_usd: spend !== null && clicks !== null && clicks > 0
        ? Number((spend / clicks).toFixed(5)) : null,
      sample_sufficient: sufficient,
    };
  });
  if (!fromAuthenticatedWorker) cautions.push("These rows were supplied externally and are NOT authenticated directly against the Meta REST Worker.");
  if (reasons.length === 0 && !fromAuthenticatedWorker)
    reasons.push("source_not_verified_by_gateway");
  if (reasons.length === 0 && !window) reasons.push("missing_window");
  return {
    status: reasons.length === 0 ? "ready_for_read_only_simulation" : "blocked",
    reasons: [...new Set(reasons)],
    source: fromAuthenticatedWorker ? "authenticated_rest_worker" : "caller_supplied",
    automatic_budget_changes_allowed: false, expected_window: window, summaries, cautions,
  };
}
