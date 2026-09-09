# 2026-09-09 — B13.b1 authorized change set with CI reconciliation

Branch: `feat/live-author-studio`

## Реализовано

- `apps/builder-runner/src/changeset-operations.ts`:
  - `BoundedChangeSetApplier` — принимает immutable policy, exact remote URL и CI-source;
    конструктор отвергает remote, не совпадающий с policy repository (локальные bare-фикстуры
    разрешены для тестов и фиксируются как test-only);
  - `applyAndPush({operationId, grant, operations})` — bounded operationId (8..128, `[A-Za-z0-9._:-]`),
    grant обязан совпасть с policy (repository + base branch), identity и commit subject валидированы
    (без CRLF, ≤200 chars); запись через policy-bounded `writeText`, `treeIdentity()` до коммита;
    коммит и push только в `HEAD:refs/heads/<grant.targetBranch>`, fixed argv, чистое environment,
    timeout 30 s; пустой change set (нет эффективных изменений) отклоняется `invalid_change_set`;
  - `reconcileWithCi(branch, commitSha)` — требует CI-ран с headSha === commitSha; иначе
    `ci_reconciliation_failed`; CI-source — интерфейс `CiStatusSource`, реализуемый окружением
    (например gh CLI), сам по себе не содержит credentials;
  - исходный checkout не затрагивается; push идёт из disposable isolated clone.

## Проверки

- `npm run test:builder` — exit 0, 16/16 (+3 теста b1);
- e2e-фикстура: bounded change set → push в bare-remote → `rev-parse main` remote === receipt.commitSha,
  при этом HEAD источника не изменился;
- отказы: короткий operationId, branch вне grant, repository вне grant — fail closed;
- CI-сверка: без рана на нужном SHA → отказ; ран с совпадающим SHA → success-квитанция.

## Ограничения

- Push реализован через локальный git с environment без credentials; фактическая аутентификация
  remote остаётся ответственностью среды исполнения (в CI — runner token; локально — SSH-агент).
  Модуль не получает и не хранит токены.
- CI-source пока не подключён к реальному GitHub API — в карточке b1 это допустимо (сверка
  доказана на интерфейсе); живое подключение через `gh` выполняется при b1-приёмке на реальном
  репозитории.
