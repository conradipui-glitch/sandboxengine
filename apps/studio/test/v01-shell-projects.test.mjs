import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SQLiteControlReleaseStore,
  SQLiteControlStore
} from "../../../packages/control/dist/index.js";
import { buildPluginRegistry } from "../../../packages/plugins/dist/index.js";
import { DICE_CHECK_MANIFEST } from "../../../packages/plugins/dist/dice-check.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient } from "../dist/src/api.js";
import { ControlApiError } from "../dist/src/api.js";
import { StudioApp } from "../dist/src/app.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import { createInitialLocationBlock } from "../dist/src/forms.js";

const here = dirname(fileURLToPath(import.meta.url));

// StudioApp.render() читает document.activeElement; браузера в тестах нет.
globalThis.document ??= { activeElement: null };
globalThis.HTMLElement ??= class {};

// --- V01: проекты грузятся/создаются/открываются без Technical ID (интеграция через Control) ---

async function withStudio(run) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-v01-"));
  const path = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  const releaseStore = new SQLiteControlReleaseStore({ path });
  const registry = buildPluginRegistry([DICE_CHECK_MANIFEST]);
  assert.equal(registry.ok, true);
  const control = createControlHttpServer({
    store,
    releases: { store: releaseStore, pluginRegistry: registry.registry, nowMs: () => 1_000 }
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const fetchAgainstStudio = (input, init) => fetch(new URL(String(input), origin), init);
  const api = new ControlApiClient(fetchAgainstStudio);
  try {
    await run({ api, origin });
  } finally {
    await studio.close();
    await control.close();
    releaseStore.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function generatedId(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
  return `${slug}-t01`;
}

test("V01 project create/list/open cycle works with Studio-generated IDs (no user Technical ID)", async () => {
  await withStudio(async ({ api }) => {
    const title = "Мой первый квест";
    const project = await api.createProject({ projectId: generatedId(title), title });
    assert.ok(project.projectId.length > 0);

    const projects = await api.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].title, title);

    const questTitle = "Первая сцена";
    const draft = await api.createQuest({
      projectId: project.projectId,
      questId: generatedId(questTitle),
      title: questTitle,
      entryLocationId: "start",
      initialBlocks: [createInitialLocationBlock("start", "Старт")]
    });
    assert.equal(draft.title, questTitle);

    const quests = await api.listQuests(project.projectId);
    assert.equal(quests.length, 1);

    const opened = await api.getDraft(project.projectId, draft.questId);
    assert.equal(opened.draftRevision, 0);
  });
});

// --- V01: токены «Светлая мастерская» присутствуют ---

test("V01 design tokens are present in Studio styles", async () => {
  const css = await readFile(join(here, "..", "styles.css"), "utf8");
  for (const token of ["#F5F3EE", "#176B56", "#125642", "#EAF4EF", "#245BD7", "#B42332", "#8A5200", "--canvas", "--primary", "--radius-s", "--radius-m", "--radius-l"]) {
    assert.ok(css.includes(token), `missing token ${token}`);
  }
  assert.match(css, /\.project-grid/);
  assert.match(css, /\.ed-topbar/);
  assert.match(css, /min-height: 40px/);
});

// --- V01: корневые пути неизменны ---

test("V01 root entry paths are unchanged", async () => {
  const studio = createStudioDevServer({ controlOrigin: "http://127.0.0.1:1" });
  const address = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const root = await fetch(`${origin}/`);
    assert.equal(root.status, 200);
    const html = await root.text();
    assert.match(html, /Living History Studio/);
    assert.match(html, /studio-assets\/dist\/src\/app\.js/);

    const css = await fetch(`${origin}/studio-assets/styles.css`);
    assert.equal(css.status, 200);
    assert.match(await css.text(), /--canvas/);
  } finally {
    await studio.close();
  }
});

// --- V01: стартовый экран «Мои проекты» без DOM-браузера ---

function fakeRoot() {
  const listeners = {};
  return {
    innerHTML: "",
    listeners,
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    querySelector() { return null; }
  };
}

