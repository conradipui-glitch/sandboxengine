# B09-01 — authenticated Control access and project roles

## Goal

Replace the current "Control is safe only because it is loopback" boundary with an explicit first-release identity/session/project-role boundary, while preserving an intentional local-loopback-owner development mode.

Base: published canonical B08 merge `7389a1ffd3d8c37e2d13c860d2f8bb5b3d69cbc3`, exact main CI `34113390498` — success.

Specification sources: §8.2, §11.5, §14.6, §15.2–15.3, B09 card in §19.

## Main invariant

**Every network-capable Control operation is authorized server-side against one authenticated user and one project role. Browser visibility is never an authorization mechanism. Mutating authenticated requests require CSRF proof in addition to the session cookie.**

## B09 slicing

- **B09-01 (this slice):** closed users, password/session security, project membership roles, route authorization, network-listen gate.
- **B09-02:** immutable release build + publish/rollback pointer with exact validation/content hash and B08 plugin sidecars.
- **B09-03:** draft/version history, clone/import/export, references/deletion UX, Studio Versions/Access surfaces, completed author trace and canonical B09 audit.

The split does not change B09 external acceptance; it prevents publish authority from being added before identity/roles exist.

## Do

### 1. Security/storage contract

Add a bounded Control security contract implemented by Memory and SQLite stores:

- closed provisioned users; no public registration endpoint;
- roles exactly `owner | editor | tester` per project;
- durable project memberships in SQLite;
- durable server-side sessions in SQLite and equivalent Memory behavior;
- session lookup by a hash of an opaque token, never plaintext token persistence;
- CSRF secret stored/compared by hash, never returned by storage reads;
- expiry uses injected/service wall time, never gameplay clock;
- explicit session revoke/logout;
- owner-only membership administration;
- project creation for an authenticated user atomically creates the project and owner membership in the same storage transaction.

Do not weaken existing optimistic draft concurrency or validation/playtest hash binding.

### 2. Password handling

Use Node runtime cryptography, not custom password crypto:

- bounded UTF-8 passwords;
- random per-user salt;
- `crypto.scrypt`/`scryptSync` derived password verifier with explicit version/parameters;
- timing-safe comparison;
- no plaintext password persistence/logging/response;
- malformed stored verifier fails closed.

User provisioning is an operator/store capability in B09-01, not a public signup route.

### 3. HTTP auth endpoints

Authenticated Control mode adds bounded endpoints:

- `POST /control/v1/auth/login` — closed-user credential login; sets opaque session cookie and returns safe user/session metadata + CSRF token;
- `GET /control/v1/auth/session` — returns current safe identity/session metadata, never token/hash/password data;
- `POST /control/v1/auth/logout` — CSRF-protected revoke + cookie expiry;
- `GET /control/v1/projects/{projectId}/members` — owner only;
- `PUT /control/v1/projects/{projectId}/members/{userId}` — owner only, exact role body;
- `DELETE /control/v1/projects/{projectId}/members/{userId}` — owner only, with last-owner/self-orphan protections.

No public registration/password-reset/invite flow in this slice.

### 4. Session/cookie/CSRF boundary

- opaque session token and CSRF token use cryptographically secure random bytes;
- cookie is `HttpOnly`, `SameSite=Strict`, scoped to Control path; `Secure` is configurable for TLS termination and mandatory for non-loopback listen;
- all authenticated mutations except login require the matching `X-CSRF-Token` header;
- missing/invalid session returns one explicit authentication failure without disclosing whether a project exists;
- project authorization failure is deny-by-default and must not leak inaccessible project content;
- malformed/expired/revoked sessions fail closed;
- login response and all Control responses stay `Cache-Control: no-store`.

### 5. Login throttling / origin

Add a bounded process-local login throttle using injected service time (not gameplay clock), keyed without storing passwords. At minimum repeated failed login attempts produce `429` for a bounded cooldown.

Authenticated mode accepts an allowlist of browser origins. If an `Origin` header is present it must match. Non-loopback listen requires authenticated mode, secure cookies and at least one allowed origin.

