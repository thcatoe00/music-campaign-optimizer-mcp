# Secure Meta Reporting MCP — deployment checklist (draft)

This branch is **NOT ready to deploy or merge**. The deployed `main` Worker remains an unauthenticated calculator demo with no Meta integration. The existing read-only Meta REST Worker (`odd-hall-a184`) is separate and must remain unchanged.

## Goal
Expose only four **read-only** MCP tools (`get_campaigns`, `get_adsets`, `get_ads`, `get_insights`) to the verified owner after OAuth sign-in. Calls proxy to the pre-existing authenticated Meta Worker. No ad budget writes and no direct access to Meta system-user credentials.

## Required before merge
1. **Confirm OAuth library compatibility and typecheck** against the pinned SDK version. The proposed `src/index.ts` has **not** been built or tested and is only a draft; resolve OAuth provider API, handler typing, error handling, token endpoint, resource metadata, and login callback issues.
2. Create a **GitHub OAuth App** whose authorization callback URL is `https://music-campaign-optimizer-mcp.waynecatoe3.workers.dev/callback` and configure its homepage URL to the MCP Worker origin. This is **not** the existing Meta Developer app.
3. Create a Cloudflare **Workers KV namespace** for OAuth state/grants and configure the binding `OAUTH_KV` in the MCP Worker's `wrangler.jsonc` only after obtaining the real namespace ID. **Never commit a secret or placeholder namespace ID to a deployed configuration**.
4. Store `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` (if required by the finalized provider flow), and `MUSIC_API_KEY` as Cloudflare **Worker secrets** in the MCP Worker. The MUSIC_API_KEY must match the rotated secret of the existing Meta REST Worker. No secret values belong in GitHub, ChatGPT messages, or screenshots.
5. Restrict sign-in to the intended GitHub numeric user ID and confirm that other identities receive no access. The target ID needs owner verification; the repository API currently reports its owner user ID as 359685372.
6. Confirm consent page security, CSRF and upstream `state` browser binding, redirect URI validation, scope enforcement, and untrusted client-name escaping. Test OAuth with an authorized client, rejected identity, rejected/missing scopes, failed callbacks, and expired/revoked tokens.
7. In a **separate staging Worker**, test that unauthenticated MCP requests receive 401; authorized MCP clients can call the four read-only tools; and no public/private Meta data is returned to unauthenticated requests. Test Meta response paging, placement reporting, and stale-token failure.
8. Verify the Meta backend never logs Meta secrets or sends credentials in result text, redirect destinations, or pagination links; scrub error messages before returning them.
9. Once secure staging tests pass, deploy with explicit approval. **Only afterward** attach the authenticated MCP URL to ChatGPT's Music Campaign Optimizer plugin. Plugins that only have skills cannot automatically call the new MCP server without a proper app/MCP binding.

## Known scope and design limits
- Direct streaming links cannot attribute post-click listening to ads.
- Platform × creative × placement measurements are reported where Meta supplies them; audience comparisons require deliberately distinct audience configurations.
- No automatic budget modifications are included.
- Four tools are planned; the existing API's currently supported fields and presets define their scope.
