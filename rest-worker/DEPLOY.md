# Meta reporting Worker: one-time Git connection

This source is for the **existing** Cloudflare Worker `odd-hall-a184`, not the owner-authenticated MCP Worker `music-campaign-optimizer-mcp`.

**State:** Source, tests, and Wrangler config are prepared in `rest-worker/`. Deployment to the separate Worker is not possible through GitHub alone until its own Cloudflare Builds connection is configured. No Meta write capability is included.

## Connect once

1. In Cloudflare, select **Workers & Pages → odd-hall-a184 → Settings → Builds → Connect**.
2. Choose GitHub and the existing repository `thcatoe00/music-campaign-optimizer-mcp`.
3. Use production branch `main` and set **Root directory** to `rest-worker` (not repository root). Ensure the worker name is `odd-hall-a184`.
4. Deploy command from that directory: `npx wrangler deploy`. A `rest-worker/package.json` and `rest-worker/wrangler.jsonc` are provided.
5. Preserve the existing Worker bindings in Cloudflare: `MUSIC_API_KEY` and `META_ACCESS_TOKEN` as secrets, `META_AD_ACCOUNT_ID` as variable. The provided Wrangler config sets `keep_vars: true` to retain dashboard variables on deploy. Never paste secrets into GitHub.
6. Verify the production build and confirm that original `/api/campaigns`, `/api/adsets`, `/api/ads`, and `/api/insights` remain functional via the MCP gateway. Unauthenticated `GET /api/daily-insights?days=7` must return 401.
7. When a real campaign is created, owner-only MCP `get_daily_reporting_readiness` validates complete day-by-day rows and account identity.

The root repository is separately linked to the **MCP** Worker. Do **not** change that Worker's existing Cloudflare root directory or production build settings. Connecting a second Cloudflare Worker to the same repository must specify `rest-worker` as its own root.

## Read-only contracts

- Daily endpoint: `GET /api/daily-insights?days=5|6|7`; requires existing bearer key.
- Source: `rest-worker/index.js`.
- Unit tests: `node --test rest-worker/test/*.test.mjs`.
- Dry-run build from repository root: `npx wrangler deploy --config rest-worker/wrangler.jsonc --dry-run`.
- No `POST`, `PATCH` or `DELETE` paths; no scheduled budget writes.
- User-supplied campaign budget and flight dates are not yet approved.

**Deployment note:** Cloudflare Builds may require a production push after connection; do not create a duplicate Worker or replace an unrelated one. A single manual code-editor deployment of the identical source file is an alternative if Builds connection isn't offered, but would need manual updates in the future.
