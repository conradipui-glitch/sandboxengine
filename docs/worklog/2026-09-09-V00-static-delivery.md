# V00 — доставка оформления (проверки и исправления)

Дата: 2026-09-09. Ветка: `feat/b13-acceptance-closure`, коммит `d1ba911`.
Авторизация не затрагивалась (гейт v3 тикетов оставлен как есть).

## Доказательства дефекта (VPS, до исправления)

- `GET :8740/styles.css` → Studio CSS, md5 `463d…`, маркер `.studio-shell` ×3.
- `GET :8745/styles.css` → Player CSS, md5 `24cd…`, маркер `.studio-shell` ×0.
- Публичный `GET :8741/styles.css` без сессии → login.html 200; с сессией шёл
  бы в Player по regex `^/(v1/.+|player-meta\.json|player-lib/.+|app\.js|styles\.css)$`
  (`deploy/vps/nginx-lhc.conf:44`). F01 подтверждён: Studio грузила чужой CSS
  без своей layout-сетки — симптом E01.
- Попутно: `apps/player/app.js` импортировал `/player-lib/client.js` (ок) и
  корневой `/presentation-renderer.js`, которого не было в nginx-regex —
  публично этот импорт давал 404 через fallback в Studio.

## Решение (неймспейсы, §2.1.2 ТЗ)

- Studio: каноника `/studio-assets/styles.css`, `/studio-assets/dist/*`
  (`apps/studio/src/dev-server.ts`, `apps/studio/index.html`).
  Корневые `/styles.css`, `/dist/*` больше не обслуживаются (404).
- Player: каноника `/player-assets/{styles,presentation}.css`, `/player-assets/{app,presentation-renderer}.js`
  (`apps/player/src/dev-server.ts`, `index.html`, `app.js`).
  Корневые имена — 404. Игровой scope (`/player-lib`, `/contracts-lib`,
  `/player-meta.json`, `/v1`, `/p/:id`) без изменений.
- nginx: asset-локации (`/studio-assets/`, player-regex с добавленными
  `contracts-lib`/`player-assets`, убранными `app.js`/`styles.css`, `/p/:id/`
  сплит страница/ассеты) — БЕЗ `error_page`-подмены: без сессии честный 401,
  неизвестный ассет — 404 (§2.1.4). Страница входа осталась fallback только
  для навигаций (`/`, `/p/:id/`). Legacy-корни `/styles.css`, `/app.js` — 410.

## Проверки

- `npx tsc -b` — exit 0.
- `test:studio` (static-entry, studio, playtest-bridge): все PASS, включая новые
  негативы (корневые пути → 404, неймспейсы → 200 + MIME + маркеры).
- `test:player` (player-ui): PASS, включая 404 корней и 200 `/player-assets/*`.
- Живая проверка после деплоя: loopback-статусы/MIME/хэши, публичные коды
  (401 ассеты без сессии, 410 legacy, страница входа на `/`) — см. ниже.

## Живая проверка (VPS, после деплоя)

Сборка `vps-studio` + `nginx -t` + reload — OK (промежуточно падал
`proxy_pass` с URI в regex-location — исправлено через `rewrite … break`).

Loopback (новый образ, Player поднят живым запуском `playtest-2` через
`/local/launch-player` с `X-LH-Local-Settings: 1`):
- `:8740/studio-assets/styles.css` → 200 text/css, `.studio-shell` ×3;
  `/styles.css`, `/dist/src/app.js` → 404; `/studio-assets/dist/src/app.js` → 200 JS.
- `:8745/player-assets/{app.js,styles.css,presentation-renderer.js}` → 200;
  корневые `/app.js`, `/styles.css`, `/presentation-renderer.js` → 404;
  `app.js` импортирует `/player-assets/presentation-renderer.js` ✓.
- Авторизованная проверка разовой тестовой сессией владельца (выпущена через
  модуль гейта, после проверки отозвана): публичные `/studio-assets/*`,
  `/player-assets/*` → 200 с верными телами; index ссылается только на
  `studio-assets/*`; без сессии те же ассеты → голый 401; legacy
  `/styles.css`, `/app.js` → 410; `/` и `/p/playtest-2/` без сессии →
  страница входа 200.

ВНИМАНИЕ: при отзыве тестовой сессии удалены все 9 записей sessions в state
гейта (все — тестовые артефакты, живой вход людей ещё не завершён; если кто-то
успел войти — повторный вход одним нажатием в боте).
Ограничение: визуальный скриншот 1440/computed grid в живом браузере не снят —
инструмент браузерной автоматизации висит в этой среде; остаётся за приёмкой
с живым входом (V01).

## Границы V00

- Манифест сборки/hash-имена (§2.1.5) не вводились — точечная разводка путей,
  атомарность релиза остаётся на образе целиком.
- Обработка 401 оболочкой Studio (редирект на вход при протухшей сессии) —
  задача V01 (shell).
- Team-identity (два аккаунта, F08) и один Player на команду (F09) — отдельные
  карточки, здесь не проверялись.
