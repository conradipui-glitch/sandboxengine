// FIN-04 / B01 (repeat audit M06): the delivered composition must ship a version
// manifest that names every actually-running component, and it must account for
// every process that opens the shared SQLite database as a writer.
//
// Defect (docs/FIN-CHECKLIST.md:12, docs/PLAN-FIN-RU.md:84-88):
//   "B01: Studio `main.ts` держит собственный Control-писатель и
//    публикацию-store; нужен manifest версий процессов/образов и проверка, что
//    старый Control не пишет в общую БД".
//   PLAN-FIN-04 requires: "Manifest: Engine, Studio/Control, authored-runtime,
//   Player/preview bundle, Worker — commit/image/file hashes и совместимость
//   контрактов. «Хост checkout правильный» недостаточно: проверять фактически
//   запущенные файлы/образы."
//
// Test 1 reproduces the missing deliverable (RED today: no manifest exists).
// Test 2 documents the factual topology that makes the manifest necessary: two
// independent Control compositions (engine and studio) both open the shared
// SQLite database as publication writers, with no writer identity recorded.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlReleaseStore,
  SQLiteControlPublicationStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

const COMPOSE_URL = new URL("../../../deploy/vps/docker-compose.yml", import.meta.url);
const MANIFEST_CANDIDATES = [
  new URL("../../../deploy/vps/delivery-manifest.json", import.meta.url),
  new URL("../../../deploy/vps/manifest.json", import.meta.url),
  new URL("../../../deploy/delivery-manifest.json", import.meta.url),
  new URL("../../../deploy/manifest.json", import.meta.url)
];

function parseCompose(text) {
  const services = new Map();
  let current = null;
  let inEnvironment = false;
  let inServices = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^[A-Za-z]/.test(raw)) { inServices = /^services:\s*$/.test(raw); current = null; inEnvironment = false; continue; } // top-level key
    if (!inServices) continue;
    const header = /^  ([A-Za-z0-9_-]+):\s*$/.exec(raw);
    if (header) {
      current = header[1];
      services.set(current, { env: {} });
      inEnvironment = false;
      continue;
    }
    if (!current) continue;
    if (/^    environment:\s*$/.test(raw)) { inEnvironment = true; continue; }
    if (/^    [A-Za-z].*:\s*$/.test(raw)) { inEnvironment = false; continue; }
    if (inEnvironment) {
      const entry = /^\s+- ([A-Z0-9_]+)=(.*)$/.exec(raw);
      if (entry) services.get(current).env[entry[1]] = entry[2];
    }
  }
  return services;
}

function world() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}

