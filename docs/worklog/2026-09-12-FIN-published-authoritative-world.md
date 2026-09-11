# FIN (правило данных №9): стартовый мир публичной игры берётся из релиза

Дата: 2026-09-12. Ветка `fix/published-initial-world`, база `29a0a66` (HEAD `feat/b13-acceptance-closure`).

## Дефект

`POST /public/v1/missions/<id>/sessions` принимал `initialWorld` ОТ ВЫЗЫВАЮЩЕГО и передавал его как
начальное состояние сессии. Сайт присылает пустой мир, поэтому:

- варианты с эффектом на ресурс отбивались `422 MISSION_TURN_EFFECT_FAILED` (`resource_not_found`),
  миссию нельзя было пройти дальше первого хода;
- с миром из пина релиза те же варианты применялись `200` и финал достигался.

Нарушалось неизменяемое правило данных №9 «Начальное состояние новой публичной игры берётся из релиза,
а не из присланного клиентом `initialWorld`» (`docs/PLAN-FIN-RU.md`).

## Решение (зафиксировано явно)

- Публичная сессия инициализируется **авторитетным миром закреплённого релиза**: запись релиза читается
  из `releases.store` по `publication.releaseId` и мир материализуется функцией
  `materializePublishedRuntimeTemplate` (существующий путь `apps/server/src/published-release-resolver.ts`)
  из `compiledArtifact`-блоков пина.
- Если релиз недоступен или не проходит preflight — `409 PUBLIC_MISSION_RELEASE_UNAVAILABLE`
  (с `detailCode`), новая игра не стартует на недоказанном мире. Никаких «пропускать проверку эффекта»:
  валидация эффектов остаётся жёсткой, меняется только источник стартового мира.
- **Контракт запроса не меняется.** Поле `initialWorld` остаётся обязательным и проверяется как
  plain object (сайт его присылает), но его содержимое **полностью игнорируется** и источником истины
  не является. Это сохраняет уже проверенный сайтом контракт: ответ Engine
  `{mission, session, credential}` и `response.presentation.kind === "published-mission"` на стороне сайта
  не затрагиваются — мир приезжает на сайт внутри `session`, как и раньше.

## Изменённые файлы

- `apps/server/src/control-server.ts` — импорт `materializePublishedRuntimeTemplate`; в
  `routePublicMissionSession` (ветка создания сессии) мир берётся из релиза, `initialWorld` клиента
  игнорируется.
- `apps/server/test/fin-published-authoritative-world.test.mjs` — новый тест (3 кейса).
- `apps/server/test/m06-public-runtime.test.mjs` — обоснованное изменение: тест подставлял рукописную
  запись релиза без `compiledArtifact` (`getRelease: async () => release`), которая после правки перестала
  быть валидной заменой реального релиза. Мок заменён на настоящий `buildControlRelease` +
  `freezeReleaseBundle` + `MemoryControlReleaseStore` (тест усилен, не ослаблен).

## Доказательства

- Красный до фикса: `node --test apps/server/test/fin-published-authoritative-world.test.mjs` — 3/3 fail,
  первый ход `422 MISSION_TURN_EFFECT_FAILED`, мир сессии = присланный пустой мир.
- Зелёный после фикса: те же 3/3 pass.
- Несущая способность: мутация `initialWorld: authoritativeWorld` → `body.initialWorld` с побайтовым
  бэкапом (`cp`) и откатом — все 3 теста краснеют, откат побайтово идентичен.
- Полная регрессия: `LH_NODE_BIN=<node 24.19.0> node scripts/verify-all.mjs` → exit 0,
  15/15 шагов, 0 падений (server 294/294, control 213/214 +1 skip, contracts 78/78, studio 504/505 +1 skip).
- Живая сквозная проверка на реальной публикации Florence (Engine 8931/8952, отдельная копия БД,
  `scripts/seed-real-content.mjs --db <копия> --confirm`): validate → release → freeze → publish,
  затем публичная сессия с пустым миром = мир релиза (7 ресурсов, pigment-jars=2 … deal-open=1),
  канонический маршрут `draft/ledger/counter/pigment/public/deliver` — все 6 ходов **200**
  (ветка с эффектом применяется), финал `fragment-unsealed` достигнут; поддельный мир клиента
  проигнорирован; после **перезапуска процесса** Engine сессия читается 200 с сохранённым финалом
  (turn 6, `terminal={reason:"mission.ending",outcome:"fragment-unsealed"}`, ресурсы изменились эффектами).
  Лог: `C:/Users/kato55/lhc-pw-stand/live-accept.json`.

## Не проверено

- Браузерный проход через сайт (BFF/Cloudflare) не запускался — проверялся публичный HTTP-контур Engine.
- Сайт (репозиторий `sandbox`) не трогался: подтверждено, что форма ответа Engine не изменилась, но
  живой перезапуск сайта не выполнялся.
- Реальный VPS-стенд и доставка не выполнялись (вне зоны).
