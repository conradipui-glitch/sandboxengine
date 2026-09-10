import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlPublicationStore,
  SQLiteControlPublicationStore
} from "../dist/publication-store.js";

const listing = {
  title: "Пропавший груз",
  slug: "missing-cargo",
  summary: "Ночная станция и два решения.",
  coverAssetId: null,
  period: "1917",
  place: "Петроград",
  playerRole: "Распорядитель станции",
  estimatedMinutes: 20,
  supportedModes: ["choice"]
};

async function run(name, create) {
  await test(name, async () => {
    const store = await create();
    try {
      const first = await store.publish({
        record: {
          schemaVersion: "1.0", publicMissionId: "mission:p:q", slug: listing.slug,
          projectId: "p", questId: "q", draftRevision: 3, draftContentHash: "d".repeat(64), releaseId: "release-1", contentHash: "a".repeat(64),
          channel: "production", status: "published", listing, publishedAtMs: 10
        },
        idempotencyKey: "pub-1",
        requestHash: "b".repeat(64)
      });
      assert.equal(first.kind, "published");
      assert.equal((await store.listPublished()).length, 1);
      assert.equal((await store.getPublicMission("missing-cargo"))?.releaseId, "release-1");
      const replay = await store.publish({
        record: first.publication,
        idempotencyKey: "pub-1",
        requestHash: "b".repeat(64)
      });
      assert.equal(replay.kind, "replay");
      const changed = await store.publish({
        record: { ...first.publication, releaseId: "release-2", contentHash: "c".repeat(64), publishedAtMs: 20 },
        idempotencyKey: "pub-2",
        requestHash: "d".repeat(64)
      });
      assert.equal(changed.kind, "published");
      assert.equal((await store.getPublicMission("mission:p:q"))?.releaseId, "release-2");
      const hidden = await store.unpublish({
        publicMissionId: "mission:p:q", expectedReleaseId: "release-2", idempotencyKey: "unpub-1", requestHash: "e".repeat(64)
      });
      assert.equal(hidden.kind, "unpublished");
      assert.equal((await store.listPublished()).length, 0);
    } finally {
      store.close?.();
    }
  });
}

await run("M06 publication store: Memory publish/replay/update/unpublish", async () => new MemoryControlPublicationStore());
await run("M06 publication store: SQLite survives reopen and keeps public record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lh-publication-"));
  const path = join(dir, "control.sqlite");
  const first = new SQLiteControlPublicationStore({ path });
  const originalClose = first.close.bind(first);
  (first).close = () => { originalClose(); void rm(dir, { recursive: true, force: true }); };
  return first;
});
