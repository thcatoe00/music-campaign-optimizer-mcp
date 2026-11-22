import test from "node:test";
import assert from "node:assert/strict";
import { collectAuthenticatedMetaDaily } from "../src/rest-daily-collector.ts";

const creds = {metaAccessToken:"TEST_TOKEN_NOT_REAL",metaAdAccountId:"act_4694437724123689"};
const now = new Date("2026-11-21T21:00:00.000Z");
const account = {account_id:"4694437724123689",currency:"USD",timezone_name:"America/New_York"};
const daily = {
  account_id:"4694437724123689",account_currency:"USD",adset_id:"101",
  date_start:"2026-11-19",date_stop:"2026-11-19",spend:"2.00",
  outbound_clicks:[{action_type:"outbound_click",value:"4"}],
};
const json = x => new Response(JSON.stringify(x), {status:200,headers:{"Content-Type":"application/json"}});
test("daily REST collector fetches authoritative account currency and IANA timezone",async()=>{
  const calls = [];
  const get = async (url,init) => {
    calls.push({url,init});
    return url.includes("/insights")?json({data:[daily]}):json(account);
  };
  const result = await collectAuthenticatedMetaDaily(creds,7,now,get);
  assert.deepEqual([result.since,result.until],["2026-11-13","2026-11-19"]);
  assert.equal(result.time_increment,1);
  assert.equal(result.account_id,"4694437724123689");
  assert.equal(result.account_timezone,"America/New_York");
  assert.equal(result.rows.length,1);
  assert.ok(result.pagination_complete);
  assert.equal(calls.length,2);
  assert.ok(calls.every(x=>x.init.method==="GET"));
  assert.ok(calls.every(x=>x.init.headers.Authorization==="Bearer TEST_TOKEN_NOT_REAL"));
  const query = new URL(calls[1].url).searchParams;
  assert.equal(query.get("time_increment"),"1");
  assert.deepEqual(JSON.parse(query.get("time_range")), {since:"2026-11-13",until:"2026-11-19"});
});
test("never follows arbitrary Meta paging URL, uses only bounded cursors",async()=>{
  const urls=[];
  const get=async (url)=>{
    urls.push(url);
    if(!url.includes("/insights")) return json(account);
    const after = new URL(url).searchParams.get("after");
    if(!after) return json({data:[daily],paging:{next:"https://attacker.invalid/?access_token=LEAK",cursors:{after:"SAFE_CURSOR"}}});
    return json({data:[{...daily,adset_id:"102"}],paging:{}});
  };
  const result=await collectAuthenticatedMetaDaily(creds,5,now,get);
  assert.equal(result.rows.length,2);
  assert.equal(urls.length,3);
  assert.ok(urls.every(x=>!x.includes("attacker.invalid")));
  assert.equal(new URL(urls[2]).searchParams.get("after"),"SAFE_CURSOR");
});
test("incomplete or repeated cursors fail closed",async()=>{
  const get=async (url)=>{
    if(!url.includes("/insights")) return json(account);
    return json({data:[daily],paging:{next:"https://graph.facebook.com/next",cursors:{after:"SAME"}}});
  };
  await assert.rejects(()=>collectAuthenticatedMetaDaily(creds,7,now,get),/pagination_unverifiable/);
});
test("Meta API errors and ad-account mismatches block collection",async()=>{
  const badGet=async ()=>new Response("forbidden",{status:403});
  await assert.rejects(()=>collectAuthenticatedMetaDaily(creds,7,now,badGet),/meta_daily_api_unavailable/);
  const wrongAccount=async (url)=>url.includes("/insights")?json({data:[]}):json({...account,account_id:"123"});
  await assert.rejects(()=>collectAuthenticatedMetaDaily(creds,7,now,wrongAccount),/meta_account_identity_or_settings_missing/);
});
test("metadata discrepancy on a Meta Insights row is rejected",async()=>{
  const bad=async (url)=>url.includes("/insights")?json({data:[{...daily,account_currency:"EUR"}]}):json(account);
  await assert.rejects(()=>collectAuthenticatedMetaDaily(creds,7,now,bad),/invalid_meta_insights_row_metadata/);
});
test("date calculation observes account timezone, not server's UTC calendar day",async()=>{
  // 02:00 UTC on Nov 21 is Nov 20 local in New York.
  const early = new Date("2026-11-21T02:00:00.000Z");
  const get=async(url)=>url.includes("/insights")?json({data:[]}):json(account);
  const result=await collectAuthenticatedMetaDaily(creds,7,early,get);
  assert.equal(result.until,"2026-11-18");
  assert.equal(result.since,"2026-11-12");
});
test("collector refuses invalid configuration before requesting any Graph data",async()=>{
  const fakeGet=async()=>{throw new Error("network must not be called");};
  await assert.rejects(()=>collectAuthenticatedMetaDaily({...creds,metaAdAccountId:"wrong"},7,now,fakeGet),/invalid_reporting_configuration/);
});
