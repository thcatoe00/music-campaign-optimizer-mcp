# Secure Meta Reporting MCP — deployment checklist (draft)

This branch is a controlled **authentication-only release**. Before deployment, the live `main` Worker is an unauthenticated calculator demo. The separate, functioning Meta REST Worker (`odd-hall-a184`) must remain unchanged.

## Build validation status (2026-11-21)
- GitHub Actions TypeScript and Wrangler dry-run build passed for commit `a45140ee7ed237f771cf90acb9500144b47613f8`.
- OAuth scope and verified-owner checks have been added to the MCP dispatch path. An auth-only endpoint replaced all draft Meta reporting tools; rerun validation against the latest commit.
- These are static/build checks only; live OAuth, rejected-user, CSRF, credential isolation and upstream API tests are still outstanding.
- Current deployed OAuth starter does not access Meta. Do not populate the MCP Worker's `MUSIC_API_KEY` secret until the identity/consent checks are complete and the previously exposed key has been rotated in the upstream Meta Worker.

## Goal
This phase exposes **only** `get_connection_status` to the verified owner after OAuth sign-in. It must contain **no Meta API calls, no access to `MUSIC_API_KEY`, and no advertising data**. After live authorization tests, a later controlled release can add four read-only tools (`get_campaigns`, `get_adsets`, `get_ads`, `get_insights`) to proxy to the existing Meta REST Worker.

## Required before merge
1. **Confirm OAuth library compatibility and typecheck** against the pinned SDK version. The proposed `src/index.ts` has passed a TypeScript check and Wrangler dry-run bundle but **has not been live-tested**; verify OAuth provider API, handler typing, error handling, token endpoint, resource metadata, and login callback behavior.
2. Create a **GitHub OAuth App** whose authorization callback URL is `https://music-campaign-optimizer-mcp.waynecatoe3.workers.dev/callback` and configure its homepage URL to the MCP Worker origin. This is **not** the existing Meta Developer app.
3. Create a Cloudflare **Workers KV namespace** for OAuth state/grants and configure the binding `OAUTH_KV` in the MCP Worker's `wrangler.jsonc` only after obtaining the real namespace ID. **Never commit a secret or placeholder namespace ID to a deployed configuration**.
4. Store `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` as Cloudflare **Worker secrets** in the MCP Worker. Configure `COOKIE_ENCRYPTION_KEY` only if required by finalized provider flow. Do **not** add `MUSIC_API_KEY` during authentication-only testing. Do **not** configure `MUSIC_API_KEY` in the MCP Worker for this authentication-only phase. It will only be needed after authentication is proven, in a later version, and must then match the rotated upstream REST Worker secret. No secret values belong in GitHub, ChatGPT messages, or screenshots.
5. Restrict sign-in to the intended GitHub numeric user ID and confirm that other identities receive no access. The target ID needs owner verification; the repository API currently reports its owner user ID as 359685372.
6. Confirm consent page security, CSRF and upstream `state` browser binding, redirect URI validation, scope enforcement, and untrusted client-name escaping. Test OAuth with an authorized client, rejected identity, rejected/missing scopes, failed callbacks, and expired/revoked tokens.
7. In the **authentication-only Worker**, test that unauthenticated MCP requests receive 401; an authorized owner can call `get_connection_status`; a different GitHub user is rejected; and *no* Meta data is exposed. A later separate staging release must verify campaign/placement report paging and upstream token failure before adding Meta reporting tools.
8. Verify the Meta backend never logs Meta secrets or sends credentials in result text, redirect destinations, or pagination links; scrub error messages before returning them.
9. Deploy the auth-only gateway after owner approval and static checks; **do not connect Meta** until live OAuth tests and later staging reporting tests pass. **Only afterward** attach the authenticated MCP URL to ChatGPT's Music Campaign Optimizer plugin. Plugins that only have skills cannot automatically call the new MCP server without a proper app/MCP binding.

## Known scope and design limits
- Direct streaming links cannot attribute post-click listening to ads.
- Platform × creative × placement measurements are reported where Meta supplies them; audience comparisons require deliberately distinct audience configurations.
- No automatic budget modifications are included.
- Four tools are planned; the existing API's currently supported fields and presets define their scope.
