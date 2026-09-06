# Living History Studio

Минимальный авторский интерфейс B05-02 поверх authoritative Control API.

## Что умеет текущий slice

- список/создание проектов;
- список/создание квестов;
- форма целочисленного `core.resource`;
- форма bounded `core.action/core.paint`;
- изменение стоимости paint action;
- save через `baseRevision`;
- явный stale-conflict review/retry/cancel;
- validation с revision/hash/status/errors.

Studio не пишет SQLite или quest files напрямую и не хранит самостоятельный authoritative JSON.

## Запуск

```bash
npm run dev:studio
```

По умолчанию:

- Studio: `http://127.0.0.1:4173`;
- Control API запускается на loopback ephemeral port и доступен Studio через same-origin `/control/*` proxy;
- SQLite: `./data/living-history.sqlite`.

Переменные:

- `LH_DATABASE_PATH` — путь SQLite;
- `LH_CONTROL_PORT` — локальный порт Control (`0` по умолчанию);
- `LH_STUDIO_PORT` — локальный порт Studio (`4173`).

B05-02 намеренно не разрешает non-loopback Studio/Control bind до B09 auth.

## Проверка

```bash
npm run test:studio
npm run verify
```

Integration tests поднимают real file-backed SQLiteControlStore, Control HTTP и Studio proxy. Browser framework/tooling в этом bounded slice не добавлялся.

## Не входит

Player — B05-03; onboarding — B05-04; LLM — B06/B10; presentation/assets — B07; auth/publish — B09; animation suggestions и Florence — позже.
