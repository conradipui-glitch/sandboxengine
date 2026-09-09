# B13 — подключаемый Builder и deployment

Статус: **B13.0–B13.a1 GREEN; B13.a2 NEXT**
Вход: опубликованный B12 (`6f2ad73fca228c60361012250b72609447edc968` в истории текущей ветки), §25 и T33–35 спецификации.

## Граница блока

Builder работает отдельным процессом от Core/Runtime. Изолированная Git-папка сама по себе не считается sandbox. Права чтения, записи, проверок, внешних repo-операций и deployment выдаются раздельно; содержимое README, Skill, MCP-ответа или model output не расширяет task policy.

До отдельной приёмки соответствующей карточки запрещены: произвольный shell, доступ к игровой SQLite/секретам/Docker socket/host root, push, создание PR, запуск workflow, preview и production deployment.

## Последовательные карточки

| ID | Результат | Статус |
|---|---|---|
| B13.0 | Точный repository snapshot, канонические read/write paths и argv проверок; fail-closed policy без файлового исполнения | GREEN (2026-09-09) |
| B13.a1 | Отдельный workspace adapter: чтение exact base SHA, realpath/symlink boundary, отсутствие записи в исходный checkout | GREEN (2026-09-09) |
| B13.a2 | Bounded agent job, patch только в разрешённые пути, diff и проверки на точном tree hash | GREEN (2026-09-09) |
| B13.b1 | Разрешённый commit/push/change set, внешний operation ID и сверка CI с нужным SHA | NEXT |
| B13.b2 | Один preview deployment adapter с artifact identity и smoke | NOT STARTED |
| B13.c1 | Production policy, reconciliation потерянного ответа и проверенный rollback | NOT STARTED |

## B13.0 — policy baseline

**Сделать:** добавить `apps/builder-runner` в TypeScript graph; определить immutable policy с exact `owner/repository`, абсолютным корнем, base branch/SHA, каноническими portable read/write prefixes и проверками как `executable + argv`; возвращать только разрешённый относительный путь. Write scope обязан быть подмножеством read scope.

**Проверить:** traversal, абсолютные пути, backslash-варианты, `.git`, prefix collision, write escalation, malformed repo/SHA и shell-like executable fail closed. `test:builder` входит в общий `verify`.

**Не входит:** создание/чтение файлов, разрешение symlink, запуск команд, Git credentials и любые внешние изменения. Реальный executor обязан повторно проверить filesystem boundary через realpath и использовать sandbox; policy-функция не объявляется security boundary.

**Доказательство:** [worklog B13.0](../worklog/2026-09-09-B13-00-builder-policy.md).

## B13.a1 — read-only workspace adapter

Реализован disposable local clone на exact base SHA. Git вызывается только фиксированными argv без shell, с очищенным HOME/config и без интерактивных запросов; repository-defined commands, hooks, tests, model output и deployment не запускаются. Adapter повторно сверяет HEAD источника после clone, читает только разрешённые policy paths, отвергает `realpath` за пределами clone и ограничивает один текстовый файл 1 MiB. Fixture подтверждает: source checkout и его `.git/HEAD`/`.git/config` не изменились, изменившийся HEAD отвергается, junction/symlink наружу отвергается.

**Доказательство:** [worklog B13.a1](../worklog/2026-09-09-B13-a1-readonly-workspace.md).

## B13.b1 — разрешённые repo-операции

Добавить разрешённый commit/push change set с внешним operation ID и сверкой CI-результата с нужным SHA.

## B13.a2 — bounded agent job (2026-09-09, GREEN)

Контрактный слой (`bounded-patch-job.ts`, `bounded-agent-job.ts`) + реальный executor
(`workspace-executor.ts`): disposable isolated checkout на exact base SHA, policy-bounded writes
(1 MiB cap, realpath containment, `.git` недоступен), детерминированный `treeIdentity()`
(`git write-tree`, кросс-проверен ручным репозиторием), verification-runner исполняет дословно
только policy-команды (execFile без shell, чистое environment, timeout 120 s).

**Проверить:** `npm run test:builder` — exit 0, 13/13; тот же patch на двух workspace → одинаковый
tree SHA; source checkout не изменён; запись вне prefix/traversal/`.git`/oversize/unknown command —
fail closed. Полный `npm run verify` и Linux CI — см. worklog.

**Ограничение:** исполнение команд без контейнерной изоляции (Docker/Podman отсутствуют, WSL2
сломан) — границей служит policy-allowlist, PATH не security boundary.

**Доказательство:** [worklog a2 contract](../worklog/2026-09-09-B13-a2-bounded-patch-job.md),
[worklog a2 executor](../worklog/2026-09-09-B13-a2-workspace-executor.md).
