# B05-03 — Basic Player + frozen playtest gameplay E2E

## Цель

Соединить frozen playtest B05-01 и authoring path B05-02 с первым минимальным Player, чтобы доказать главный gameplay результат B05: изменение стоимости действия в draft влияет только на **новую** тестовую сессию, а уже созданный playtest остаётся на старых правилах.

## Канонический вход

- B05-01 published: durable draft/validation/frozen playtest;
- B05-02 published: Studio project/quest/resource/core.paint forms;
- `docs/SPECIFICATION.md` B05: Player пока показывает фон, текст, варианты, результат и reset; начальный режим без LLM, с action buttons;
- ADR 0014–0015.

## Главный invariant

**Игровая тестовая сессия запускается из frozen playtest snapshot, а не из current draft.**

Изменение draft после создания P1 не меняет definitions/content hash P1. Новый P2 после новой validation получает новые правила.

## Сделать

### 1. Player package boundary

Создать базовый `packages/player` либо столь же явную client library boundary.

Player:

- читает только player-safe/runtime contracts и frozen playtest bootstrap;
- не вычисляет последствия действия самостоятельно;
- не импортирует ControlStore/SQLite;
- не получает возможность менять draft.

### 2. Frozen playtest bootstrap

Добавить bounded путь запуска тестовой игровой сессии из `FrozenPlaytestRecord`/compiled artifact:

- создать initial `WorldState` только из поддерживаемых B05 blocks;
- `core.location` → стартовая location;
- `core.resource` → integer resource initial/min/max;
- bounded `core.action/core.paint` → action definition для существующего Core resolver;
- сохранить identity playtest/content hash в test-session metadata вне причинного `WorldState`, если это нужно.

Не читать current quest draft после bootstrap.

### 3. Минимальный Player UI

Первый surface без полной presentation system B07:

- заголовок/текст тестового квеста;
- нейтральный фон, если asset contract ещё не готов;
- текущий ресурс;
- одна кнопка action `Рисовать`;
- bounded quantity (достаточно фиксированного тестового количества либо простого integer input);
- результат executed/partial/blocked с объяснением;
- обновлённый player-safe resource value;
- reset — новая session из **того же frozen playtest**, а не current draft.

### 4. Runtime ownership

Action button должен идти через существующий Runtime action path / Core resolver, а не локально вычитать ресурс в Player.

Соблюсти:

- expected revision;
- idempotency semantics;
- один committed turn;
- player-safe projection;
- повтор не исполняет Core второй раз.

### 5. Канонический E2E cost 1 → 2

Обязательный сценарий:

1. через Control/Studio-compatible authoring создать resource initial=2 и `core.paint` cost=1;
2. validate revision R1;
3. создать frozen playtest P1;
4. запустить Player session S1 из P1;
5. выполнить request quantity=2 → при cost=1 действие выполняет ожидаемый объём по существующему resolver;
6. изменить draft: cost=2;
7. validate R2;
8. создать P2;
9. P1 и reset/новая session из P1 продолжают использовать cost=1;
10. новая session S2 из P2 использует cost=2 и тот же request даёт другой deterministic outcome;
11. content hash P1 != P2.

Точные ожидаемые executed/partial/resource values зафиксировать из существующего `core.paint` resolver, а не придумывать в UI.

### 6. Reset semantics

Reset:

- не мутирует старую session;
- создаёт новую gameplay session из того же frozen playtest identity;
- восстанавливает initial state этого playtest;
- не подхватывает более новый draft автоматически.

### 7. Тесты

Добавить целевой `test:player` / `test:e2e` в root verify.

Минимум:

- frozen bootstrap deterministic;
- Player action проходит Runtime/Core, не client math;
- cost1/cost2 canonical E2E;
- old P1 remains cost1 after draft edit;
- reset P1 stays cost1;
- P2 gets cost2;
- idempotent action retry;
- no Control/SQLite imports in Player package.

## Приёмка B05-03

- новый Player реально запускается из frozen playtest;
- один и тот же action request даёт разные ожидаемые результаты для P1/P2 после cost edit 1→2;
- старый playtest и reset не меняются;
- Player не читает current draft;
- gameplay result считается существующим Core/Runtime;
- no raw storage/internal compiled leakage в Player surface;
- root verify green.

## Не делать

- полную `PresentationPlan`/анимации/asset timeline — B07;
- свободный текст/LLM — B06;
- onboarding — B05-04;
- publish/roles/login — B09;
- animation suggestion assistant;
- Florence migration;
- перенос всей старой игры;
- client-side simulation как shortcut.

## Следующий slice

B05-04 — постоянная справка + повторяемый onboarding tour / T29 без расхода AI. После B05-04 провести общий canonical audit B05 по полному author path.
