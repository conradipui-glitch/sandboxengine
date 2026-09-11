// FIN-03 / B04 (repeat audit M06): an already-started public mission must keep
// access to the immutable asset bytes of *its own* revision.
//
// Defect (docs/FIN-CHECKLIST.md:11, docs/PLAN-FIN-RU.md:79-82):
//   "ассеты привязаны к текущей публикации" — the public asset route resolves
//   through the *current* publication pointer, not through the revision a
//   session/ReleaseBundle pinned. Consequences reproduced below:
//     (1) the same assetId re-uploaded with different bytes is served under the
//         published revision's URL with `cache-control: immutable`, corrupting
//         the revision's content identity;
//     (2) after a newer publication (different asset set) or an unpublish, the
//         still-open session of the old revision loses its asset (404).
//
// The plan requires the fix to serve the pinned revision via a session binding
// or via explicitly allowed immutable published objects (PLAN-FIN-RU.md:81).
// The assertions below accept either mechanism: they look for the bytes at the
// mission URL and, failing that, at a session-scoped asset URL.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlPublicationStore,
  MemoryControlReleaseStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  return out;
}

// A real, decodable PNG whose bytes differ per seed (content identity changes).
function pngBytes(seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const tail = createHash("sha256").update(String(seed)).digest().subarray(0, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.concat([Buffer.from("seed\0", "ascii"), tail])),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function world() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}

function missionWithBackground(assetId, hash) {
  return {
    schemaVersion: "1.0", projectId: "project", questId: "quest", contentRevision: 0, contentHash: "",
    listing: { title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"] },
    story: {
      entrySceneId: "start",
      scenes: [{
        id: "start", title: "Старт", text: "Ночь.", dialogue: [],
        choices: [{ id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] }]
      }],
      endings: [{ id: "done", title: "Готово", text: "Рассвет." }]
    },
    screens: {
      intros: [],
      scenes: assetId
        ? { start: { background: { assetId, hash }, inheritBackground: false, layers: [], music: null } }
        : {},
      endings: {}
    },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-fin03-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = new MemoryControlReleaseStore();
  const publications = new MemoryControlPublicationStore();
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "start",
    initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {} }]
  });
  const control = createControlHttpServer({
    store,
    missionStore: store,
    assetLibrary: store,
    assetStorage: new LocalAssetStore(join(dir, "objects")),
    releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry, publicMissionSessionSecret: "test-public-session-secret-123" }
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  t.after(async () => {
    await control.close();
    publications.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const upload = async (assetId, key, bytes) => {
    const response = await fetch(`${base}/control/v1/projects/project/assets`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "idempotency-key": key, "x-asset-id": assetId, "x-filename": `${assetId}.png`, "x-alt-text": "background" },
      body: bytes
    });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    return JSON.parse(body).manifest;
  };
  const save = async (baseRevision, key, assetId, hash) => {
    const saved = await store.saveMission("project", "quest", {
      baseRevision, mission: missionWithBackground(assetId, hash), idempotencyKey: key, actorUserId: "owner"
    });
    assert.equal(saved.kind, "saved");
    return saved.mission;
  };
  const buildRelease = async (releaseId, key) => {
    // The release is built from the single authored draft snapshot (revision 0);
    // the immutable *mission* revision a release pins is resolved at publish.
    const validation = await store.validateDraft("project", "quest", 0);
    assert.equal(validation.kind, "validated");
    const release = await buildControlRelease(
      { controlStore: store, releaseStore, pluginRegistry: built.registry },
      { projectId: "project", questId: "quest", releaseId, draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: key }
    );
    assert.equal(release.kind, "created");
    return release.release;
  };
  const publish = async (releaseId, expectedCurrentReleaseId, key) => {
    const response = await fetch(`${base}/control/v1/projects/project/quests/quest/publish`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ releaseId, expectedCurrentReleaseId })
    });
    const body = await response.text();
    return { status: response.status, body };
  };
  const unpublish = async (expectedReleaseId, key) => {
    const response = await fetch(`${base}/control/v1/projects/project/quests/quest/publication/unpublish`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ publicMissionId: "mission:project:quest", expectedReleaseId })
    });
    return { status: response.status, body: await response.text() };
  };
  const startSession = async (sessionId, key) => {
    const response = await fetch(`${base}/public/v1/missions/cargo/sessions`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ sessionId, initialWorld: world() })
    });
    const body = await response.json();
    return { status: response.status, body };
  };
  // Fetch an asset for an (optionally) specific open session. Accepts either
  // the mission-scoped URL or a session-scoped one, so the test does not
  // prescribe which mechanism the fix uses.
  const getAsset = async (assetId, session) => {
    const candidates = [`${base}/public/v1/missions/cargo/assets/${assetId}`];
    if (session) candidates.push(`${base}/public/v1/missions/cargo/sessions/${session.sessionId}/assets/${assetId}`);
    let last = null;
    for (const url of candidates) {
      const response = await fetch(url, { headers: session ? { authorization: `Bearer ${session.credential}` } : {} });
      if (response.status === 200) {
        const bytes = Buffer.from(await response.arrayBuffer());
        return { status: 200, hash: sha256(bytes), contentType: response.headers.get("content-type"), cacheControl: response.headers.get("cache-control"), url };
      }
      last = { status: response.status, hash: null, contentType: response.headers.get("content-type"), cacheControl: response.headers.get("cache-control"), url };
    }
    return last;
  };

  return { base, store, publications, upload, save, buildRelease, publish, unpublish, startSession, getAsset };
}

