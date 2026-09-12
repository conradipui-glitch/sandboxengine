import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryControlSecurityStore,
  SQLiteControlStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { ControlApiClient, ControlApiError } from "../dist/src/api.js";
import { StudioApp } from "../dist/src/app.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import {
  collabField,
  collaborationAnchorLabel,
  collaborationErrorMessage,
  collaborationLoadMessage,
  collaborationWriteFailure,
  loadCollaborationPanel,
  renderCollaborationPanel
} from "../dist/src/collaboration.js";

/* ------------------------------------------------------------------ */
/* Fixtures: shapes copied from packages/control/src/types.ts          */
/* ------------------------------------------------------------------ */

function note(overrides = {}) {
  return Object.freeze({
    noteId: "note-1",
    projectId: "project",
    questId: "quest",
    text: "Проверить фон в мастерской",
    authorUserId: "editor",
    position: Object.freeze({ x: 12, y: 34 }),
    revision: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides
  });
}

function message(overrides = {}) {
  return Object.freeze({
    messageId: "message-1",
    authorUserId: "editor",
    text: "Нужен другой фон",
    revision: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    deleted: false,
    ...overrides
  });
}

function thread(overrides = {}) {
  return Object.freeze({
    threadId: "thread-1",
    projectId: "project",
    questId: "quest",
    anchor: Object.freeze({ kind: "scene", targetId: "workshop", position: null }),
    anchorDeleted: false,
    status: "open",
    revision: 2,
    createdByUserId: "editor",
    createdAtMs: 1,
    updatedAtMs: 2,
    resolvedAtMs: null,
    messages: Object.freeze([message()]),
    ...overrides
  });
}

function view(overrides = {}) {
  return Object.freeze({
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    revision: 7,
    unresolvedThreadCount: 1,
    notes: Object.freeze([
      note(),
      note({
        noteId: "note-2",
        text: "Подписать ресурс краски",
        authorUserId: "owner",
        revision: 3,
        position: Object.freeze({ x: 120, y: 80 })
      })
    ]),
    threads: Object.freeze([
      thread(),
      thread({
        threadId: "thread-2",
        anchor: Object.freeze({ kind: "board", targetId: null, position: Object.freeze({ x: 400, y: 500 }) }),
        status: "resolved",
        revision: 4,
        resolvedAtMs: 5,
        messages: Object.freeze([
          message({ messageId: "message-1" }),
          message({ messageId: "message-2", authorUserId: "owner", text: "Беру на себя" }),
          message({ messageId: "message-3", authorUserId: "editor", text: "", deleted: true })
        ])
      })
    ]),
    ...overrides
  });
}

function options(overrides = {}) {
  return Object.freeze({
    canWrite: true,
    currentUserId: "editor",
    isOwner: false,
    conflict: null,
    busy: false,
    fields: Object.freeze({}),
    editing: null,
    notice: null,
    ...overrides
  });
}

function ready(viewValue = view(), ...rest) {
  return Object.freeze({ kind: "ready", view: viewValue });
}

function indexOfOrFail(haystack, needle) {
  const index = haystack.indexOf(needle);
  assert.notEqual(index, -1, `expected markup to contain ${needle}`);
  return index;
}

/* ------------------------------------------------------------------ */
/* Pure surface                                                        */
/* ------------------------------------------------------------------ */

