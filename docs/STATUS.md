# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B08 published; B09-01 functional accepted, Publication Gate in progress** | B08 merge `7389a1ffd3d8c37e2d13c860d2f8bb5b3d69cbc3`, main CI `34113390498`; B09-01 pre-docs head `f8e5263ae32e0c3582d99f6126d11aad2653d647`, CI `34119808138` success |
| Контракты/Core | **B01–B03 published** | deterministic gameplay authority |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP |
| Authoring / Control | **B05 published + B09-01 auth accepted** | draft → validation → frozen playtest; closed users/sessions/roles/CSRF |
| AI foundation | **B06 published** | provider/intent/narrator/AgentBackend boundary; canonical BLOCKER=0 |
| Presentation/assets/Player | **B07 published** | immutable assets + executor + Runtime/browser integration |
| Plugins | **B08 published** | trusted manifest/registry/execution + artifact-bound `dice-check`; canonical BLOCKER=0 |
| Auth/publish | **B09-01 accepted, not yet published** | final docs/current-head CI → ready → pinned merge → exact main CI; then B09-02 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |
| Release hardening | не начато | B12 |

## B09-01 accepted behavior

- closed provisioned users; no public registration;
- scrypt password verifier with random salt/timing-safe comparison;
- opaque session + CSRF secrets, hashes only at rest;
- durable SQLite sessions/memberships/revocation;
- project roles exactly `owner | editor | tester`;
- atomic project creation + creator owner membership;
- server-side role matrix across current Control routes;
- owner-only membership administration and last-owner protection;
- authenticated login/session/logout;
- CSRF on authenticated mutations;
- bounded process-local login throttle using service time;
- browser Origin allowlist + credentialed CORS/preflight;
- non-loopback network mode requires authenticated mode + Secure cookie + allowed origin;
- local loopback-owner remains an explicit development mode;
- Runtime guest auth remains independent;
- generated agent/OpenAPI registry exposes implemented B09-01 operations only;
- B09-02 publish/rollback is not advertised early.

Semantic audit: `docs/audits/2026-09-07-b09-01-semantic-audit.md` → unresolved BLOCKER **0**.

## Publication Gate

B09-01 is **not called published yet**. Remaining:

1. final full CI on this docs/current head;
2. update PR #31 with final evidence;
3. mark PR ready;
4. merge pinned to exact head;
5. verify exact merge-SHA `event=push`, `head_branch=main` CI;
6. only then call B09-01 published and create B09-02 exactly from that merge SHA.

Weighted first-release estimate at this checkpoint: roughly **86–87%**. B12 is the first-release closure; B13 remains a post-release Builder/deployment expansion.