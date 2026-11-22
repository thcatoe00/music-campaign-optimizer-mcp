import test from "node:test";
import assert from "node:assert/strict";
import { preflightBudgetChange } from "../src/budget-guardrails.ts";

const at=new Date("2026-11-21T21:00:00.000Z");
const ids=["101","102","103","104"];
const platforms=["Spotify","YouTube Music","Amazon Music","Apple Music"];
const sample=()=>({
  policy:{
    account_id:"4694437724123689",campaign_id:"987654321",
    first_allowed_local_date:"2026-11-20",last_allowed_local_date:"2026-12-01",
    approved_daily_total_cents:4000,approved_lifetime_ceiling_cents:10000,
    exploration_floor_bps:1000,platform_share_ceiling_bps:5000,
    max_daily_change_bps:2000,
  },
  snapshot:{
    account_id:"4694437724123689",campaign_id:"987654321",
    account_currency:"USD",account_timezone:"America/New_York",
    campaign_status:"ACTIVE",campaign_budget_mode:"ADSET",budget_sharing_enabled:false,
    fetched_at:"2026-11-21T20:55:00.000Z",
    daily_report_ready:true,daily_report_pagination_complete:true,
    reported_adset_ids_for_campaign:[...ids],
    adsets:ids.map((adset_id,i)=>({
      adset_id,platform:platforms[i],campaign_id:"987654321",
      status:"ACTIVE",current_daily_budget_cents:1000,
      meta_min_daily_budget_cents:500,complete_window_outbound_clicks:75,
    })),
    campaign_spend_to_date_cents:2000,
    native_campaign_spending_limit_cents:10000,
    native_limit_verified_active:true,
  },
  controls:{manual_pause:false,emergency_stop:false,
    account_api_healthy:true,monitoring_healthy:true,previous_change_verified:true},
  proposal:ids.map((adset_id,i)=>({adset_id,daily_budget_cents:[1050,1100,950,900][i]})),
});
const evaluate=async(transform=x=>x)=>preflightBudgetChange(transform(sample()),at);

