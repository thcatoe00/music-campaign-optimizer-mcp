// Pure, deterministic read-only analytics and scenario budgeting.
// Dollar values require an explicitly confirmed USD ad account.
// No Meta writes, scheduling or attribution of paid streams.

export const DESTINATIONS = ["Spotify", "YouTube Music", "Amazon Music", "Apple Music"] as const;
export type Destination = (typeof DESTINATIONS)[number];
export const DEFAULT_ROYALTY_PER_1000: Record<Destination, number> = {
  Spotify: 4.41, "YouTube Music": 10.22, "Amazon Music": 8.61, "Apple Music": 6.28,
};
export type RawRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
export function outboundClicks(value: unknown): number | null {
  if (Array.isArray(value)) {
    // Do not confuse link clicks, omni clicks, or other action types with outbound clicks.
    const hits = value.filter((v) => isRecord(v) && v.action_type === "outbound_click");
    if (hits.length !== 1) return null;
    const n = finiteNonNegative(hits[0].value);
    return n !== null && Number.isInteger(n) ? n : null;
  }
  const n = finiteNonNegative(value);
  return n !== null && Number.isInteger(n) ? n : null;
}
const round = (n: number, places = 4) => Number(n.toFixed(places));
export const asId = (v: unknown) => typeof v === "string" && /^\d{1,30}$/.test(v) ? v : null;
export const validDestination = (v: unknown): v is Destination =>
  typeof v === "string" && (DESTINATIONS as readonly string[]).includes(v);

export interface Measurement {
  platform: Destination;
  spend_usd: number;
  outbound_clicks: number;
  current_daily_budget_usd: number;
  minimum_daily_budget_usd: number;
  royalty_per_1000_usd?: number;
}
export interface Scenario {
  proposed_total_daily_budget_usd: number;
  confirmed_usd_currency: boolean;
  observed_complete_days: number;
  data_complete_and_unpaginated: boolean;
  measurements: Measurement[];
}
export interface ScenarioOutcome {
  mode: "simulation_only";
  status: "ready" | "blocked";
  reasons: string[];
  assumptions: string[];
  provisional_rates_per_1000_usd: Record<Destination, number>;
  platforms: {
    platform: Destination;
    spend_usd: number;
    outbound_clicks: number;
    outbound_cpc_usd: number | null;
    royalty_weighted_proxy_index: number | null;
    previous_daily_budget_usd: number;
    simulated_daily_budget_usd: number | null;
    simulated_change_percent: number | null;
  }[];
  total_simulated_daily_budget_usd: number | null;
  actual_budget_changes_applied: false;
}

