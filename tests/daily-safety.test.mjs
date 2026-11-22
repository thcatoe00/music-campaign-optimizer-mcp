import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDailyEvidence } from "../src/daily-safety.ts";

const now = new Date("2026-11-21T21:00:00.000Z");
const days = ["2026-11-13","2026-11-14","2026-11-15","2026-11-16","2026-11-17","2026-11-18","2026-11-19"];
const mapping = [
  {adset_id:"101",platform:"Spotify"},
  {adset_id:"102",platform:"YouTube Music"},
  {adset_id:"103",platform:"Amazon Music"},
  {adset_id:"104",platform:"Apple Music"},
];
const makeReport = () => ({
  schema_version:"1", account_id:"4694437724123689",
  account_currency:"USD", account_timezone:"America/New_York",
  fetched_at:"2026-11-21T20:00:00.000Z",
  level:"adset", time_increment:1, since:"2026-11-13", until:"2026-11-19",
  pagination_complete:true,
  rows:mapping.flatMap(({adset_id})=>days.map(date=>({
    adset_id,date_start:date,date_stop:date,spend:"5.00",
    outbound_clicks:[{action_type:"outbound_click",value:"6"}],
    account_currency:"USD",
  }))),
});
test("verified daily 4x7 report passes conservative readiness without enabling writes", () => {
  const result = evaluateDailyEvidence(makeReport(),mapping,now,true);
  assert.equal(result.status,"ready_for_read_only_simulation",JSON.stringify(result.reasons));
  assert.equal(result.automatic_budget_changes_allowed,false);
  assert.deepEqual(result.expected_window,{since:"2026-11-13",until:"2026-11-19",days:7,reporting_lag_days:2});
  assert.equal(result.summaries.length,4);
  for (const p of result.summaries) {
    assert.equal(p.outbound_clicks,42);
    assert.equal(p.days_observed,7);
    assert.equal(p.spend_usd,35);
    assert.equal(p.sample_sufficient,true);
  }
});
test("externally provided rows cannot masquerade as authenticated Meta source",()=>{
  const r=evaluateDailyEvidence(makeReport(),mapping,now);
  assert.equal(r.status,"blocked");
  assert.deepEqual(r.reasons,["source_not_verified_by_gateway"]);
  assert.equal(r.source,"caller_supplied");
});
test("missing or duplicate daily observations prevent readiness",()=>{
  const a=makeReport();a.rows.pop();
  const r=evaluateDailyEvidence(a,mapping,now,true);
  assert.ok(r.reasons.includes("missing_daily_adset_rows"));
  const b=makeReport();b.rows.push(b.rows[0]);
  const t=evaluateDailyEvidence(b,mapping,now,true);
  assert.ok(t.reasons.includes("duplicate_daily_row"));
});
test("requires exactly 5–7 complete timezone-local days with reporting lag",()=>{
  const r=makeReport();r.until="2026-11-20";r.since="2026-11-14";
  assert.ok(evaluateDailyEvidence(r,mapping,now,true).reasons.includes("window_must_be_five_to_seven_consecutive_complete_local_days"));
  const c=makeReport();c.until="2026-11-19";c.since="2026-11-17";
  assert.ok(evaluateDailyEvidence(c,mapping,now,true).reasons.includes("window_must_be_five_to_seven_consecutive_complete_local_days"));
});
test("wrong currency, timezone and pagination cannot pass",()=>{
  const r=makeReport();r.account_currency="EUR";r.pagination_complete=false;r.account_timezone="Etc/invalid-zone";
  const x=evaluateDailyEvidence(r,mapping,now,true);
  for(const code of ["account_must_be_verified_usd","pagination_incomplete","unrecognized_account_timezone"]) assert.ok(x.reasons.includes(code),code);
});
test("stale or future report timestamp blocks readiness",()=>{
  const r=makeReport();r.fetched_at="2026-11-19T20:00:00.000Z";
  assert.ok(evaluateDailyEvidence(r,mapping,now,true).reasons.includes("stale_or_invalid_fetch_timestamp"));
  const f=makeReport();f.fetched_at="2026-11-22T00:00:00.000Z";
  assert.ok(evaluateDailyEvidence(f,mapping,now,true).reasons.includes("stale_or_invalid_fetch_timestamp"));
});
test("link clicks cannot replace outbound clicks and fewer than 30 blocks",()=>{
  const r=makeReport();
  for(const row of r.rows.filter(x=>x.adset_id==="101")) row.outbound_clicks=[{action_type:"link_click",value:"6"}];
  assert.ok(evaluateDailyEvidence(r,mapping,now,true).reasons.includes("missing_or_ambiguous_daily_metrics"));
  const x=makeReport();
  for(const row of x.rows.filter(x=>x.adset_id==="101")) row.outbound_clicks=[{action_type:"outbound_click",value:"3"}];
  assert.ok(evaluateDailyEvidence(x,mapping,now,true).reasons.includes("insufficient_platform_click_sample"));
});
test("cross-adset rows, row currency mismatch and fake Meta time increment are rejected",()=>{
  const r=makeReport();r.rows[0].adset_id="999";r.rows[1].account_currency="GBP";r.time_increment=7;
  const x=evaluateDailyEvidence(r,mapping,now,true);
  for(const reason of ["unexpected_adset_or_daily_date","daily_row_currency_mismatch","daily_source_contract_not_verified"])
    assert.ok(x.reasons.includes(reason),reason);
});
test("duplicate map and unexpected platform ID blocks",()=>{
  const r=makeReport();
  const x=evaluateDailyEvidence(r,[...mapping.slice(0,3),{adset_id:"101",platform:"Apple Music"}],now,true);
  assert.ok(x.reasons.includes("invalid_or_duplicate_adset_mapping"));
  assert.equal(x.automatic_budget_changes_allowed,false);
});
