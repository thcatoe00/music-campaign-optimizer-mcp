/**
 * Music Campaign Optimizer — fail-closed preflight of a hypothetical budget write.
 *
 * This module NEVER sends Meta requests or changes spending. All supplied snapshots
 * are untrusted until a future trusted backend binds them to authenticated Meta reads
 * and server-side stored owner approvals. Outputs are review-only.
 */
import { DESTINATIONS, type Destination } from "./optimizer.ts";

export type Cents = number;
export type AdsetState = "ACTIVE" | "PAUSED" | "OTHER";
export interface ProposedBudget {
  adset_id: string;
  daily_budget_cents: Cents;
}
export interface ObservedAdset {
  adset_id: string;
  platform: Destination;
  campaign_id: string;
  status: AdsetState;
  current_daily_budget_cents: Cents;
  meta_min_daily_budget_cents: Cents;
  complete_window_outbound_clicks: number;
}
export interface ProposedPolicy {
  account_id: string;
  campaign_id: string;
  first_allowed_local_date: string;
  last_allowed_local_date: string;
  approved_daily_total_cents: Cents;
  approved_lifetime_ceiling_cents: Cents;
  exploration_floor_bps: number;
  platform_share_ceiling_bps: number;
  max_daily_change_bps: number;
}
export interface PreflightSnapshot {
  account_id: string;
  campaign_id: string;
  account_currency: string;
  account_timezone: string;
  campaign_status: "ACTIVE" | "PAUSED" | "OTHER";
  campaign_budget_mode: "ADSET" | "CAMPAIGN" | "UNKNOWN";
  budget_sharing_enabled: boolean;
  fetched_at: string;
  daily_report_ready: boolean;
  daily_report_pagination_complete: boolean;
  reported_adset_ids_for_campaign: string[];
  adsets: ObservedAdset[];
  campaign_spend_to_date_cents: Cents;
  native_campaign_spending_limit_cents: Cents | null;
  native_limit_verified_active: boolean;
}
export interface SafetyState {
  manual_pause: boolean;
  emergency_stop: boolean;
  account_api_healthy: boolean;
  monitoring_healthy: boolean;
  previous_change_verified: boolean;
}
export interface PreflightInput {
  policy: ProposedPolicy;
  snapshot: PreflightSnapshot;
  controls: SafetyState;
  proposal: ProposedBudget[];
}
export interface BudgetDecision {
  mode: "dry_run_only";
  status: "reviewable" | "blocked";
  reasons: string[];
  candidate_cents: Record<Destination, number | null>;
  current_total_cents: number | null;
  proposed_total_cents: number | null;
  spending_impact_usd: 0;
  meta_writes_attempted: false;
  owner_authorization_verified: false;
  controls_verified_against_live_meta: false;
  audit_event: {
    kind: "budget_preflight";
    emitted_at: string;
    decision_fingerprint: string;
    result: "reviewable" | "blocked";
    reasons: string[];
    // This event is returned to caller; persistence comes in a future phase.
    persistence: "not_yet_configured";
  };
}

