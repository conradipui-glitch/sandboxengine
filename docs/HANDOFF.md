# Передача работы

Обновлено: 2026-09-08

Текущий блок: **B11 — реальные квесты и интеграция**  
База: published B10 merge `4e5fea2888d14440c60ad48abffbefe42abfe637`  
B10 exact main CI: #650 / run `34209005817` — success  
Ветка: `b11-real-quests-integration`  
Статус: **B11.0/B00 source confirmation GREEN; B11.1 real quest packages next**

## Published foundation

B01–B10 опубликованы.

B10 закрыл интерактивный author-assistant цикл и его границы:

- verified PR #34 head `f03e283d5e027cb93dea7d3f149685b058724ad0`;
- merge SHA `4e5fea2888d14440c60ad48abffbefe42abfe637`;
- exact main CI #650 / `34209005817` success;
- semantic audit unresolved BLOCKER 0;
- Codex adapter boundary;
- account/login/quota isolation;
- regression `author request → linked blocks → Apply → correction → Apply → validation → frozen playtest`.

Do not claim a real authenticated Codex subscription run in CI: the accepted evidence is deterministic protocol evidence because CI has no configured authenticated local App Server.

## B11.0 closed

The old B00 documentation debt is closed in `docs/BASELINE.md` and the migration contract is frozen in `docs/tasks/B11-01-source-migration-map.md`.

Confirmed source:

- repo `conradipui-glitch/sandbox`;
- Florence merge PR #9;
- exact source SHA `092bcef0be5943e32bf02f08f9e9d4cde393fa95`;
- current source main checked at `f9b0cd0d607da48d89827f0a1a882b74e9b78e50`;
- post-baseline drift is README/docs only, gameplay baseline did not move;
- exact source production run #47 / `34012448412` succeeded through install, tests, build and Worker deploy.

Mapped legacy runtime:

- React/Vite client;
- Cloudflare Worker API;
- `HistorySession` Durable Object as authoritative game storage;
- `StoredGame { state, processedKeys, analytics }` under storage key `game`;
- browser localStorage is not the canonical save; it stores anonymous visitor identity;
- gameplay routes are `POST /api/games`, `GET /api/games/:id`, `POST /api/games/:id/turn`, plus scenario/metrics/health routes;
- retries use saved idempotency keys;
- old sessions must stay on the old runtime instead of being silently converted.

Florence source evidence:

- six semantic decisions;
- canonical route `draft → ledger → counter → pigment → public → deliver` reaches victory with six trace entries;
- legacy authored tests recursively cover all 729 prepared `3^6` routes;
- conditional vs executed behavior is explicit;
- blocked/unknown compound actions do not partially mutate state;
- save/restore does not double-charge;
- a legacy save missing Florence memory is not given fabricated facts.

## B11 architecture contract

Preserve these boundaries:

- **no Florence-specific branch in `packages/core`**;
- no generic runtime/Core type named `FlorenceMemory`;
- quest-specific facts/actors/resources remain authored data;
- six source turns migrate as **narrative beats**, while elapsed world time stays on the generic clock/scheduler;
- presentation/assets never become gameplay authority;
- freeform AI may interpret/propose, while Core/runtime owns validation and mutation;
- `executed`, `conditional` and blocked/precondition semantics remain distinguishable;
- no client-side gameplay arithmetic;
- immutable release + published-session binding remains the rollout authority.

## Real quests required by B11

### `examples/florence`

Move the real Florence scenario semantics from the exact source SHA into generic Engine contracts/state. Preserve causal meaning, not source implementation branches or exact prose.

### `examples/transfer-desk`

The existing `packages/contracts/fixtures/transfer-desk` is only a B01 contract fixture. B11 requires a full second example with a different causal shape: different goal, item transfer/possession, social context and resource pressure. It must not be Florence with renamed actors.

## Rollout contract for later B11 integration

- do not modify or migrate old live `sandbox` sessions;
- the adapter/BFF chooses legacy vs Engine only when creating a new Florence session;
- the chosen runtime/release is pinned to the session;
- changing a rollout flag never moves an in-progress session;
- rollback stops routing future sessions to Engine while both kinds of existing session continue on their pinned runtime.

## Exact next sequence

1. create `examples/florence` using only generic contracts/extensions;
2. create `examples/transfer-desk` as a genuinely different real quest;
3. add deterministic contract/scenario tests and verify no Florence identifiers enter `packages/core`;
4. run root `npm run verify` on the exact B11 head;
5. only then add the minimal `sandbox` adapter/BFF + new-session routing flag;
6. run old/new semantic comparison using the canonical Florence route plus representative compromise/refusal routes;
7. prove rollback/session pinning and complete B11 acceptance before B12.

Do not begin by editing the legacy app or by introducing a Florence special case into the Engine. The next implementation surface is the two real quest packages.