test("FIN-03/B04: a published revision never serves re-uploaded bytes of the same assetId as immutable", async (t) => {
  const h = await harness(t);
  const firstBytes = pngBytes("background-A");
  const firstHash = sha256(firstBytes);
  assert.equal((await h.upload("cellar-bg", "asset-1", firstBytes)).hash, firstHash);

  const v1 = await h.save(0, "save-1", "cellar-bg", firstHash);
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);

  const servedFirst = await h.getAsset("cellar-bg");
  assert.equal(servedFirst.status, 200);
  assert.equal(servedFirst.hash, firstHash, "r1 serves r1's bytes");

  // The release pinned r1's content identity: the asset manifest records the
  // hash of the pixels the revision actually referenced.
  const pin = await h.publications.getReleasePin("project", "quest", "release-1");
  assert.deepEqual(pin.assets, [{ assetId: "cellar-bg", hash: firstHash }]);

  // The same assetId is re-uploaded with different pixels (library entry now
  // points at new bytes; the content-addressed object store still holds both).
  const secondBytes = pngBytes("background-B");
  const secondHash = sha256(secondBytes);
  assert.notEqual(secondHash, firstHash);
  assert.equal((await h.upload("cellar-bg", "asset-2", secondBytes)).hash, secondHash);

  // A player of the still-published r1 asks for the revision's asset.
  const served = await h.getAsset("cellar-bg");
  // Defect: returns 200 with the *new* bytes and `immutable`, silently
  // rewriting the published revision's content identity.
  assert.notEqual(
    served.hash,
    secondHash,
    `a published revision must not serve changed bytes under its asset identity: served=${served.hash} reuploaded=${secondHash} pinned=${firstHash} cache-control=${served.cacheControl ?? "-"}`
  );
  if (served.status === 200) {
    assert.equal(served.hash, firstHash, "if served, the published revision must return its pinned bytes");
  }
  assert.equal(served.contentType, "image/png");
});

test("FIN-03/B04: an open session keeps its revision's assets after a newer publication and after unpublish", async (t) => {
  const h = await harness(t);
  const bytesA = pngBytes("background-A");
  const hashA = sha256(bytesA);
  const bytesB = pngBytes("background-B");
  const hashB = sha256(bytesB);
  assert.equal((await h.upload("bg-a", "asset-a", bytesA)).hash, hashA);
  assert.equal((await h.upload("bg-b", "asset-b", bytesB)).hash, hashB);

  const v1 = await h.save(0, "save-1", "bg-a", hashA);
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);

  const sessionA = await h.startSession("session-a", "public-sess-a");
  assert.equal(sessionA.status, 201, JSON.stringify(sessionA.body));
  assert.equal(sessionA.body.session.contentRevision, v1.contentRevision);
  assert.equal(typeof sessionA.body.credential, "string");
  const player = { sessionId: "session-a", credential: sessionA.body.credential };

  // The open session can reach its revision's asset today.
  const before = await h.getAsset("bg-a", player);
  assert.equal(before.status, 200);
  assert.equal(before.hash, hashA);

  // The author edits the mission to a different asset set and publishes r2.
  const v2 = await h.save(v1.contentRevision, "save-2", "bg-b", hashB);
  assert.notEqual(v2.contentHash, v1.contentHash);
  await h.buildRelease("release-2", "build-2");
  assert.equal((await h.publish("release-2", "release-1", "publish-2")).status, 200);

  const newGame = await h.startSession("session-b", "public-sess-b");
  assert.equal(newGame.status, 201);
  assert.equal(newGame.body.session.contentRevision, v2.contentRevision);
  assert.equal((await h.getAsset("bg-b", { sessionId: "session-b", credential: newGame.body.credential })).hash, hashB);

  // Defect (a): the still-open r1 session loses its own asset after r2 ships,
  // because the asset route resolves through the current publication.
  const afterR2 = await h.getAsset("bg-a", player);
  assert.equal(afterR2.status, 200, "an open r1 session must keep resolving r1's asset after r2 is published");
  assert.equal(afterR2.hash, hashA, "and it must be r1's pinned bytes");

  // Unpublish withdraws the *mission* (no new games) but must not strip the
  // immutable assets of a game that is already in progress.
  assert.equal((await h.unpublish("release-2", "unpublish-1")).status, 200);
  assert.equal((await h.startSession("session-c", "public-sess-c")).status, 404, "new games are blocked after unpublish");

  // Defect (b): the open r1 session loses its asset on unpublish.
  const afterUnpublish = await h.getAsset("bg-a", player);
  assert.equal(afterUnpublish.status, 200, "an open session must keep its revision's asset after unpublish");
  assert.equal(afterUnpublish.hash, hashA);
});

