# Worklog 2026-09-12 — «Проверить и сыграть» для сюжетной миссии (Studio)

Ветка `fix/studio-play-story`, worktree `C:/Users/kato55/lhc-play-story` (от `a554f48`).
Репозиторий-база не тронут: своя ветка, свой worktree, своя база, свои порты.

## Дефект (воспроизведён)

Кнопка Studio «Проверить и сыграть» (`play-quest`) делает `validations` → `playtests` → `POST /local/launch-player`. Последний строит **блочный** bootstrap frozen playtest, который требует хотя бы один `core.action`:

```
packages/player/src/bootstrap.ts: actionBlocks.length < 1 → failure("unsupported_playtest")
```

Миссия Florence (`scripts/seed-real-content.mjs`) — сюжетная: документ миссии со сценами/выборами/финалами, доска — 3 локации, 4 персонажа, 7 ресурсов, **ноль** блоков-действия. Поэтому запуск отвечал `409 unsupported_playtest`, и автор не мог проверить то, что написал. Стенд (`/local/launch-player`) отвечал тем же кодом.

Дополнительно (тот же путь): у доски и документа миссии независимые счётчики ревизий. На копии базы стенда Florence: доска `draftRevision = 0`, документ миссии `contentRevision = 1`, `getMissionAtRevision(..., 0) = null`. Старый поиск сюжета по `playtest.draftRevision` не мог найти документ даже после снятия блочного запрета.

Ещё один дефект, найденный уже в браузере: `RuntimePlayerClient` брал ссылку на `fetch` и вызывал её как метод → в браузере `Illegal invocation` на первом же запросе (в Node-тестах не виден). Любой Player в браузере падал на старте.

## Решение

Решение зафиксировано в [ADR 0032](../decisions/0032-story-playtest-play-path.md). Кратко:

- `startPlayer` пробует блочный bootstrap; если он отвечает `unsupported_playtest` (в снимке нет действия), запуск ищет к той же работе играбельный сюжетный документ (`isPlayableStoryMission`). Есть — **сюжетный запуск**; нет — прежний `unsupported_playtest`. Больше одного действия — прежний отказ.
- Сюжет пинится к **той же авторской ревизии, что замораживает выпуск** (`resolveAuthoredMissionRevision`: новейшая авторская ревизия, до первой правки — текущий документ) с проверкой хэша; читается один раз при запуске и удерживается Player'ом в памяти (правка черновика запущенную игру не подменяет). Сессия ходов прибита к той же ревизии существующим `createPlayerTurnService`.
- Мир — из замороженного снимка **той же** функцией, что и блочный bootstrap (`buildFrozenWorldState`, вынесена из `bootstrap.ts`). Блочный ход по сюжетной миссии честно `blocked` (`ACTION_NOT_CONFIGURED`, мир не меняется), а не исполняется по чужому определению.
- `player-meta.json` сохраняет прежние 10 ключей; `resource*`/`action*` (поля блочного шелла) у сюжетной миссии пусты — выдумывать ресурс нельзя. Обязательные поля проверяются как раньше.
- `RuntimePlayerClient` по умолчанию берёт обёртку над `fetch`.

## Файлы

| Файл | Что сделано |
|---|---|
| `packages/player/src/frozen-playtest.ts` (новый) | `buildFrozenWorldState`, `isPlayableStoryMission`, общие стражи (`isRuntimeId`, `isHash`, `deepFreeze`, `isRecord`) |
| `packages/player/src/bootstrap.ts` | мир строится общей функцией; контракт B05 (`unsupported_playtest` при нуле действий) сохранён |
| `packages/player/src/index.ts` | экспорт новых функций |
| `packages/player/src/client.ts` | default `fetch` — обёртка (браузерный `Illegal invocation`) |
| `apps/player/src/dev-server.ts` | `validateStory` делегирует общему предикату; `validateMetadata` допускает пустые paint-поля |
| `apps/player/src/launch.ts` | ветка сюжетного запуска (`startStoryPlayer`, `resolveStoryMission`), общий `finishLaunch`, `startPaintPlayer` без изменения поведения |
| `apps/studio/src/app.ts` | честное сообщение об отказе `unsupported_playtest` (только эта строка запуска) |
| `scripts/test/studio-play-story.test.mjs` (новый) | носитель: живой HTTP, RED → GREEN |
| `scripts/play-story-acceptance.local.mjs` (новый) | браузерная приёмка продуктовой композиции (CDP) |
| `scripts/play-story-mutations.local.mjs` (новый) | побайтовые мутации с `cp`-бэкапом и откатом |
| `docs/decisions/0032-story-playtest-play-path.md` (новый) | ADR |
| `artifacts/play-story/**` | скриншоты и receipts |