export function simulateAllocation(input: Scenario): ScenarioOutcome {
  const reasons: string[] = [];
  const assumptions = [
    "Illustrative royalty amounts are not fixed per-stream payouts.",
    "The score assumes equal qualified streams per outbound click across services; this is not observed.",
    "A click does not establish a paid stream or actual attributable royalty.",
    "This is a what-if model only: no Meta budget changes are made.",
    "Budget floors/caps are planning assumptions; verify Meta-enforced minimums and the campaign spending ceiling.",
  ];
  const byPlatform = new Map<Destination, Measurement>();
  for (const m of input.measurements) {
    if (byPlatform.has(m.platform)) reasons.push("duplicate_platform");
    byPlatform.set(m.platform, m);
  }
  if (byPlatform.size !== 4 || input.measurements.length !== 4 ||
      DESTINATIONS.some((p) => !byPlatform.has(p))) reasons.push("four_unique_platforms_required");
  if (!input.confirmed_usd_currency) reasons.push("account_currency_not_confirmed_usd");
  if (!input.data_complete_and_unpaginated) reasons.push("data_completeness_not_verified");
  if (input.observed_complete_days < 5 || input.observed_complete_days > 7) reasons.push("requires_five_to_seven_complete_days");
  if (!(input.proposed_total_daily_budget_usd > 0)) reasons.push("positive_budget_required");

  const rates = { ...DEFAULT_ROYALTY_PER_1000 };
  const rows = DESTINATIONS.map((platform) => {
    const m = byPlatform.get(platform);
    if (m?.royalty_per_1000_usd !== undefined) rates[platform] = m.royalty_per_1000_usd;
    const spend = m?.spend_usd ?? NaN;
    const clicks = m?.outbound_clicks ?? NaN;
    const valid = Number.isFinite(spend) && spend >= 0 && Number.isInteger(clicks) && clicks >= 0;
    if (!valid) reasons.push("invalid_spend_or_outbound_click_count");
    if (valid && clicks < 30) reasons.push("insufficient_outbound_clicks");
    if (!m || !Number.isFinite(m.current_daily_budget_usd) || m.current_daily_budget_usd <= 0 ||
        !Number.isFinite(m.minimum_daily_budget_usd) || m.minimum_daily_budget_usd < 0) {
      reasons.push("invalid_or_missing_current_or_minimum_budget");
    }
    if (!Number.isFinite(rates[platform]) || rates[platform] <= 0) reasons.push("invalid_royalty_assumption");
    const cpc = valid && clicks > 0 ? spend / clicks : null;
    const proxy = cpc !== null && cpc > 0 && Number.isFinite(rates[platform]) && rates[platform] > 0
      ? rates[platform] / cpc : null;
    if (proxy === null) reasons.push("unscorable_platform");
    return {
      platform, spend_usd: spend, outbound_clicks: clicks,
      outbound_cpc_usd: cpc === null ? null : round(cpc, 5),
      royalty_weighted_proxy_index: proxy === null ? null : round(proxy, 5),
      previous_daily_budget_usd: m?.current_daily_budget_usd ?? NaN,
      simulated_daily_budget_usd: null as number | null,
      simulated_change_percent: null as number | null,
      _score: proxy, _min: m?.minimum_daily_budget_usd ?? NaN,
    };
  });
  if (input.measurements.length === 4) {
    const currentTotal = rows.reduce((s, x) => s + x.previous_daily_budget_usd, 0);
    if (!Number.isFinite(currentTotal) || Math.abs(currentTotal - input.proposed_total_daily_budget_usd) > 0.03) {
      reasons.push("existing_daily_budget_sum_does_not_match_scenario_total");
    }
  }
  const amount = input.proposed_total_daily_budget_usd;
  const lower = rows.map((r) => Math.max(0.10 * amount, r._min, 0.80 * r.previous_daily_budget_usd));
  const upper = rows.map((r) => Math.min(0.50 * amount, 1.20 * r.previous_daily_budget_usd));
  if (lower.some((v, i) => !Number.isFinite(v) || !Number.isFinite(upper[i]) || v > upper[i] + 0.000001) ||
    lower.reduce((a, b) => a + b, 0) > amount + 0.000001 ||
    upper.reduce((a, b) => a + b, 0) < amount - 0.000001) {
    reasons.push("infeasible_budget_bounds");
  }
  let allocation: number[] | null = null;
  if (reasons.length === 0) {
    allocation = [...lower];
    const scores = rows.map((r) => r._score ?? 0);
    let remaining = amount - allocation.reduce((s, v) => s + v, 0);
    // Weighted water filling under hard lower/upper bounds.
    for (let step = 0; step < 12 && remaining > 0.000001; step++) {
      const eligible = scores.map((score, i) => (upper[i] - allocation![i] > 0.000001 ? i : -1))
        .filter((i) => i >= 0);
      if (eligible.length === 0) break;
      const weight = eligible.reduce((sum, i) => sum + scores[i], 0);
      let added = 0;
      for (const i of eligible) {
        const share = weight > 0 ? scores[i] / weight : 1 / eligible.length;
        const extra = Math.min(remaining * share, upper[i] - allocation[i]);
        allocation[i] += extra;
        added += extra;
      }
      remaining -= added;
      if (added <= 0.000001) break;
    }
    if (Math.abs(amount - allocation.reduce((s, v) => s + v, 0)) > 0.005) {
      reasons.push("unable_to_reconcile_budget_allocation");
      allocation = null;
    } else {
      // Round only after feasibility, preserving the total in cents and per-adset constraints.
      const centsTarget = Math.round(amount * 100);
      const floorCents = lower.map((v) => Math.ceil((v - 1e-9) * 100));
      const capCents = upper.map((v) => Math.floor((v + 1e-9) * 100));
      const cents = allocation.map((v, i) =>
        Math.max(floorCents[i], Math.min(capCents[i], Math.floor(v * 100 + 1e-8))));
      let delta = centsTarget - cents.reduce((a, b) => a + b, 0);
      for (let k = 0; k < 100000 && delta !== 0; k++) {
        const indices = [0, 1, 2, 3].filter((i) =>
          delta > 0 ? cents[i] < capCents[i] : cents[i] > floorCents[i]);
        if (!indices.length) break;
        indices.sort((a, b) => delta > 0
          ? ((allocation![b] * 100 - cents[b]) - (allocation![a] * 100 - cents[a]))
          : ((cents[b] - allocation![b] * 100) - (cents[a] - allocation![a] * 100)));
        cents[indices[0]] += delta > 0 ? 1 : -1;
        delta += delta > 0 ? -1 : 1;
      }
      if (delta !== 0) { allocation = null; reasons.push("cent_rounding_infeasible"); }
      else allocation = cents.map((c) => c / 100);
    }
  }
  const resultRows = rows.map((r, i) => ({
    platform: r.platform, spend_usd: r.spend_usd,
    outbound_clicks: r.outbound_clicks, outbound_cpc_usd: r.outbound_cpc_usd,
    royalty_weighted_proxy_index: r.royalty_weighted_proxy_index,
    previous_daily_budget_usd: r.previous_daily_budget_usd,
    simulated_daily_budget_usd: allocation?.[i] ?? null,
    simulated_change_percent: allocation ? round(100 * (allocation[i] - r.previous_daily_budget_usd) / r.previous_daily_budget_usd, 2) : null,
  }));
  return {
    mode: "simulation_only", status: reasons.length ? "blocked" : "ready",
    reasons: [...new Set(reasons)], assumptions,
    provisional_rates_per_1000_usd: rates, platforms: resultRows,
    total_simulated_daily_budget_usd: allocation ? round(allocation.reduce((s, v) => s + v, 0), 2) : null,
    actual_budget_changes_applied: false,
  };
}