const ID = /^\d{1,30}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const sum = (items: number[]) => items.reduce((a,b)=>a+b,0);
const int = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function localDay(now: Date, tz: string): string | null {
  try {
    const parts=new Intl.DateTimeFormat("en-US",{
      timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit",
    }).formatToParts(now);
    const part=(type:string)=>parts.find(x=>x.type===type)?.value??"";
    return [part("year"),part("month"),part("day")].join("-");
  } catch {return null;}
}
function validDay(d: string): boolean {
  if (!ISO_DAY.test(d)) return false;
  const t=Date.parse(d+"T00:00:00Z");
  return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===d;
}
function inBasisPoints(value: number, denominator: number, bps: number, relation: "min" | "max"): boolean {
  // Divide first to avoid exceeding Number.MAX_SAFE_INTEGER.
  if (!int(value)||!int(denominator)||!int(bps)) return false;
  const threshold=denominator*bps/10000;
  return relation==="min" ? value+0.000001>=threshold : value-0.000001<=threshold;
}
async function fingerprint(payload: unknown): Promise<string> {
  const source=JSON.stringify(payload);
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(source));
  return Array.from(new Uint8Array(bytes)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

export async function preflightBudgetChange(
  input: PreflightInput, now: Date = new Date(),
): Promise<BudgetDecision> {
  const reasons: string[]=[];
  const p=input.policy, s=input.snapshot, c=input.controls;
  const add=(why:string)=>{if(!reasons.includes(why))reasons.push(why);};
  if (!ID.test(p.account_id)||!ID.test(p.campaign_id)||
      s.account_id!==p.account_id||s.campaign_id!==p.campaign_id)
    add("account_or_campaign_not_allowlisted");
  if (s.account_currency!=="USD") add("usd_currency_not_verified");
  const today=localDay(now,s.account_timezone);
  if (!today||!validDay(today)||!validDay(p.first_allowed_local_date)||
      !validDay(p.last_allowed_local_date)||p.first_allowed_local_date>p.last_allowed_local_date||
      today<p.first_allowed_local_date||today>p.last_allowed_local_date)
    add("outside_approved_local_flight");
  const fetched=Date.parse(s.fetched_at);
  if (!Number.isFinite(fetched)||fetched>now.valueOf()+60_000||
      now.valueOf()-fetched>10*60_000) add("meta_snapshot_stale");
  if (c.manual_pause||c.emergency_stop) add("manual_or_emergency_stop_active");
  if (!c.account_api_healthy||!c.monitoring_healthy) add("monitoring_or_api_unhealthy");
  if (!c.previous_change_verified) add("prior_change_not_verified");
  if (s.campaign_status!=="ACTIVE") add("campaign_not_active");
  if (s.campaign_budget_mode!=="ADSET"||s.budget_sharing_enabled)
    add("unsupported_meta_budget_distribution");
  if (!s.daily_report_ready||!s.daily_report_pagination_complete)
    add("complete_daily_reporting_required");
  const plannedTotal=p.approved_daily_total_cents;
  if (!int(plannedTotal)||plannedTotal<=0||
      !int(p.approved_lifetime_ceiling_cents)||p.approved_lifetime_ceiling_cents<=0)
    add("invalid_approved_spending_policy");
  if (!int(p.exploration_floor_bps)||p.exploration_floor_bps<1000||
      !int(p.platform_share_ceiling_bps)||p.platform_share_ceiling_bps>5000||
      !int(p.max_daily_change_bps)||p.max_daily_change_bps>2000)
    add("policy_safety_thresholds_outside_limits");
  if (!int(s.campaign_spend_to_date_cents)) add("campaign_spend_unverified");
  if (!s.native_limit_verified_active||!int(s.native_campaign_spending_limit_cents)||
      s.native_campaign_spending_limit_cents!==p.approved_lifetime_ceiling_cents)
    add("enforced_campaign_ceiling_not_verified");
  if (int(s.campaign_spend_to_date_cents)&&int(plannedTotal)&&
      int(p.approved_lifetime_ceiling_cents) &&
      s.campaign_spend_to_date_cents+plannedTotal>p.approved_lifetime_ceiling_cents)
    add("insufficient_remaining_campaign_budget");

  const ids=new Set<string>();
  const platforms=new Set<Destination>();
  const sourceById=new Map<string,ObservedAdset>();
  for (const a of s.adsets) {
    if (!ID.test(a.adset_id)||ids.has(a.adset_id)||!DESTINATIONS.includes(a.platform)||
        platforms.has(a.platform)||a.campaign_id!==p.campaign_id) add("invalid_or_duplicate_adsets");
    ids.add(a.adset_id);platforms.add(a.platform);sourceById.set(a.adset_id,a);
    if (a.status!=="ACTIVE") add("one_or_more_adsets_not_active");
    if (!int(a.current_daily_budget_cents)||a.current_daily_budget_cents<=0||
        !int(a.meta_min_daily_budget_cents)||a.meta_min_daily_budget_cents<=0)
      add("adset_budget_or_meta_minimum_unverified");
    if (!int(a.complete_window_outbound_clicks)||a.complete_window_outbound_clicks<30)
      add("insufficient_outbound_clicks");
  }
  if(s.adsets.length!==4||platforms.size!==4) add("exactly_four_destinations_required");
  const allIds=s.reported_adset_ids_for_campaign;
  if (!Array.isArray(allIds)||allIds.length!==4||new Set(allIds).size!==4||
      allIds.some(x=>!ids.has(x))) add("unmapped_or_extra_campaign_adset");
  const proposedIds=new Set<string>();
  const nextById=new Map<string,number>();
  for(const change of input.proposal){
    if (!ID.test(change.adset_id)||proposedIds.has(change.adset_id)||
        !sourceById.has(change.adset_id)||!int(change.daily_budget_cents)||
        change.daily_budget_cents<=0) add("invalid_or_duplicate_proposed_adset");
    proposedIds.add(change.adset_id);nextById.set(change.adset_id,change.daily_budget_cents);
  }
  if(input.proposal.length!==4||proposedIds.size!==4||[...ids].some(x=>!proposedIds.has(x)))
    add("proposal_must_cover_exact_four_adsets");
  const prev=s.adsets.map(x=>x.current_daily_budget_cents);
  const next=input.proposal.map(x=>x.daily_budget_cents);
  const currentTotal=prev.every(int)?sum(prev):null;
  const proposedTotal=next.every(int)?sum(next):null;
  if (currentTotal===null||currentTotal!==plannedTotal||
      proposedTotal===null||proposedTotal!==plannedTotal) add("daily_budget_total_mismatch");

  const candidate:Record<Destination,number|null>={
    Spotify:null,"YouTube Music":null,"Amazon Music":null,"Apple Music":null,
  };
  for(const a of s.adsets){
    if(!DESTINATIONS.includes(a.platform))continue;
    const proposed=nextById.get(a.adset_id);
    if (int(proposed)) candidate[a.platform]=proposed;
    if(!int(proposed)||!int(plannedTotal)||!int(a.current_daily_budget_cents)||
       !int(a.meta_min_daily_budget_cents))continue;
    if(proposed<a.meta_min_daily_budget_cents||
       !inBasisPoints(proposed,plannedTotal,p.exploration_floor_bps,"min"))
      add("minimum_or_exploration_floor_violation");
    if(!inBasisPoints(proposed,plannedTotal,p.platform_share_ceiling_bps,"max"))
      add("platform_share_ceiling_violation");
    const absoluteDelta=Math.abs(proposed-a.current_daily_budget_cents);
    if(!inBasisPoints(absoluteDelta,a.current_daily_budget_cents,p.max_daily_change_bps,"max"))
      add("per_run_change_limit_exceeded");
  }
  // Audit fingerprints are deterministic for the same request and evaluation time.
  // They are *not* execution authorization or a concurrency/idempotency lock.
  const status=reasons.length?"blocked":"reviewable";
  const emitted_at=Number.isFinite(now.valueOf())?now.toISOString():"invalid";
  const decision_fingerprint=await fingerprint({input,emitted_at,status,reasons});
  return {
    mode:"dry_run_only",status,reasons,candidate_cents:candidate,
    current_total_cents:currentTotal,proposed_total_cents:proposedTotal,
    spending_impact_usd:0,meta_writes_attempted:false,
    owner_authorization_verified:false,controls_verified_against_live_meta:false,
    audit_event:{kind:"budget_preflight",emitted_at,decision_fingerprint,
      result:status,reasons:[...reasons],persistence:"not_yet_configured"},
  };
}