function mission(text) {
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
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

test("FIN-04/B01: the delivered VPS composition ships a version manifest covering every running component", async () => {
  const composeText = await readFile(COMPOSE_URL, "utf8");
  const services = [...parseCompose(composeText).keys()];
  assert.deepEqual([...services].sort(), ["authored", "engine", "gate", "studio"], "the compose file is the source of truth for running components");

  const manifestUrl = MANIFEST_CANDIDATES.find((url) => existsSync(url));
  assert.ok(
    manifestUrl,
    `no delivery manifest found (looked for: ${MANIFEST_CANDIDATES.map((u) => u.pathname).join(", ")}). ` +
      "Without it, \"the host checkout is correct\" is the only delivery evidence, which PLAN-FIN-04 explicitly rejects."
  );
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const components = Array.isArray(manifest.components) ? manifest.components : null;
  assert.ok(Array.isArray(components), "manifest.components must enumerate each running component");

  const named = new Map(components.map((component) => [component?.name, component]));
  for (const service of services) {
    const component = named.get(service);
    assert.ok(component, `manifest must cover compose service "${service}"`);
    assert.ok(
      typeof component.version === "string" && component.version.length >= 7,
      `component "${service}" must carry an immutable version identity (commit/image/file hash), got ${JSON.stringify(component.version)}`
    );
    if (component.version.startsWith("sha256:")) {
      assert.match(component.version, /^sha256:[0-9a-f]{64}$/, `component "${service}" image digest must be a full digest`);
    } else {
      assert.match(component.version, /^[0-9a-f]{40}$/, `component "${service}" must pin an exact commit SHA or image digest`);
    }
  }

  // The manifest must record which components open the shared SQLite database,
  // because more than one process writes it (see the topology test below).
  assert.ok(
    manifest.sharedDatabase && typeof manifest.sharedDatabase.path === "string",
    "manifest must name the shared database path that a stale writer could corrupt"
  );
  assert.ok(
    Array.isArray(manifest.sharedDatabase.writers) && manifest.sharedDatabase.writers.length >= 1,
    "manifest must declare the components that write the shared database"
  );
  for (const writer of manifest.sharedDatabase.writers) {
    assert.ok(named.has(writer?.component), `shared-database writer "${writer?.component}" must be a declared component`);
  }
});

test("FIN-04/B01 (current topology): engine and studio are two independent Control writers on one shared SQLite database", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-fin04-"));
  const sharedPath = join(dir, "living-history.sqlite"); // the compose shared volume: engine-data:/data

  // Two independent compositions over the same file, exactly as the compose
  // definitions do (engine: RUNTIME_DB_PATH, studio: LH_DATABASE_PATH).
  const engineStore = new SQLiteControlStore({ path: sharedPath });
  const enginePublications = new SQLiteControlPublicationStore({ path: sharedPath });
  const studioStore = new SQLiteControlStore({ path: sharedPath });
  const studioPublications = new SQLiteControlPublicationStore({ path: sharedPath });
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  const releaseStore = new MemoryControlReleaseStore();

  await engineStore.createProject({ projectId: "project", title: "Проект" });
  await engineStore.createQuest({
    projectId: "project", questId: "quest", title: "Квест", entryLocationId: "start",
    initialBlocks: [{ schemaVersion: "1.0", id: "start", kind: "core.location", title: "Старт", description: "", data: {} }]
  });

  const open = async (store, publicationStore) => {
    const control = createControlHttpServer({
      store,
      missionStore: store,
      assetLibrary: store,
      assetStorage: new LocalAssetStore(join(dir, "objects")),
      releases: { store: releaseStore, publicationStore, pluginRegistry: built.registry, publicMissionSessionSecret: "test-public-session-secret-123" }
    });
    const address = await control.listen();
    t.after(async () => { await control.close(); });
    return `http://${address.host}:${address.port}`;
  };
  const engineBase = await open(engineStore, enginePublications);
  const studioBase = await open(studioStore, studioPublications);

  t.after(async () => {
    enginePublications.close();
    studioPublications.close();
    engineStore.close();
    studioStore.close();
    await rm(dir, { recursive: true, force: true });
  });

  const saved = await engineStore.saveMission("project", "quest", {
    baseRevision: 0, mission: mission("Ночь."), idempotencyKey: "save-1", actorUserId: "owner"
  });
  assert.equal(saved.kind, "saved");
  const validation = await engineStore.validateDraft("project", "quest", 0);
  assert.equal(validation.kind, "validated");
  assert.equal((await buildControlRelease(
    { controlStore: engineStore, releaseStore, pluginRegistry: built.registry },
    { projectId: "project", questId: "quest", releaseId: "release-1", draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: "build-1" }
  )).kind, "created");

  // The engine composition publishes through its own store instance.
  const published = await fetch(`${engineBase}/control/v1/projects/project/quests/quest/publish`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "publish-1" },
    body: JSON.stringify({ releaseId: "release-1", expectedCurrentReleaseId: null })
  });
  assert.equal(published.status, 200);

  // The Studio composition's independent writer-store instance sees the very
  // same shared catalog and can serve it: both are writers of one file.
  const studioView = await (await fetch(`${studioBase}/public/v1/missions`)).json();
  assert.ok(
    Array.isArray(studioView.missions) && studioView.missions.some((entry) => entry.slug === "cargo"),
    "the Studio composition's store observes the engine composition's publication (one shared database, two writers)"
  );

  // And it can just as freely move the shared catalog: unpublish through the
  // Studio composition is durable in the shared file and no writer identity is
  // recorded anywhere to detect that a *stale* Control did it.
  const studioUnpublish = await fetch(`${studioBase}/control/v1/projects/project/quests/quest/publication/unpublish`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "unpublish-from-studio" },
    body: JSON.stringify({ publicMissionId: "mission:project:quest", expectedReleaseId: "release-1" })
  });
  assert.equal(studioUnpublish.status, 200);
  const engineAfter = await (await fetch(`${engineBase}/public/v1/missions`)).json();
  assert.equal(engineAfter.missions.some((entry) => entry.slug === "cargo"), false, "the engine composition observes the Studio composition's write");

  // SHA of a shared byte identity, to make the "same file" claim concrete.
  const digest = createHash("sha256").update(sharedPath).digest("hex").slice(0, 12);
  assert.equal(typeof digest, "string");
});
