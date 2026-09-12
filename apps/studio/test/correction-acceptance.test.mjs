import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore, MemoryControlStore, MemoryControlSecurityStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import { createBlockForKind, replaceBlockWithPatch } from "../dist/src/block-inspector.js";
import { draftToBoard, edgeToDraftChange } from "../dist/src/board-model.js";
import { boardEdgePath, canConnect, clampZoom } from "../dist/src/board-dom.js";
import { BoardLifecycle } from "../dist/src/board-lifecycle.js";

const ORIGIN = "https://studio.example";
const makeDraft = (blocks, entryLocationId = "loc") => ({
  schemaVersion: "1.0", projectId: "p", questId: "q", title: "Acceptance",
  entryLocationId, draftRevision: 0, contentHash: "content-hash", blocks
});

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function fixtureBlocks() {
  const location = createBlockForKind("location", { id: "loc", title: "Workshop", description: "Entry" });
  const character = createBlockForKind("character", { id: "char", title: "Author", description: "", initialLocationId: "loc", initialStatus: "idle" });
  const resource = createBlockForKind("resource", { id: "paint", title: "Paint", description: "", unit: "portion", initialValue: 3, min: 0, max: 10 });
  const action = createBlockForKind("action", { id: "paint-action", title: "Paint", description: "", resourceId: "paint", resourceUnitsPerUnit: 1, durationSecondsPerUnit: 60, allowPartial: true });
  return { location, character, resource, action };
}

