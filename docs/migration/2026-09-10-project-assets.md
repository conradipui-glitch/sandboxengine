# Project asset library migration (Control schema v4 → v5)

`SQLiteControlStore` добавляет библиотеку ассетов проекта поверх M01/M02:

- `control_project_assets` — `(project_id, asset_id, hash, filename, mime_type, kind, width/height/duration, byte_length, listed 0/1, uploaded_by, created_at)`, PK `(project_id, asset_id)`;
- `control_project_asset_idempotency` — `(project_id, idempotency_key → asset_id, request_hash)` с FK на запись библиотеки.

`listed=0` скрывает карточку из библиотеки, но байты и запись сохраняются: опубликованные release и старые сессии продолжают читать объект по `(assetId, hash)`. Отдельной сборки мусора нет (учёт ссылок — M06 publication).

На базе v1–v4 initializer создаёт недостающие таблицы и переводит `schema_version` в `5`. Версии выше 5 — fail-closed.

Байты живут отдельно в content-addressed `LocalAssetStore` (`<data-dir>/assets`, `objects/xx/<sha256>` + immutable registry). Backup: SQLite-набор (файл + `-wal`/`-shm`, см. mission-доки) плюс каталог `assets/` целиком; объект никогда не перезаписывается, поэтому инкрементальный rsync безопасен.

Проверка после подъёма:

1. `schema_version=5`;
2. `GET .../assets` возвращает загруженное; `GET .../assets/{id}?hash=` отдаёт байт-в-байт с `cache-control: immutable`;
3. повтор upload с тем же key — replay без дубликата; чужой key на тот же payload — 409;
4. PNG с `.jpg` именем → 422 `ASSET_EXTENSION_MISMATCH`; HTML-байты → 422 `ASSET_UNSUPPORTED_TYPE`;
5. после restart список и байты те же; второй браузерный профиль читает без своей сессии upload.

Границы: `application/octet-stream` до `maxInputBytes+1` (иначе 413), метаданные только ASCII-headers (`x-asset-id`, `x-filename`, `x-claimed-mime`, `x-alt-text`, `x-source`, `x-rights`); не-ASCII текст клиент кодирует (encodeURIComponent) — M05 Studio-клиент. Studio proxy пропускает asset-тела до того же лимита и только whitelisted headers.
