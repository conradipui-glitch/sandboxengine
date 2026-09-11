import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlPublicationStore, SQLiteControlPublicationStore } from "@living-history/control";

// R-28 (финальное код-ревью, зона 4): идемпотентный повтор `unpublish` возвращал
// «успех» из журнала ДО проверки CAS `expectedReleaseId`. Повторная доставка
// с устаревшим ожидаемым выпуском сообщала автору «снято с публикации», хотя
// живым выпуском уже был другой: контракт `expectedReleaseId` — это CAS-guard,
// и он обязан проверяться на всех путях, включая повтор.

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

function record(overrides = {}) {
  return {
    schemaVersion: "1.0",
    publicMissionId: "mission-1",
    slug: "mission-one",
    projectId: "project-1",
    questId: "quest-1",
    draftRevision: 3,
    draftContentHash: H1,
    releaseId: "rel-1",
    contentHash: H1,
    channel: "production",
    status: "published",
    publishedAtMs: 1_700_000_000_000,
    listing: {
      title: "История", slug: "mission-one", summary: "Найти груз.", coverAssetId: null,
      period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"]
    },
    ...overrides
  };
}

async function harness(kind, t) {
  if (kind === "memory") return { store: new MemoryControlPublicationStore(), cleanup: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), "living-history-unpublish-replay-"));
  const store = new SQLiteControlPublicationStore({ path: join(dir, "control.sqlite") });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, cleanup: async () => {} };
}

for (const kind of ["memory", "sqlite"]) {
  test(`R-28 (${kind}): повтор unpublish с устаревшим expectedReleaseId даёт конфликт, а не «успех»`, async (t) => {
    const { store } = await harness(kind, t);

    // 1. Публикация rel-1.
    const first = await store.publish({ record: record(), idempotencyKey: "pub-1", requestHash: H1 });
    assert.equal(first.kind, "published");

    // 2. Снятие с публикации с ожиданием rel-1.
    const slug = record().slug;
    const un = await store.unpublish({ publicMissionId: "mission-1", expectedReleaseId: "rel-1", idempotencyKey: "unpub-1", requestHash: H1 });
    assert.equal(un.kind, "unpublished");
    assert.equal(un.publication.status, "unlisted");

    // 3. Новый выпуск rel-2 становится живым.
    const second = await store.publish({ record: record({ releaseId: "rel-2", contentHash: H2, draftContentHash: H2 }), idempotencyKey: "pub-2", requestHash: H2 });
    assert.equal(second.kind, "published");

    // 4. Повторная доставка того же unpublish (тот же ключ и хеш запроса) с устаревшим
    //    expectedReleaseId: живой выпуск — rel-2, поэтому обязан быть конфликт.
    const replayStale = await store.unpublish({ publicMissionId: "mission-1", expectedReleaseId: "rel-1", idempotencyKey: "unpub-1", requestHash: H1 });
    assert.notEqual(replayStale.kind, "replay");
    assert.equal(replayStale.kind, "current_release_conflict");
    assert.equal(replayStale.currentReleaseId, "rel-2");

    // Живая запись не изменилась: миссия остаётся опубликованной под rel-2.
    const live = await store.getPublicMission("mission-one");
    assert.equal(live.status, "published");
    assert.equal(live.releaseId, "rel-2");
    assert.equal(slug, "mission-one");
  });

  test(`R-28 (${kind}): повтор unpublish без вмешательства остаётся идемпотентным`, async (t) => {
    const { store } = await harness(kind, t);
    assert.equal((await store.publish({ record: record(), idempotencyKey: "pub-1", requestHash: H1 })).kind, "published");
    assert.equal((await store.unpublish({ publicMissionId: "mission-1", expectedReleaseId: "rel-1", idempotencyKey: "unpub-1", requestHash: H1 })).kind, "unpublished");

    const again = await store.unpublish({ publicMissionId: "mission-1", expectedReleaseId: "rel-1", idempotencyKey: "unpub-1", requestHash: H1 });
    assert.equal(again.kind, "replay");
    assert.equal(again.publication.status, "unlisted");

    // Тот же ключ, другой хеш запроса — это уже переиспользование ключа, а не повтор.
    const reused = await store.unpublish({ publicMissionId: "mission-1", expectedReleaseId: "rel-1", idempotencyKey: "unpub-1", requestHash: H2 });
    assert.equal(reused.kind, "idempotency_key_reused");
  });
}
