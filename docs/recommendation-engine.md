# Royalty-weighted recommendation engine (read-only v1)

## Capabilities
- **`analyze_live_efficiency`** retrieves Meta read-only ad-set, ad, and placement performance through the existing protected REST Worker. It requires an explicit ad-set ID → streaming-service map; it NEVER guesses the service from an ad-set name.
- **`simulate_budget_allocation`** performs a deterministic what-if calculation from four platform measurements. It NEVER writes to Meta and cannot launch or pause ads.
- Existing `get_campaigns`, `get_adsets`, `get_ads`, `get_insights`, and `get_connection_status` remain intact.

## What counts as evidence
The live REST Worker currently supports `date_preset` aggregate Insights but does not expose account timezone, account currency, or daily `time_increment` reports. This means an aggregated `last_7d` report is **diagnostic only**; it does not prove five to seven *complete account-local days*. The live tool does not automatically propose budgets. Outbound-click counts are parsed from the `outbound_click` action type (never from `clicks` or other Meta action types).

Creative comparisons use ad identifiers when available. Placement comparisons use Meta's `publisher_platform` and `platform_position` rows. The current API does not classify a creative file's dimensions or video/image format. The configured audience recipe is visible, but an audience's causal effect cannot be separated from a destination platform when each platform uses only one audience recipe.

## Provisional royalties, USD per 1,000 US paid streams
- Spotify: 4.41
- YouTube Music: 10.22
- Amazon Music: 8.61
- Apple Music: 6.28

These are editable planning assumptions, not verified payout rates. No paid streams are attributed to ad clicks. The relative proxy index is royalty-per-1,000 divided by outbound CPC under an **equal expected qualified streams per outbound click** assumption.

## Simulation input contract
```json
{
  "proposed_total_daily_budget_usd": 40,
  "confirmed_usd_currency": true,
  "observed_complete_days": 7,
  "data_complete_and_unpaginated": true,
  "measurements": [
    {"platform":"Spotify","spend_usd":20,"outbound_clicks":60,"current_daily_budget_usd":10,"minimum_daily_budget_usd":3},
    {"platform":"YouTube Music","spend_usd":20,"outbound_clicks":60,"current_daily_budget_usd":10,"minimum_daily_budget_usd":3},
    {"platform":"Amazon Music","spend_usd":20,"outbound_clicks":60,"current_daily_budget_usd":10,"minimum_daily_budget_usd":3},
    {"platform":"Apple Music","spend_usd":20,"outbound_clicks":60,"current_daily_budget_usd":10,"minimum_daily_budget_usd":3}
  ]
}
```

**Illustration only** — these aren't actual Meta measurements or an approved budget.

If any of the following fails, the simulator returns **`blocked` with null proposed amounts**:
- Four unique destinations represented exactly once
- Account currency positively verified as USD
- Five to seven *complete* observed days and complete, unpaginated data
- At least 30 outbound clicks from each platform over the same window
- Valid spend/click data, royalties, prior daily budgets, and platform minimums
- Existing daily budgets reconcile to the user's hypothetical total
- Feasible minimums with 10% exploration floor, ≤50% platform cap, and maximum ±20% relative daily adjustment

All suggested amounts are rounded to cents while preserving the exact proposed total. This is a mathematical planning simulator, **not an instruction to spend**. Use real Meta platform minimums once known. The app has no budget-write, ad-creation, or scheduling endpoint.

## Getting to real budget recommendations later
1. Build the campaign manually and map the four actual ad-set IDs to streaming services.
2. Confirm ad account USD currency and timezone.
3. Extend the read-only REST Worker to retrieve day-scoped Insights and verify complete days; compare totals with Ads Manager.
4. Review and approve campaign budget and creative/placement choices separately.
5. Use actual complete data to run a simulation. Never claim stream-attributed ROAS.
