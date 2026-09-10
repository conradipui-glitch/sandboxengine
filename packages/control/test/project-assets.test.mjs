import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteControlStore } from "../dist/index.js";

function entry(hash) {
  return {
    assetId: "hero-knight",
    hash,
    filename: "knight.png",
    mimeType: "image/png",
    kind: "image",
    widthPx: 64,
    heightPx: 64,
    durationMs: null,
    byteLength: 128
  };
}

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "living-history-assets-"));
  const path = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  await store.createProject({ projectId: "project", title: "Проект" });
  return { dir, path, store };
}

test("M03 project asset library: register/list/unlist keeps bytes referenced", async () => {
  const { dir, path, store } = await makeStore();
  try {
    assert.deepEqual(await store.listProjectAssets("project", true), []);
    const first = await store.registerProjectAsset("project", {
      ...entry("a".repeat(64)),
      idempotencyKey: "asset-1",
      actorUserId: "owner"
    });
    assert.equal(first.kind, "registered");

    const replay = await store.registerProjectAsset("project", {
      ...entry("a".repeat(64)),
      idempotencyKey: "asset-1",
      actorUserId: "owner"
    });
    assert.equal(replay.kind, "replay");

    const second = await store.registerProjectAsset("project", {
      ...entry("b".repeat(64)),
      assetId: "hero-mage",
      filename: "mage.png",
      idempotencyKey: "asset-2",
      actorUserId: "owner"
    });
    assert.equal(second.kind, "registered");

    const listed = await store.listProjectAssets("project", true);
    assert.deepEqual(listed.map((row) => row.assetId).sort(), ["hero-knight", "hero-mage"]);

    const unlisted = await store.setProjectAssetListed("project", "hero-mage", false, "owner");
    assert.equal(unlisted.kind, "updated");
    assert.deepEqual((await store.listProjectAssets("project", true)).map((row) => row.assetId), ["hero-knight"]);
    assert.deepEqual(
      (await store.listProjectAssets("project", false)).map((row) => row.assetId).sort(),
      ["hero-knight", "hero-mage"]
    );

    const unknown = await store.registerProjectAsset("nope", {
      ...entry("a".repeat(64)),
      idempotencyKey: "asset-9",
      actorUserId: "owner"
    });
    assert.equal(unknown.kind, "project_not_found");

    store.close();
    const reopened = new SQLiteControlStore({ path });
    try {
      assert.deepEqual((await reopened.listProjectAssets("project", true)).map((row) => row.assetId), ["hero-knight"]);
      const db = new DatabaseSync(path);
      const row = db.prepare("SELECT value FROM control_meta WHERE key = 'schema_version'").get();
      db.close();
      assert.equal(Number(row.value), 5);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
