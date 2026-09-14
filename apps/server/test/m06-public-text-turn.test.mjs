// Свободный ход опубликованной миссии по HTTP: маршрут принимает авторский
// вариант и текст, а всё остальное отвергает. Отказ разбора не тратит ход.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore, MemoryControlPublicationStore, MemoryControlReleaseStore } from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { createControlHttpServer, freezeReleaseBundle } from "../dist/control-server.js";
import { buildControlRelease } from "../dist/release-authority.js";

function world() {
  return { schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 }, locations: [], entities: [], resources: [], items: [], terminal: null };
}
function mission() {
  return {
    schemaVersion: "1.0", projectId: "project", questId: "quest", contentRevision: 0, contentHash: "",
    listing: { title: "Груз", slug: "cargo", summary: "Найти груз.", coverAssetId: null, period: "1917", place: "Станция", playerRole: "Кладовщик", estimatedMinutes: 10, supportedModes: ["choice", "free-input"] },
    story: { entrySceneId: "start", scenes: [{ id: "start", title: "Старт", text: "Ночь.", dialogue: [], choices: [
      { id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] },
      { id: "wait", label: "Подождать", targetSceneId: null, endingId: "waited", conditions: [], effects: [] }
    ] }], endings: [{ id: "done", title: "Готово", text: "Рассвет." }, { id: "waited", title: "Ожидание", text: "Тишина." }] },
    screens: { intros: [], scenes: {}, endings: {} }, defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}
async function req(base, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body: options.json === undefined ? undefined : JSON.stringify(options.json) });
  return { status: response.status, body: await response.json() };
}

/** Полный стенд опубликованной миссии; интерпретатор подставляется тестом. */
async function boot(interpreter) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-public-text-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const publications = new MemoryControlPublicationStore();
  const releaseStore = new MemoryControlReleaseStore();
  const built = buildPluginRegistry([]);
  assert.equal(built.ok, true);
  const control = createControlHttpServer({
    store, missionStore: store,
    ...(interpreter === undefined ? {} : { missionChoiceInterpreter: interpreter }),
    releases: { store: releaseStore, publicationStore: publications, publicMissionSessionSecret: "test-public-session-secret-123", pluginRegistry: built.registry }
  });
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({ projectId: "project", questId: "quest", title: "Квест", entryLocationId: "start", initialBlocks: [
    { schemaVersion: "1.0", id: "start", kind: "core.location", title: "Перрон", description: "Ночной перрон.", data: {} }
  ] });
  const saved = await store.saveMission("project", "quest", { baseRevision: 0, mission: mission(), idempotencyKey: "save-text-mission", actorUserId: "owner" });
  assert.equal(saved.kind, "saved");
  const validation = await store.validateDraft("project", "quest", 0);
  assert.equal(validation.kind, "validated");
  const builtRelease = await buildControlRelease(
    { controlStore: store, releaseStore, pluginRegistry: built.registry },
    { projectId: "project", questId: "quest", releaseId: "release-1", draftRevision: 0, validationId: validation.validation.validationId, idempotencyKey: "build-text-mission" }
  );
  assert.equal(builtRelease.kind, "created", JSON.stringify(builtRelease));
  assert.equal((await freezeReleaseBundle(
    { releases: { store: releaseStore, publicationStore: publications, pluginRegistry: built.registry }, missionStore: store },
    { projectId: "project", questId: "quest", releaseId: "release-1" }
  )).kind, "frozen");
  await publications.publish({ record: { schemaVersion: "1.0", publicMissionId: "mission:project:quest", slug: "cargo", projectId: "project", questId: "quest", draftRevision: saved.mission.contentRevision, draftContentHash: saved.mission.contentHash, releaseId: "release-1", contentHash: builtRelease.release.compiledContentHash, channel: "production", status: "published", listing: saved.mission.listing, publishedAtMs: 10 }, idempotencyKey: "catalog-text", requestHash: "c".repeat(64) });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  const created = await req(base, "/public/v1/missions/cargo/sessions", { method: "POST", headers: { "idempotency-key": "public-text-session" }, json: { sessionId: "browser-session-1", initialWorld: world() } });
  assert.equal(created.status, 201);
  return {
    base,
    credential: created.body.credential,
    async close() { await control.close(); publications.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
  };
}
const turn = (stand, key, json) => req(stand.base, "/public/v1/missions/cargo/sessions/browser-session-1/turns", {
  method: "POST",
  headers: { authorization: `Bearer ${stand.credential}`, "idempotency-key": key },
  json
});