export interface LivePage { data: RawRecord[]; has_more: boolean; next_cursor: string | null }
export interface PlatformMap { adset_id: string; platform: Destination }
type Ranked = {
  id: string;
  name: string | null;
  platform: Destination;
  placement: string | null;
  spend_account_currency: number | null;
  outbound_clicks: number | null;
  outbound_cpc_account_currency: number | null;
  royalty_weighted_proxy_index: number | null;
  provisional_comparison_only: true;
};

export function analyzeLiveReport(
  adsets: LivePage, adsetInsights: LivePage, ads: LivePage,
  adInsights: LivePage, placementInsights: LivePage, platformMap: PlatformMap[],
  currencyConfirmedUSD: boolean, period: string,
) {
  const notices: string[] = [
    "No listening conversions or ad-attributed royalty revenue are available through these direct links.",
    "The current Meta API query aggregates the requested date preset; complete account-local days, currency and date freshness cannot be independently verified.",
    "Genre/service interests may be soft suggestions; with one audience per platform the audience effect is confounded with platform performance.",
    "Meta allocates delivery among ads and placements within an ad set; this report cannot set creative/placement budgets.",
  ];
  const pages = [adsets, adsetInsights, ads, adInsights, placementInsights];
  const completePagination = pages.every((p) => !p.has_more);
  const allAdsets = adsets.data.filter(isRecord);
  const relevantIds = new Set(allAdsets.map((r) => asId(r.id)).filter((s): s is string => !!s));
  const idToPlatform = new Map<string, Destination>();
  const seenPlatforms = new Set<Destination>();
  const mapErrors: string[] = [];
  for (const entry of platformMap) {
    if (!asId(entry.adset_id) || !validDestination(entry.platform)) { mapErrors.push("invalid_map_entry"); continue; }
    if (idToPlatform.has(entry.adset_id) || seenPlatforms.has(entry.platform)) mapErrors.push("duplicate_map_assignment");
    idToPlatform.set(entry.adset_id, entry.platform);
    seenPlatforms.add(entry.platform);
    if (!relevantIds.has(entry.adset_id)) mapErrors.push("mapping_id_not_in_current_adsets");
  }
  if (platformMap.length > 0 && platformMap.length !== 4) mapErrors.push("four_adset_map_entries_required");
  const adIdMap = new Map<string,string>();
  for (const a of ads.data) {
    const aid = asId(a.id), sid = asId(a.adset_id);
    if (aid && sid) adIdMap.set(aid,sid);
  }
  const accountRows: Ranked[] = [];
  const creativeRows: Ranked[] = [];
  const placementRows: Ranked[] = [];
  let invalidMetrics = false;
  const transform = (raw: RawRecord, type: "adset"|"ad"|"placement"): Ranked | null => {
    const sid = asId(raw.adset_id) || (type === "ad" || type === "placement" ? adIdMap.get(asId(raw.ad_id) ?? "") : null);
    if (!sid || !idToPlatform.has(sid)) return null;
    const id = type === "adset" ? sid : asId(raw.ad_id);
    if (!id) return null;
    const spend = finiteNonNegative(raw.spend);
    const clicks = outboundClicks(raw.outbound_clicks);
    if (spend === null || clicks === null) invalidMetrics = true;
    const cpc = spend !== null && clicks !== null && clicks > 0 ? spend/clicks : null;
    const platform = idToPlatform.get(sid)!;
    const score = currencyConfirmedUSD && cpc !== null && cpc > 0 ? DEFAULT_ROYALTY_PER_1000[platform]/cpc : null;
    return {
      id, name: typeof raw.ad_name === "string" ? raw.ad_name
        : typeof raw.adset_name === "string" ? raw.adset_name : null,
      platform,
      placement: type === "placement"
        ? [raw.publisher_platform, raw.platform_position].filter((v):v is string=>typeof v === "string").join(" / ") || "unspecified"
        : null,
      spend_account_currency: spend === null ? null : round(spend, 2),
      outbound_clicks: clicks,
      outbound_cpc_account_currency: cpc === null ? null : round(cpc, 5),
      royalty_weighted_proxy_index: score === null ? null : round(score, 5),
      provisional_comparison_only: true,
    };
  };
  for (const row of adsetInsights.data) { const x=transform(row,"adset"); if(x)accountRows.push(x); }
  for (const row of adInsights.data) { const x=transform(row,"ad"); if(x)creativeRows.push(x); }
  for (const row of placementInsights.data) { const x=transform(row,"placement"); if(x)placementRows.push(x); }
  const descriptors = allAdsets.map((r) => ({
    adset_id: asId(r.id), adset_name: typeof r.name==="string" ? r.name : null,
    platform: idToPlatform.get(asId(r.id)??"")??null,
    targeting_present: isRecord(r.targeting),
    targeting_fields: isRecord(r.targeting) ? Object.keys(r.targeting).slice(0,12) : [],
    configured_daily_budget_account_minor_units: finiteNonNegative(r.daily_budget),
  }));
  const status = allAdsets.length===0 ? "awaiting_campaign_adsets"
    : !platformMap.length ? "explicit_adset_platform_map_required"
    : mapErrors.length ? "invalid_platform_map" : !completePagination ? "partial_data"
    : invalidMetrics ? "missing_or_ambiguous_metrics" : "diagnostic_only";
  if (!completePagination) notices.push("At least one response is paginated; this report must not be used for allocation decisions.");
  if (!currencyConfirmedUSD) notices.push("Account currency has not been verified as USD; royalty-weighted scores are withheld.");
  if (invalidMetrics) notices.push("Some Meta outbound_clicks actions are missing/ambiguous. Do not substitute all link clicks.");
  const shortlist = (rows: Ranked[]) => DESTINATIONS.map((platform) => {
    const source = rows.filter((row) => row.platform === platform);
    const supported = source.filter((row) =>
      (row.outbound_clicks ?? 0) >= 30 && row.royalty_weighted_proxy_index !== null);
    supported.sort((a,b) => (b.royalty_weighted_proxy_index ?? 0) - (a.royalty_weighted_proxy_index ?? 0));
    const winner = supported[0];
    return {
      platform, status: winner ? "provisional_rank_only" : "insufficient_sample_or_metrics",
      compared_candidates: supported.length, total_candidates: source.length,
      highest_proxy_candidate: winner ? {
        id: winner.id, name: winner.name, placement: winner.placement,
        outbound_clicks: winner.outbound_clicks,
        outbound_cpc_account_currency: winner.outbound_cpc_account_currency,
        royalty_weighted_proxy_index: winner.royalty_weighted_proxy_index,
      } : null,
    };
  });
  const qualifiedPlatforms = accountRows.filter((row) =>
    (row.outbound_clicks ?? 0) >= 30 && row.royalty_weighted_proxy_index !== null);
  const uniqueQualified = new Set(qualifiedPlatforms.map((row) => row.platform));
  const platformOrder = qualifiedPlatforms.length === 4 && uniqueQualified.size === 4
    ? [...qualifiedPlatforms].sort((a,b) => (b.royalty_weighted_proxy_index ?? 0) - (a.royalty_weighted_proxy_index ?? 0))
      .map((r) => ({ platform: r.platform, royalty_weighted_proxy_index: r.royalty_weighted_proxy_index }))
    : [];
  const comparisonsUsable = completePagination && !mapErrors.length && !invalidMetrics && currencyConfirmedUSD;
  return {
    status, analysis_period: period,
    currency_confirmed_usd: currencyConfirmedUSD,
    data_pagination_complete: completePagination,
    mapping_issues: [...new Set(mapErrors)],
    platform_mapping_provided: platformMap.length,
    expected_four_destinations: [...DESTINATIONS],
    adsets: descriptors,
    platforms: accountRows,
    creatives: creativeRows,
    placements: placementRows,
    directional_comparisons: {
      status: comparisonsUsable ? "exploratory_only" : "not_ready",
      platform_ranking: comparisonsUsable ? platformOrder : [],
      best_supported_creative_by_platform: comparisonsUsable ? shortlist(creativeRows) : [],
      best_supported_placement_by_platform: comparisonsUsable ? shortlist(placementRows) : [],
      caveat: "Top proxy scores are not causal winners, stream-attributed returns, or instructions to alter Meta delivery.",
    },
    comparison_guidance: "Compare only like-for-like supported rows after sufficient outbound clicks; current report does not authorize allocations.",
    budget_changes_applied: false, notices,
  };
}
