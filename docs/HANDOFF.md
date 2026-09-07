# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B09-01 — authenticated Control access and project roles**  
База: published B08 merge `7389a1ffd3d8c37e2d13c860d2f8bb5b3d69cbc3`  
B08 main CI: `34113390498` — success  
Ветка: `b09-01-auth-publish-foundation`  
PR: #31  
Статус: **functional accepted; semantic BLOCKER=0; final docs/current-head Publication Gate next**

## Published foundation

B01–B08 are fully published. B08 canonical merge is `7389a1ffd3d8c37e2d13c860d2f8bb5b3d69cbc3`, exact main push CI `34113390498` success.

## B09 slicing

- B09-01: identity/session/project roles/network Control security;
- B09-02: immutable release build + owner-only publish/rollback + exact validation/hash/plugin-sidecar preflight;
- B09-03: history/clone/import-export + Studio Versions/Access + canonical B09 audit.

## B09-01 architecture

`closed user credentials -> server session + CSRF -> centralized project role authorization -> existing Control store operations`

Control has two explicit modes:

- `local-loopback-owner`: development-only and loopback-only;
- authenticated mode: durable closed users/sessions and owner/editor/tester memberships.

Runtime guest authentication is a separate trust domain and is not widened by Control identity.

## Accepted security behavior

- scrypt password verifier, random salt, timing-safe compare;
- opaque session/CSRF values with hashes only at rest;
- expiry/revoke fail closed;
- authenticated mutation requires CSRF;
- role matrix enforced server-side before project content access;
- owner-only membership admin + last-owner protection;
- project create + owner membership atomic in SQLite;
- process-local login throttle with injected service time;
- allowlisted browser Origin with credentialed CORS/preflight;
- non-loopback requires authenticated mode, Secure cookie and allowed Origin;
- SQLite users/memberships/sessions/revocation survive restart;
- publish/rollback remains absent until B09-02.

## Audit history

Post-green semantic review found one real blocker: allowed cross-origin browser mode validated Origin but originally lacked CORS/preflight, so real browser requests with credentials/CSRF would fail despite Node fetch tests. Fixed and regression-tested.

Audit: `docs/audits/2026-09-07-b09-01-semantic-audit.md` → unresolved BLOCKER **0**.  
ADR: `docs/decisions/0029-authenticated-control-access-boundary.md`.  
Worklog: `docs/worklog/2026-09-07-b09-01.md`.

Pre-docs green evidence: `f8e5263ae32e0c3582d99f6126d11aad2653d647` → CI `34119808138` success.

## Exact next sequence

1. run full CI on docs/current head;
2. update PR #31 body with final evidence;
3. mark ready;
4. pinned merge using the exact current head SHA;
5. fetch exact `push` workflow on merge SHA and require `head_branch=main` + success;
6. only then say B09-01 published;
7. create `b09-02-immutable-release-publish` exactly from verified merge SHA;
8. write B09-02 task card before implementation.

Do not start B09-02 from the feature branch or an unverified main ref.