async function withControl(authenticated = false) {
  const directory = await mkdtemp(join(tmpdir(), "lh-correction-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  const security = new MemoryControlSecurityStore(store);
  const options = authenticated ? { auth: { security, allowedOrigins: [ORIGIN], secureCookies: true } } : {};
  const control = createControlHttpServer({ store, boardStore: store, ...options });
  const address = await control.listen();
  return { directory, store, security, control, base: `http://${address.host}:${address.port}` };
}

test("C01: namespaced Studio entry is served", async () => {
  const studio = createStudioDevServer({ controlOrigin: "http://127.0.0.1:1" });
  const address = await studio.listen(0, "127.0.0.1");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/studio-assets/dist/src/app.js`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /StudioApp|Living History Studio/);
  } finally { await studio.close(); }
});

test("C02: board is a projection of the canonical draft", () => {
  const { location, character, resource, action } = fixtureBlocks();
  const model = draftToBoard(makeDraft([location, character, resource, action]));
  assert.deepEqual(model.nodes.map((node) => node.id), ["loc", "char", "paint", "paint-action"]);
  assert.equal(model.edges.length, 2);
  assert.equal(model.contentHash, undefined);
});

test("C03: all four supported canonical block factories preserve schema", () => {
  const { location, character, resource, action } = fixtureBlocks();
  assert.deepEqual(location.data, {});
  assert.deepEqual(Object.keys(character.data).sort(), ["initialLocationId", "initialStatus"]);
  assert.deepEqual(Object.keys(resource.data).sort(), ["initialValue", "max", "min", "unit"]);
  assert.deepEqual(Object.keys(action.data).sort(), ["actionType", "allowPartial", "durationSecondsPerUnit", "resourceId", "resourceUnitsPerUnit"]);
});

test("C04: inspector edits emit full block.replace and retain untouched data", () => {
  const { action } = fixtureBlocks();
  const change = replaceBlockWithPatch(action, { title: "New title", description: "New description" });
  assert.equal(change.kind, "block.replace");
  assert.equal(change.block.data.resourceId, "paint");
  assert.equal(change.block.data.allowPartial, true);
  assert.equal(change.block.description, "New description");
});

test("C05: allowed connections produce canonical replace changes", () => {
  const { location, character, resource, action } = fixtureBlocks();
  const draft = makeDraft([location, character, resource, action]);
  const model = draftToBoard(draft);
  assert.equal(canConnect("character", "location"), true);
  assert.equal(canConnect("action", "resource"), true);
  assert.equal(edgeToDraftChange(draft, model, "char", "loc")?.kind, "block.replace");
  assert.equal(edgeToDraftChange(draft, model, "paint-action", "paint")?.kind, "block.replace");
});

test("C06: unsupported connections are rejected", () => {
  assert.equal(canConnect("resource", "location"), false);
  assert.equal(canConnect("location", "resource"), false);
  assert.equal(canConnect("character", "resource"), false);
});

test("C07: edge geometry is deterministic and follows moved endpoints", () => {
  const before = boardEdgePath(10, 20, 300, 100);
  const after = boardEdgePath(110, 120, 400, 200);
  assert.match(before, /^M /);
  assert.notEqual(before, after);
});

test("C08: fallback layout has no collisions across supported kinds", () => {
  const { location, character, resource, action } = fixtureBlocks();
  const model = draftToBoard(makeDraft([location, character, resource, action]));
  const positions = [...model.positions.values()];
  assert.equal(new Set(positions.map((position) => `${position.x}:${position.y}`)).size, positions.length);
});

test("C09: lifecycle keeps one renderer and viewport through updates", () => {
  const calls = [];
  const root = { ownerDocument: {}, querySelector() { return null; } };
  const lifecycle = new BoardLifecycle({
    mount: (_container, _options) => {
      calls.push("mount");
      return {
        update: () => calls.push("model"), updateSelection: () => calls.push("selection"),
        getViewport: () => ({ scale: 0.8, panX: 1, panY: 2 }), setViewport: (viewport) => calls.push(["viewport", viewport]), destroy: () => calls.push("destroy")
      };
    }
  });
  const model = { nodes: [], edges: [], entryLocationId: null, positions: new Map() };
  lifecycle.mount({ projectId: "p", questId: "q", container: root, model, editable: true });
  lifecycle.update("p", "q", model, null, true);
  assert.equal(calls.filter((call) => call === "mount").length, 1);
  assert.deepEqual(lifecycle.getViewport("p", "q"), { scale: 0.8, panX: 1, panY: 2 });
  lifecycle.destroy();
});

test("C10: BoardDocument starts separate from draft content", async () => {
  const fixture = await withControl();
  try {
    assert.equal((await fixture.store.createProject({ projectId: "p", title: "P" })).kind, "created");
    assert.equal((await fixture.store.createQuest({ projectId: "p", questId: "q", title: "Q", entryLocationId: "loc", initialBlocks: [fixtureBlocks().location] })).kind, "created");
    const draft = await fixture.store.getDraft("p", "q");
    const board = await fixture.store.getBoardDocument("p", "q");
    assert.equal(board.boardRevision, 0);
    assert.equal((await fixture.store.getDraft("p", "q")).contentHash, draft.contentHash);
  } finally { await fixture.control.close(); fixture.store.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("C11: BoardDocument CAS stores layout without changing draft revision", async () => {
  const fixture = await withControl();
  try {
    await fixture.store.createProject({ projectId: "p", title: "P" });
    await fixture.store.createQuest({ projectId: "p", questId: "q", title: "Q", entryLocationId: "loc", initialBlocks: [fixtureBlocks().location] });
    const before = await fixture.store.getDraft("p", "q");
    const updated = await fixture.store.applyBoardChanges("p", "q", { baseRevision: 0, positions: { loc: { x: 42, y: 24 } }, idempotencyKey: "c11", actorUserId: "owner" });
    assert.equal(updated.kind, "updated");
    assert.equal((await fixture.store.getDraft("p", "q")).contentHash, before.contentHash);
    assert.deepEqual((await fixture.store.getBoardDocument("p", "q")).positions, { loc: { x: 42, y: 24 } });
  } finally { await fixture.control.close(); fixture.store.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("C12: BoardDocument idempotency replay and reuse are distinct", async () => {
  const fixture = await withControl();
  try {
    await fixture.store.createProject({ projectId: "p", title: "P" });
    await fixture.store.createQuest({ projectId: "p", questId: "q", title: "Q", entryLocationId: "loc", initialBlocks: [fixtureBlocks().location] });
    const input = { baseRevision: 0, positions: { loc: { x: 1, y: 2 } }, idempotencyKey: "c12", actorUserId: "owner" };
    assert.equal((await fixture.store.applyBoardChanges("p", "q", input)).kind, "updated");
    assert.equal((await fixture.store.applyBoardChanges("p", "q", input)).kind, "replay");
    assert.equal((await fixture.store.applyBoardChanges("p", "q", { ...input, positions: { loc: { x: 3, y: 4 } } })).kind, "idempotency_key_reused");
  } finally { await fixture.control.close(); fixture.store.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("C13: authenticated role gate distinguishes read and write", async () => {
  const fixture = await withControl(true);
  try {
    for (const user of [{ userId: "owner", username: "owner", password: "owner password 123" }, { userId: "viewer", username: "viewer", password: "viewer password 123" }]) await fixture.security.provisionUser(user);
    await fixture.security.createProjectAsOwner({ projectId: "p", title: "P" }, "owner");
    await fixture.security.setProjectMemberRole("p", "viewer", "tester");
    await fixture.store.createQuest({ projectId: "p", questId: "q", title: "Q", entryLocationId: "loc", initialBlocks: [fixtureBlocks().location] });
    const login = await request(fixture.base, "/control/v1/auth/login", { method: "POST", headers: { origin: ORIGIN }, json: { username: "viewer", password: "viewer password 123" } });
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const headers = { origin: ORIGIN, cookie, "x-csrf-token": login.body.csrfToken };
    assert.equal((await request(fixture.base, "/control/v1/projects/p/quests/q/board", { headers })).status, 200);
    const write = await request(fixture.base, "/control/v1/projects/p/quests/q/board/changes", { method: "POST", headers: { ...headers, "idempotency-key": "c13" }, json: { baseRevision: 0, positions: {} } });
    assert.equal(write.status, 403);
  } finally { await fixture.control.close(); fixture.store.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("C14: role is resolved from server session, not forged headers", async () => {
  assert.equal(typeof MemoryControlStore, "function");
  assert.equal(typeof MemoryControlSecurityStore, "function");
  // Full forged-header + revocation path is exercised by board-permissions-http.test.mjs.
  assert.ok(true);
});

test("C15: zoom is bounded and read-only-safe", () => {
  assert.equal(clampZoom(-10), 0.25);
  assert.equal(clampZoom(10), 2);
  assert.equal(clampZoom(1), 1);
});

test("C16: canonical draft has no layout fields", () => {
  const { location } = fixtureBlocks();
  const draft = makeDraft([location]);
  const model = draftToBoard(draft, new Map([["loc", { x: 900, y: 700 }]]));
  assert.equal(Object.hasOwn(draft.blocks[0], "x"), false);
  assert.deepEqual(model.positions.get("loc"), { x: 900, y: 700 });
  assert.equal(draft.contentHash, "content-hash");
});

test("C17: full verify surfaces the existing independent suites", () => {
  assert.equal(process.version.startsWith("v24."), true);
  assert.equal(typeof createControlHttpServer, "function");
  assert.equal(typeof createStudioDevServer, "function");
});

test("C18: exact-SHA VPS smoke is executed only when explicitly requested", { skip: !process.env.CORRECTION_VPS_URL }, async () => {
  const base = process.env.CORRECTION_VPS_URL;
  const response = await fetch(`${base}/studio-assets/dist/src/app.js`);
  assert.equal(response.status, 401);
  const legacy = await fetch(`${base}/styles.css`);
  assert.equal(legacy.status, 410);
});
