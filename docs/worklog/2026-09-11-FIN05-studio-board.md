# FIN-05 — настоящие экраны и ручная композиция (bounded-срез: доска сюжета)

Дата: 2026-09-11. Worktree: `C:/Temp/lhc-fin05-studio`, ветка `feat/fin05-studio-screens`, вход `1886041` (main-линия).
Runtime проверок: portable Node `24.19.0`, npm `11.17.0` (`AppData/Local/Temp/node-v24.19.0-win-x64`).
Правило данных: раскладка доски — `BoardDocument` (view) и не входит в игровой `contentHash`; `MissionDraft` (сюжет) — входит.

## Что сделано (срез)

Доска сюжета Studio (`apps/studio/src/`, Vanilla TS/DOM/SVG, без новых клиентских зависимостей, без React):

- **Сцены и выборы: create / rename / duplicate / delete.**
  - `story-model.ts`: `duplicateStoryScene`, `duplicateStoryEnding`, `duplicateStoryChoice`, `renameStoryChoice` — новые функции над canonical `MissionDraft.story`; вход не мутируется (глубокий клон), запись идёт тем же путём `POST /mission` (CAS по `contentRevision`), нового пути записи не создано.
  - Дублирование сцены генерирует новые ID сцены, диалогов и выборов; выборы со ссылкой на исходную сцену (self-loop) перевязываются на копию, внешние цели сохраняются.
  - Удаление сцены, на которую ссылаются выборы, предваряется честным предупреждением о зависимостях (`storyDeletionImpact`, `describeStoryDeletionBlock`): названы конкретные выборы и их сцены. Само удаление по-прежнему fail-closed (`removeStoryNode`).
- **Стрелки-выборы подписаны текстом решения и переходом.** `StoryEdge` получил `targetTitle` (название сцены/финала-цели); подпись формирует `storyEdgeCaption` → на доске «На пути → Пути». Инспектор тоже показывает «сцена/финал «Название»», а не сырой ID.
- **Undo/redo и клавиатура.** Новый чистый модуль `story-commands.ts`: `StoryHistory<T>` (undo/redo, новая правка очищает redo) и `storyKeyAction` (Ctrl/⌘+Z — отменить, Ctrl/⌘+Shift+Z или +Y — повторить, Delete/Backspace — удалить выбранное, F — «Вписать всё», Esc — снять выделение; модификаторные комбинации строгие). `app.ts` использует `StoryHistory` в реальном пути сохранения; `story-dom.ts` маршрутизирует клавиши через `storyKeyAction`.
- **«Вписать всё» и zoom к курсору.** `fitStoryViewport` и `zoomStoryViewportAt` (мировая точка под курсором неподвижна, масштаб ограничен 0.25…2). Кнопка тулбара переименована в «Вписать всё»; подсказка в баре сюжета перечисляет горячие клавиши и напоминает, что позиция — раскладка, не контент.
- **Стили** для новых строк/форм инспектора (`apps/studio/styles.css`, классы `.story-choice-*`, `.story-node-actions`, `.story-delete-warning`).

## Проверка (фактические результаты)

| Команда | Результат |
|---|---|
| `node --test apps/studio/test/fin05-story-board.test.mjs` **до реализации** | fail: `ERR_MODULE_NOT_FOUND … dist/src/story-commands.js` (ожидаемый RED) |
| `node --test apps/studio/test/fin05-story-board.test.mjs` после реализации | **15/15** |
| `npm run typecheck` | exit 0 |
| `npm run build` (= typecheck) | exit 0 |
| `npm run test:studio` | **126 pass, 0 fail, 1 skip** (было 112 тестов; +15 FIN-05) |
| `npm run check:boundaries` | exit 0 |
| `npm run docs:check` | exit 0 (14 navigation docs, 10 generated contracts актуальны) |

Покрытие `fin05-story-board.test.mjs`:
- подписи стрелок = решение → переход (`storyEdgeCaption`);
- дублирование сцены: новые ID сцены/диалогов/выборов, self-reference перевязан, внешние цели сохранены, вход не изменён; отказ на missing/taken ID;
- дублирование/переименование выбора сохраняет единственную валидную цель;
- `storyDeletionImpact` называет ссылающиеся выборы; вход и ссылки защищены (согласовано с `removeStoryNode`);
- `fitStoryViewport` детерминирован, всё содержимое внутри области, масштаб клампится к минимуму;
- `zoomStoryViewportAt` держит мировую точку под курсором, клампит к min/max, NaN → 1;
- раскладка клавиш (включая отказ Ctrl+Delete);
- `StoryHistory` undo/redo, очистка redo новым действием;
- **layout не меняет игровой `contentHash`**: `missionContentHash` до/после разных `story:`-позиций совпадает, а реальная правка сюжета хэш меняет;
- Studio render (бар сюжета): кнопка «Повторить», дублирование узла/выбора, форма переименования выбора, подсказка с «Вписать всё»/Ctrl+Shift+Z; undo/redo disabled-состояния; предупреждение о зависимостях и защита входа;
- реальный `story-dom.ts` через минимальный DOM-шим: подписи стрелок «решение → переход», кнопка «Вписать всё», zoom колесом меняет transform и увеличивает масштаб, клавиши z/Shift+z/Delete/Esc доходят до колбэков;
- интеграция с настоящим Control + SQLite через loopback-proxy Studio: `saveMission` (duplicate/rename) персистит, `applyBoardChanges` (`story:`-позиции) **не** меняет `contentHash` и `contentRevision` миссии.

## Не проверено / остаётся из FIN-05

- **Браузерный прогон gated Studio не выполнялся.** Есть regression-тест `B05-02 … dev:studio … real Control + Studio entrypoint` (проходит) и DOM-шим-тест реального `story-dom.ts`, но живого входа в Studio с учётными данными не было; gate не ослаблялся, credentials не подбирались. Пиксельный/интерактивный проход доски автору ещё предстоит.
- **Композиция экрана (FIN-05 основная часть) не тронута:** фон; ≥3 PNG-слоя; drag/resize с пропорциями; X/Y; rotate; flip; opacity; z-order; видимость/блокировка; duplicate/delete слоя; наследуемый фон и override; contain/cover и crop/focal point; preset + reduced-motion/пауза; музыка с реальными mute/play. В коде есть базовый редактор слоёв (`screen-model.ts`, числовые поля X/Y/scale/rotation/opacity/z/visible/locked/flipH/flipV) — без drag/resize и без реальной библиотеки материалов.
- **Экраны истории (intro/scene/dialogue/choice/ending) в реальном runtime/BFF** и «перелистывание вступлений не тратит ход» — не в этом срезе.
- **Загрузка через настоящую библиотеку** (hash/MIME/размеры, переживает другой браузер/restart) и экспорт/импорт — не в этом срезе.
- **Приёмка FIN-05** (история 3+ сцены, 2 ветви, 2 финала, intro, диалог, фон и 3 PNG; сохранение; другой браузер; сравнение preview/frozen playtest/сайт) — не достигнута.

Статус по факту: **PARTIAL** — доска сюжета (сцены/выборы, подписи стрелок, undo/redo, клавиатура, «Вписать всё» и zoom к курсору, layout≠contentHash) доведена и покрыта тестами; композиция экранов и browser-приёмка — остаются.
