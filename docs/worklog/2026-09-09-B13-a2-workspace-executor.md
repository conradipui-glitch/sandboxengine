# 2026-09-09 — B13.a2 real workspace executor (continuation)

Branch: `feat/live-author-studio`

## Контекст

Карточка B13.a2 имела контрактный слой (bounded-patch-job, bounded-agent-job) от Codex на `267fdaa`
(CI success), но worklog честно фиксировал: реального filesystem writer и runner проверок нет.
Эта работа закрывает пробел. План: [B13-A2-PLAN.md](../tasks/B13-A2-PLAN.md).

## Реализовано

- `apps/builder-runner/src/workspace-executor.ts`:
  - `createMutableBuilderWorkspace(policy)` — disposable isolated checkout на exact base SHA
    (переиспользует readonly-adapter a1: realpath source, clone --no-local, HEAD сверяется до и после)
    с добавлением policy-bounded `writeText` (write-authorization → realpath-containment родителя →
    лимит 1 MiB → mkdir+write) и `treeIdentity()` = `git add -A -- <writable prefixes>` +
    `git write-tree` (40-hex SHA, детерминированный);
  - `createPolicyVerificationRunner(policy)` — исполняет ТОЛЬКО команды из immutable policy,
    сверяя executable+args дословно; execFile без shell, чистое environment (без секретов,
    без пользовательского Git config), timeout 120 s, maxBuffer 1 MiB, ошибки типизированы
    (`verification_command_unknown`, `verification_failed` с bounded stderrTail ≤ 2000 chars).
- `apps/builder-runner/src/index.ts` — публичный surface дополнен executor-модулем.
- Тесты: `workspace-executor.test.mjs` (3), `bounded-agent-job.test.mjs` переписан на реальный
  executor вместо фейковых стабов (2).

## Проверки

- `npm run test:builder` — exit 0, 13/13 (было 9/9 контракта);
- кросс-проверка tree identity: тот же patch на двух независимых workspace даёт одинаковый tree SHA;
  этот SHA совпадает с `git write-tree` ручного репозитория с идентичным полным содержимым;
- source checkout после patch+tree+dispose не изменён (`git status --porcelain` пуст, байты файлов те же);
- отказы: запись вне writable prefix, traversal-варианты, `.git`, файл > 1 MiB, команда вне policy,
  не-канонический путь — все fail closed с типизированными кодами;
- среда исполнения: Docker/Podman отсутствуют, WSL2 сломан (Wsl/CallMsi/E_ACCESSDENIED, требует
  admin). Sandbox построен из Node-примитивов: fixed argv, изолированное environment, изолированный
  clone, PATH-g hygiene. PATH — НЕ security boundary (честно задокументировано); границей остаётся
  policy-allowlist + изолированный clone.

## Ограничения

- Исполнение verification-команд происходит на host-Node без контейнерной изоляции: произвольный код
  НЕ запускается (только policy-команды), но если какая-то policy-команда сама опасна — это решает
  кто составляет policy, а не runtime. Для полноценной процессной изоляции в b1+ потребуется CI-раннер
  или контейнеры.
- push/PR/workflow/deployment по-прежнему отсутствуют (следующие карточки).
