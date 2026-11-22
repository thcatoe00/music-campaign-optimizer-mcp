# Music Campaign Optimizer — isolated budget Worker

**Deployment state:** This directory is a ready-to-deploy **disabled** Cloudflare Worker, separate from `odd-hall-a184` and `music-campaign-optimizer-mcp`.

## One-time Cloudflare setup

- Create a **new Worker** using the existing GitHub repository `thcatoe00/music-campaign-optimizer-mcp`, production branch `main`.
- Worker name must be `music-campaign-budget-control`.
- Root directory must be `budget-worker`. Build command blank; deploy command `npx wrangler deploy`.
- Confirm `GET /health` returns `status: disabled` and `meta_write_enabled: false`.
- Do not change the existing reporting or MCP Workers. No Meta token is required to deploy this disabled Worker.

## Later, after Meta system-user authorization

Store the **separate** system-user token (permissions scoped to the owner's ad account, `ads_management`) in the new Worker's **Variables and Secrets**, using a **Secret** (encrypted), named `META_BUDGET_ACCESS_TOKEN`. Never place it in GitHub, source code, ChatGPT, build logs or HTTP query strings. The existing read-only `META_ACCESS_TOKEN` stays untouched in `odd-hall-a184`.

**Important:** Even if the token is present, no current Worker code reads or uses it. This Worker cannot modify ad sets, campaigns, budgets, or spend. No scheduling is enabled.

## Before any future activation

A subsequent reviewed release must introduce an authenticated, owner-approved server-side policy, allowlisted ad account/campaign/ad-set IDs, genuinely verified campaign hard spending ceiling and Meta permissions, fresh daily evidence, idempotent singleton execution lock, pause/kill switch, durable audit trail, readback/rollback and alerts. Budget writes must remain disabled until explicit separate owner approval. Do not infer that normal Meta daily budgets are hard daily caps.

## Local tests

`node --test budget-worker/test/*.test.mjs`; CI additionally runs Wrangler dry-run bundling. No secrets are needed for these tests.
