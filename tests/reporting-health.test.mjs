import test from "node:test";
import assert from "node:assert/strict";
import { probeDailyRest } from "../src/reporting-health.ts";
const origin="https://odd-hall-a184.waynecatoe3.workers.dev";
const good={schema_version:"1",level:"adset",time_increment:1,pagination_complete:true,
  account_id:"4694437724123689",account_currency:"USD",account_timezone:"America/New_York",
  fetched_at:"2026-11-21T21:00:00.000Z",since:"2026-11-13",until:"2026-11-19",rows:[]};
const json=(payload,status=200)=>new Response(JSON.stringify(payload),{status});
test("existing status tool can verify daily reporting route without leaking credentials",async()=>{
  const r=await probeDailyRest(origin,"EXAMPLE_TEST_KEY",async(url,init)=>{
    assert.equal(new URL(url).pathname,"/api/daily-insights");
    assert.equal(init.method,"GET");
    assert.equal(init.headers.Authorization,"Bearer EXAMPLE_TEST_KEY");
    assert.equal(init.redirect,"manual");
    return json(good);
  });
  assert.equal(r.daily_reporting_endpoint_status,"available");
  assert.equal(r.daily_reporting_endpoint_verified,true);
  assert.ok(!JSON.stringify(r).includes("EXAMPLE_TEST_KEY"));
});
test("missing route, access denial and Meta upstream error are distinctly reported",async()=>{
  for(const [code,expected] of [[404,"endpoint_missing"],[401,"unauthorized"],[502,"upstream_error"]]){
    const r=await probeDailyRest(origin,"TEST",async()=>json({},code));
    assert.equal(r.daily_reporting_endpoint_status,expected);
    assert.equal(r.daily_reporting_endpoint_verified,false);
  }
});
test("unauthenticated or malformed response must never pass verification",async()=>{
  const noKey=await probeDailyRest(origin,undefined,async()=>{throw Error("unexpected network call")});
  assert.equal(noKey.daily_reporting_endpoint_status,"not_configured");
  const invalid=await probeDailyRest(origin,"TEST",async()=>json({data:[]}));
  assert.equal(invalid.daily_reporting_endpoint_status,"invalid_response");
  assert.equal(invalid.daily_reporting_endpoint_verified,false);
});
test("transport errors are swallowed and credentials not exposed",async()=>{
  const r=await probeDailyRest(origin,"TEST_PRIVATE_KEY",async()=>{throw Error("could contain secret TEST_PRIVATE_KEY")});
  assert.deepEqual(r,{daily_reporting_endpoint_status:"unreachable",daily_reporting_endpoint_verified:false});
});
