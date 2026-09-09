# 2026-09-09 — B13.a1 read-only workspace adapter

Branch: `feat/live-author-studio`

## Реализовано

- `createReadonlyBuilderWorkspace` раскрывает source root через `realpath`, сверяет exact base SHA до и после clone и создаёт отдельный disposable checkout на том же SHA;
- Git запускается исключительно через фиксированный `execFile("git", argv)`: без shell, интерактивного prompt, пользовательского/system Git config и унаследованных секретных переменных окружения;
- `readText` проходит B13.0 policy, затем `realpath`; junction/symlink вне isolated checkout, несуществующий путь, directory и файл более 1 MiB отклоняются;
- adapter не предоставляет write, command, model, GitHub или deployment API. Cleanup удаляет только им самим созданный temporary root.

## Проверки

- `npm run test:builder` — exit 0, 6/6;
- `npm run verify` — exit 0; Builder 6/6, Studio 62/62, Player 29/29 и Server 121/121; release audit, drills, boundaries и docs checks прошли;
- Linux CI `34310010055` — success на implementation SHA `d9ccb6a5c00eb980d20bbb0fed67b379807cba5b`.
- отдельный local Git fixture доказал: workspace root отличается от source root, exact SHA совпадает, разрешённый файл читается, запрещённый файл не читается, source content / `.git/HEAD` / `.git/config` / `git status --porcelain` не изменились;
- source с новым HEAD отвергается `base_commit_mismatch`;
- фактическая Windows junction (POSIX symlink на соответствующей платформе), указывающая наружу checkout, отвергается `workspace_path_symlinked`;
- security diff review: fixed argv без shell, чистое Git environment, policy allowlist и `realpath` исключают command injection, policy bypass и static symlink escape. `.git` запрещён в любом сегменте разрешённого пути.

## Ограничения и следующий шаг

Это файловая граница read-only clone, не sandbox исполнения произвольного кода. B13.a2 должен использовать отдельный sandbox для какого-либо agent-driven patch/verification и доказать diff/tree identity. Push, PR, workflow и deployment по-прежнему не реализованы.
