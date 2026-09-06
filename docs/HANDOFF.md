# Передача работы

Обновлено: 2026-09-06

Текущий блок: **B05-01 — Draft Control foundation и frozen playtest snapshot**  
База ветки: опубликованный B04 merge `3ef8633cff0c07339e09107e4f3653f7e7295f0f`  
Push-to-main B04 CI: `34039569962` — success  
Текущая ветка: `b05-01-canonical-slice`  
Текущая карточка: [B05-01](tasks/B05-01-draft-control-frozen-playtest.md)  
Статус: **task-card зафиксирована; реализация B05-01 ещё не принята**

## Опубликованная база

B01–B04 приняты и опубликованы. B04 завершил public Runtime boundary:

- Memory/SQLite operation semantics;
- durable idempotency/restart/fencing;
- guest ownership;
- deny-by-default PlayerView;
- explicit Runtime HTTP;
- T10–12/T15;
- five available Runtime endpoints в generated contract.

B04 merge: `3ef8633cff0c07339e09107e4f3653f7e7295f0f`.  
Push-CI: `34039569962` — success.  
ADR: 0011–0013.

## Canonical B05

По `docs/SPECIFICATION.md` B05 — **«Первый законченный путь автора»**:

- минимальная Studio;
- server-side draft;
- entities/action/rule forms;
- validation;
- frozen playtest;
- базовый Player;
- повторяемая справка/обучение.

Главная итоговая приёмка B05: человек создаёт квест, добавляет ресурс, меняет стоимость действия и видит новый результат в **новой** тестовой сессии без ручного JSON; уже начатый playtest при редактировании draft не меняется.

## B05 разложен на bounded slices

1. **B05-01:** Draft Control foundation + validation + frozen playtest snapshot.
2. **B05-02:** минимальные `apps/studio` формы поверх Control API.
3. **B05-03:** базовый Player + frozen playtest E2E/result/reset.
4. **B05-04:** постоянная справка + повторяемый onboarding/T29 без AI usage.

## B05-01 invariant

Draft — единственная редактируемая истина автора.

- каждое изменение использует `baseRevision`;
- change set применяется atomically на trial snapshot;
- stale revision не перетирает более новый draft;
- validation относится к точному revision/hash;
- playtest pinned к immutable snapshot/hash;
- последующие draft edits не меняют существующий playtest.

## Следующее действие

1. Проверить текущую структуру `packages/` и `apps/server`.
2. Выбрать отдельную Control/authoring package boundary; не смешивать authoring tables с gameplay `RuntimeStorage` lifecycle.
3. Добавить минимальный authoring domain + Memory reference semantics.
4. Добавить regressions: atomic change set, stale revision, validation binding, frozen playtest.
5. Только после semantic gate добавлять Control HTTP subset и readiness registry.

## Не делать в B05-01

- Studio UI;
- полный Player presentation interpreter;
- tutorial/help UI;
- free-text/LLM/author assistant;
- publish/release/rollback/roles/login;
- asset pipeline;
- animation suggestion assistant;
- Florence migration;
- debug mutation gameplay state;
- изменение B03/B04 semantics.

Известное наблюдение: `npm ci` сообщает 2 vulnerabilities (1 moderate, 1 high); force-upgrade не смешивать с B05-01.
