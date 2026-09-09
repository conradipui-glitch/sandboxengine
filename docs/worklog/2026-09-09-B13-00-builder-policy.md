# 2026-09-09 — B13.0 Builder policy baseline

Branch: `feat/live-author-studio`

## Baseline

- `origin/main` обновлён read-only fetch: `6f2ad73fca228c60361012250b72609447edc968`;
- merge-base текущей ветки с `origin/main`: тот же B12 SHA;
- входной SHA после закрытия L09: `1c45db510a7669c02a85aa0151af33e8ae2bccef`;
- канонические требования: §25, B13 и T33–35 в `docs/SPECIFICATION.md`;
- `apps/builder-runner` до карточки содержал только README и не входил в TypeScript/test graph.

## Реализовано

- immutable `BuilderWorkspacePolicy`: exact repository ID, absolute root, branch, exact lowercase 40-character base SHA, separate readable/writable prefixes and bounded verification argv;
- portable relative paths reject traversal, absolute/drive paths, backslashes, empty/dot segments and `.git`;
- path-prefix comparison segment-aware, поэтому `apps/builder-runner-copy` не совпадает с `apps/builder-runner`;
- write prefixes обязаны быть внутри read prefixes;
- `authorizeBuilderPath` возвращает канонический разрешённый относительный путь, а не выполняет filesystem access;
- отдельный `test:builder` добавлен в обязательный `npm run verify`.

## Проверки

- `npm run test:builder` — exit 0, 3/3.
- `npm run verify` — exit 0; новый builder gate 3/3 выполнен внутри общего pipeline, Studio 62/62, Player 29/29 и Server 121/121 остались зелёными; audit, drills, boundaries и docs checks прошли.
- Первый запуск выявил скрытую зависимость от отсутствующих Node typings в новом app. Policy-слой исправлен: платформенное разрешение файлового пути не выполняется до появления отдельного executor в B13.a1.

## Ограничение и следующая карточка

B13.0 не создаёт sandbox и не защищает от symlink сам по себе. Он не читает и не меняет repository, не запускает argv и не имеет push/deploy credentials. B13.a1 должен добавить фактический workspace adapter с realpath/symlink boundary и exact-HEAD проверкой на локальном fixture repository.
