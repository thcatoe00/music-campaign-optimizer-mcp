import test from "node:test";
import assert from "node:assert/strict";
import app from "../index.js";

const origin="https://music-campaign-budget-control.example.invalid";
const secret="DO_NOT_LOG_THIS_TEST_TOKEN";
const request=(path,method="GET")=>
  app.fetch(new Request(origin+path,{method}),{
    META_BUDGET_ACCESS_TOKEN:secret,
    META_AD_ACCOUNT_ID:"act_4694437724123689",
  });

test("health makes disabled/no budget writes explicit",async()=>{
  const response=await request("/health");
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(body,{
    service:"music-campaign-budget-control",
    status:"disabled",
    meta_write_enabled:false,
    scheduled_execution_enabled:false,
    budget_write_methods:0,
  });
});
test("all hypothetical API write routes remain closed even with a token",async()=>{
  for(const method of ["POST","PUT","PATCH","DELETE"]){
    for(const path of ["/api/budgets","/api/adsets/123","/health"]){
      const response=await request(path,method);
      assert.equal(response.status,403,method+" "+path);
      assert.deepEqual(await response.json(),{error:"budget_changes_disabled"});
    }
  }
  const response=await request("/api/budgets");
  assert.equal(response.status,403);
});
test("unknown paths are not exposed",async()=>{
  const response=await request("/not-found");
  assert.equal(response.status,404);
});
test("responses contain neither secrets nor account identifiers",async()=>{
  for(const path of ["/health","/api/budgets","/not-found"]){
    const response=await request(path);
    const text=await response.text();
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes("4694437724123689"));
  }
});