test("valid mock scenario is reviewable only, never write-eligible",async()=>{
  const d=await evaluate();
  assert.equal(d.status,"reviewable",d.reasons.join(", "));
  assert.equal(d.mode,"dry_run_only");
  assert.equal(d.owner_authorization_verified,false);
  assert.equal(d.controls_verified_against_live_meta,false);
  assert.equal(d.meta_writes_attempted,false);
  assert.equal(d.spending_impact_usd,0);
  assert.equal(d.proposed_total_cents,4000);
  assert.equal(d.audit_event.persistence,"not_yet_configured");
  assert.match(d.audit_event.decision_fingerprint,/^[0-9a-f]{64}$/);
});
test("decision fingerprint deterministic for exact same input and time",async()=>{
  const a=await evaluate(),b=await evaluate();
  assert.equal(a.audit_event.decision_fingerprint,b.audit_event.decision_fingerprint);
  assert.deepEqual(a.reasons,b.reasons);
});
test("mismatched account or campaign ID is blocked",async()=>{
  const d=await evaluate(x=>{x.snapshot.account_id="999";return x;});
  assert.ok(d.reasons.includes("account_or_campaign_not_allowlisted"));
});
test("campaign flight uses account-local time and date windows",async()=>{
  const d=await evaluate(x=>{x.policy.last_allowed_local_date="2026-11-20";return x;});
  assert.ok(d.reasons.includes("outside_approved_local_flight"));
  const unknown=await evaluate(x=>{x.snapshot.account_timezone="Invalid/Bogus";return x;});
  assert.ok(unknown.reasons.includes("outside_approved_local_flight"));
});
test("stale and future meta evidence fail closed",async()=>{
  const old=await evaluate(x=>{x.snapshot.fetched_at="2026-11-21T20:30:00.000Z";return x;});
  assert.ok(old.reasons.includes("meta_snapshot_stale"));
  const future=await evaluate(x=>{x.snapshot.fetched_at="2026-11-21T21:02:00.000Z";return x;});
  assert.ok(future.reasons.includes("meta_snapshot_stale"));
});
test("manual stop, emergency stop and monitoring failures all block",async()=>{
  const d=await evaluate(x=>{x.controls.manual_pause=true;x.controls.emergency_stop=true;
    x.controls.account_api_healthy=false;x.controls.monitoring_healthy=false;
    x.controls.previous_change_verified=false;return x;});
  assert.ok(d.reasons.includes("manual_or_emergency_stop_active"));
  assert.ok(d.reasons.includes("monitoring_or_api_unhealthy"));
  assert.ok(d.reasons.includes("prior_change_not_verified"));
});
test("campaign budget optimization and budget sharing are incompatible",async()=>{
  const d=await evaluate(x=>{x.snapshot.campaign_budget_mode="CAMPAIGN";
    x.snapshot.budget_sharing_enabled=true;return x;});
  assert.ok(d.reasons.includes("unsupported_meta_budget_distribution"));
});
test("campaign paused and adset paused freeze proposals",async()=>{
  const d=await evaluate(x=>{x.snapshot.campaign_status="PAUSED";
    x.snapshot.adsets[0].status="PAUSED";return x;});
  assert.ok(d.reasons.includes("campaign_not_active"));
  assert.ok(d.reasons.includes("one_or_more_adsets_not_active"));
});
test("missing or unsupported spend cap blocks the proposal",async()=>{
  const a=await evaluate(x=>{x.snapshot.native_limit_verified_active=false;return x;});
  assert.ok(a.reasons.includes("enforced_campaign_ceiling_not_verified"));
  const b=await evaluate(x=>{x.snapshot.native_campaign_spending_limit_cents=null;return x;});
  assert.ok(b.reasons.includes("enforced_campaign_ceiling_not_verified"));
});
test("remaining lifetime allowance insufficient for one proposed day",async()=>{
  const d=await evaluate(x=>{x.snapshot.campaign_spend_to_date_cents=7000;return x;});
  assert.ok(d.reasons.includes("insufficient_remaining_campaign_budget"));
});
test("extra, missing or unmapped adset blocks proposals",async()=>{
  const a=await evaluate(x=>{x.snapshot.reported_adset_ids_for_campaign.push("105");return x;});
  assert.ok(a.reasons.includes("unmapped_or_extra_campaign_adset"));
  const b=await evaluate(x=>{x.proposal[3].adset_id="999";return x;});
  assert.ok(b.reasons.includes("invalid_or_duplicate_proposed_adset"));
  assert.ok(b.reasons.includes("proposal_must_cover_exact_four_adsets"));
});
test("cents-only budgets enforce matching totals",async()=>{
  const a=await evaluate(x=>{x.proposal[0].daily_budget_cents=1000.1;return x;});
  assert.ok(a.reasons.includes("invalid_or_duplicate_proposed_adset"));
  const b=await evaluate(x=>{x.proposal[0].daily_budget_cents=1100;return x;});
  assert.ok(b.reasons.includes("daily_budget_total_mismatch"));
});
test("per-run delta, Meta minimum and exploration floor block oversized shifts",async()=>{
  const a=await evaluate(x=>{
    x.proposal[0].daily_budget_cents=1400;x.proposal[1].daily_budget_cents=700;
    x.proposal[2].daily_budget_cents=950;x.proposal[3].daily_budget_cents=950;
    return x;
  });
  assert.ok(a.reasons.includes("per_run_change_limit_exceeded"));
  const b=await evaluate(x=>{
    x.snapshot.adsets[3].meta_min_daily_budget_cents=950;return x;
  });
  assert.ok(b.reasons.includes("minimum_or_exploration_floor_violation"));
});
test("safety thresholds can only become stricter, not looser",async()=>{
  const d=await evaluate(x=>{
    x.policy.max_daily_change_bps=3500;x.policy.platform_share_ceiling_bps=7500;
    x.policy.exploration_floor_bps=500;return x;
  });
  assert.ok(d.reasons.includes("policy_safety_thresholds_outside_limits"));
});
test("missing/partial reports and weak click evidence block",async()=>{
  const d=await evaluate(x=>{
    x.snapshot.daily_report_ready=false;
    x.snapshot.daily_report_pagination_complete=false;
    x.snapshot.adsets[2].complete_window_outbound_clicks=20;
    return x;
  });
  assert.ok(d.reasons.includes("complete_daily_reporting_required"));
  assert.ok(d.reasons.includes("insufficient_outbound_clicks"));
});
test("unknown USD or unverified prior budget state cannot pass",async()=>{
  const d=await evaluate(x=>{
    x.snapshot.account_currency="EUR";
    x.snapshot.adsets[0].current_daily_budget_cents=1500;
    return x;
  });
  assert.ok(d.reasons.includes("usd_currency_not_verified"));
  assert.ok(d.reasons.includes("daily_budget_total_mismatch"));
});
