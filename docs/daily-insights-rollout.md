# Daily Insights v1: rollout contract for the separate Meta reporting Worker

**Status:** Source and tests prepared in the MCP repository, but **not installed in the live `odd-hall-a184` REST Worker**. The separate Worker source is not linked to this repository; this file is an integration guide, not a deployment claim.

## Existing architecture
- Existing Cloudflare REST Worker: `odd-hall-a184` owns the Meta `ads_read` secret and the `MUSIC_API_KEY` bearer gate.
- Existing Cloudflare MCP gateway: `music-campaign-optimizer-mcp` owns GitHub OAuth and only the shared `MUSIC_API_KEY`.
- The new `get_daily_reporting_readiness` MCP tool will call `GET /api/daily-insights?days=7` on the **existing REST Worker**, but returns `blocked` while its route is absent.
- Do not move the Meta token to the MCP gateway or GitHub. Preserve the owner-only OAuth enforcement and avoid spending writes.

## Integration steps (future REST Worker deployment)
1. Copy or adapt `src/rest-daily-collector.ts` and its imported `requiredDailyWindow` helper from `src/daily-safety.ts` into the separately deployed REST Worker project.
2. Add the fixed GET route `/api/daily-insights` **after** the existing `MUSIC_API_KEY` authentication middleware, allowing only `days=5|6|7` (default 7). No request body, no arbitrary Graph URLs, no account ID parameter.
3. Call `collectAuthenticatedMetaDaily({metaAccessToken: env.META_ACCESS_TOKEN, metaAdAccountId: env.META_AD_ACCOUNT_ID}, days)`. Return the data as JSON; on upstream/validation failures, return non-sensitive error codes with no partial `pagination_complete:true` claims.
4. Deploy only after verifying existing REST routes (`/api/campaigns`, `/api/adsets`, `/api/ads`, `/api/insights`) still work and the bearer key cannot be bypassed.
5. Extend `/api/adsets` to include verified `campaign_id` for each row and confirm all four intended ad sets belong to a *single* correct campaign.
6. After actual ads exist, test seven day-scoped rows per ad set, USD and account timezone, pagination, report fetch timestamp, outbound-click actions and equivalent Ads Manager totals. The gateway refuses missing days rather than manufacturing zero-spend results.

## Authorized Meta GETs
- `GET https://graph.facebook.com/v27.0/act_{AD_ACCOUNT_ID}?fields=account_id,currency,timezone_name`
- `GET https://graph.facebook.com/v27.0/act_{AD_ACCOUNT_ID}/insights` with:
  - `level=adset`
  - `time_increment=1`
  - `time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}`
  - `fields=account_id,account_currency,adset_id,date_start,date_stop,spend,outbound_clicks`
  - `limit=250` and bounded `after` cursor paging.
- Use `Authorization: Bearer <Meta token>` on **server-to-Meta** calls. Never place tokens in a URL, client response, GitHub file, or log.
- Reject unexpected API origin, mismatched account ID/currency, incomplete page sequences or invalid metadata. Do not follow Meta's arbitrary `paging.next` URL.

The Meta API documents `time_increment` and `time_range` on the ad-account Insights endpoint, and `currency` and `timezone_name` on Ad Account. Revalidate before production deployment:
- https://developers.facebook.com/docs/graph-api/reference/adaccount/insights/
- https://developers.facebook.com/docs/graph-api/reference/ad-account/

## Exact expected JSON response
```json
{
  "schema_version":"1",
  "account_id":"4694437724123689",
  "account_currency":"USD",
  "account_timezone":"America/New_York",
  "fetched_at":"2026-11-21T21:00:00.000Z",
  "level":"adset",
  "time_increment":1,
  "since":"2026-11-13",
  "until":"2026-11-19",
  "pagination_complete":true,
  "rows":[{
    "adset_id":"1234567890",
    "date_start":"2026-11-13",
    "date_stop":"2026-11-13",
    "spend":"5.00",
    "outbound_clicks":[{"action_type":"outbound_click","value":"6"}],
    "account_currency":"USD"
  }]
}
```
**These example dates, ad-set ID and metrics are fictional.** The actual gateway requires four real mapped ad sets and 5–7 consecutive complete account-local days ending two days before the current local date. All rows must be present; the partial example above is not simulation-ready.

## Autonomous-budget gating still not enabled
Passing this daily report check enables **read-only scenario evaluation**, not automatic spending. Before any budget write service can be added, separately build and verify:
- Owner-approved campaign ID, total dollar limit, flight dates, per-ad-set minimums and allowed optimization rules
- Confirmed Meta-enforced spending cap/limit and compatible ad-set budget mode, no conflicting automated CBO/budget sharing
- Dedicated Meta `ads_management` credentials only after explicit owner authorization
- Stale-data freeze, atomic per-run idempotency, concurrent execution lock, proposed changes/audit history, write/readback verification, rollback and emergency pause
- Account- and campaign-specific allowlists, error alerts and a test mode; use safe storage appropriate for concurrent workers
- Scheduled execution in a separate, explicitly disabled-by-default Worker; ChatGPT need not be open once deployed

**Never infer that a daily budget is a hard daily maximum or that Meta outbound clicks are attributed music streams.**
