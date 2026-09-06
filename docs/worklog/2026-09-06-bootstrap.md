# 2026-09-06 — bootstrap sandboxengine

## Сделано

- Проверен удалённый `conradipui-glitch/sandboxengine`: репозиторий пуст, ветка `main` ещё не содержала commit.
- Проверен исходный `conradipui-glitch/sandbox` на commit `092bcef0be5943e32bf02f08f9e9d4cde393fa95`.
- Зафиксировано, что в исходной игре уже есть отдельные Florence/AI/worker-модули и тесты; перенос не считать выполненным.
- Добавлены README, инструкции агента, status/handoff, baseline, MVP, team, ADR и карточка B01-01.
- Добавлен минимальный TypeScript workspace с `contracts`, чистым `core`, реальными тестами и boundary/docs checks.

## B01-01

- Контрактный guard перенесён в публичный слой `contracts`; Core делегирует ему без второй реализации правил.
- Добавлены `action-result.executed.json` и `action-result.invalid.json`.
- Контрактные проверки расширены до 5 тестов; B01-01 принят по своей карточке.
- Уточнено: до передачи движка команде реализацию ведут владелец проекта и агент; команда подключается на этапе плейтеста и корректировок.

## Проверки

- TypeScript build: прошёл (`tsc -b --pretty false`, TypeScript `7.0.2` из рабочего окружения).
- Node test runner: 4/4 теста прошли.
- `node scripts/check-boundaries.mjs`: прошёл.
- `node scripts/docs-check.mjs`: прошёл.
- `git diff --check`: прошёл.
- GitHub Actions run [34019976966](https://github.com/conradipui-glitch/sandboxengine/actions/runs/34019976966): `npm ci` и `npm run verify` на чистом runner прошли успешно.

## Не сделано

Runtime API, storage, Studio, Player, AI adapters, quotas, plugins, Builder, deployment и migration Florence.

## Следом

Bootstrap опубликован в `main`; B01-01 теперь требует публикации отдельным commit. Следом выполнить `docs/tasks/B01-02-schemas.md`; затем обновить STATUS и HANDOFF измеренными результатами.
