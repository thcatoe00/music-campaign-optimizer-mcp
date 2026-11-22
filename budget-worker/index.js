/**
 * Budget-control service placeholder.
 *
 * This is intentionally non-operational: no Meta API calls, credentials,
 * budget changes, queues, alarms, CRON triggers, or other write routes.
 * Providing a META_BUDGET_ACCESS_TOKEN secret later does NOT enable spending.
 */
const headers={
  "content-type":"application/json; charset=utf-8",
  "cache-control":"no-store",
  "x-content-type-options":"nosniff",
  "referrer-policy":"no-referrer",
};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
export default {
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(request.method==="GET" && path==="/health") {
      return json({
        service:"music-campaign-budget-control",
        status:"disabled",
        meta_write_enabled:false,
        scheduled_execution_enabled:false,
        budget_write_methods:0,
      });
    }
    // Reject every write-like request, even if a token is later configured.
    if(request.method!=="GET" || path.startsWith("/api/")) {
      return json({error:"budget_changes_disabled"},403);
    }
    return json({error:"not_found"},404);
  },
};
