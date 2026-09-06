# ADR 0015 — Studio как клиент authoritative Control API

Дата: 2026-09-06  
Статус: accepted в B05-02

## Контекст

B05-01 опубликовал durable authoring draft, validation и frozen playtest через loopback Control API. B05-02 должен дать первый человеческий интерфейс автора, не создавая вторую authoring truth в браузере и не обходя optimistic concurrency.

## Решение

### 1. Studio не является хранилищем

`apps/studio` читает и изменяет квест только через Control API. UI не пишет SQLite, файлы квестов или самостоятельный JSON snapshot. После успешного save локальное представление заменяется server snapshot.

### 2. Save всегда optimistic

Каждый `DraftChangeSet` отправляет текущий `draftRevision` как `baseRevision`. `409 DRAFT_REVISION_CONFLICT` не повторяется автоматически: Studio загружает свежий draft, показывает конфликт и предлагает явный retry локального намерения на новой revision либо cancel.

Silent last-write-wins запрещён.

### 3. Первый form vocabulary bounded

Studio показывает только реально зарегистрированные возможности текущего B05:

- project/quest;
- стартовая `core.location`;
- `core.resource`;
- bounded `core.action` с `actionType=core.paint`.

Пользователь редактирует человеческие поля формы, а typed builders собирают корректные blocks/change sets. Raw JSON editor не является основным путём.

### 4. Validation принадлежит revision/hash

Studio показывает `draftRevision`, content hash, status и errors. Если draft изменился после validation, старый report визуально помечается как относящийся к предыдущей revision.

### 5. Loopback same-origin development surface

Control listener остаётся loopback-only согласно ADR 0014. Для браузера B05-02 добавляет небольшой Studio dev server, который:

- сам слушает только loopback;
- проксирует `/control/*` только к loopback Control origin;
- раздаёт статические Studio assets.

Это устраняет CORS-разрыв, не превращая Control API в сетевой public endpoint до B09 auth.

### 6. Dependency budget

В репозитории до B05-02 не было frontend framework/browser-test dependencies. Для bounded формы выбран нативный TypeScript + DOM без React/Vite/Playwright dependency change.

Acceptance проверяется реальным integration path: file-backed SQLiteControlStore → Control HTTP → Studio same-origin proxy → typed Studio API client, плюс smoke фактического compiled browser entry. Полноценная browser screenshot/fidelity automation этим ADR не заявляется; если она станет необходима, это отдельный tooling change, а не скрытая зависимость B05-02.

## Последствия

Плюсы:

- одна server-side authoring truth;
- reload восстанавливает state через Control API;
- stale editor не теряет чужие изменения;
- Control остаётся физически локальным до auth;
- Studio не вводит новый frontend dependency stack раньше необходимости;
- B05-03 может использовать уже созданные Studio drafts/frozen playtests без изменения authoring semantics.

Цена:

- UI намеренно минимален и не является финальной дизайн-системой;
- нет node graph, asset timeline или AI helper;
- browser visual QA пока ручная/следующий tooling slice при необходимости.

## Проверки решения

- Studio static surface и compiled browser entry реально раздаются;
- project → quest → resource → paint cost=1 → validation → cost=2 проходит через real SQLite + Control HTTP + Studio proxy;
- новый API client после reload видит cost=2 с сервера;
- external update вызывает 409, stale change не появляется в server draft;
- retry — отдельный explicit request на свежей revision;
- non-loopback Control origin для Studio proxy отклоняется;
- root `npm run verify` включает `test:studio`.

## Не решено этим ADR

Player/frozen playtest gameplay E2E — B05-03; onboarding — B05-04; LLM, presentation/assets, plugins, auth/publish и Florence — последующие блоки.
