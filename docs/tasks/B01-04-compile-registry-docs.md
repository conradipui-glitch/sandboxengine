# B01-04 — compile skeleton, readiness registry и generated contracts

## Цель

Закрыть оставшийся каркас общего B01 после принятых B01-01…03: доказать, что канонический fixture-пакет можно детерминированно проверить/скомпилировать в immutable artifact, а документация и перечень HTTP-возможностей генерируются из фактических реестров, не обещая ещё не реализованный Runtime API.

## Вход

- `AGENTS.md`, `docs/HANDOFF.md`;
- B01-01…03 и `packages/contracts/schemas/v1/`;
- разделы 4, 6.4, 13, 15, B01 и 20 `docs/SPECIFICATION.md`.

## Сделать

1. Добавить минимальный `compileQuest` skeleton: загрузка уже schema-valid блоков/release, semantic checks, детерминированный normalized artifact/manifest и hash. Он не исполняет действия.
2. Зафиксировать endpoint readiness registry. Реестр может содержать planned записи, но generated OpenAPI/agent capabilities экспортируют только реально available operations; если HTTP runtime ещё отсутствует, не выдавать planned endpoint за рабочий.
3. Добавить `docs:generate` и усилить `docs:check`: детерминированно получать текущие schema index/compatibility и минимальный agent contract из registry/schema metadata.
4. Собрать второй маленький fixture-пакет другой предметной области (`transfer-desk`/«Стол находок») без Florence-specific веток.
5. Проверить одинаковый input → одинаковый artifact/hash; malformed/broken package не выдаёт artifact.
6. Обновить STATUS/HANDOFF/worklog фактическими результатами и решить, принят ли B01 в целом.

## Приёмка

- `npm run verify` на чистом runner;
- два fixture-пакета проходят compile skeleton и дают стабильные hashes;
- изменённый содержательный input меняет hash;
- broken reference/version блокирует compile без частичного результата;
- `docs:generate` повторяем, `docs:check` падает на stale generated contract;
- generated agent/API docs не содержат будущих endpoints/capabilities как available;
- Core остаётся без HTTP/storage/LLM/React/Cloudflare;
- после этого можно отдельно оценить полный B01 по требованиям ТЗ, но не автоматически начинать B02 при незакрытой приёмке.

## Не делать

Action resolver, scheduler, серверные handlers, SQLite, authentication, AI providers, Studio/Player UI, Florence migration, plugin SDK или deployment.
