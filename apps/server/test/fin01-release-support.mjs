// Support harness for the FIN-01/B02 adversarial verification tests.
//
// This file is deliberately NOT named *.test.mjs so `node --test
// apps/server/test/*.test.mjs` does not execute it as a suite. It mirrors the
// real-wiring harness of fin01-release-bundle.test.mjs (SQLiteControlStore +
// publication store + createControlHttpServer, no mocks).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlReleaseStore,
  MemoryControlPublicationStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

export const SECRET = "test-public-session-secret-123";

export function world() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}

export function mission(text, background) {
  return {
    schemaVersion: "1.0", projectId: "project", questId: "quest", contentRevision: 0, contentHash: "",
    listing: { title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice"] },
    story: {
      entrySceneId: "start",
      scenes: [{
        id: "start", title: "Старт", text, dialogue: [],
        choices: [{ id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] }]
      }],
      endings: [{ id: "done", title: "Готово", text: "Рассвет." }]
    },
    screens: {
      intros: [],
      scenes: background
        ? { start: { background: { assetId: background.assetId, hash: background.hash }, inheritBackground: false, layers: [], music: null } }
        : {},
      endings: {}
    },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

export function pngBytes(seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    Buffer.from(data).copy(out, 8);
    return out;
  };
  const tail = createHash("sha256").update(String(seed)).digest().subarray(0, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.concat([Buffer.from("seed\0", "ascii"), tail])),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function harness(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-fin01-verify-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const releaseStore = options.releaseStore ?? new MemoryControlReleaseStore();
  const publications = options.publicationStore ?? new MemoryControlPublicationStore();
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "start",
    initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {} }]
  });
  const servers = [];
  const extras = [];
  const openServer = async (publicationStore) => {
    const control = createControlHttpServer({
      store,
      missionStore: store,
      assetLibrary: store,
      assetStorage: new LocalAssetStore(join(dir, "objects")),
      releases: {
        store: releaseStore,
        publicationStore,
        pluginRegistry: built.registry,
        publicMissionSessionSecret: SECRET
      }
    });
    const address = await control.listen();
    servers.push(control);
    return `http://${address.host}:${address.port}`;
  };
  let base = await openServer(publications);

  const isBinary = (value) => typeof value === "object" && value !== null
    && (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer);
  const raw = async (method, path, { body, key, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined || typeof body === "string" || isBinary(body) ? {} : { "content-type": "application/json" }),
        ...(key ? { "idempotency-key": key } : {}),
        ...headers
      },
      ...(body === undefined ? {} : { body: typeof body === "string" || isBinary(body) ? body : JSON.stringify(body) })
    });
    const contentType = response.headers.get("content-type") ?? "";
    const bytes = Buffer.from(await response.arrayBuffer());
    let parsed = null;
    if (contentType.includes("json")) { try { parsed = JSON.parse(bytes.toString("utf8")); } catch { /* empty */ } }
    return { status: response.status, body: parsed, bytes, contentType };
  };
  const posts = (path, body, key) => raw("POST", path, { body, key });
  const get = (path, headers) => raw("GET", path, { headers });

  const saveMission = async (text, baseRevision, key, background) => {
    const saved = await store.saveMission("project", "quest", {
      baseRevision, mission: mission(text, background), idempotencyKey: key, actorUserId: "owner"
    });
    assert.equal(saved.kind, "saved");
    return saved.mission;
  };
  // Direct authority call: builds a release WITHOUT going through the HTTP
  // route (so the route's best-effort build-time freeze does not run). This is
  // how a release created by an older server looks.
  const buildRelease = async (releaseId, key, draftRevision = 0) => {
    const validation = await store.validateDraft("project", "quest", draftRevision);
    assert.equal(validation.kind, "validated");
    const release = await buildControlRelease(
      { controlStore: store, releaseStore, pluginRegistry: built.registry },
      { projectId: "project", questId: "quest", releaseId, draftRevision, validationId: validation.validation.validationId, idempotencyKey: key }
    );
    assert.equal(release.kind, "created");
    return release.release;
  };
  // Release build through the real HTTP route (runs the best-effort freeze).
  const buildReleaseHttp = async (releaseId, key, draftRevision = 0) => {
    const validation = await store.validateDraft("project", "quest", draftRevision);
    assert.equal(validation.kind, "validated");
    return posts("/control/v1/projects/project/quests/quest/releases", {
      releaseId, draftRevision, validationId: validation.validation.validationId
    }, key);
  };
  const publish = (releaseId, expectedCurrentReleaseId, key) =>
    posts("/control/v1/projects/project/quests/quest/publish", { releaseId, expectedCurrentReleaseId }, key);
  const rollback = (targetReleaseId, expectedCurrentReleaseId, key) =>
    posts("/control/v1/projects/project/quests/quest/rollback", { targetReleaseId, expectedCurrentReleaseId }, key);
  const startSession = (sessionId, key, slug = "cargo") =>
    posts(`/public/v1/missions/${slug}/sessions`, { sessionId, initialWorld: world() }, key);
  const uploadPng = (assetId, key, bytes) => raw("POST", "/control/v1/projects/project/assets", {
    key,
    headers: {
      "content-type": "application/octet-stream",
      "x-asset-id": assetId,
      "x-filename": `${assetId}.png`,
      "x-alt-text": "background"
    },
    body: bytes
  });
  const publicAsset = (assetId, slug = "cargo") => get(`/public/v1/missions/${slug}/assets/${assetId}`);

  t.after(async () => {
    for (const server of servers) await server.close();
    for (const extra of extras) { try { extra(); } catch { /* best effort */ } }
    publications.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  return {
    dir, store, releaseStore, publications, raw, posts, get,
    onCleanup: (fn) => { extras.push(fn); },
    saveMission, buildRelease, buildReleaseHttp, publish, rollback, startSession, uploadPng, publicAsset,
    openServer: async (publicationStore) => { base = await openServer(publicationStore); return base; },
    setBase: (value) => { base = value; }
  };
}
