# B02-02 — explicit action resolver

## Цель

Связать принятые B01 `ResolvedIntent` и B02-01 typed gameplay effects первым реальным action resolver без LLM и без scheduler. На одном тестовом действии Core должен по авторитетному `WorldState` вычислить понятный `executed`, `partial` или `blocked` результат, длительность и batch `GameplayEffect`, а затем атомарно получить trial next state.

## Вход

- принятый B02-01 и ADR 0003;
- `ResolvedIntent`, `GameplayEffect.resource.change`, `tryApplyEffectBatch`;
- разделы 7.1–7.3 и сценарии T01/T07 `docs/SPECIFICATION.md`.

## Сделать

1. Ввести минимальное типизированное action definition для тестового `core.paint`: target resource ID, requested integer units, cost resource units per completed unit, duration seconds per completed unit и policy частичного исполнения.
2. Resolver принимает уже validated explicit intent/args и authoritative state; свободный текст здесь не разбирается.
3. Для достаточного ресурса: `executed`, фактически выполненное количество = requested, рассчитанная длительность, typed `resource.change` batch.
4. Для ограниченного ресурса при разрешённой partial policy: `partial`, выполнено только максимальное целое количество, явно указаны completed/requested и reason code `RESOURCE_LIMIT`; не округлять ресурс или расход.
5. Если нельзя выполнить ни одной единицы: `blocked`, duration 0 и пустой gameplay-effect batch/state без изменения.
6. Перед возвратом успешного/partial результата прогнать рассчитанные effects через `tryApplyEffectBatch`. Ошибка внутренне рассчитанного batch не маскируется под игровой `blocked`; resolver возвращает детерминированную internal calculation failure без next state.
7. Не повышать revision и не двигать clock в этом срезе: длительность только рассчитана. Commit/time progression начнутся позже.
8. Зафиксировать contract boundary рассчитанного action outcome. Не переписывать публичный B01 `ActionResult` v1.0 молча; при необходимости использовать отдельный `ResolvedAction`/`CalculatedAction` contract до согласованного публичного versioning change.
9. Добавить сценарные тесты T01-ядра: paint 8 units при ресурсе 2 и цене 1 → partial 2, delta -2, duration 600; повтор на state с 0 → blocked, duration 0.
10. Обновить generated capabilities только если появляется действительно зарегистрированный action type.

## Приёмка

- `npm run verify` на чистом runner;
- `core.paint` с 8 requested / 2 available даёт partial completed=2, resource=0 в trial next state, duration=600 при 300 sec/unit;
- повтор с resource=0 даёт blocked, duration=0, effects=[] и неизменный state;
- достаточный ресурс даёт executed;
- invalid args/definition не исполняются и не мутируют state;
- action outcome не приписывает решение/согласие игроку сверх переданного explicit intent;
- Core остаётся без scheduler, HTTP/storage и AI.

## Не делать

Свободный русский ввод, clarification/unsupported, сложный язык условий, NPC actions, scheduler/deadline, session revision commit, HTTP, SQLite, Studio, Florence migration или plugin SDK.

## Следом

После B02-02 отдельно добавить декларативные preconditions/conditions и остальные базовые effects, необходимые T02–04/T07, либо разделить на следующие bounded-срезы до общей приёмки B02.
