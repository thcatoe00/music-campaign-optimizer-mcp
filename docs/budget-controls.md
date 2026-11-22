# Budget control preflight — read-only v1

**Status: implemented as dry-run evaluation; no Meta budget writes exist in this release.**

The `preview_budget_controls` MCP tool accepts a *hypothetical* policy, snapshot, controls and proposed ad-set budgets. These inputs are **not independently authenticated** by that tool. Even when every check passes, its strongest conclusion is `reviewable`, **not** "safe for autonomous execution." The returned `owner_authorization_verified:false`, `controls_verified_against_live_meta:false`, `meta_writes_attempted:false` and `spending_impact_usd:0` are invariants.

## Safeguards now evaluated
- The proposal references one allowlisted account/campaign and exactly four uniquely mapped ad sets (Spotify, YouTube Music, Amazon Music, Apple Music), with no unmapped additional ad sets in the campaign.
- Campaign/ad sets must be active; account currency must be USD; ad-set budget control rather than campaign-level budget optimization/budget sharing.
- Current campaign/adset snapshot must have been fetched no more than ten minutes ago; daily-reporting readiness and complete pagination must be affirmed; 30+ outbound clicks per platform required.
- Policy must specify valid account-local campaign flight dates, a daily total and lifetime ceiling, verified active **native campaign spending limit**, and enough remaining lifetime allowance for another full budget day.
- Manual pause, emergency stop, unavailable API/monitoring, or an unverified previous change freezes any proposal.
- New daily budgets must equal the policy daily total **exactly in USD cents**, preserving the same prior daily total. Each change must honor the current Meta minimum, at least 10% exploration floor, no more than 50% per destination, and no more than a 20% per-run adjustment. Safer/tighter limits are permitted.
- Each dry-run returns a deterministic SHA-256 fingerprint of the proposed inputs, evaluation time and findings and a structured audit event; **events are returned but not stored persistently**.

**Crucial:** no native Meta campaign spending cap was queried or established here. The submitted `native_limit_verified_active` flag is a *hypothetical condition*, not a real permission or proof of the limit. A future trusted executor must obtain independent readback of this status, enforce the cap without relying on daily budgets as hard maximums, and use authenticated server-side policy records. Some Meta campaign configurations may not support the required native hard ceiling; that must be resolved before autonomous changes.

## What remains before actual budget modifications are allowed

1. **Source validation:** Bind preflight inputs to authenticated Meta GETs and the verified daily-reporting endpoint; store the exact four ad-set IDs, current budget state, account timezone and campaign state.
2. **Real owner authorization:** Obtain the owner's approved campaign ID, ad-flight dates, total/lifetime limits and allocation rules, recorded securely server-side. Do not treat a tool-call boolean as authorization.
3. **Meta permissions:** Separate, explicit `ads_management` grant and restricted system-user permission for a dedicated write service. No token in ChatGPT/GitHub.
4. **Execution safety:** durable append-only audit logs, idempotency keys, single-writer locking across Cloudflare invocations, read-before/write-after, paused-state verification, a rollback/incident procedure and hard budget ceiling enforcement. Never claim a sequence of per-adset writes is atomic on Meta.
5. **Scheduler:** disabled-by-default recurring controller, independent of ChatGPT. Activation only after verified spending controls and explicit user approval.

The mathematical guardrail evaluator does not create a recurring task, send alerts, write to Meta, or enable ads. It is a testable foundation for those later systems.
