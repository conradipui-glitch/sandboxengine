# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B09-02 — immutable release build and publication**  
База: published B09-01 merge `206ae32e1ce9f4a027c881e61d8e6e2163a4095d`  
B09-01 main CI: `34135325041` — success  
Ветка: `b09-02-immutable-release-publish`  
PR: #32  
Статус: **functional accepted; semantic BLOCKER=0; final docs/current-head Publication Gate next**

## Published foundation

B01–B08 and B09-01 are fully published. B09-01 canonical merge is `206ae32e1ce9f4a027c881e61d8e6e2163a4095d`, exact main push CI `34135325041` success.

## B09 slicing

- B09-01: identity/session/project roles/network Control security — published;
- B09-02: immutable release build + owner-only publish/rollback + exact validation/hash/plugin-sidecar preflight + published Runtime bootstrap — functionally accepted;
- B09-03: history/clone/import-export + Studio Versions/Access + canonical B09 audit — next after verified B09-02 publication.

## B09-02 architecture

`exact successful validation -> immutable Control release + B08 sidecars -> owner currentReleaseId pointer -> application-boundary published resolver -> Runtime session pinned to exact release`

Existing published sessions do not resolve mechanics from current pointer. They use:

`durable project binding + SessionRecord.release -> exact stored release -> exact execution context`

This preserves mechanics through later publish/rollback and process reopen.

## Accepted behavior

- release content is append-only and immutable;
- build re-proves exact draft/validation/compiled artifact identity;
- compiled artifact SHA-256 is recomputed before persistence;
- B08 plugin preflight is reused at build, publish/rollback and session start;
- explicit empty plugin requirements metadata is persisted when appropriate;
- owner/editor build; tester cannot build;
- publish/rollback are owner-only and expected-current CAS;
- rollback requires a previously published target;
- publication history is append-only;
- required release HTTP routes use B09-01 role/CSRF/Origin/CORS policy;
- new sessions follow current published release;
- existing sessions keep exact pinned release mechanics;
- production standalone composition has no static-template fallback;
- mixed static/published Runtime composition fails explicitly;
- missing/corrupt/incompatible release fails closed;
- SQLite reopen preserves current pointer, published session binding and continued pinned execution;
- generated endpoint/OpenAPI truth contains implemented B09-02 operations only.

## Hardening history

Post-green review did not accept the first green partial implementation. It found four acceptance-level gaps and closed all of them:

1. missing Control HTTP release authority;
2. risk of global/static executor violating old-session pinning;
3. standalone production still using `minimal-paint` static template;
4. missing end-to-end existing-session execution proof after SQLite reopen.

Key evidence:

- HTTP authority `0828e8812fd878f833f9199302644170af3accf3` → CI `34145973151` success;
- pinned execution `4dc7217102f3a68f7fe0692a9d8d4ec2e75d74bf` → CI `34146359865` success;
- production composition `58c1acaea560547cf557fee0294d2a6d262bfa51` → CI `34146421428` success;
- restart regression `674d8542dbb5ffb1612815133a1210cf7b867520` → CI `34146693272` success;
- generated contract sync `20bb2fc2be046abb04b77b838cf94692cabc51c7` → CI `34147022847` success.

Audit: `docs/audits/2026-09-07-b09-02-semantic-audit.md` → unresolved BLOCKER **0**.  
ADR: `docs/decisions/0030-immutable-release-publication-pinned-runtime.md`.  
Worklog: `docs/worklog/2026-09-07-b09-02.md`.

## Explicit limitation

Published Runtime materialization currently accepts the implemented unambiguous zero-or-one `core.action` routing case. Multiple `core.action` blocks fail explicitly with `UNSUPPORTED_ACTION_ROUTING`; no ordering/action is guessed. This is non-blocking for B09-02 and must be widened only by an explicit later routing contract.

## Exact next sequence

1. run full CI on this final docs/current head;
2. update PR #32 body with final semantic/CI evidence;
3. ensure no unresolved PR review threads;
4. mark PR ready;
5. merge pinned using the exact current head SHA;
6. fetch exact `push` workflow on merge SHA and require `head_branch=main` + success;
7. only then say B09-02 published;
8. create `b09-03-version-history-studio-access` exactly from verified B09-02 merge SHA and write its task card before implementation.

Do not start B09-03 from the feature branch or an unverified main ref.
