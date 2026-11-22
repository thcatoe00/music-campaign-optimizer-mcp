import test from "node:test";
import assert from "node:assert/strict";
import {
  simulateAllocation, outboundClicks, analyzeLiveReport, DEFAULT_ROYALTY_PER_1000,
} from "../src/optimizer.ts";

const four = [
  { platform: "Spotify", spend_usd: 20, outbound_clicks: 60, current_daily_budget_usd: 10, minimum_daily_budget_usd: 3 },
  { platform: "YouTube Music", spend_usd: 20, outbound_clicks: 60, current_daily_budget_usd: 10, minimum_daily_budget_usd: 3 },
  { platform: "Amazon Music", spend_usd: 20, outbound_clicks: 60, current_daily_budget_usd: 10, minimum_daily_budget_usd: 3 },
  { platform: "Apple Music", spend_usd: 20, outbound_clicks: 60, current_daily_budget_usd: 10, minimum_daily_budget_usd: 3 },
];
const ready = {
  proposed_total_daily_budget_usd: 40, confirmed_usd_currency: true,
  observed_complete_days: 7, data_complete_and_unpaginated: true,
  measurements: four,
};
test("outbound-click array requires explicit action type", () => {
  assert.equal(outboundClicks([{ action_type: "link_click", value: "20" }]), null);
  assert.equal(outboundClicks([{ action_type: "outbound_click", value: "17" }]), 17);
  assert.equal(outboundClicks([{ action_type: "outbound_click", value: "17" }, { action_type: "outbound_click", value: "17" }]), null);
  assert.equal(outboundClicks("0"), 0);
  assert.equal(outboundClicks("1e9"), null);
});
test("four-platform scenario respects total, cents, exploration, 50% cap and 20% change", () => {
  const r = simulateAllocation(ready);
  assert.equal(r.status, "ready", JSON.stringify(r.reasons));
  assert.equal(r.total_simulated_daily_budget_usd, 40);
  assert.equal(r.actual_budget_changes_applied, false);
  for (const row of r.platforms) {
    assert.ok(row.simulated_daily_budget_usd >= 8 && row.simulated_daily_budget_usd <= 12, JSON.stringify(row));
    assert.ok(Math.abs(row.simulated_change_percent) <= 20);
    assert.ok(Math.abs(Math.round(row.simulated_daily_budget_usd * 100) - row.simulated_daily_budget_usd * 100) < 1e-6);
  }
  const yt = r.platforms.find(x => x.platform === "YouTube Music");
  const sp = r.platforms.find(x => x.platform === "Spotify");
  assert.ok(yt.royalty_weighted_proxy_index > sp.royalty_weighted_proxy_index);
  assert.ok(yt.simulated_daily_budget_usd >= sp.simulated_daily_budget_usd);
  assert.equal(r.provisional_rates_per_1000_usd["YouTube Music"], DEFAULT_ROYALTY_PER_1000["YouTube Music"]);
});
test("missing complete days blocks budget proposal", () => {
  const r = simulateAllocation({ ...ready, observed_complete_days: 2 });
  assert.equal(r.status, "blocked");
  assert.equal(r.total_simulated_daily_budget_usd, null);
  assert.ok(r.reasons.includes("requires_five_to_seven_complete_days"));
});
test("below 30 outbound clicks blocks budget movement", () => {
  const r = simulateAllocation({ ...ready, measurements: four.map((m,i) => i===0 ? {...m,outbound_clicks:29} : m) });
  assert.equal(r.status, "blocked");
  assert.ok(r.reasons.includes("insufficient_outbound_clicks"));
});
test("unverified USD and incomplete pagination block budget changes", () => {
  const r = simulateAllocation({ ...ready, confirmed_usd_currency: false, data_complete_and_unpaginated: false });
  assert.equal(r.status, "blocked");
  assert.ok(r.reasons.includes("data_completeness_not_verified"));
  assert.ok(r.reasons.includes("account_currency_not_confirmed_usd"));
});
test("Meta minimum budgets can make a scenario infeasible", () => {
  const r = simulateAllocation({ ...ready, measurements: four.map(m=>({...m, minimum_daily_budget_usd: 13})) });
  assert.equal(r.status, "blocked");
  assert.ok(r.reasons.includes("infeasible_budget_bounds"));
});
test("duplicated service or incompatible total blocks a proposal", () => {
  const duplicate = simulateAllocation({ ...ready, measurements: [...four.slice(0,3), {...four[3],platform:"Spotify"}] });
  assert.equal(duplicate.status, "blocked");
  assert.ok(duplicate.reasons.includes("duplicate_platform"));
  const mismatch=simulateAllocation({ ...ready, proposed_total_daily_budget_usd: 100 });
  assert.ok(mismatch.reasons.includes("existing_daily_budget_sum_does_not_match_scenario_total"));
});
test("live report requires explicit adset map and never guesses from names", () => {
  const p = {data: [{id:"123",name:"SPOTIFY campaign adset",daily_budget:"500",targeting:{geo_locations:{countries:["US"]}}}],has_more:false,next_cursor:null};
  const none={data:[],has_more:false,next_cursor:null};
  const r=analyzeLiveReport(p,none,none,none,none,[],false,"last_7d");
  assert.equal(r.status,"explicit_adset_platform_map_required");
  assert.equal(r.platforms.length,0);
  assert.equal(r.budget_changes_applied,false);
});
test("live report parses structured outbound clicks and flags partial pagination", () => {
  const adsets = {data:[{id:"123",name:"test",daily_budget:"500"}],has_more:false,next_cursor:null};
  const insight = {data:[{adset_id:"123",adset_name:"test",spend:"12.00",outbound_clicks:[{action_type:"outbound_click",value:"40"}]}],has_more:true,next_cursor:"cursor"};
  const empty = {data:[],has_more:false,next_cursor:null};
  const r=analyzeLiveReport(adsets,insight,empty,empty,empty,[{adset_id:"123",platform:"Spotify"}],true,"last_7d");
  assert.equal(r.status,"invalid_platform_map");
  assert.equal(r.platforms[0].outbound_clicks,40);
  assert.equal(r.platforms[0].royalty_weighted_proxy_index,14.7);
  assert.equal(r.data_pagination_complete,false);
});
