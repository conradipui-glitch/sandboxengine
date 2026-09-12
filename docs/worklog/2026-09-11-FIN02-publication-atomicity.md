# Worklog — FIN-02 (B03): публикация без частично применённого состояния

Дата: 2026-09-11. Ветка: `feat/b13-acceptance-closure`.
Карточка: FIN-02 в [FIN-CHECKLIST.md](../FIN-CHECKLIST.md); дефект B03 повторного аудита M06.

## Дефект

Публикация применялась в два шага, которые могли разойтись:

1. запись каталога писалась **сразу** (`publicationStore.publish`), то есть становилась видимой;
2. указатель «текущего релиза» двигался вторым шагом с CAS-проверкой.

Если второй шаг отклонялся (устаревший `expectedCurrentReleaseId`, повтор ключа идемпистентности),
каталог уже показывал новую миссию, публикация которой не состоялась, а компенсирующий откат
(`revertPublicationRecord`) был best-effort и публиковал `previous` **как `published`** независимо от
того, был ли он ранее `unlisted`. На открытом вопросе это и воспроизводилось: тест ожидал `unlisted`,
получал `published`.

## Воспроизведение (до фикса)

`apps/server/test/fin02-publication-atomicity.test.mjs` — 1/3:

- «a publish rejected by CAS leaves the unpublished mission out of the catalog» — fail (`published` вместо `unlisted`);
- «a rejected publish keeps the previous release serving its own content» — fail (в каталоге новая ревизия);
- «the same idempotency key with another request is refused» — pass.

## Решение

Публикация и rollback стали **стейджинговыми** (staged): сначала кандидатная запись каталога пишется
как *pending*-операция, видимость меняется только на commit-шаге. Отменять нечего — откат не нужен
в принципе.

- `packages/control/src/publication-store.ts` — тип `ControlPublicationOperation`, методы
  `beginPublicationOperation` / `commitPublicationOperation` / `abortPublicationOperation` /
  `listPendingPublicationOperations` в Memory- и SQLite-реализациях;
  SQLite: таблица `control_publication_operations` (`state IN ('pending','committed','aborted')`,
  `kind IN ('publish','rollback')`), индекс `control_publication_operations_pending_idx(state, started_at_ms)`,
  валидаторы `operationMapKey` / `validOperationShape`.
- `apps/server/src/control-server.ts` — `beginPublicationCandidate` / `commitPublicationCandidate` /
  `abortPublicationCandidate` вместо `syncPublicationRecord`; `revertPublicationRecord` удалён.
  Порядок: stage → `publishControlRelease` / `rollbackControlRelease` (CAS) → commit (или abort).
  Отказ записи каталога (`store_failure`) отдаёт 500 `PUBLICATION_STORE_UNAVAILABLE` и **не двигает**
  указатель; конфликт ключа — 409 `PUBLICATION_CONFLICT`; повтор завершённого запроса — 200
  с `publication.kind = "replay"` и каталогом, который реально живёт.

## Доказательства

- `node --test apps/server/test/fin02-publication-atomicity.test.mjs` — 3/3 pass (до фикса 1/3).
- `npm run test:server` — 141/141 (в т.ч. `m06-immutable-release.test.mjs`, `fin01-release-bundle.test.mjs`).
- `npm run test:control` — 106/106; `test:contracts` — 57/57; `test:studio` — 111 pass / 1 skip / 0 fail.
- `npm run docs:check`, `npm run check:boundaries`, `npm run typecheck` — exit 0.
- Runtime: portable Node `24.19.0` (системный `22.23.2` даёт ложные падения).

## Изменение существующего теста (осознанное)

`apps/server/test/m06-immutable-release.test.mjs`: дублёр `FailingPublicationStore` переопределял
`publish()`, но теперь запись каталога идёт через `beginPublicationOperation` — без правки дублёра
тест перестал бы что-либо проверять. Добавлено переопределение `beginPublicationOperation()`;
утверждения теста не изменялись.

## Честно не сделано

- Recovery после падения процесса с pending-операцией: методы есть (`listPendingPublicationOperations`),
  отдельного маршрута/периодической задачи нет — hosted-сценарий «убили во время публикации» не проверялся.
- Hosted-проверка на стенде требует доставки новой ревизии engine (FIN-04).
