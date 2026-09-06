# ADR 0017 — Static repeatable onboarding остаётся UI-only boundary

Дата: 2026-09-07  
Статус: accepted в B05-04 после functional gate

## Контекст

B05-01–B05-03 уже дают законченный причинный путь authoring → validation → frozen playtest → Player → Runtime/Core. Последний B05 пробел — T29: новый автор должен понимать этот путь без внешней инструкции, а справка и обучение должны быть доступны повторно.

Главный риск — превратить onboarding во второй источник продуктовой или игровой логики: начать генерировать подсказки моделью, вызывать Control от имени tour, создавать synthetic draft data, вычислять gameplay в браузере или использовать completion flag как capability.

## Решение

### 1. Help и tour — отдельный browser-only модуль

`apps/studio/src/onboarding.ts` подключается рядом с существующим Studio surface и не импортирует:

- Control/API boundary;
- Runtime;
- Player;
- Core;
- provider/LLM client.

Модуль не использует `fetch`. Открытие справки, Next/Back/Skip и replay не могут сами инициировать network mutation.

Это сохраняет существующий `app.ts` и Control authoring path источником истины.

### 2. Содержимое справки versioned и статическое

В репозитории зафиксированы восемь B05 понятий:

1. project/quest;
2. resource;
3. bounded `core.paint`;
4. save/revision/conflict;
5. validation;
6. frozen playtest;
7. local Player launch;
8. Reset как новая session из того же frozen playtest.

B06/B07/B09 возможности не объявляются доступными.

### 3. Tour — deterministic state machine поверх существующего UI

Tour имеет восемь шагов и чистые переходы:

- start;
- Next;
- Back;
- Skip;
- completion;
- replay через Help.

Шаги ссылаются на существующие Studio regions/selectors. Regression закрепляет эти anchors: если соответствующий Studio element исчезает или переименовывается, тест падает.

Если квест, validation или frozen playtest ещё не существуют, tour показывает prerequisite и не создаёт synthetic данные.

### 4. Completion preference не является canonical state

Разрешено хранить только UX preference `completed` / `skipped` под отдельным browser localStorage key.

Preference:

- не записывается в draft;
- не создаёт Control blocks;
- не мутирует Runtime session;
- не даёт permissions/capabilities;
- failure-safe: если localStorage недоступен, Studio остаётся рабочей, а tour может появиться снова.

### 5. Accessibility не требует нового application state

Help имеет dialog title/label, tour — accessible dialog surface. Escape закрывает Help/tour, стандартные кнопки дают keyboard Next/Back, после закрытия focus возвращается на постоянный Help trigger.

Tour highlight и mobile layout существуют только в DOM/CSS слоях и удаляются после закрытия.

### 6. T29 закреплён regression-тестами

`test:studio` теперь проверяет:

- статический vocabulary;
- deterministic Next/Back/Skip/completion/replay;
- optional/failure-safe preference;
- реальные Studio anchors;
- отсутствие `fetch` и запрещённых architectural imports;
- static Studio entry с onboarding bundle.

Отдельный canonical B05 audit связывает fresh Studio authoring с frozen P1/P2 и настоящим Runtime/Core outcome и одновременно проверяет, что onboarding bundle остаётся статическим/no-fetch.

## Каноническое доказательство B05

Один интеграционный audit проходит:

- fresh Studio/Control;
- project + quest/location;
- resource initial=2;
- `core.paint` cost=1;
- validation + frozen P1;
- P1 request2 → `executed`, completed=2, 600s;
- idempotent retry не запускает Core второй раз;
- reset/new session P1 сохраняет cost=1;
- draft edit cost=2;
- old P1 остаётся cost=1;
- validation + frozen P2;
- P2 request2 → `partial`, completed=1, 300s;
- P1/P2 имеют разные content hashes;
- Help/onboarding bundle доступен и не содержит network call.

## Последствия

Плюсы:

- T29 не расширяет trusted gameplay/authoring boundary;
- onboarding повторяем и дешёв по определению: нет AI/token usage;
- Help доступна независимо от наличия проекта/квеста;
- старые B05 Studio/Player paths не переписываются ради tour;
- будущая смена UI anchors обнаруживается тестом.

Цена:

- первый tour намеренно простой и не является B07 visual-polish системой;
- highlight использует текущие DOM regions, поэтому intentional UI refactor требует синхронного обновления registry/test;
- preference локальна конкретному browser profile и не синхронизируется между устройствами, что соответствует её UX-only роли.

## Не решено этим ADR

LLM/free text/provider routing — B06; PresentationPlan/assets/animations — B07; plugins — B08; auth/public publish — B09; AI author helper — B10; Florence migration — B11.
