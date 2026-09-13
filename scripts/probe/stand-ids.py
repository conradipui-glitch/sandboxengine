#!/usr/bin/env python3
"""Список проектов и квестов стенда (только чтение, без секретов)."""
import sqlite3

DB = "/data/living-history.sqlite"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
cur = con.cursor()
names = [row[0] for row in cur.execute("select name from sqlite_master where type = 'table' order by name")]
print("tables:", len(names))
for table in ("control_projects", "control_quests", "control_missions"):
    if table not in names:
        print(f"{table}: отсутствует")
        continue
    cols = [row[1] for row in cur.execute(f"pragma table_info({table})")]
    print(f"{table}: {cols}")
    for row in cur.execute(f"select * from {table} limit 8"):
        record = dict(zip(cols, row))
        slim = {k: (str(v)[:60] if v is not None else None) for k, v in record.items()
                if k in ("id", "identifier", "project_id", "quest_id", "title", "slug", "status", "updated_at_ms")}
        print("  ", slim)
