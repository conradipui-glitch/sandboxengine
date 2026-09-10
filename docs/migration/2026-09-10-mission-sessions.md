# Mission sessions migration (Control schema v3 → v4)

`SQLiteControlStore` добавляет durable mission sessions поверх M01-документов:

- `control_mission_sessions` — `(session_id PK, project_id, quest_id, content_revision, content_hash, current_scene_id, world_json, turn, actor, created/updated)` с FK на точную ревизию `control_mission_documents`;
- `control_mission_session_idempotency` — `(project_id, quest_id, idempotency_key → session_id, request_hash)`;
- `control_mission_turn_idempotency` — `(session_id, idempotency_key → base_turn, result_json {session, target})`.

Сессия привязывается к точному `(contentRevision, contentHash)`; ход коммитит эффекты и переход сцены вместе (CAS по `turn`, `UPDATE ... WHERE turn = ?` + проверка `changes`). Повтор с тем же key возвращает replay без нового increment; чужой key на тот же payload — `idempotency_key_reused`.

На базе v1–v3 initializer создаёт недостающие таблицы и переводит `schema_version` в `4`. Версии выше 4 — fail-closed.

Backup/rollback — как в `2026-09-10-mission-document.md` (остановить writer, скопировать файл + `-wal`/`-shm` согласованно). Проверка после подъёма:

1. `schema_version=4`;
2. `getMissionSession` после close/open возвращает ту же сцену/turn/hash;
3. новый ход от `baseTurn` применяется ровно один раз; повтор key — replay;
4. VPS prod path (`apps/server/src/main.ts`) уже использует `SQLitePublishedSessionBindingStore` на общем volume — resume идёт через durable binding, а не Memory store (`deploy/vps/authored-server.mjs` — legacy standalone, в compose не используется).
