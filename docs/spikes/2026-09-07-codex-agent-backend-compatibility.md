# 2026-09-07 — Codex AgentBackend compatibility spike

## Статус

**Verdict: `limited` for Living History Runtime.**

Codex подтверждает нужную форму session-oriented backend (auth + thread/session lifecycle + turn + close/cancel primitives), но на текущем upstream evidence нельзя честно доказать наш обязательный Runtime invariant `toolPolicy: none`.

Поэтому B06-04 **не добавляет production Codex Runtime adapter**. Codex остаётся потенциальным AgentBackend для будущего bounded use case, когда supported configuration/API сможет гарантировать отсутствие built-in shell/filesystem/tool authority, либо когда Runtime будет запускать backend в отдельной инфраструктурной изоляции с эквивалентной доказанной policy.

## Upstream snapshot

Проверено 2026-09-07 против `openai/codex` main commit:

`121f91fd5d9dc66017866ce9bdc49f1e182721df`

### 1. Session/auth lifecycle — compatible by shape

Текущий public Python SDK документирует:

- `login_api_key(...)`;
- `login_chatgpt()`;
- `login_chatgpt_device_code()`;
- `account()` / `logout()`;
- `thread_start(...)`;
- `thread_resume(...)`;
- thread `run(...)` / `turn(...)`;
- explicit client/context-manager close lifecycle.

Source: `openai/codex/sdk/python/docs/api-reference.md` and `sdk/python/docs/faq.md` at the snapshot above.

Это хорошо соответствует отдельному `AgentBackend` lifecycle и является причиной не пытаться маскировать Codex под stateless `ModelProvider.generate`.

### 2. Sandbox — ограничивает доступ, но не равен no-tools

Documented SDK sandbox presets:

- `read_only` — files readable, writes blocked;
- `workspace_write` — read/write in workspace roots;
- `full_access` — no filesystem restrictions.

Source: `openai/codex/sdk/python/docs/api-reference.md` / `getting-started.md`.

`read_only` всё равно специально описан как режим, где agent **читает файлы**. Следовательно, он не удовлетворяет нашему более строгому `toolPolicy: none`.

Permission/sandbox controls ограничивают действие command/tool execution, но не являются доказательством, что built-in tool inventory вообще отсутствует.

### 3. Нет стабильного подтверждённого global built-in-tools-off contract

Upstream issue `openai/codex#6049` остаётся feature request на возможность отключить built-in tools (shell/file/apply_patch и др.) для controlled/headless execution.

Текущий config schema имеет отдельные toggles для части tools/apps/plugins, но не даёт нам достаточного documented invariant «all built-in tools absent» для Runtime profile.

Отдельные regressions/случайные конфигурации, при которых tools оказываются недоступны, **не считаются supported security mechanism**.

### 4. App-server dynamic tools не решают проблему

`codex-rs/app-server/README.md` поддерживает experimental `dynamicTools` на `thread/start`. Это добавление host-defined tools, а не replace/restrict mechanism для built-in Codex tools.

Upstream discussions/issues также описывают partial per-thread control для plugins/skills, но не гарантированное replacement built-in capability set.

### 5. Почему не используем `read_only + approval never`

Такой режим полезен для coding automation, но для Living History Runtime он всё ещё шире требуемого contract:

- agent может иметь filesystem/shell-like tool surface;
- read-only запрещает mutation, но разрешает чтение workspace;
- модель может видеть содержимое, которого нет в bounded `FactPacket`/intent context;
- наличие approval/sandbox policy не должно заменять deny-by-default API boundary.

Поэтому `read_only` не конвертируется в `AgentBackendCapabilities.toolPolicy = "none"`.

## Compatibility matrix

| Requirement | Codex current evidence | Verdict |
|---|---|---|
| Session lifecycle | thread start/resume/turn/close | compatible |
| ChatGPT/API-key auth | public SDK login flows | compatible |
| Bounded turn/interrupt | turn handle/run/interrupt primitives | compatible |
| Explicit sandbox | read-only/workspace/full-access | compatible but broader than Runtime need |
| No shell/filesystem tools exposed | no supported global guarantee found; upstream request remains open | **not proven** |
| No repository/workspace visibility | read-only explicitly permits reads | **not compatible with `toolPolicy:none`** |
| No gameplay mutation API | can be enforced by our adapter contract, but backend tool surface is still broader | limited |
| Production Runtime adapter | requires all security invariants above | **not accepted** |

## B06-04 decision

`AgentBackend` contract remains useful and intentionally supports a future Codex-like adapter, but current Codex is classified:

`limited`

Reason code:

`BUILTIN_TOOLS_CANNOT_BE_PROVEN_ABSENT`

No production adapter is added in B06-04 unless new evidence in the same slice changes this result.

## What would change verdict to compatible

Any one of the following with stable supported semantics and tests could unblock a future adapter:

1. documented per-thread/API option that builds a Codex thread with **zero built-in tools**, plugins, skills, MCP, shell/filesystem/app tools;
2. supported permission profile whose contract explicitly guarantees no tool exposure, not merely sandbox denial;
3. isolated backend service that provides only a text/session RPC surface to Living History and can prove Codex process has no readable gameplay/host filesystem, tools or external capabilities beyond model transport.

Even then, Runtime would still validate any returned text through existing intent/narrator boundaries before it could affect gameplay/presentation.

## Scope consequence

B06-04 continues with:

- generic AgentBackend contract/fake tests;
- bounded live `ModelProvider` intent/narrator eval;
- canonical B06 audit.

It does **not** spend more scope forcing Codex into Runtime through unsupported configuration tricks.