test("FIN-12 UI: панель показывает реальные серверные данные и действие прямо под каждым списком", () => {
  const html = renderCollaborationPanel(ready(), options());

  assert.match(html, /data-collab-panel/);
  // Коллекционная ревизия и счётчики — из ответа сервера, без плейсхолдеров.
  assert.match(html, /Коллекция r7/);
  assert.match(html, /Заметок <strong>2<\/strong>/);
  assert.match(html, /Открытых <strong>1<\/strong> из <strong>2<\/strong>/);
  assert.doesNotMatch(html, /N\/A|TODO|плейсхолдер|placeholder/i);

  for (const text of ["Проверить фон в мастерской", "Подписать ресурс краски", "Нужен другой фон", "Беру на себя"]) {
    assert.ok(html.includes(text), `note/message text must be rendered verbatim: ${text}`);
  }
  assert.match(html, /x 12 · y 34/);
  assert.match(html, /x 120 · y 80/);
  assert.match(html, /editor/);
  assert.match(html, /owner/);

  // Тред: пин на доске и сцена, статусы и ревизии.
  assert.match(html, /Сцена workshop/);
  assert.match(html, /Пин на доске/);
  assert.match(html, /открыт/);
  assert.match(html, /закрыт/);
  assert.match(html, /r4/);
  // Мягко удалённое сообщение сохраняет место в треде.
  assert.match(html, /Сообщение удалено/);
  assert.match(html, /data-message-id="message-3"/);

  // Действие (форма создания) — сразу под своим списком.
  const notesSection = indexOfOrFail(html, "data-collab-notes");
  const notesListEnd = html.indexOf("</ul>", notesSection);
  const noteForm = indexOfOrFail(html, 'data-form="collab-note-create"');
  const threadsSection = indexOfOrFail(html, "data-collab-threads");
  const threadForm = indexOfOrFail(html, 'data-form="collab-thread-create"');
  assert.ok(notesListEnd > notesSection && noteForm > notesListEnd, "notes form must sit directly under the notes list");
  assert.ok(threadForm > threadsSection, "thread form must sit inside the threads section");
  const firstThread = indexOfOrFail(html, 'data-thread-id="thread-1"');
  assert.ok(threadForm > firstThread, "thread form must sit under the rendered threads");
  assert.match(html, /data-form="collab-thread-reply"/);

  // Короткая справка во вкладке с конкретным примером.
  assert.match(html, /data-collab-help/);
  assert.match(html, /Пример:/);
  assert.match(html, /Проверить свет в мастерской/);
});

test("FIN-12 UI: read-only роль не получает ни одного write-контрола, но видит данные и перечитку", () => {
  const readOnly = renderCollaborationPanel(ready(), options({ canWrite: false, currentUserId: "tester" }));

  assert.doesNotMatch(readOnly, /data-form=/);
  assert.doesNotMatch(readOnly, /data-action="collab-note-edit"/);
  assert.doesNotMatch(readOnly, /data-action="collab-note-delete"/);
  assert.doesNotMatch(readOnly, /data-action="collab-thread-resolve"/);
  assert.doesNotMatch(readOnly, /data-action="collab-message-delete"/);
  assert.doesNotMatch(readOnly, /expectedRevision/);
  assert.match(readOnly, /Только чтение/);
  assert.match(readOnly, /Проверить фон в мастерской/);
  assert.match(readOnly, /data-action="collab-reload"/);
  assert.match(readOnly, /Коллекция r7/);

  // Автор и владелец видят правку/удаление своей заметки; чужую — нет.
  const asEditor = renderCollaborationPanel(ready(), options());
  assert.match(asEditor, /data-action="collab-note-edit" data-note-id="note-1"/);
  assert.doesNotMatch(asEditor, /data-action="collab-note-edit" data-note-id="note-2"/);
  const asOwner = renderCollaborationPanel(ready(), options({ currentUserId: "owner", isOwner: true }));
  assert.match(asOwner, /data-action="collab-note-delete" data-note-id="note-2"/);
  assert.match(asOwner, /data-action="collab-thread-reopen" data-thread-id="thread-2"/);
});

test("FIN-12 UI: конфликт ревизий показывается с текущей ревизией сервера и предложением перечитать, без silent overwrite", () => {
  const html = renderCollaborationPanel(ready(), options({
    conflict: Object.freeze({ code: "COLLABORATION_REVISION_CONFLICT", currentRevision: 9, message: "Конфликт ревизий: сервер уже на r9. Правка не применена." })
  }));

  assert.match(html, /data-collab-conflict/);
  assert.match(html, /role="alert"/);
  assert.match(html, /r9/);
  assert.match(html, /не перезаписано|не применена/);
  assert.match(html, /data-action="collab-reload"/);
  assert.match(html, /Перечитать с сервера/);
  // Локальные данные остаются прежними до явной перечитки.
  assert.match(html, /Коллекция r7/);
  assert.match(html, /Проверить фон в мастерской/);
});

