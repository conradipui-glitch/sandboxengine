# MissionDocument migration (Control schema v2 → v3)

`SQLiteControlStore` поднимает существующую Control SQLite базу и атомарно создаёт:

- `control_mission_documents` — append-only ревизии `{project_id, quest_id, content_revision, content_hash, mission_json, actor_user_id, created_at_ms}`, PK `(project_id, quest_id, content_revision)`;
- `control_mission_idempotency` — `(project_id, quest_id, idempotency_key, request_hash, result_revision, result_json, actor_user_id, created_at_ms)` с FK на ревизию-документ.

На базе с `control_meta.schema_version=1|2` initializer создаёт недостающие таблицы (`CREATE IF NOT EXISTS`) и переводит `schema_version` в `3`. Версии выше 3 отклоняются fail-closed. Draft/board таблицы и content hashes не изменяются.

## Backup before restart

Остановить только процесс, использующий конкретный `RUNTIME_DB_PATH`, затем сохранить базовый файл и SQLite sidecars согласованно:

```text
control.sqlite  → backup/control.sqlite.pre-mission-document
control.sqlite-wal / control.sqlite-shm → backup/ (если существуют)
```

Не копировать живую SQLite-базу по одному файлу во время записи. После backup запустить тот же runtime и проверить:

1. `schema_version=3`;
2. `getMission` на новом квесте возвращает `null`;
3. `saveMission` с новым `idempotencyKey` создаёт revision 1 с 64-hex `contentHash`;
4. повтор того же payload/key возвращает replay без нового increment;
5. история содержит все ревизии по порядку; export возвращает последнюю.

Откат выполняется только после остановки runtime: вернуть согласованный backup-набор, не смешивая WAL/SHM от разных состояний.

## Bounds and write rules

Mission mutations проходят owner/editor permission gate (M06 HTTP), required `idempotencyKey` формата `[A-Za-z0-9][A-Za-z0-9._:-]{0,199}`, structural + semantic validation (`mission.*` коды) до записи, atomic CAS по `baseRevision`. Hash покрывает listing/story/screens/defaults без self-reference. BoardDocument/boardRevision остаются отдельными.