This is not a distributed abuse-prevention system; B09-01 must not pretend a single-process limiter is one.

### 6. Project authorization matrix

Authenticated routes enforce:

| Operation | owner | editor | tester |
|---|---:|---:|---:|
| list/read own projects/quests/draft | yes | yes | yes |
| create project | yes (creator becomes owner) | yes (creator becomes owner) | yes (creator becomes owner) |
| create quest / change draft | yes | yes | no |
| validate draft | yes | yes | yes |
| create/read playtest | yes | yes | yes |
| membership administration | yes | no | no |
| future publish/rollback | reserved B09-02 owner only | no | no |
| AI keys/settings | reserved owner-only later route | no | no |

Project listing returns only projects in which the authenticated user has a membership.

Local development mode may continue to treat loopback as one synthetic owner, but it MUST still refuse non-loopback binding and MUST be explicitly distinguishable from authenticated mode in code/tests.

### 7. HTTP/server integration

Refactor `createControlHttpServer` so authorization is centralized rather than duplicated ad hoc inside each handler:

- resolve access mode/identity before project handlers;
- derive project ID from the matched route and check the required role/capability;
- protect every existing Control route;
- keep login/session routes outside project authorization but inside auth/origin/rate-limit policy;
- do not expose Runtime guest credentials to Control auth or vice versa.

### 8. Endpoint registry / agent docs

Only after the endpoints actually exist:

- register implemented auth/member operations as available;
- include auth/CSRF expectations in generated contract metadata where the existing registry supports it;
- keep B09-02 publish/rollback endpoints planned/not advertised until implemented;
- `docs:check` must stay deterministic.

## Tests

Minimum regressions:

1. password verifier is salted, deterministic for one stored verifier, rejects wrong password and never returns/stores plaintext;
2. closed login: unknown/wrong credential fails without user enumeration detail;
3. failed login throttle reaches `429`, success resets/reduces the relevant failure state, injected service time controls expiry/cooldown;
4. login issues random opaque session + CSRF values, storage contains hashes only;
5. cookie attributes include HttpOnly/SameSite and Secure in network mode;
6. expired/revoked/garbled session rejected;
7. GET authenticated route works without CSRF; POST/PUT/DELETE without matching CSRF is rejected before store mutation;
8. cross-origin browser request outside allowlist rejected;
9. project listing shows only memberships;
10. project creation + creator owner membership is atomic in Memory and SQLite;
11. owner can manage membership; editor/tester cannot;
12. last owner cannot be removed/demoted into an ownerless project;
13. tester can validate/playtest/read but cannot mutate draft/create quest;
14. editor can mutate draft but cannot manage membership;
15. inaccessible project returns deny-by-default without draft/validation leakage;
16. SQLite users/memberships/sessions survive reopen; revoked/expired session behavior survives reopen;
17. unauthenticated/local-owner mode still refuses non-loopback listen;
18. authenticated non-loopback mode refuses insecure cookies or empty origin allowlist;
19. Runtime guest auth remains independent;
20. root `npm run verify` green and generated docs not stale.

## Functional acceptance

B09-01 is accepted when:

1. every current Control project route has a tested server-side role decision in authenticated mode;
2. login/session/CSRF/network-listen boundaries fail closed;
3. SQLite durability proves user/membership/session state survives restart;
4. project creation cannot leave an ownerless authenticated project;
5. local loopback-owner development remains supported without becoming a network bypass;
6. no B09-02 publish/rollback authority is advertised early;
7. semantic audit has zero unresolved BLOCKER.

## Not now

- release build/publish/rollback/currentRelease pointer (B09-02);
- persistence/enforcement of B08 release sidecars in production publish/start (B09-02);
- import/export/clone/history/version UI (B09-03);
- public signup, email invites, password reset, OAuth/OIDC/SAML;
- enterprise IAM / live collaboration;
- distributed rate limiting;
- AI provider key management UI;
- Builder/deployment permissions.

## Next

After verified published B09-01: **B09-02 — immutable release build + owner-only publish/rollback with exact validation/hash/plugin-sidecar preflight**, exactly from the verified B09-01 merge SHA.