test("a typed turn reaches the same authored option the interpreter names", async () => {
  let seenText = null;
  const stand = await boot({ interpret: async (request) => { seenText = request.text; return { kind: "resolved", choiceId: "wait", reason: "игрок решил ждать" }; } });
  try {
    const turned = await turn(stand, "text-turn-1", { baseTurn: 0, input: { kind: "text", text: "Останусь и подожду до утра" } });
    assert.equal(turned.status, 200);
    assert.equal(seenText, "Останусь и подожду до утра");
    assert.deepEqual(turned.body.target, { kind: "ending", endingId: "waited" });
    assert.equal(turned.body.session.turn, 1);
    // Игрок должен увидеть, к какому авторскому варианту свёлся его текст.
    assert.equal(turned.body.choiceId, "wait");
  } finally {
    await stand.close();
  }
});

test("a typed turn that matches nothing is refused without spending the turn", async () => {
  const stand = await boot({ interpret: async () => ({ kind: "unsupported", explanation: "В этой сцене так поступить нельзя." }) });
  try {
    const refused = await turn(stand, "text-turn-refused", { baseTurn: 0, input: { kind: "text", text: "Улетаю на воздушном шаре" } });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, "MISSION_TURN_TEXT_UNSUPPORTED");
    assert.equal(refused.body.error.explanation, "В этой сцене так поступить нельзя.");
    // Ход не потрачен: авторский вариант на той же базе по-прежнему проходит.
    const after = await turn(stand, "choice-after-refusal", { baseTurn: 0, choiceId: "finish" });
    assert.equal(after.status, 200);
    assert.equal(after.body.session.turn, 1);
    assert.equal(after.body.choiceId, "finish");
  } finally {
    await stand.close();
  }
});

test("a provider failure is a failure, not a refusal", async () => {
  const stand = await boot({ interpret: async () => ({ kind: "failed", code: "provider_failure" }) });
  try {
    const failed = await turn(stand, "text-turn-failed", { baseTurn: 0, input: { kind: "text", text: "Подожду" } });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, "MISSION_TURN_TEXT_FAILED");
    // Отказ обязан объяснять игроку, что мир не изменился и ход не потрачен.
    assert.match(failed.body.error.explanation, /ход не потрачен/);
    assert.equal(failed.body.error.reason, "provider_failure");
  } finally {
    await stand.close();
  }
});

test("without an interpreter the route says so instead of pretending", async () => {
  const stand = await boot(undefined);
  try {
    const unavailable = await turn(stand, "text-turn-unavailable", { baseTurn: 0, input: { kind: "text", text: "Подожду" } });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error.code, "MISSION_TURN_TEXT_UNAVAILABLE");
  } finally {
    await stand.close();
  }
});

test("the route accepts exactly two shapes of turn", async () => {
  const stand = await boot({ interpret: async () => ({ kind: "resolved", choiceId: "wait", reason: "ok" }) });
  try {
    for (const [key, json] of [
      ["bad-empty-text", { baseTurn: 0, input: { kind: "text", text: "   " } }],
      ["bad-kind", { baseTurn: 0, input: { kind: "voice", text: "Подожду" } }],
      ["bad-both", { baseTurn: 0, choiceId: "wait", input: { kind: "text", text: "Подожду" } }],
      ["bad-extra", { baseTurn: 0, input: { kind: "text", text: "Подожду" }, extra: true }],
      ["bad-turn", { baseTurn: -1, input: { kind: "text", text: "Подожду" } }]
    ]) {
      const response = await turn(stand, key, json);
      assert.equal(response.status, 400, key);
      assert.equal(response.body.error.code, "INVALID_PUBLIC_MISSION_TURN", key);
    }
    // Границы длины: слишком длинный свободный ход отвергается до модели.
    const long = await turn(stand, "bad-long", { baseTurn: 0, input: { kind: "text", text: "я".repeat(701) } });
    assert.equal(long.status, 400);
  } finally {
    await stand.close();
  }
});
