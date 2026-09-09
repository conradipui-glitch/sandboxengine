# 2026-09-09 — B13 приёмка: окружение исполнения и sandbox-статус

Branch: `feat/live-author-studio`

## Решение по окружению (требование карточки: «для исполнения кода найди и проверь подходящую изолированную среду»)

Доступные на хосте варианты, проверенные фактически:

- Docker — отсутствует (`docker: command not found`);
- Podman — отсутствует;
- WSL2 — сломан (`Wsl/CallMsi/E_ACCESSDENIED`, требуется интерактивный admin-repair; в этой сессии недоступен);
- Windows Sandbox — не проверяем programmatically из этой сессии (требует отдельного запуска пользователем).

Принятая изолированная среда B13.a2: **dedicated CI runner**. Каждая проверка исполняется одним из:

1. Linux GitHub Actions runner (`ci.yml` verify job) — ephemeral VM, одноразовое окружение,
   изолированное от игровых данных и хоста оператора по построению;
2. локальный disposable clone + policy-allowlist (fixed argv, чистое environment, 1 MiB caps,
   realpath containment) — filesystem-граница, НЕ process-sandbox.

## Честный статус

| Компонент | Статус |
|---|---|
| Policy-слой (B13.0) | GREEN — traversal/absolute/backslash/.git/prefix-collision/write-escalation fail closed |
| Read-only workspace (B13.a1) | GREEN — disposable clone, exact-SHA сверка, symlink/junction escape отклоняется |
| Patch executor + verification runner (B13.a2) | **PARTIAL** — policy-граница доказана; полноценная процессная изоляция НЕ предоставлена локально (нет Docker/Podman, WSL сломан). Изолированная среда для исполнения проверок = Linux CI runner; локально исполняются только policy-allowlist команды |
| Change set + CI reconciliation (B13.b1) | GREEN — push из isolated clone, exact-SHA сверка рана |
| Preview adapter (B13.b2) | GREEN (контракт) — живой dispatch выполнен в рамках связки `sandbox` (см. ниже) |
| Production adapter (B13.c1) | GREEN (контракт) — живой production dispatch не выполнялся (по решению оператора) |

## Блокер для полного GREEN a2 (конкретный)

Отсутствие контейнерной/VM-изоляции на локальной Windows-машине. Устранение: включить WSL2
(требуется админ), установить Docker Desktop или Podman, либо объявить Linux CI единственной
средой исполнения verification-команд (уже реализовано: ci.yml). До этого a2 = PARTIAL с этим
конкретным блокером; B13 в целом не объявляется завершённым.
