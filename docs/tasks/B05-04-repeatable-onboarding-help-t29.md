# B05-04 — Repeatable onboarding + persistent help / T29

## Цель

Закрыть последний canonical B05 slice: новый автор должен понимать первый Studio→frozen playtest→Player путь без внешней инструкции, а onboarding можно повторить в любой момент **без AI/LLM вызовов и без изменения authoring/game state**.

После B05-04 провести общий canonical audit B05 по полному first-author path.

## Канонический вход

- B05-01 published: authoritative draft, validation, frozen playtest;
- B05-02 published: human Studio forms;
- B05-03 published после merge: frozen Player bootstrap, causal cost 1→2 E2E, real Player surface;
- `docs/SPECIFICATION.md` B05 / T29: постоянная справка и повторяемый onboarding;
- ADR 0014–0016.

## Главный invariant

**Onboarding объясняет существующий рабочий путь, но не становится ещё одним источником логики.**

Tour/help:

- не создаёт и не изменяет quest blocks сам;
- не подменяет Control validation;
- не вычисляет gameplay;
- не вызывает AI;
- restart/replay tour не расходует AI/token budget;
- завершение/пропуск onboarding не меняет canonical author/game state.

## Сделать

### 1. Persistent Help entrypoint

Добавить в Studio постоянно доступный элемент «Справка» / `?`, который доступен:

- до создания проекта;
- внутри project/quest workspace;
- после завершения onboarding.

Справка должна кратко объяснять текущий B05 vocabulary:

1. project/quest;
2. resource;
3. `core.paint` action;
4. save/revision/conflict;
5. validation;
6. frozen playtest;
7. запуск локального Player;
8. Reset означает новую session из того же frozen playtest.

Не документировать ещё не реализованные B06/B07/B09 возможности как доступные.

### 2. Repeatable guided tour

Добавить лёгкий deterministic Studio tour по уже существующим UI anchors.

Достаточно 5–8 шагов, например:

1. Projects/quests navigation;
2. resource form;
3. action form/cost;
4. revision/save status;
5. validation;
6. frozen playtest;
7. Player launch command;
8. Help/restart tour.

Tour должен:

- подсвечивать конкретный существующий element/region;
- иметь Next/Back/Skip;
- корректно переживать отсутствие выбранного quest: такой шаг либо объясняет prerequisite, либо предлагает перейти к следующему доступному шагу без synthetic data;
- завершаться явно;
- иметь кнопку **«Повторить обучение»** из Help.

### 3. UI-only completion state

Допустимо хранить только UX preference `onboarding completed/skipped` локально в браузере (например, localStorage), потому что это не authoring truth.

Запрещено:

- записывать completion в quest draft;
- создавать скрытые Control blocks;
- мутировать Runtime session;
- считать локальный flag основанием для capabilities/permissions.

Если localStorage недоступен, Studio должна оставаться полностью функциональной; tour можно показать снова.

### 4. No-AI / T29 proof

Добавить regression, который доказывает repeatability без AI:

- start tour;
- пройти/закрыть;
- restart tour;
- пройти назад/вперёд/skip;
- ни одного network request кроме уже допустимых Control calls, которые пользователь сам вызывает для authoring;
- сам tour/help не вызывает Control mutation endpoint и не вызывает Runtime/AI endpoint.

Если в кодовой базе ещё нет provider/LLM client, тест должен дополнительно закрепить, что onboarding module не импортирует будущие provider/AI boundaries и не использует `fetch` для tour content.

### 5. Help content is static/versioned

Help/tour content хранится в репозитории как versioned static data/code, а не генерируется моделью при открытии.

Текст должен соответствовать реально реализованному B05 UI. При изменении anchor id или шага test должен падать, а не silently пропускать весь tour.

### 6. Accessibility / interaction

Минимум:

- modal/popover имеет accessible label/title;
- keyboard Escape закрывает Help/tour, если это не разрушает текущую authoring operation;
- focus возвращается на trigger;
- Next/Back доступны клавиатурой;
- overlay не блокирует сохранение после закрытия;
- mobile viewport не делает controls недоступными.

Не нужен финальный visual polish B07.

### 7. Tests

Добавить `test:onboarding` либо включить в `test:studio`.

Минимум:

- help entrypoint присутствует на пустом Studio и в quest workspace;
- tour step registry ссылается на реальные stable anchors;
- Next/Back/Skip state machine deterministic;
- completion preference optional/failure-safe;
- replay после completion работает;
- no AI/network call from help/tour engine;
- no Control mutation вызвана самим tour;
- existing B05 Studio/Player regressions остаются green.

### 8. Общий B05 canonical audit

После functional B05-04 gate выполнить один интеграционный audit полного пути:

1. fresh Studio process;
2. project;
3. quest/location;
4. resource initial=2;
5. paint cost=1;
6. validation;
7. frozen P1;
8. Player P1 request2 → executed2/600;
9. return/edit cost=2;
10. validation + frozen P2;
11. old P1/reset остаются cost=1;
12. P2 request2 → partial1/300;
13. Help доступна;
14. onboarding можно повторить;
15. никакого AI call для tour.

Это audit, а не новый gameplay feature.

## Приёмка B05-04 / B05 overall

- пользователь может открыть Help в любой момент;
- onboarding можно повторить после completion/skip;
- tour deterministic и versioned;
- onboarding/help не вызывает AI и не мутирует canonical state;
- T29 regression green;
- полный B05 author→Player causal path green;
- root `npm run verify` green;
- ADR/STATUS/HANDOFF/worklog синхронизированы;
- после merge и green main CI общий B05 можно объявить published.

## Не делать

- LLM/free text/provider routing — B06;
- PresentationPlan/assets/animations — B07;
- animation suggestion assistant;
- plugins — B08;
- login/roles/public publish — B09;
- AI author helper — B10;
- Florence migration — B11;
- analytics product dashboard;
- full design-system rewrite;
- browser automation dependency только ради tour, если существующий deterministic DOM/state testing закрывает acceptance.

## Следующий блок после B05

B06 — free-text/LLM intent + narration согласно canonical roadmap. Перед началом создать новый bounded task-card от verified B05 merge, не смешивать B06 с B05-04 PR.
