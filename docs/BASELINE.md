# Baseline действующей игры

**Статус B00: CONFIRMED для входа в B11.**

Это фактическая карта исходной игры, а не утверждение о завершённом переносе. Она отделяет доказанный legacy baseline от будущих изменений дизайна в Living History Engine.

## 1. Точная исходная точка

- Репозиторий: [conradipui-glitch/sandbox](https://github.com/conradipui-glitch/sandbox)
- Florence merge: PR #9
- Exact source commit: [`092bcef0be5943e32bf02f08f9e9d4cde393fa95`](https://github.com/conradipui-glitch/sandbox/commit/092bcef0be5943e32bf02f08f9e9d4cde393fa95)
- Commit message: `fix: keep Florence surprising without breaking continuity`
- Аудит подтверждён: 2026-09-08
- Текущий `sandbox/main` на момент аудита: `f9b0cd0d607da48d89827f0a1a882b74e9b78e50`
- Compare `092bcef..f9b0cd`: после gameplay baseline есть только следующий docs/README commit; gameplay-код Florence не менялся.

Именно `092bcef...` является каноническим source SHA для B11. Миграция не должна молча брать более новый `main` как новый игровой baseline.

## 2. Проверка build / tests / production deploy

Для exact source SHA `092bcef...` найден production workflow run **#47 / run id `34012448412`**, conclusion `success`.

В этом exact-head run успешно завершены:

1. `npm ci`
2. `npm test`
3. `npm run build`
4. `npx wrangler deploy`

Таким образом B00 больше не зависит от предположения «исходник, вероятно, собирался»: test/build/deploy подтверждены на точном мигрируемом SHA.

Текущий README исходного приложения указывает production demo:

- `https://living-history-sandbox.conradipui.workers.dev/`

Отдельный новый live smoke настоящей AI-литературной сессии в рамках этого B00-аудита не заявляется. Это не блокирует технический baseline: протокол, gameplay-state и six-beat authored semantics имеют отдельные доказательства ниже; качество живой генерации остаётся author/playtest acceptance B11/B12.

## 3. Как воспроизвести исходник

Канонические scripts source repository:

```bash
npm ci
npm test
npm run build
npm run dev:worker
npm run dev
```

Preview Worker также запускается через:

```bash
npm run preview
```

Deployment:

```bash
npm run deploy
```

Legacy `package.json` использует `latest` для ряда npm-зависимостей, но exact source имеет lockfile. Это **не переносится как policy** в новый Engine: `sandboxengine` уже фиксирует поддерживаемый Node/npm диапазон и конкретные dependency versions.

## 4. Runtime и API исходной игры

Исходная архитектура:

`React/Vite Player -> Cloudflare Worker API -> HistorySession Durable Object -> Workers AI/DeepSeek + static assets`.

Worker name: `living-history-sandbox`.

Bindings на source SHA:

- `AI`
- `HISTORY_SESSIONS` -> Durable Object `HistorySession`
- `PRODUCT_ANALYTICS`
- `ASSETS`
- optional `DEEPSEEK_API_KEY`
- optional `ANALYTICS_DASHBOARD_TOKEN`

Публичные gameplay routes:

- `GET /api/health`
- `GET /api/scenarios`
- `POST /api/games`
- `GET /api/games/:id`
- `POST /api/games/:id/turn`
- `GET /api/games/:id/metrics`

Отдельно существует защищённый analytics endpoint `GET /api/analytics/overview`.

## 5. Save / session mapping

Authoritative gameplay save **не находится в browser localStorage**.

`HistorySession` хранит под Durable Object storage key `game` структуру:

```ts
interface StoredGame {
  state: GameState;
  processedKeys: Record<string, GameState>;
  analytics?: SessionAnalytics;
}
```

Следовательно:

- authoritative state = server-side Durable Object;
- `processedKeys` = legacy idempotency replay protection;
- analytics сохраняется рядом с session state;
- клиентский `localStorage` в `src/client/api.ts` используется для anonymous visitor UUID, а не как canonical game save;
- state читается через `GET /api/games/:id`;
- ход записывается через `POST /api/games/:id/turn`;
- успешный turn сначала строит новое состояние, затем записывает обновлённый `StoredGame`;
- idempotency key возвращает уже сохранённое состояние и не тратит ход повторно.

Для B11 это означает: **старые Durable Object sessions не конвертируются in place**. Они продолжают обслуживаться legacy runtime. Новый Engine получает только новые Florence sessions после включения route flag; привязка runtime/release фиксируется на session creation.

## 6. Florence gameplay baseline

Source scenario id: `florence-workshop`.

Начальная семантика включает:

- title: `Флоренция: Мастерская под давлением`;
- role: художник / хозяин мастерской;
- date: `1512-04-17`;
- mode: `chronicle`;
- turn: `1`;
- status: `active`;
- пять legacy metrics: reputation/legitimacy, materials/economy, guild support/army, people/stability, client agreement/diplomacy;
- три ключевых социальных участника: Джулиано, Риччи, Лука;
- Florence-specific memory with facts + trace;
- prepared choices и freeform action path;
- resolution statuses `executed`, `conditional`, `blocked`/requirement semantics.

### Шесть решений — доказанный structural route

Legacy authored resolver test содержит канонический путь:

`draft -> ledger -> counter -> pigment -> public -> deliver`

Он заканчивается `victory`, имеет ровно шесть trace entries и terminal state.

Кроме одного примера, тест рекурсивно проходит **все 729 prepared routes (3^6)** и для каждого завершённого маршрута проверяет:

- terminal `turn === 7`;
- `florence.trace.length === 6`;
- финальный summary валиден;
- reflection присутствует;
- terminal options пусты;
- на каждом active beat доступны ровно три prepared options;
- successful decision сдвигает turn ровно на один.

Также отдельно доказаны:

- `executed` отказ как завершённое решение;
- `conditional` запрос без выдуманного согласия;
- atomic rejection неизвестного compound action;
- запрет выдумывать факты из negation/arbitrary commands;
- JSON save/restore без повторной оплаты уже выполненного действия;
- legacy save без Florence memory не получает выдуманные facts и не продолжается как будто совместим.

Документированный manual AI playtest source repo используется как сценарий проверки freeform path. Он прямо отделяет protocol/state evidence от литературной оценки живого AI — это ограничение сохраняем.

## 7. Что переносим в B11

Переносим **семантику**, а не Florence-specific код:

- персонажей/социальные роли;
- locations и presentation assets;
- исходные facts/preconditions;
- meaningful actions и consequences;
- ресурсы и их изменения;
- executed / conditional / blocked semantics;
- память о принятых решениях;
- шесть narrative beats;
- финальные состояния/reflection;
- freeform intent path;
- источник scene/presentation cues;
- rollback-compatible session boundary.

Не переносим в Core:

- `if (scenarioId === 'florence-workshop')`;
- `FlorenceMemory` как встроенный тип ядра;
- Florence-specific prompt/validator branches;
- coupling `turn == narrative beat == elapsed time`;
- legacy dependency policy `latest`;
- browser-specific visual aliases как gameplay truth.

## 8. Что уже общее и используется вместо копирования

В `sandboxengine` уже существуют generic contracts/runtime для:

- `core.location`, `core.actor`, `core.resource` blocks;
- conditions/effects/action resolution;
- social actions;
- clock/scheduler/tasks;
- AI intent/narrative boundary;
- asset ingestion/storage;
- persistent sessions/playtest traces;
- immutable quest releases;
- published session binding/release resolution;
- Player presentation execution.

`packages/contracts/fixtures/transfer-desk` — существующая contract fixture «Стол находок». B11 не должен объявлять её вторым real quest только по факту существования fixture: требуемый artifact остаётся `examples/transfer-desk` с полноценной иной целью, предметами и social context.

## 9. Размещение standalone Engine

B00 не выявил необходимости переносить новый Node runtime внутрь Cloudflare Worker. Поэтому сохраняется решение ТЗ:

- standalone Engine остаётся отдельным runtime/service;
- текущий `sandbox` получает тонкий adapter/BFF + route flag;
- flag применяется только при создании **новых** Florence sessions;
- существующая session остаётся pinned к старому runtime;
- rollback = перестать направлять новые sessions в Engine, не переписывая старые saves.

## 10. B00 gate

| Проверка | Статус |
|---|---|
| Exact source commit | PASS |
| Merge/PR provenance | PASS |
| Current-main drift checked | PASS — README/docs only after baseline |
| Exact-head tests | PASS |
| Exact-head build | PASS |
| Exact-head production deploy | PASS |
| Runtime/API mapped | PASS |
| Save/persistence mapped | PASS |
| Florence rules mapped | PASS |
| Six-decision structural routes | PASS — 729 prepared routes |
| Legacy-save incompatibility identified | PASS |
| Technical migration vs design change separated | PASS |
| Standalone Engine placement decision | PASS |

**B00 = GREEN for B11 entry.**

Remaining live-provider literary comparison is intentionally not relabelled as B00 infrastructure proof; it belongs to B11 semantic old/new playtest acceptance.
