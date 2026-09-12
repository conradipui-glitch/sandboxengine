# BoardDocument migration (Control schema v1 → v2)

`SQLiteControlStore` поднимает существующую Control SQLite базу и атомарно создаёт:

- `control_board_documents` — `{schema_version, project_id, quest_id, board_revision, positions_json, updated_by, updated_at_ms}`;
- `control_board_idempotency` — `(project_id, quest_id, idempotency_key, request_hash, result_revision, result_json, actor_user_id, created_at_ms)`.

На старой базе с `control_meta.schema_version=1` initializer создаёт недостающие таблицы и переводит `schema_version` в `2`. Версии выше 2 отклоняются fail-closed. Canonical draft tables/content hashes не изменяются.

## Backup before restart

Остановить только процесс, использующий конкретный `RUNTIME_DB_PATH`, затем сохранить базовый файл и SQLite sidecars согласованно:

```text
control.sqlite  → backup/control.sqlite.pre-board-document
control.sqlite-wal / control.sqlite-shm → backup/ (если существуют)
```

Не копировать живую SQLite-базу по одному файлу во время записи. После backup запустить тот же runtime и проверить:

1. `schema_version=2`;
2. GET `/control/v1/projects/:projectId/quests/:questId/board` возвращает `boardRevision` и `positions`;
3. POST с новым `idempotency-key` увеличивает revision ровно на один;
4. повтор того же payload/key возвращает replay без нового increment;
5. после остановки/старта и из второго браузерного профиля документ тот же.

Откат выполняется только после остановки runtime: вернуть согласованный backup-набор, не смешивая WAL/SHM от разных состояний.

## Bounds and write rules

Board mutations проходят owner/editor permission gate, required `idempotency-key`, finite coordinates `[-1000000, 1000000]`, максимум 1000 positions и atomic CAS по `baseRevision`. Layout не является draft change и не попадает в `contentHash`.