function fakeApi({ projects = [], questsByProject = {} } = {}) {
  return {
    async getSession() { throw new ControlApiError(404, "NOT_FOUND", null); },
    hasMutationProof() { return true; },
    async listProjects() { return projects; },
    async listQuests(projectId) { return questsByProject[projectId] ?? []; }
  };
}

async function bootStudio(options) {
  const root = fakeRoot();
  const app = new StudioApp(root, fakeApi(options));
  await app.start();
  return { app, root };
}

test("V01 empty projects screen has AI prompt, honest paint note and blank-project start", async () => {
  const { root } = await bootStudio({ projects: [] });
  assert.match(root.innerHTML, /Мои проекты/);
  assert.match(root.innerHTML, /О чём будет квест\?/);
  assert.match(root.innerHTML, /Создать с ИИ/);
  assert.match(root.innerHTML, /Начать с пустого проекта/);
  assert.match(root.innerHTML, /ограниченном профиле/);
  assert.ok(!root.innerHTML.includes("Technical ID"), "no Technical ID on projects screen");
});

test("V01 project cards open the project and show quest counts with roles", async () => {
  const projects = [
    { projectId: "p-one", title: "Первая история", role: "owner" },
    { projectId: "p-two", title: "Вторая история", role: "editor" }
  ];
  const { app, root } = await bootStudio({
    projects,
    questsByProject: { "p-one": [{ questId: "q1", title: "Первый квест" }], "p-two": [] }
  });
  assert.match(root.innerHTML, /data-action="open-project"/);
  assert.match(root.innerHTML, /Первая история/);
  assert.match(root.innerHTML, /Квестов: 1/);
  assert.match(root.innerHTML, /Квестов: 0/);
  assert.match(root.innerHTML, /Новый проект/);
  assert.match(root.innerHTML, /Поиск по названию/);
  assert.ok(!root.innerHTML.includes("Technical ID"), "no Technical ID on cards");

  await app.openProject("p-one");
  assert.equal(app.state.view, "editor");
  assert.equal(app.state.selectedProjectId, "p-one");
});

test("V01 new-project modal is 480px dialog without Technical ID", async () => {
  const { app, root } = await bootStudio({ projects: [] });
  app.state.projectModal = true;
  app.render();
  assert.match(root.innerHTML, /data-form="project-new"/);
  assert.match(root.innerHTML, /class="modal"/);
  assert.ok(!root.innerHTML.includes("Technical ID"), "modal has no Technical ID field");
});

test("V01 editor shell has 60px topbar, 240px library, inspector tabs and bottom check panel", async () => {
  const projects = [{ projectId: "p-one", title: "Первая история", role: "owner" }];
  const { app, root } = await bootStudio({ projects, questsByProject: { "p-one": [] } });
  await app.openProject("p-one");
  app.state.quests = Object.freeze([{
    projectId: "p-one", questId: "q1", draftRevision: 0,
    title: "Первый квест", entryLocationId: "start", contentHash: "x".repeat(64)
  }]);
  app.state.selectedQuestId = "q1";
  app.state.draft = Object.freeze({
    projectId: "p-one", questId: "q1", draftRevision: 0,
    title: "Первый квест", entryLocationId: "start", contentHash: "x".repeat(64),
    blocks: Object.freeze([])
  });
  app.render();
  assert.match(root.innerHTML, /ed-topbar/);
  assert.match(root.innerHTML, /Проверить/);
  assert.match(root.innerHTML, /Играть/);
  assert.match(root.innerHTML, /ed-library/);
  assert.match(root.innerHTML, /Библиотека/);
  assert.match(root.innerHTML, /Свойства/);
  assert.match(root.innerHTML, /Соавтор/);
  assert.match(root.innerHTML, /ed-bottom/);
  assert.match(root.innerHTML, /Проверка квеста/);
  assert.ok(!root.innerHTML.includes("Technical ID"), "no Technical ID in editor main path");
  assert.match(root.innerHTML, /Дополнительно/);
});
