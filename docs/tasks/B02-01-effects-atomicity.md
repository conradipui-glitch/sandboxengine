# B02-01 — typed effects и атомарное применение

## Цель

Начать B02 с минимального вычислительного примитива: один реально типизированный gameplay effect и пробное атомарное применение effect batch к копии `WorldState`. Этот срез ещё не распознаёт намерение игрока и не решает, какое действие выполнить.

## Вход

- принятый B01 и generated agent contracts;
- `packages/contracts/schemas/v1/effect.schema.json`, `WorldState`, `ActionResult`;
- разделы 5.2, 7.2–7.3 и сценарий T07 `docs/SPECIFICATION.md`.

## Сделать

1. Зафиксировать первый исполняемый effect `resource.change`: resource ID, целочисленная delta и provenance/source ID.
2. Не ломать опубликованный schema contract молча. Если строгая типизация требует несовместимого изменения существующего `Effect` v1.0, оформить versioning/compatibility решение в ADR и обновить schema metadata/generated docs в том же change set.
3. Реализовать чистый `tryApplyEffectBatch(state, effects)` над копией состояния. Проверить весь batch прежде, чем вернуть новое состояние.
4. Отклонять неизвестный resource ID, выход ниже min/выше max, нецелые значения и неподдерживаемый effect type. При любой ошибке исходный state и весь batch остаются неприменёнными.
5. Несколько изменений одного ресурса в одном batch проверяются последовательно на trial-copy; результат либо весь принимается, либо весь отклоняется.
6. Добавить fixtures/tests на успешный batch и на ошибку во второй операции после валидной первой — доказательство отсутствия partial apply.
7. Обновить generated contracts/STATUS/HANDOFF/worklog только по фактически реализованным типам.

## Приёмка

- `npm run verify` проходит на чистом runner;
- исходный `WorldState` не мутируется;
- успешный batch возвращает новое состояние с ожидаемыми значениями;
- ошибка в любом effect возвращает failure без нового state и без частично применённых изменений;
- min/max и integer invariants соблюдаются;
- provenance сохраняется в результате/trace-ready структуре, но отдельный trace storage ещё не создаётся;
- Core остаётся без HTTP/storage/LLM/React/Cloudflare;
- generated capabilities не объявляют action resolver или endpoints, которых всё ещё нет.

## Не делать

Action resolver, `partial` расчёт действия, preconditions языка условий, scheduler/clock advance, NPC tasks, HTTP, SQLite, AI parsing, Studio, Florence migration или plugin SDK.

## Следом

После принятия B02-01 отдельным bounded-срезом добавить action definition/resolver и статусы `executed/partial/blocked` на тестовом действии, не смешивая это с scheduler B03.
