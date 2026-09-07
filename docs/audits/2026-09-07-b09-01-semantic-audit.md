# B09-01 semantic acceptance audit

Date: 2026-09-07  
Branch: `b09-01-auth-publish-foundation`  
Base: published B08 merge `7389a1ffd3d8c37e2d13c860d2f8bb5b3d69cbc3`

## Verdict

**ACCEPTED — unresolved BLOCKER = 0.**

Last fully green pre-docs checkpoint: `f8e5263ae32e0c3582d99f6126d11aad2653d647` → CI `34119808138` success.

## What was audited

- password verifier and secret handling;
- Memory/SQLite user/session/membership semantics;
- atomic project-owner creation;
- authenticated Control HTTP identity resolution;
- CSRF order and mutation protection;
- owner/editor/tester authorization matrix;
- project isolation / deny-by-default behavior;
- login throttling and injected service time;
- Origin/network-listen policy;
- browser credentialed CORS/preflight behavior;
- Runtime guest-auth independence;
- endpoint registry/generated docs truthfulness;
- absence of early B09-02 publish/rollback advertisement.

## Findings

### BLOCKER — browser network mode lacked CORS/preflight

Initial authenticated HTTP implementation validated `Origin`, but a real browser on another allowed origin would preflight credentialed requests carrying JSON and `X-CSRF-Token`. Without `Access-Control-Allow-*` and bounded `OPTIONS` handling, Node fetch tests could pass while the intended browser network mode failed.

Resolution:

- allowlisted Origin receives credentialed CORS headers;
- preflight allows only the required methods/headers;
- denied Origin receives no CORS grant;
- regression test added to the authenticated Control HTTP suite.

Evidence: hardening head `c678a3493de7af473fd88640a40968c74456fd91`; functional suites green in CI `34119305168` (run failed only because generated docs were intentionally stale after endpoint registry change).

### Non-blocking clarification — throttle boundary

The attempt that reaches the configured failure count still returns the generic credential failure; subsequent attempts during cooldown return `429`. The test was corrected to match this deliberate semantics rather than changing production behavior to satisfy an assertion.

### Documentation drift — B08 plugin wording

Generated Skill text still claimed installed metadata did not imply resolver execution, which became stale after B08-02/B08-03 trusted build-time execution. Generator wording was corrected without widening public plugin APIs.

## Security invariants confirmed

1. Password plaintext is never persisted or returned; malformed verifier fails closed.
2. Session and CSRF plaintext secrets are not persisted; lookup/validation uses server-side hashes.
3. Missing, malformed, expired or revoked session fails closed.
4. Authenticated mutations require matching CSRF proof before store mutation.
5. Project authorization happens server-side and inaccessible projects do not expose project content.
6. Tester cannot mutate draft/create quest; editor cannot administer membership; owner can administer membership.
7. Last owner cannot be removed or demoted into an ownerless project.
8. SQLite user/membership/session/revocation behavior survives reopen.
9. Local owner mode still refuses non-loopback listen.
10. Authenticated non-loopback mode requires secure cookies and nonempty origin allowlist.
11. Runtime guest auth remains independent from Control auth.
12. Publish/rollback is not available or advertised before B09-02.

## Honest residual scope

- login throttle is process-local, not distributed;
- user provisioning is operator/store capability, not public lifecycle UX;
- no password reset/invite/OAuth flow;
- no B09-02 release publication authority yet;
- full Studio Access/Versions UX remains B09-03.

None of these are B09-01 blockers.