# B01-03 — авторские схемы и минимальный пакет квеста

## Цель

Продолжить B01 после принятого первого runtime-контрактного слоя: закрепить канонические структуры авторского блока, минимального квеста/release и `ResolvedIntent`, а затем собрать из них один целостный минимальный fixture-пакет. Не переходить к исполнению действий B02.

## Вход

- `AGENTS.md`, `docs/HANDOFF.md`;
- принятые B01-01 и B01-02;
- разделы 5–7, 13 и B01 из `docs/SPECIFICATION.md`;
- `packages/contracts/schemas/v1/` и правила версий/ссылок из его README.

## Сделать

1. Зафиксировать JSON Schema v1.0 для общего `Block` envelope и минимально необходимых типов блока первого fixture.
2. Зафиксировать минимальный `QuestRelease`/manifest, который ссылается на блоки устойчивыми ID и объявляет совместимость схем.
3. Зафиксировать `ResolvedIntent` без произвольного `statePatch`, времени или неподтверждённого решения NPC.
4. Добавить положительные/отрицательные fixtures на версию, неизвестный kind, дубль/битую ссылку и malformed intent.
5. Собрать один полный минимальный fixture-пакет квеста, достаточный для последующего compile skeleton; не объявлять его уже исполняемым runtime.
6. Обновить agent-context/status/handoff/worklog и фактические проверки.

## Приёмка

- новые схемы используют тот же Draft 2020-12 и version policy B01-02;
- плохие версии, неизвестные зарегистрированному набору kind и битые ссылки отклоняются с различением schema/semantic ошибок;
- `ResolvedIntent` не содержит effect batch, `durationSeconds` или state mutation;
- минимальный пакет целостен по ID и проходит contract gate;
- `npm run verify` проходит на чистом runner;
- Core, Runtime API, storage, LLM и Studio не расширяются.

## Не делать

Action resolver, scheduler, SQLite, HTTP handlers, endpoint registry реализации, OpenAPI generation, Studio, Player, Florence migration или plugin SDK. Endpoint readiness registry, compile skeleton и воспроизводимая генерация agent docs остаются следующей bounded-подзадачей B01.