test("FIN-12 UI: ошибки записи переводятся в понятные сообщения, а не в голые коды", () => {
  const conflict = collaborationWriteFailure(new ControlApiError(409, "COLLABORATION_REVISION_CONFLICT", {
    error: { code: "COLLABORATION_REVISION_CONFLICT", currentRevision: 5 }
  }));
  assert.deepEqual(conflict, { kind: "conflict", currentRevision: 5, code: "COLLABORATION_REVISION_CONFLICT" });
  assert.match(collaborationErrorMessage(conflict), /Конфликт ревизий/);
  assert.match(collaborationErrorMessage(conflict), /r5/);
  assert.match(collaborationErrorMessage(conflict), /не перезаписано/);

  const forbidden = collaborationWriteFailure(new ControlApiError(403, "COLLABORATION_FORBIDDEN", {
    error: { code: "COLLABORATION_FORBIDDEN" }
  }));
  assert.equal(forbidden.kind, "forbidden");
  assert.match(collaborationErrorMessage(forbidden), /автор|владелец/);

  const missing = collaborationWriteFailure(new ControlApiError(404, "NOT_FOUND", { error: { code: "NOT_FOUND" } }));
  assert.equal(missing.kind, "not_found");
  assert.match(collaborationErrorMessage(missing), /уже удалён|обновите/i);

  const roleGate = collaborationWriteFailure(new ControlApiError(403, "CONTROL_FORBIDDEN", { error: { code: "CONTROL_FORBIDDEN" } }));
  assert.equal(roleGate.kind, "forbidden");

  const reused = collaborationWriteFailure(new ControlApiError(409, "COLLABORATION_IDEMPOTENCY_KEY_REUSED", {
    error: { code: "COLLABORATION_IDEMPOTENCY_KEY_REUSED" }
  }));
  assert.equal(reused.kind, "idempotency_reused");

  const offline = collaborationWriteFailure(new ControlApiError(0, "CONTROL_UNAVAILABLE", null));
  assert.equal(offline.kind, "error");
  assert.match(collaborationErrorMessage(offline), /Control/);

  const invalid = collaborationWriteFailure(new ControlApiError(422, "INVALID_COLLABORATION_REQUEST", {
    error: { code: "INVALID_COLLABORATION_REQUEST", details: ["text"] }
  }));
  assert.equal(invalid.kind, "invalid");
});

test("FIN-12 UI: введённый текст и координаты переживают перерисовку, якоря читаются по-человечески", () => {
  assert.equal(collabField({ "note.text": "Свет" }, "note.text", ""), "Свет");
  assert.equal(collabField({}, "note.text", "0"), "0");
  assert.equal(collabField({ "note.text": "" }, "note.text", "0"), "");

  const preserved = renderCollaborationPanel(ready(), options({
    fields: Object.freeze({ "note.text": "Проверить свет", "note.x": "120", "note.y": "80", "thread.text": "Нужен фон" })
  }));
  assert.match(preserved, /Проверить свет/);
  assert.match(preserved, /data-collab-field="note.x"[^>]*value="120"/);
  assert.match(preserved, /data-collab-field="note.y"[^>]*value="80"/);
  assert.match(preserved, /Нужен фон/);

  assert.equal(collaborationAnchorLabel({ kind: "board", targetId: null, position: { x: 1, y: 2 } }), "Пин на доске");
  assert.equal(collaborationAnchorLabel({ kind: "scene", targetId: "workshop", position: null }), "Сцена workshop");
  assert.equal(collaborationAnchorLabel({ kind: "layer", targetId: "bg", position: null }), "Слой bg");
  assert.equal(collaborationAnchorLabel({ kind: "field", targetId: "text", position: null }), "Поле text");

  const deletedAnchor = renderCollaborationPanel(ready(view({
    threads: Object.freeze([thread({ anchorDeleted: true })])
  })), options());
  assert.match(deletedAnchor, /Элемент удалён/);
});

