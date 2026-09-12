# Вторая волна FIN: шесть веток субагентов — проверка и вливание

Дата: 2026-09-11. Базовая линия до волны: `feat/b13-acceptance-closure` @ `e170221`
(после правки доски «порты + перетаскивание за любую часть карточки»).

## Что проверено самостоятельно (не по отчёту)

Ветки не принимались на слово: у каждой сверены SHA на `origin`, затем в её worktree
выполнены `npx tsc -b` и прогон её собственных тестов под pinned Node 24.19.0.

| Ветка | Коммит | Проверка на HEAD |
|---|---|---|
| `feat/fin05-player-screens` | `f15dc35` | player 17/17, tsc 0 |
| `feat/fin12-collab-gaps` | `4d46e95` | control 8/8 (collab-store), server 5/5 (collab-http) |
| `feat/fin01-legacy-migr` | `3a25ab0` | control 5/5 (файловая БД), server 1/1 + 1 skip |
| `feat/fin10-onboarding` | `593dd6f` | onboarding 16/16, studio 162/0 |
| `feat/fin13-presence` | `38399c4` | server 8/8, studio 7/7 |
| `feat/fin05-site-fit` | `74ea9b0` | сайт: 23 файла / 123 теста, `npm run check` и `build` 0 |

Все пять engine-веток влиты в `feat/b13-acceptance-closure` без конфликтов; после вливания
`tsc -b --force` = 0, server 170/171 (1 skip), control 119/119, studio 178/179 (1 skip),
player 17/17, contracts 57/57.

## Интеграционные правки (то, что субагентам было запрещено)

1. **`apps/server/src/control-server.ts` — presence-модуль подключён к настоящему серверу.**
   Раньше FIN-13 жил только в автономном `createPresenceOnlyHttpServer`. Теперь: ленивый
   сервис на `auth` (WeakMap), диспетчеризация сразу после CORS-preflight и до общего
   роутера, закрытие вместе с сервером.
2. **`apps/server/src/control-server.ts` — CAS ответов по проводу.** `POST …/comments/:threadId/messages`
   принимает `expectedRevision` (ровно `text` или `expectedRevision,text`), значение уходит в
   `addMessage`; устаревшая ревизия → `409 COLLABORATION_REVISION_CONFLICT`, а не молчаливая запись.
3. **`apps/studio/src/api.ts` — `currentCsrfToken()`**: тонкий доступ к токену для модулей,
   которые ходят в Control сами (presence).
4. **`apps/studio/src/app.ts` — presence монтируется вместе с доской** (`mountPresenceIfNeeded`
   из `mountBoardIfNeeded`, `destroyPresence` из `destroyBoard`), viewport берётся из
   `boardLifecycle.getViewport`, точка курсора — из `getBoundingClientRect` хоста доски.
5. **`apps/studio/src/app.ts` — русский баннер ошибки с «Повторить»** (`syncLoadErrorBanner`
   после shell-render, слоты `data-error-slot` для миссии и Player).
6. **`apps/studio/styles.css` — стили `.presence-*` и `position: relative` для `.board-host`**
   (без них слой присутствия не позиционировался бы над доской).

## Доказательства

- `apps/server/test/fin13-presence-wiring.test.mjs` (2/2): presence отвечает через **настоящий**
  control-сервер (401 без сессии, 200 участнику, чужой → 404, POST с CSRF, SSE-поток отдаёт
  первый кадр), а не только через автономный сервер.
- `apps/server/test/fin12-reply-cas-http.test.mjs` (1/1): свежая ревизия → 200, устаревшая → 409,
  `expectedRevision: 0` → 422 с деталью, лишний ключ → 400; число сообщений в треде не растёт
  после отказов.
- `apps/studio/test/fin13-presence-wiring.test.mjs` (4/4): точки интеграции presence и баннера
  ошибок в `app.ts`/`api.ts`/`styles.css` — падают, если проводку убрать.
- Мутации (обе с откатом и повторным зелёным прогоном):
  снятая диспетчеризация presence → 0/2 (оба теста красные); снятый CAS в маршруте ответа → 0/1.

## Осталось (честно)

- **FIN-12 message-level parent** — блокирован схемой SQLite (`control_collaboration_messages`
  без колонки родителя); схему в этой волне меняет только миграционная задача. Точный план
  миграции — в отчёте субагента.
- **FIN-13 вторая половина** (конкурентное редактирование: lock/conflict/reconcile) не вливалась.
- **Сайт `feat/fin05-site-fit`** не влит: это отдельный репозиторий со своим checkout
  `C:/Temp/lhc-site-audit-20260910`, который запрещено переключать; решение о вливании — за владельцем.
- Живой браузерный прогон presence двумя разными аккаунтами не делался (нужны две сессии);
  проверено на HTTP-уровне и на уровне проводки в UI.
- Дефект FIN-01 «пин с `assetsVerified:true` для релиза без доказательств» зафиксирован
  тестом `skip` в ветке миграции; правка лежит в `control-server.ts` и не применялась.