## Команды и фактический результат

Все команды — в worktree, Node `C:/Users/kato55/AppData/Local/Temp/node-v24.19.0-win-x64/node.exe`.

1. **RED** (до правки), `node --test scripts/test/studio-play-story.test.mjs` → exit 1:
   `409 !== 200`, `{"error":{"code":"unsupported_playtest","message":"Frozen playtest cannot start Player: unsupported_playtest"}}` на реальной миссии Florence (копия базы стенда, `seed-real-content.mjs --confirm`).
2. **GREEN** после правки, там же → exit 0, 2/2. Проверено и на копии стенда (доска r0 / документ r1), и на свежей фикстуре (`LH_STAND_DB_PATH=<нет такого файла>` → 2/2): сцена, 6 сцен, ≥2 финала, `story.mission.contentHash === authored.contentHash`, `blocked` блочный ход без изменения мира, ходы 1→2 со сменой сцены, replay по ключу, `422 TURN_CHOICE_NOT_IN_SCENE` на недоступный выбор, финал, неизменность запущенной ревизии после правки черновика. Второй тест: playtest без сюжета и без действия остаётся `409 unsupported_playtest`.
3. **Несущая способность** (`scripts/play-story-mutations.local.mjs`, `cp`-бэкап → правка → `tsc -b --force` → тест → `cp` обратно → `tsc -b --force` → тест) → exit 0:
   - M1 «сюжетная ветка отключена»: build 0, тест **1** (красный), возврат: build 0, тест 0, файл восстановлен байт-в-байт;
   - M2 «сюжетный Player без маршрута хода»: build 0, тест **1** (красный), возврат: build 0, тест 0, файл восстановлен байт-в-байт.
   Receipt: `artifacts/play-story/receipts/play-story-mutations.json`, бэкапы — `artifacts/play-story/mutation-backups/`.
4. **Браузерная приёмка** (`scripts/play-story-acceptance.local.mjs`, продуктовая композиция `apps/studio/dist/src/main.js`, Control 8925, Studio 4215, Player 8956, Chrome CDP 9391) → exit 0, 14/14 шагов, предупреждений нет, ошибок в консоли нет:
   - «Проверить и сыграть» нажимается, игрок получает `PLAYER ЗАПУШЕН: HTTP://127.0.0.1:8956`, сообщения об отказе нет;
   - Player: первая сцена «Срок и условие заказчика» и авторские варианты `draft/healer/close`; ходы 1…6 меняют сцену (заголовки сверяются с `narrative-beats.json`); финал «Фрагмент без печати».
   Скриншоты: `artifacts/play-story/01-studio-light-before-play.png`, `02-studio-dark-before-play.png`, `03-studio-launched-player-link.png`, `04-player-first-scene.png`, `05-player-after-choice.png`, `06-player-ending.png`, `07-studio-dark-after-play.png`, `08-studio-light-after-play.png`. Receipt — `artifacts/play-story/receipts/play-story-acceptance.json`.
5. **Полный набор** `LH_NODE_BIN=<node> <node> scripts/verify-all.mjs` (без конвейеров, честный exit) → exit 0: 15/15 шагов, тестовых падений 0 (`apps/studio` 517 тестов 516 pass / 1 skip, `apps/server` 294, `packages/control` 214, `scripts` 49 и т. д.).

## Что осталось непроверенным

- Доставка решения на стенд и на сайт не выполнялась: живая проверка — локальная (копия базы стенда + `seed-real-content.mjs`, плюс свежая фикстура).
- Сюжетный запуск — авторская проверка, а не публикация: пин авторской ревизии в записи playtest не сохраняется (запись playtest хранит ревизию доски), поэтому гарантия «frozen» держится на времени жизни запущенного Player'а. Изменение схемы playtest в зону этой задачи не входило.
- Блочный путь со сюжетом одновременно (одно действие + документ миссии) не менялся и отдельно не проверялся.
- Мобильная/узкая вёрстка Player и скриншоты под нагрузкой (таймаут `Page.captureScreenshot`) — вне этой задачи; в приёмке кадры снимаются с `prefers-reduced-motion: reduce`.
