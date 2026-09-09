# B13 — подключаемый Builder и deployment

Статус: **B13.0 GREEN; B13.a1 NEXT**
Вход: опубликованный B12 (`6f2ad73fca228c60361012250b72609447edc968` в истории текущей ветки), §25 и T33–35 спецификации.

## Граница блока

Builder работает отдельным процессом от Core/Runtime. Изолированная Git-папка сама по себе не считается sandbox. Права чтения, записи, проверок, внешних repo-операций и deployment выдаются раздельно; содержимое README, Skill, MCP-ответа или model output не расширяет task policy.

До отдельной приёмки соответствующей карточки запрещены: произвольный shell, доступ к игровой SQLite/секретам/Docker socket/host root, push, создание PR, запуск workflow, preview и production deployment.

## Последовательные карточки

| ID | Результат | Статус |
|---|---|---|
| B13.0 | Точный repository snapshot, канонические read/write paths и argv проверок; fail-closed policy без файлового исполнения | GREEN (2026-09-09) |
| B13.a1 | Отдельный workspace adapter: чтение exact base SHA, realpath/symlink boundary, отсутствие записи в исходный checkout | NEXT |
| B13.a2 | Bounded agent job, patch только в разрешённые пути, diff и проверки на точном tree hash | NOT STARTED |
| B13.b1 | Разрешённый commit/push/change set, внешний operation ID и сверка CI с нужным SHA | NOT STARTED |
| B13.b2 | Один preview deployment adapter с artifact identity и smoke | NOT STARTED |
| B13.c1 | Production policy, reconciliation потерянного ответа и проверенный rollback | NOT STARTED |

## B13.0 — policy baseline

**Сделать:** добавить `apps/builder-runner` в TypeScript graph; определить immutable policy с exact `owner/repository`, абсолютным корнем, base branch/SHA, каноническими portable read/write prefixes и проверками как `executable + argv`; возвращать только разрешённый относительный путь. Write scope обязан быть подмножеством read scope.

**Проверить:** traversal, абсолютные пути, backslash-варианты, `.git`, prefix collision, write escalation, malformed repo/SHA и shell-like executable fail closed. `test:builder` входит в общий `verify`.

**Не входит:** создание/чтение файлов, разрешение symlink, запуск команд, Git credentials и любые внешние изменения. Реальный executor обязан повторно проверить filesystem boundary через realpath и использовать sandbox; policy-функция не объявляется security boundary.

**Доказательство:** [worklog B13.0](../worklog/2026-09-09-B13-00-builder-policy.md).

## Следующий шаг — B13.a1

Создать adapter изолированного workspace на локальном fixture-репозитории. Он должен подтвердить exact base SHA, отказаться от изменившегося HEAD, разрешать чтение только после realpath/symlink проверки и никогда не писать в исходный checkout. Никаких model backend, push или deployment в этой карточке.