test("FIN-03/B04: unpublish withdraws new games but not the assets of an already-started game", async (t) => {
  const h = await harness(t);
  const bytesA = pngBytes("background-A");
  const hashA = sha256(bytesA);
  assert.equal((await h.upload("bg-a", "asset-a", bytesA)).hash, hashA);

  const v1 = await h.save(0, "save-1", "bg-a", hashA);
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);
  const started = await h.startSession("session-a", "public-sess-a");
  assert.equal(started.status, 201);
  const player = { sessionId: "session-a", credential: started.body.credential };
  assert.equal((await h.getAsset("bg-a", player)).hash, hashA);

  assert.equal((await h.unpublish("release-1", "unpublish-1")).status, 200);
  // The mission is withdrawn from the catalog, so no new game may start...
  assert.equal((await h.startSession("session-b", "public-sess-b")).status, 404);
  // ...but the running game must keep the bytes its revision referenced
  // (PLAN-FIN-RU.md:46 rule 6, FIN-03 acceptance: "старая игра получает A").
  const served = await h.getAsset("bg-a", player);
  assert.equal(served.status, 200, "unpublish must not strip the assets of an already-started game");
  assert.equal(served.hash, hashA);
  assert.equal(served.contentType, "image/png");
  assert.equal(v1.contentRevision >= 1, true);
});

// FIN-03 (волна 3): байты публичной ревизии отдаются по СТАБИЛЬНОМУ адресу, в
// котором нет хэша контента. Значит «immutable» тут — разрешение общему кэшу
// закрепить старые байты под этим адресом на год. Маршрут обязан требовать
// ревалидацию и отдавать 304 только при совпадении ревизии.
test("FIN-03 (hosted): a revision-bound asset URL is not immutable and revalidates by revision", async (t) => {
  const h = await harness(t);
  const bytes = pngBytes("background-A");
  const hash = sha256(bytes);
  assert.equal((await h.upload("cellar-bg", "asset-1", bytes)).hash, hash);
  await h.save(0, "save-1", "cellar-bg", hash);
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);

  const url = `${h.base}/public/v1/missions/cargo/assets/cellar-bg`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  const cacheControl = first.headers.get("cache-control") ?? "";
  const etag = first.headers.get("etag");
  assert.ok(!/immutable/i.test(cacheControl), `immutable must never be emitted for a non-hashed path: ${cacheControl}`);
  assert.ok(/no-cache|no-store/i.test(cacheControl), `the route must require revalidation: ${cacheControl}`);
  assert.equal(typeof etag, "string");

  // Тот же адрес + тот же ETag → 304, тело не пересылается.
  const revalidated = await fetch(url, { headers: { "if-none-match": etag } });
  assert.equal(revalidated.status, 304);
  assert.equal((await revalidated.arrayBuffer()).byteLength, 0);

  // Смена ревизии → другой ETag, и старый ETag больше не даёт 304.
  const secondBytes = pngBytes("background-B");
  const secondHash = sha256(secondBytes);
  assert.equal((await h.upload("cellar-bg", "asset-2", secondBytes)).hash, secondHash);
  await h.save(1, "save-2", "cellar-bg", secondHash);
  await h.buildRelease("release-2", "build-2");
  assert.equal((await h.publish("release-2", "release-1", "publish-2")).status, 200);

  const afterR2 = await fetch(url, { headers: { "if-none-match": etag } });
  assert.equal(afterR2.status, 200, "a stale ETag must not satisfy a newer revision");
  assert.notEqual(afterR2.headers.get("etag"), etag);
});

// FIN-05 (волна 3): маршрут хода на авторской стороне обязан отдавать позицию
// истории и статусы выборов, посчитанные движком, — раньше ответ содержал сырую
// сессию, и клиент достраивал переход сам.
test("FIN-05 (wiring): the author-side turn route answers with the engine's projected state", async (t) => {
  const h = await harness(t);
  const bytes = pngBytes("background-A");
  const hash = sha256(bytes);
  assert.equal((await h.upload("start-bg", "asset-1", bytes)).hash, hash);
  await h.save(0, "save-1", "start-bg", hash);
  await h.buildRelease("release-1", "build-1");
  assert.equal((await h.publish("release-1", null, "publish-1")).status, 200);

  const started = await h.startSession("session-a", "public-sess-a");
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const sessionId = started.body.session.sessionId;

  const turn = async (key, body) => {
    const response = await fetch(`${h.base}/control/v1/projects/project/quests/quest/mission/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  const applied = await turn("turn-1", { baseTurn: 0, choiceId: "finish" });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(typeof applied.body.state, "object", "the reply must carry the projected story state");
  assert.equal(applied.body.state.position.turn, 1);
  assert.equal(applied.body.state.position.endingId, "done");
  assert.equal(applied.body.state.position.terminal, true);
  assert.ok(Array.isArray(applied.body.state.options), "options must be the engine's list, not the client's guess");

  // Тот же ключ хода — повтор, а не второй ход.
  const replay = await turn("turn-1", { baseTurn: 0, choiceId: "finish" });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.state.position.turn, 1, "a replay must not advance the story");
});