test("FIN-12 UI: текст заметок и сообщений экранируется и не обрезается многоточием", async () => {
  const unsafe = renderCollaborationPanel(ready(view({
    notes: Object.freeze([note({ text: "<img src=x onerror=alert(1)>" })]),
    threads: Object.freeze([thread({ messages: Object.freeze([message({ text: "<script>alert(1)</script>" })]) })])
  })), options());
  assert.doesNotMatch(unsafe, /<script>alert\(1\)<\/script>/);
  assert.match(unsafe, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(unsafe, /<img src=x/);

  const css = await readFile(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
  const fin12 = css.slice(css.indexOf("/* FIN-12"));
  assert.ok(fin12.length > 0, "styles.css must carry a FIN-12 block");
  assert.doesNotMatch(fin12, /text-overflow:\s*ellipsis/, "FIN-12 surface must never truncate with an ellipsis");
  assert.match(fin12, /overflow-wrap:\s*anywhere/);
  assert.match(fin12, /\.collab-panel/);
  assert.match(fin12, /\.ed-body\.notes-open/);
  assert.match(fin12, /width:\s*100%/);

  // R-29: обрезка многоточием запрещена во ВСЁМ интерфейсе, а не только в блоке FIN-12:
  // `-webkit-line-clamp` рисует то же многоточие, но старый страж его не видел.
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/, "интерфейс не обрезает текст многоточием");
  assert.doesNotMatch(css, /-webkit-line-clamp/, "line-clamp = та же обрезка многоточием; нужен перенос строк");
  const descBlock = css.slice(css.indexOf(".node-desc {"), css.indexOf(".node-meta"));
  assert.match(descBlock, /overflow-wrap:\s*anywhere/, "описание карточки доски переносится, а не обрезается");
  assert.doesNotMatch(descBlock, /overflow:\s*hidden/, "описание карточки доски не прячет строки");
});

/* ------------------------------------------------------------------ */
/* Studio shell wiring                                                 */
/* ------------------------------------------------------------------ */

globalThis.document ??= { activeElement: null };
globalThis.HTMLElement ??= class HTMLElement {};
globalThis.Element ??= class Element {};
globalThis.HTMLInputElement ??= class HTMLInputElement {};
globalThis.HTMLTextAreaElement ??= class HTMLTextAreaElement {};
globalThis.HTMLSelectElement ??= class HTMLSelectElement {};

function fakeRoot() {
  const listeners = {};
  return {
    innerHTML: "",
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    removeEventListener() {},
    querySelector() { return null; }
  };
}

function fakeShellApi(viewValue) {
  let calls = 0;
  return {
    calls: () => calls,
    hasMutationProof() { return true; },
    async getSession() { throw new ControlApiError(404, "NOT_FOUND", null); },
    async listProjects() { return [{ projectId: "p-one", title: "Мастерская", role: "editor" }]; },
    async listQuests() { return []; },
    async getCollaboration() { calls += 1; return viewValue; },
    async getDraft() { throw new ControlApiError(404, "NOT_FOUND", null); },
    async getBoard() { throw new ControlApiError(404, "NOT_FOUND", null); },
    async getMission() { return null; }
  };
}

function fakeClick(action, dataset = {}) {
  const element = Object.assign(Object.create(globalThis.Element.prototype), {
    dataset: { action, ...dataset },
    closest() { return this; }
  });
  return { target: element, preventDefault() {} };
}

test("FIN-12 UI: вкладка «Заметки» встроена в Studio shell, занимает ширину панели и подтягивает данные по кнопке", async () => {
  const api = fakeShellApi(view());
  const root = fakeRoot();
  const app = new StudioApp(root, api);
  await app.start();

  app.state.view = "editor";
  app.state.selectedProjectId = "p-one";
  app.state.selectedQuestId = "quest";
  app.state.draft = Object.freeze({
    projectId: "p-one", questId: "quest", draftRevision: 0,
    title: "Квест", entryLocationId: "start", contentHash: "x".repeat(64),
    blocks: Object.freeze([])
  });
  app.state.collaboration = Object.freeze({ kind: "ready", view: view() });
  app.state.inspectorTab = "notes";
  app.render();
  assert.match(root.innerHTML, /data-tab="notes"/);
  assert.match(root.innerHTML, /ed-body [^"]*notes-open/);
  assert.match(root.innerHTML, /data-collab-panel/);
  assert.match(root.innerHTML, /Коллекция r7/);
  assert.match(root.innerHTML, /Заметки · 1/);
  assert.match(root.innerHTML, /Проверить фон в мастерской/);
  assert.match(root.innerHTML, /data-form="collab-note-create"/);
  assert.match(root.innerHTML, /data-collab-help/);

  // Панель не отдаёт ellipsis-обрезку и переживает перечитку без перезагрузки страницы.
  const before = api.calls();
  app.state.collaboration = Object.freeze({ kind: "unavailable", reason: "Панель временно недоступна." });
  app.render();
  assert.match(root.innerHTML, /data-action="collab-reload"/);
  await app.onClick(fakeClick("collab-reload"));
  assert.equal(api.calls(), before + 1);
  assert.equal(app.state.collaboration.kind, "ready");
  assert.match(root.innerHTML, /Проверить фон в мастерской/);
  assert.doesNotMatch(root.innerHTML, /data-collab-conflict/);
});

test("FIN-12 UI: shell показывает конфликт ревизий и не рисует write-контролы для read-only роли", async () => {
  const api = fakeShellApi(view());
  const root = fakeRoot();
  const app = new StudioApp(root, api);
  await app.start();

  app.state.view = "editor";
  app.state.selectedProjectId = "p-one";
  app.state.selectedQuestId = "quest";
  app.state.draft = Object.freeze({
    projectId: "p-one", questId: "quest", draftRevision: 0,
    title: "Квест", entryLocationId: "start", contentHash: "x".repeat(64),
    blocks: Object.freeze([])
  });
  app.state.inspectorTab = "notes";
  app.state.collaboration = Object.freeze({ kind: "ready", view: view() });
  app.state.collaborationConflict = Object.freeze({
    code: "COLLABORATION_REVISION_CONFLICT",
    currentRevision: 12,
    message: "Конфликт ревизий: сервер уже на r12. Ваша правка не применена."
  });
  app.render();
  assert.match(root.innerHTML, /data-collab-conflict/);
  assert.match(root.innerHTML, /Перечитать с сервера/);
  assert.match(root.innerHTML, /r12/);
  assert.match(root.innerHTML, /Коллекция r7/);

  // tester: read-only панель внутри shell без форм и кнопок-мутаций.
  app.state.projects = Object.freeze([{ projectId: "p-one", title: "Мастерская", role: "tester" }]);
  app.state.collaborationConflict = null;
  app.render();
  assert.match(root.innerHTML, /Только чтение/);
  assert.match(root.innerHTML, /Проверить фон в мастерской/);
  assert.doesNotMatch(root.innerHTML, /data-form="collab-note-create"/);
  assert.doesNotMatch(root.innerHTML, /data-action="collab-note-delete"/);
});


const ORIGIN = "https://studio.example";

async function withCollaborationStudio(run) {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin12-studio-ui-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  const security = new MemoryControlSecurityStore(store);
  const accounts = [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "editor", username: "editor.user", password: "editor password 123" },
    { userId: "editor2", username: "editor2.user", password: "editor2 password 123" },
    { userId: "tester", username: "tester.user", password: "tester password 123" },
    { userId: "outsider", username: "outsider.user", password: "outsider password 123" }
  ];
  for (const account of accounts) assert.equal((await security.provisionUser(account)).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "project", title: "Проект" }, "owner")).kind, "created");
  for (const [userId, role] of [["editor", "editor"], ["editor2", "editor"], ["tester", "tester"]]) {
    assert.equal((await security.setProjectMemberRole("project", userId, role)).kind, "updated");
  }
  assert.equal((await security.createProjectAsOwner({ projectId: "other", title: "Другой" }, "owner")).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Квест",
    entryLocationId: "workshop",
    initialBlocks: [{ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} }]
  })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "other", questId: "quest", title: "Другой", entryLocationId: "workshop",
    initialBlocks: [{ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} }]
  })).kind, "created");

  const control = createControlHttpServer({ store, auth: { security, allowedOrigins: [], secureCookies: false } });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const studioOrigin = `http://127.0.0.1:${studioAddress.port}`;

  const requests = [];
  const clientFor = () => {
    let cookie = null;
    const browserFetch = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      if (cookie) headers.set("cookie", cookie);
      requests.push({ path: String(input), method: init.method ?? "GET", headers: Object.fromEntries(headers.entries()) });
      const response = await fetch(new URL(String(input), studioOrigin), { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie !== null) cookie = setCookie.split(";", 1)[0];
      return response;
    };
    return new ControlApiClient(browserFetch);
  };

  const clients = {};
  for (const account of ["owner", "editor", "editor2", "tester", "outsider"]) {
    clients[account] = clientFor();
  }

  try {
    await run({ store, clients, requests, studioOrigin });
  } finally {
    await studio.close();
    await control.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("FIN-12 UI: редактор ведёт заметки и треды через прокси Studio реальными запросами с CSRF и idempotency-key", async () => {
  await withCollaborationStudio(async ({ store, clients, requests }) => {
    const editor = clients.editor;
    await editor.login("editor.user", "editor password 123");

    const empty = await loadCollaborationPanel(editor, "project", "quest");
    assert.equal(empty.kind, "ready");
    assert.equal(empty.view.revision, 0);
    const emptyHtml = renderCollaborationPanel(empty, options({ fields: Object.freeze({}) }));
    assert.match(emptyHtml, /Коллекция r0/);
    assert.match(emptyHtml, /Заметок <strong>0<\/strong>/);
    assert.match(emptyHtml, /Заметок пока нет/);

    const afterNote = await editor.createCollaborationNote(
      "project", "quest", { text: "Проверить фон в мастерской", position: { x: 12, y: 34 } }, "e-note-1"
    );
    assert.equal(afterNote.revision, 1);
    assert.equal(afterNote.notes[0].authorUserId, "editor");
    assert.equal(afterNote.notes[0].revision, 1);
    assert.match(renderCollaborationPanel(Object.freeze({ kind: "ready", view: afterNote }), options()), /Проверить фон в мастерской/);

    const noteRequest = requests.find((entry) => entry.path.endsWith("/collaboration/notes") && entry.method === "POST");
    assert.ok(noteRequest, "note creation must go through the Studio proxy");
    assert.equal(noteRequest.headers["idempotency-key"], "e-note-1");
    assert.ok(noteRequest.headers["x-csrf-token"], "editor writes must carry the CSRF proof");
    assert.equal(noteRequest.headers["content-type"], "application/json");

    const afterThread = await editor.createCollaborationThread(
      "project", "quest", { anchor: { kind: "board", targetId: null, position: { x: 400, y: 500 } }, text: "Обсудить сцену" }, "e-thread-1"
    );
    const threadId = afterThread.threads[0].threadId;
    assert.equal(afterThread.unresolvedThreadCount, 1);

    const replied = await editor.addCollaborationMessage("project", "quest", threadId, "Беру на себя", "e-reply-1");
    const repliedThread = replied.threads.find((entry) => entry.threadId === threadId);
    assert.equal(repliedThread.messages.length, 2);

    const resolved = await editor.setCollaborationThreadStatus(
      "project", "quest", threadId, { expectedRevision: repliedThread.revision, status: "resolved" }, "e-resolve-1"
    );
    assert.equal(resolved.threads[0].status, "resolved");
    assert.equal(resolved.unresolvedThreadCount, 0);
    const reopened = await editor.setCollaborationThreadStatus(
      "project", "quest", threadId, { expectedRevision: resolved.threads[0].revision, status: "open" }, "e-reopen-1"
    );
    assert.equal(reopened.threads[0].status, "open");
    assert.equal(reopened.unresolvedThreadCount, 1);

    // Ничего из этого не сдвинуло игровой черновик.
    assert.equal((await store.getDraft("project", "quest")).draftRevision, 0);
  });
});

test("FIN-12 UI: чужой текст, устаревшая ревизия и недоступная роль показываются честно и не перезаписывают сервер", async () => {
  await withCollaborationStudio(async ({ store, clients }) => {
    const editor = clients.editor;
    const editor2 = clients.editor2;
    const tester = clients.tester;
    const outsider = clients.outsider;
    await editor.login("editor.user", "editor password 123");
    await editor2.login("editor2.user", "editor2 password 123");
    await tester.login("tester.user", "tester password 123");
    await outsider.login("outsider.user", "outsider password 123");

    const created = await editor.createCollaborationNote(
      "project", "quest", { text: "Проверить фон", position: { x: 1, y: 1 } }, "e-note-1"
    );
    const noteId = created.notes[0].noteId;

    // Другой editor не автор — сервер отвечает 403 COLLABORATION_FORBIDDEN.
    let foreign = null;
    await assert.rejects(
      editor2.changeCollaborationNote("project", "quest", noteId, {
        expectedRevision: 1, text: "чужая правка", position: { x: 1, y: 1 }
      }, "e2-foreign"),
      (error) => { foreign = collaborationWriteFailure(error); return error.status === 403; }
    );
    assert.equal(foreign.kind, "forbidden");
    assert.match(collaborationErrorMessage(foreign), /автор|владелец/);
    const afterForeign = await editor.getCollaboration("project", "quest");
    assert.equal(afterForeign.notes[0].text, "Проверить фон");

    // Устаревшая ревизия — 409 с текущей ревизией; панель предлагает перечитку.
    let stale = null;
    await assert.rejects(
      editor.changeCollaborationNote("project", "quest", noteId, {
        expectedRevision: 9, text: "устарело", position: { x: 1, y: 1 }
      }, "e-stale"),
      (error) => { stale = collaborationWriteFailure(error); return error.status === 409; }
    );
    assert.equal(stale.kind, "conflict");
    assert.equal(stale.currentRevision, 1);
    const conflictHtml = renderCollaborationPanel(
      Object.freeze({ kind: "ready", view: afterForeign }),
      options({ conflict: Object.freeze({ code: stale.code, currentRevision: stale.currentRevision, message: collaborationErrorMessage(stale) }) })
    );
    assert.match(conflictHtml, /data-collab-conflict/);
    assert.match(conflictHtml, /r1/);
    assert.match(conflictHtml, /Перечитать с сервера/);
    assert.equal((await store.getCollaboration("project", "quest")).notes[0].text, "Проверить фон");

    // tester читает, но ни одного write-контрола не получает.
    const testerView = await loadCollaborationPanel(tester, "project", "quest");
    assert.equal(testerView.kind, "ready");
    const testerHtml = renderCollaborationPanel(testerView, options({ canWrite: false }));
    assert.doesNotMatch(testerHtml, /data-form=/);
    assert.match(testerHtml, /Проверить фон/);
    assert.match(testerHtml, /Только чтение/);
    const roleFailure = await tester.createCollaborationNote(
      "project", "quest", { text: "нельзя", position: { x: 1, y: 1 } }, "tester-1"
    ).then(() => null, (error) => collaborationWriteFailure(error));
    assert.equal(roleFailure.kind, "forbidden");

    // Чужой проект и отсутствующий квест — 404, без утечки роли.
    const foreignProject = await loadCollaborationPanel(outsider, "project", "quest");
    assert.equal(foreignProject.kind, "unavailable");
    assert.match(foreignProject.reason, /404|недоступ/i);
    const missingQuest = await loadCollaborationPanel(editor, "project", "no-such-quest");
    assert.equal(missingQuest.kind, "unavailable");
    assert.equal(missingQuest.reason, collaborationLoadMessage(new ControlApiError(404, "NOT_FOUND", null)));

    // Панель в 404-режиме не предлагает write-действий, но объясняет причину.
    const unavailableHtml = renderCollaborationPanel(foreignProject, options());
    assert.doesNotMatch(unavailableHtml, /data-form=/);
    assert.match(unavailableHtml, /data-action="collab-reload"/);
  });
});
