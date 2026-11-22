import test from "node:test";
import assert from "node:assert/strict";
import worker from "../index.js";

const root="https://odd-hall-a184.waynecatoe3.workers.dev";
const env={
  MUSIC_API_KEY:"TEST_KEY_NO_REAL_CREDENTIALS",
  META_ACCESS_TOKEN:"TEST_META_TOKEN_NO_REAL_CREDENTIALS",
  META_AD_ACCOUNT_ID:"act_4694437724123689",
};
const call=(path,opts={})=>worker.fetch(new Request(root+path,{
  method:opts.method??"GET",
  headers:opts.auth===false?{}:{authorization:"Bearer "+env.MUSIC_API_KEY},
}),{...env,...(opts.env??{})});
const json=data=>new Response(JSON.stringify(data),{status:200,headers:{"content-type":"application/json"}});
const account={account_id:"4694437724123689",currency:"USD",timezone_name:"America/New_York"};
let originalFetch=globalThis.fetch;
const withGraphMock=async(mock,cb)=>{
  const before=globalThis.fetch;
  globalThis.fetch=mock;
  try { return await cb(); } finally { globalThis.fetch=before; }
};

test("all Meta API endpoints require the existing bearer secret",async()=>{
  let calls=0;
  await withGraphMock(async()=>{calls++;return json({data:[]});},async()=>{
    const a=await call("/api/daily-insights",{auth:false});
    const b=await call("/api/campaigns",{auth:false});
    const c=await call("/api/daily-insights?days=7",{env:{MUSIC_API_KEY:undefined}});
    const d=await call("/api/daily-insights?days=12");
    const e=await call("/api/daily-insights?days=7",{method:"POST"});
    assert.equal(a.status,401);assert.equal(b.status,401);
    assert.equal(c.status,503);assert.equal(d.status,400);
    assert.equal(e.status,405);assert.equal(calls,0);
  });
});

test("old campaigns, adsets, ads, insights routes retain read-only behavior",async()=>{
  const seen=[];
  await withGraphMock(async(u,options)=>{
    const parsed=new URL(u);
    assert.equal(options.method,"GET");
    assert.equal(options.redirect,"manual");
    assert.equal(options.headers.authorization,"Bearer "+env.META_ACCESS_TOKEN);
    seen.push({path:parsed.pathname,params:parsed.searchParams});
    return json({data:[],paging:{}});
  },async()=>{
    for(const path of ["/api/campaigns","/api/adsets","/api/ads","/api/insights?level=ad&breakdown=placement"]){
      const response=await call(path);
      assert.equal(response.status,200);
      assert.deepEqual(await response.json(),{data:[],has_more:false,next_cursor:null});
    }
  });
  assert.equal(seen.length,4);
  assert.equal(seen[1].params.get("fields").includes("campaign_id"),true);
  assert.equal(seen[3].params.get("breakdowns"),"publisher_platform,platform_position");
});

test("day-scoped GET checks account metadata, local clock and Graph time_increment",async()=>{
  const seen=[];
  await withGraphMock(async(u,options)=>{
    const parsed=new URL(u);
    assert.equal(options.method,"GET");
    seen.push(parsed);
    if(parsed.pathname.endsWith("/insights")){
      const range=JSON.parse(parsed.searchParams.get("time_range"));
      const distance=Date.parse(range.until+"T00:00:00Z")-Date.parse(range.since+"T00:00:00Z");
      assert.equal(distance,6*86400000);
      assert.equal(parsed.searchParams.get("time_increment"),"1");
      assert.ok(range.until < new Date().toISOString().slice(0,10));
      return json({data:[],paging:{}});
    }
    return json(account);
  },async()=>{
    const response=await call("/api/daily-insights?days=7");
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.schema_version,"1");
    assert.equal(data.level,"adset");
    assert.equal(data.time_increment,1);
    assert.equal(data.account_currency,"USD");
    assert.equal(data.account_timezone,"America/New_York");
    assert.equal(data.account_id,"4694437724123689");
    assert.equal(data.pagination_complete,true);
    assert.deepEqual(data.rows,[]);
  });
  assert.equal(seen.length,2);
  assert.ok(seen.every(x=>x.origin==="https://graph.facebook.com"));
});

test("never follows Meta's paging.next URL even when it points to another host",async()=>{
  const calls=[];
  await withGraphMock(async(u)=>{
    const parsed=new URL(u);calls.push(parsed);
    assert.equal(parsed.origin,"https://graph.facebook.com");
    if(!parsed.pathname.endsWith("/insights"))return json(account);
    if(parsed.searchParams.get("after"))return json({data:[],paging:{}});
    return json({data:[],paging:{next:"https://evil.example/steal-access-token",cursors:{after:"SAFE_CURSOR"}}});
  },async()=>{
    const response=await call("/api/daily-insights");
    assert.equal(response.status,200);
    assert.equal((await response.json()).pagination_complete,true);
  });
  assert.equal(calls.length,3);
  assert.equal(calls[2].searchParams.get("after"),"SAFE_CURSOR");
});

test("malformed Meta daily rows, credential errors or redirects fail closed",async()=>{
  await withGraphMock(async(u)=>{
    if(!new URL(u).pathname.endsWith("/insights"))return json(account);
    return json({data:[{adset_id:"1234",spend:"1"}]});
  },async()=>{const response=await call("/api/daily-insights");assert.equal(response.status,502)});
  await withGraphMock(async()=>new Response(null,{status:302,headers:{location:"https://example.org/"}}),
    async()=>{const response=await call("/api/daily-insights");assert.equal(response.status,502)});
  await withGraphMock(async()=>new Response("error",{status:403}),async()=>{
    const response=await call("/api/campaigns");
    assert.equal(response.status,502);
  });
});

test("no mutation endpoint can write Meta budgets",async()=>{
  let fetched=false;
  await withGraphMock(async()=>{fetched=true;return json({data:[]})},async()=>{
    const response=await call("/api/adsets",{method:"POST"});
    assert.equal(response.status,405);
    assert.equal(fetched,false);
  });
});
