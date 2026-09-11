# Living History Player — B05-03

Первый Player — это локальный тестовый клиент frozen playtest. Он не является отдельным simulator и не читает current draft.

## Что уже работает

- загрузка конкретного durable frozen playtest из Control SQLite;
- deterministic bootstrap initial `WorldState`;
- bounded `core.paint` definition из frozen snapshot;
- Runtime guest session + idempotency/revision semantics;
- действие через существующий Core resolver;
- player-safe resource/time/result projection;
- Reset как новая session из **того же** frozen playtest;
- responsive browser surface без client-side gameplay math;
- экраны истории intro/scene/dialogue/choice/ending из pinned mission того же
  playtest на общем renderer (`presentation-renderer.js`): «Далее»/«Начать» с
  не-submit навигацией вступлений, листание диалога кликом/тапом и клавишами
  Enter/Space/стрелки/PageDown, выборы, финал с выходом/повтором.

## Рекомендуемый путь

1. Запустите Studio:

```bash
npm run dev:studio
```

2. В Studio создайте/откройте проект и квест, добавьте resource и `core.paint`.
3. Нажмите **«Проверить квест»**.
4. После valid validation нажмите **«Создать frozen playtest»**.
5. Studio покажет `playtestId` и готовую локальную команду запуска.

### PowerShell

```powershell
$env:LH_PLAYTEST_ID="<playtest-id>"; npm run dev:player
```

### macOS / Linux

```bash
LH_PLAYTEST_ID=<playtest-id> npm run dev:player
```

По умолчанию Studio и Player используют одну базу:

```text
./data/living-history.sqlite
```

Если Studio запускалась с другим `LH_DATABASE_PATH`, передайте тот же путь Player.

### Пример с явной БД

PowerShell:

```powershell
$env:LH_DATABASE_PATH="C:\path\living-history.sqlite"; $env:LH_PLAYTEST_ID="<playtest-id>"; npm run dev:player
```

macOS / Linux:

```bash
LH_DATABASE_PATH=/path/living-history.sqlite LH_PLAYTEST_ID=<playtest-id> npm run dev:player
```

## Порты

- `LH_PLAYER_PORT` — Player surface, default `4180`;
- `LH_RUNTIME_PORT` — внутренний loopback Runtime, default `0` (случайный свободный порт).

Оба listener в B05-03 предназначены только для loopback development. Это не B09 public publish/auth surface.

## Что Player намеренно НЕ делает

- не вычисляет расход ресурса;
- не вычисляет partial/executed/blocked;
- не вычисляет duration;
- не читает Control draft;
- не получает raw compiled artifact;
- не получает `resourceUnitsPerUnit` как источник игровой логики;
- не мутирует frozen playtest;
- не содержит full PresentationPlan/assets/animation system.

## Текущая bounded граница

Один `npm run dev:player` запускает один `LH_PLAYTEST_ID` и один supported `core.paint` action. Это первый законченный causal author→game path, а не финальный multi-game production server.

Reset создаёт новую gameplay session из того же playtest. Если автор после создания P1 изменил draft и создал P2, запущенный P1 не переключится на P2 автоматически.
