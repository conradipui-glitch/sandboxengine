# 2026-09-10 — Studio V00–V02 correction K00–K08

Статус: **IN_PROGRESS**

## K00 — входная сверка

- Репозиторий: `conradipui-glitch/sandboxengine` / локальная копия `C:/Users/kato55/Documents/Codex/2026-09-09-live-author-studio`.
- Ветка: `feat/b13-acceptance-closure`.
- Входной SHA: `bc8313d31bca1fb0526e4b18a31d3ddd5bdbf7d9`.
- Рабочее дерево на входе: clean.
- Совместимый runtime: `npx --yes node@24.19.0` → `v24.19.0`; `npx --yes -p npm@11.9.0 npm --version` → `11.9.0`. Требование `package.json` `>=24.19.0 <25` не изменялось.
- Локальные `STUDIO-V00-V02-REVIEW-RU.md` и `STUDIO-VISUAL-EDITOR-SPEC-RU.md` в checkout не найдены. Каноническим основанием этой карточки является переданное пользователем ТЗ; `docs/SPECIFICATION.md` прочитан по разделам, относящимся к авторскому циклу, API, проверкам и ограничениям.
- Существующие проекты Florence и «Приёмка VPS» не используются для демонстрационных изменений.
- Авторизация `@living_history_gate_bot` не меняется.
- V00 namespaces `/studio-assets/*` и `/player-assets/*` сохраняются.

## K01 — единый renderer и lifecycle — DONE

- Активный renderer: `apps/studio/src/board-dom.ts` через `mountBoard`.
- `apps/studio/src/board-render.ts` удалён после проверки импортов и полного Studio suite.
- `apps/studio/src/board-lifecycle.ts` держит один handle на project/quest и предоставляет update, selection, viewport get/set, fit, destroy.
- `app.ts` сохраняет host/handle между shell renders: вкладка inspector, save/validation и status не перемонтируют canvas и не вызывают fit.
- На выходе из проекта/квеста/logout вызывается destroy; root listeners также снимаются публичным `StudioApp.destroy()`.
- Callback wrappers получают generation token; async draft save проверяет project/quest context после ответа и не применяет stale result к новому квесту.

Проверено:
- K01 RED: `node@24.19.0 --test apps/studio/test/board-lifecycle.test.mjs` → отсутствовал `dist/src/board-lifecycle.js`.
- K01 GREEN: тот же suite → **2/2 passed**.
- `npm run typecheck` через Node 24.19.0 → exit 0.
- `node@24.19.0 --test apps/studio/test/*.test.mjs` → **78/78 passed**.

Ограничение, перенесённое в K02/K04: layout пока localStorage, а inspector и серверный BoardDocument ещё не реализованы.


| R | Проверка на входе | Статус | Фактическое основание |
|---|---|---|---|
| R01 | Один renderer и lifecycle mount/update/selection/viewport/destroy | **DONE локально** | `app.ts` uses `mountBoard`/`BoardLifecycle`; `board-render.ts` removed after import/test check; browser lifecycle evidence remains in C09. |
| R02 | Доска — главный экран, рабочие размеры и рабочие кнопки | **DONE локально + BROWSER/LOCAL** | K02 viewport shell, board-main workspace, utility menu and one board/list toggle are implemented; local browser smoke confirms board remains mounted while utility panels open. |
| R03 | Настоящий inspector выбранного canonical block | **DONE локально + BROWSER/LOCAL** | `block-inspector.ts` + app inspector, полный `block.replace`, debounce и conflict preservation проверены browser smoke. |
| R04 | Создание и редактирование четырёх типов блока | **DONE локально + BROWSER/LOCAL** | Library/modal создали location, character, resource и action; type-specific canonical fields подтверждены GET draft. |
| R05 | Связи, drag/zoom/fit, collision-aware layout | **OPEN** | Интерактивное подключение есть только в неиспользуемом `board-dom.ts`; подключённый `board-render.ts` не вызывает `onConnect`; fallback `floor(index/3)` может накладывать узлы одного типа. |
| R06 | Серверный versioned BoardDocument, CAS/idempotency/restart/other browser | **OPEN** | `board-storage.ts` прямо признаёт localStorage по одному `questId`; endpoint `/board` и Control persistence не найдены. |
| R07 | Read-only/role behavior and V00/Player regression evidence | **PARTIAL** | Access gates и existing Player tests есть, но browser proof of read-only board and independent playtests for this candidate отсутствует. |
| R08 | Regression suite C01–C18 and real connected renderer | **OPEN** | Existing `board-model.test.mjs` covers projection only; no suite reaches the renderer lifecycle, browser interactions, or C01–C18 matrix. |
| R09 | Hosted identity and server-side global provider/project permissions | **OPEN** | Current task explicitly requires this correction; UI access state cannot be treated as security. Need trace gate→nginx→Studio→Control and add server tests for forged identity/revoke/global provider mutation. |

## Evidence at K00

