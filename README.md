# Living History Engine

Переносимый движок причинных интерактивных историй с server-authoritative Runtime, Studio для авторинга, Player, immutable releases, SQLite persistence, plugins, presentation/assets и ограниченными AI-границами.

Опубликован **v0.1.0 (B01–B12)**. Ветка `feat/live-author-studio` доделывает подключение ИИ в Studio по [плану L00–L09](docs/tasks/LIVE-AUTHOR-COMPLETION.md): L00–L07 приняты (настройка провайдера, HTTP adapter, сквозной цикл, браузерная приёмка), L08 — живой прогон реальной модели — `UNVERIFIED: нет доступа к провайдеру`, L09 — финализация документации.

## Что уже реализовано

- deterministic Core: conditions, effects, scheduler, social acts, terminal states, seeded RNG;
- durable Runtime: idempotency, leases/fencing, SQLite restart recovery, guest session isolation;
- Control/Studio: drafts, validation, frozen playtests, immutable releases, publish/rollback, history/compare/restore, access roles, portability;
- Player: server-authoritative actions, replay-safe presentation, reduced-motion/skip fallback;
- trusted plugin boundary и `dice-check` reference plugin;
- bounded AI provider/intent/narrative contracts, OpenRouter/custom-compatible adapter, quota semantics;
- author assistant boundary, Skills/MCP broker и Codex App Server adapter contracts;
- реальные example quests: Florence и Transfer Desk без quest-specific веток в Core;
- B12 release gates: dependency audit, backup/restore, rollback, startup/shutdown, production smoke.

## Требования

Репозиторий закреплён на Node.js `24.19.0` (`.nvmrc`). `package.json` декларирует npm `11.9.0` как package manager.

## Чистая проверка

```bash
npm ci
npm run build
npm run verify
```

`npm run verify` включает typecheck, dependency audit, contracts/assets/plugins/Core/AI/storage/Control/server/Studio/Player tests, backup/restore drill, release rollback drill, persistent startup/shutdown drill, boundary checks и docs gate.

## Локальная Studio

```bash
npm run dev:studio
```

Это loopback-среда автора с SQLite persistence. Помощник работает через настраиваемый API provider: форма «Подключение ИИ-помощника», OpenRouter или совместимый API, ключ хранится только в памяти серверного процесса до отключения или перезапуска. Статусы подключения честные: «настройки сохранены» не означает проверенное соединение; первый запрос отправляется из помощника. Ошибки провайдера объясняются действием пользователя (ключ/429/таймаут). Сквозной цикл через настоящий HTTP adapter покрыт тестом `live-author-full-http-cycle`; живой прогон реальной модели отдельно не заявляется (L08).

После создания frozen playtest Studio показывает `LH_PLAYTEST_ID`, команду запуска Player и кнопку «Открыть в Player» — Player запускается из этой же замороженной версии, ровно один управляемый Player на процесс Studio. Player не вычисляет gameplay арифметику на клиенте.

## Persistent Runtime + Control

Сначала соберите TypeScript, затем запускайте постоянный Node+SQLite entrypoint:

```bash
npm run build
RUNTIME_DB_PATH=./data/runtime.sqlite \
PORT=8787 \
CONTROL_PORT=8788 \
CONTROL_AUTH_MODE=local \
npm start
```

Runtime health:

```bash
curl http://127.0.0.1:8787/healthz
```

`CONTROL_AUTH_MODE=local` всегда держит Control на loopback. Для authenticated/non-loopback Control требуются отдельные security settings; точные ограничения описаны в [операционном runbook](docs/RUNBOOK.md).

Persistent entrypoint сейчас не композирует live model provider автоматически. Реальный provider проверяется отдельным opt-in `npm run eval:ai` и не входит в обычный `verify`.

## Release/operations commands

```bash
npm run audit:release
npm run drill:backup-restore
npm run drill:rollback
npm run drill:startup-shutdown
npm run eval:ai
```

`eval:ai` требует явных `LHE_EVAL_API_KEY` и `LHE_EVAL_MODEL`. Без них он возвращает `status: not_configured`; fake-provider evidence не считается live evidence.

## Документация

- [Specification](docs/SPECIFICATION.md) — канонические invariants, roadmap и acceptance matrix.
- [Release Report](docs/RELEASE-REPORT.md) — B12 evidence ledger и реальные ограничения.
- [B12 Acceptance Matrix](docs/B12-ACCEPTANCE-MATRIX.md) — T01–33/T36–37 consolidation.
- [Operational Runbook](docs/RUNBOOK.md) — запуск, health, shutdown, backup/restore, rollback и ограничения.
- [Handoff](docs/HANDOFF.md) — точная текущая рабочая точка.
- [Status](docs/STATUS.md) — краткий статус блоков.
- [Changelog](CHANGELOG.md) — release-facing изменения без выдуманного тега.
- [Contributing](CONTRIBUTING.md) и [AGENTS](AGENTS.md) — правила изменений и агентной работы.

## Важные ограничения B12

- B13 Builder/code/deployment orchestration **не входит** в этот релиз.
- B12 production smoke в `sandbox` не включает Florence Engine rollout автоматически.
- Backup/restore proof относится к standalone SQLite Engine + repository assets, не к Cloudflare Durable Objects.
- Authenticated live provider eval на release CI сейчас `not_configured`; токены/latency для реальной модели не выдумываются.
- Authenticated live Codex subscription run также не заявляется без реального доступного account/session evidence.
- SQLite entrypoint не заявляет поддержку shared-network-file multi-writer deployment.

До закрытия live-provider release gate финальный B12 tag не создаётся.
