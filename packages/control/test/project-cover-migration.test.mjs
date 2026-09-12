import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteControlStore } from "../dist/index.js";

const HASH = "c".repeat(64);

test("COVER-02: SQLite v6 project table migrates to CAS cover columns without losing project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-project-cover-migration-"));
  const path = join(dir, "control.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE control_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
      INSERT INTO control_meta (key, value) VALUES ('schema_version', 6);
      CREATE TABLE control_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;
      INSERT INTO control_projects (project_id, title) VALUES ('legacy-project', 'Старый проект');
    `);
    legacy.close();

    const store = new SQLiteControlStore({ path });
    try {
      assert.deepEqual(await store.listProjects(), [{
        projectId: "legacy-project",
        title: "Старый проект",
        cover: null,
        coverRevision: 0
      }]);
      const set = await store.setProjectCover("legacy-project", {
        baseRevision: 0,
        cover: { assetId: "cover-asset", hash: HASH },
        idempotencyKey: "legacy-cover-1",
        actorUserId: "owner"
      });
      assert.equal(set.kind, "updated");
      assert.equal(set.project.cover?.hash, HASH);
      assert.equal(set.project.coverRevision, 1);
    } finally {
      store.close();
    }

    const migrated = new DatabaseSync(path);
    try {
      const columns = migrated.prepare("PRAGMA table_info(control_projects)").all().map((row) => String(row.name));
      assert.ok(columns.includes("cover_asset_id"));
      assert.ok(columns.includes("cover_hash"));
      assert.ok(columns.includes("cover_revision"));
      assert.equal(Number(migrated.prepare("SELECT value FROM control_meta WHERE key = 'schema_version'").get().value), 7);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