- `node --version` from default shell: `v22.23.2` (incompatible; not used for acceptance).
- `npx --yes node@24.19.0 --version`: exit 0, `v24.19.0`.
- `npx --yes -p node@24.19.0 -p npm@11.9.0 -c "node --version && npm --version"`: exit 0, `v24.19.0`, `11.9.0`.
- `git branch --show-current`: exit 0, `feat/b13-acceptance-closure`.
- `git rev-parse HEAD`: exit 0, `bc8313d31bca1fb0526e4b18a31d3ddd5bdbf7d9`.
- `git status --short`: exit 0, empty.
- Review files named in the task: not present locally; no claim of having read them.

## Следующая точная операция

K01: добавить failing lifecycle regression against the actually mounted board, switch `app.ts` to one `mountBoard` handle with generation/project guards, then verify focused board tests before K02.

## C01–C18 preliminary status

Все C01–C18: **OPEN** на входе; existing model tests are not counted as acceptance evidence.

## K02 — доска как главный экран — DONE

- `.ed-shell` занимает viewport; библиотека `240px`, inspector `336px`, центральная область и внутренние панели прокручиваются отдельно.
- Validation перенесена внутрь центральной области; `ed-bottom` и основной поток versions/portability убраны.
- Меню `…` открывает «История версий», «Импорт и экспорт», «Настройки проекта и доступа».
- Inspector по умолчанию — «Свойства карточки» с подсказкой «Выберите карточку на доске»; доступ и ID перенесены в настройки.
- Вкладка помощника подписана «ИИ-помощник»; видимый переключатель один: «Доска / Список».
- Добавлена единая primary/secondary button system и responsive CSS с доступным inspector на 360px.
- STATIC: Node 24.19.0 `npm run typecheck` exit 0; Studio suite `78/78`.
- BROWSER/LOCAL: отдельная SQLite и чистый Chrome с CDP; через реальный DOM click создан throwaway project/quest. После открытия квеста `data-board-host=true`; меню, History и Portability открылись, доска оставалась в DOM.

### R status after K02

- R01 **DONE локально** (K01; browser lifecycle C09 ещё открыт).
- R02 **DONE локально + BROWSER/LOCAL**, VPS для candidate ещё не обновлён.
- R03/R04/R05/R06/R08/R09 **OPEN**; R07 **PARTIAL**.

## K03 — canonical inspector и четыре типа — DONE локально + BROWSER/LOCAL

- Добавлен `apps/studio/src/block-inspector.ts`: `createBlockForKind` строит только canonical `location/character/resource/action`, `replaceBlockWithPatch` выпускает полный `block.replace`; исходные `description` и неизменённые `data`-поля сохраняются, `block.update` не используется.
- Библиотека редактора получила создание всех четырёх типов. Для action форма требует существующий resource и не создаёт dangling reference; character поддерживает `initialLocationId`/`initialStatus`, resource — unit/range/value, action — resource/cost/duration/allowPartial.
- Inspector выбранного узла редактирует canonical title/description и type-specific data; ввод хранится локально до ответа сервера, debounce — 700 ms, есть явное «Сохранить карточку», read-only поля отключаются по access state.
- Добавлен lifecycle focus после создания и отдельное сохранение inspector без перемонтирования доски.

Проверено:
- RED: `node@24.19.0 --test apps/studio/test/block-inspector.test.mjs` → отсутствовал `dist/src/block-inspector.js`.
- GREEN: тот же тест после сборки → **3/3 passed**.
- `npm run typecheck` через Node 24.19.0 → exit 0; Studio suite после K03 → **81/81 passed**.
- BROWSER/LOCAL на `http://127.0.0.1:4184` с отдельной SQLite: реальный Chromium/CDP создал location, character, resource и action; после открытия квеста все пять узлов (включая start) видны на доске.
- BROWSER/LOCAL inspector изменил title/description resource/action; Control GET подтвердил server draft revision `5` и canonical data.
- BROWSER/LOCAL conflict: внешний `block.replace` поднял revision `5→6`; локальный inspector получил «Ничего не перезаписано», локальное имя осталось в поле, GET подтвердил серверную внешнюю description без overwrite.
- BROWSER/LOCAL переключение «Свойства → ИИ-помощник → Свойства» не потеряло сохранённое содержимое и доску.

Ограничения: это доказательство локального браузера и Control persistence; серверный BoardDocument/restart/другой браузер ещё относятся к K05, live VPS candidate не обновлялся.

### R status after K03

- R01 **DONE локально** (K01; browser lifecycle C09 ещё открыт).
- R02 **DONE локально + BROWSER/LOCAL**, VPS для candidate ещё не обновлён.
- R03 **DONE локально + BROWSER/LOCAL** (canonical inspector + full replace + conflict preservation).
- R04 **DONE локально + BROWSER/LOCAL** (4 block kinds and type-specific fields).
- R05/R06/R08/R09 **OPEN**; R07 **PARTIAL**.

Следующая точная операция: K04 — допустимые связи, ports, drag/zoom/fit и collision-aware layout.
