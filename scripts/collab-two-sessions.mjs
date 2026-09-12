// scripts/collab-two-sessions.mjs
//
// Collaboration acceptance harness: TWO INDEPENDENT BROWSER CONTEXTS of Studio,
// TWO ACCOUNT SESSIONS, proving that the participants SEE EACH OTHER and that a
// concurrent edit CANNOT SILENTLY OVERWRITE work.
//
// WHY THIS BOOTS AN IN-PROCESS AUTHENTICATED STUDIO INSTEAD OF `apps/studio/dist/src/main.js`
// -------------------------------------------------------------------------------------------
// `apps/studio/src/main.ts` wires `createControlHttpServer({...})` WITHOUT the
// `auth` dependency, so Studio's own dev server runs in `local-loopback-owner`
// access mode. Presence (FIN-13) and editing locks are mounted only when `auth`
// is present:
//     if (auth && await presenceServiceFor(auth).handleRequest(...)) return;
//     if (auth && await editingLockServiceFor(auth).handleRequest(...)) return;
// With `auth === null` every `/presence` and `/editing-lock` route falls through to
// the generic router and answers `404 CONTROL_NOT_FOUND`. Collaboration (FIN-12)
// routes do work in local mode, but attributing authorship to two real accounts —
// the whole point of "two sessions" — needs real identities.
//
// This harness therefore reuses the SAME product modules (`createControlHttpServer`,
// `createStudioDevServer`, `MemoryControlSecurityStore`) with `auth` enabled and
// serves the real Studio bundle. No product file is modified; only new files under
// `scripts/` are added. A first step records the local-mode behaviour so the design
// choice is backed by evidence rather than a claim.
//
// WHY A TINY STREAMING PROXY (createStreamingProxy) INSTEAD OF THE STUDIO DEV PROXY
// ---------------------------------------------------------------------------------
// Studio's own dev-server proxy (`apps/studio/src/dev-server.ts`) does
// `new Uint8Array(await upstream.arrayBuffer())` before writing the response — it
// BUFFERS the whole upstream body. Presence is Server-Sent Events, so through that
// proxy the browser's `EventSource` never sees headers and the live cursor bar never
// opens. The harness fronts the Studio bundle with a ~45-line streaming reverse proxy
// so `/control/*` (including SSE) is piped through, which is what the nginx contour
// does in production. Static bundle and Control API are still the real product code.
//
// EXIT-CODE CONTRACT
// ------------------
// Exit 0 ONLY when every recorded step reports ok:true. A failed assertion, a fatal
// startup error (Chrome unreachable, servers down) or an unavailable Chrome surfaces
// as a non-zero exit code. A check that could not be performed is reported as FAILED,
// never silently passed.
//
// ENV SEAMS
// ---------
//   COLLAB_EXPECT_CONFLICT_STATUS  default 409 — status a stale concurrent write must
//                                  receive. Set to 200 to prove the assertion is
//                                  load-bearing (the run must then turn red).
//   COLLAB_STUDIO_PORT / COLLAB_CONTROL_PORT / COLLAB_CHROME_PORT / COLLAB_CHROME_PATH
//   COLLAB_ARTIFACTS_DIR
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MemoryControlSecurityStore, SQLiteControlStore } from "../packages/control/dist/index.js";
import { createControlHttpServer } from "../apps/server/dist/control-server.js";
import { createStudioDevServer } from "../apps/studio/dist/src/dev-server.js";
import { LocalAuthorProvider } from "../apps/studio/dist/src/local-author-provider.js";

export const PROJECT_ID = "collab-two-sessions";
export const QUEST_ID = "quest-shared";
export const ALICE = Object.freeze({ userId: "alice", username: "alice.user", password: "alice password 123" });
export const BOB = Object.freeze({ userId: "bob", username: "bob.user", password: "bob password 123" });

const WORKSHOP_BLOCK = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: {}
});

/* ───────────────────────────── pure, unit-testable logic ───────────────────────────── */

/** 0 only when there is at least one result and every result is explicitly ok:true. */
export function computeExitCode(results) {
  if (!Array.isArray(results) || results.length === 0) return 1;
  return results.every((entry) => entry && entry.ok === true) ? 0 : 1;
}

/**
 * Parse a batch of SSE blocks into `{ event, data }` frames. Malformed blocks are
 * skipped rather than thrown, so a partially-flushed chunk cannot crash the reader.
 */
export function parseSseBlocks(text) {
  const frames = [];
  for (const block of String(text).split("\n\n")) {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data += line.slice("data:".length).trim();
    }
    if (data.length === 0) continue;
    try {
      frames.push({ event, data: JSON.parse(data) });
    } catch {
      // A frame cut by a chunk boundary is retried by the incremental collector.
    }
  }
  return frames;
}

/**
 * Assertion for "a stale concurrent write must not overwrite". Kept independent of the
 * transport so the mutation proof can exercise it without a browser.
 */
export function evaluateConflictExpectation({ status, code, expectedStatus, expectedCode }) {
  if (status !== expectedStatus) {
    return { ok: false, detail: `expected HTTP ${expectedStatus} for a stale write, got ${status} (code ${code})` };
  }
  if (expectedCode !== undefined && code !== expectedCode) {
    return { ok: false, detail: `expected error code ${expectedCode}, got ${code}` };
  }
  return { ok: true, detail: `HTTP ${status} ${code}` };
}

/** Incremental SSE reader: frames survive chunk boundaries. */
export function createSseCollector() {
  const frames = [];
  let buffer = "";
  return {
    push(chunk) {
      buffer += String(chunk);
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const block of parts) {
        for (const frame of parseSseBlocks(block)) frames.push(frame);
      }
      return frames;
    },
    frames,
    text: () => buffer
  };
}

/** `lh_control_session=...` cookie string from a login's Set-Cookie header. */
export function cookieFromSetCookie(setCookie) {
  return String(setCookie).split(";", 1)[0];
}

/** userIds carried by a presence room snapshot body. */
export function snapshotUserIds(presenceBody) {
  return (presenceBody?.presence?.participants ?? []).map((participant) => participant.userId).sort();
}

/* ───────────────────────────── transport helpers ───────────────────────────── */

class StepRecorder {
  constructor({ log = true } = {}) {
    this.results = [];
    this.log = log;
    this.startedAt = Date.now();
    this.step = 0;
  }
  record(name, ok, detail) {
    this.step += 1;
    this.results.push({ name, ok, detail: detail === undefined ? null : detail });
    if (this.log) {
      const elapsed = `${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`;
      const suffix = detail === undefined || detail === null ? "" : ` ${JSON.stringify(detail).slice(0, 220)}`;
      console.log(`[${elapsed}] ${String(this.step).padStart(2, "0")} ${ok ? "ok  " : "FAIL"} ${name}${suffix}`);
    }
    return ok;
  }
  ok(name, detail) {
    return this.record(name, true, detail);
  }
  fail(name, detail) {
    return this.record(name, false, String(detail));
  }
}

function makeClient(base, { origin, cookie, csrf } = {}) {
  return {
    cookie,
    csrf,
    async json(path, options = {}) {
      const headers = { ...(options.headers ?? {}) };
      if (origin !== undefined) headers.origin = origin;
      if (this.cookie !== undefined) headers.cookie = this.cookie;
      if (this.csrf !== undefined) headers["x-csrf-token"] = this.csrf;
      let body;
      if (Object.hasOwn(options, "json")) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.json);
      }
      const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text.length === 0 ? null : JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      return { status: response.status, headers: response.headers, body: parsed };
    }
  };
}

/**
 * Streaming reverse proxy: `/control/*` is piped to the Control API (SSE keeps flowing),
 * everything else is piped to the Studio dev-server (the real bundle).
 */
function createStreamingProxy({ studioTarget, controlTarget }) {
  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(String(request.url ?? "/"), "http://proxy.local");
    } catch {
      response.statusCode = 400;
      response.end("bad request");
      return;
    }
    const target = url.pathname.startsWith("/control/") ? controlTarget : studioTarget;
    const headers = { ...request.headers };
    delete headers.host;
    headers.host = `${target.host}:${target.port}`;
    const upstream = httpRequest(
      { host: target.host, port: target.port, path: request.url, method: request.method, headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      }
    );
    upstream.on("error", () => {
      try {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      } catch {
        // headers already sent
      }
      response.end("upstream unavailable");
    });
    request.pipe(upstream);
  });
  return {
    listen(port, host = "127.0.0.1") {
      return new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolvePromise({ host, port: server.address().port }));
      });
    },
    close() {
      return new Promise((resolvePromise) => {
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      });
    }
  };
}

/* ───────────────────────────── CDP client ───────────────────────────── */

class CdpConnection {
  constructor(wsUrl) {
    this.pending = new Map();
    this.nextId = 0;
    this.socket = new WebSocket(wsUrl);
    this.ready = new Promise((resolvePromise, reject) => {
      this.socket.onopen = () => resolvePromise();
      this.socket.onerror = (event) => reject(new Error(`CDP socket error: ${event?.message ?? "unknown"}`));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve: resolvePromise, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error)})`));
      else resolvePromise(message.result);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(sessionId, expression, { timeoutMs = 30_000 } = {}) {
    const result = await withTimeout(
      this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId),
      timeoutMs,
      `eval timed out: ${String(expression).slice(0, 120)}`
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "eval failed");
    }
    return result.result.value;
  }
  close() {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function findChrome() {
  const candidates = [
    process.env.COLLAB_CHROME_PATH,
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
  ].filter((value) => typeof value === "string" && value.length > 0);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function waitForChrome(endpoint, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const version = await fetch(`${endpoint}/json/version`).then((response) => response.json());
      if (version?.webSocketDebuggerUrl) return version;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Chrome DevTools endpoint ${endpoint} did not become ready`);
    await sleep(250);
  }
}

/* ───────────────────────────── the harness ───────────────────────────── */

async function bootServers(recorder, { studioPort, controlPort }) {
  const directory = await mkdtemp(join(tmpdir(), "lh-collab-two-sessions-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  const security = new MemoryControlSecurityStore(store);

  // Two real accounts, one shared project: alice owns it, bob edits it.
  for (const user of [ALICE, BOB]) {
    const result = await security.provisionUser({ userId: user.userId, username: user.username, password: user.password });
    if (result.kind !== "created") throw new Error(`provisionUser(${user.userId}) → ${result.kind}`);
  }
  const project = await security.createProjectAsOwner({ projectId: PROJECT_ID, title: "Совместная правка" }, ALICE.userId);
  if (project.kind !== "created") throw new Error(`createProjectAsOwner → ${project.kind}`);
  const membership = await security.setProjectMemberRole(PROJECT_ID, BOB.userId, "editor");
  if (membership.kind !== "updated") throw new Error(`setProjectMemberRole(bob) → ${membership.kind}`);
  const quest = await store.createQuest({
    projectId: PROJECT_ID,
    questId: QUEST_ID,
    title: "Совместный квест",
    entryLocationId: "workshop",
    initialBlocks: [WORKSHOP_BLOCK]
  });
  if (quest.kind !== "created") throw new Error(`createQuest → ${quest.kind}`);

  // The browser contexts talk to the proxy origin, so that is the allowed origin.
  const publicOrigin = `http://127.0.0.1:${studioPort}`;
  const control = createControlHttpServer({
    store,
    boardStore: store,
    collaborationStore: store,
    auth: { security, allowedOrigins: [publicOrigin], secureCookies: false, nowMs: () => Date.now() }
  });
  const controlAddress = await control.listen(controlPort, "127.0.0.1");
  const controlOrigin = `http://127.0.0.1:${controlAddress.port}`;

  const studio = createStudioDevServer({ controlOrigin, authorProvider: new LocalAuthorProvider() });
  // The bundle server listens on an internal ephemeral port; the public port is the
  // streaming proxy, so the same port is never bound twice.
  const studioAddress = await studio.listen(0, "127.0.0.1");

  const proxy = createStreamingProxy({
    studioTarget: { host: studioAddress.host, port: studioAddress.port },
    controlTarget: { host: controlAddress.host, port: controlAddress.port }
  });
  const proxyAddress = await proxy.listen(studioPort, "127.0.0.1");

  recorder.ok("boot: authenticated Control + real Studio bundle + streaming proxy", {
    controlOrigin,
    publicOrigin: `http://127.0.0.1:${proxyAddress.port}`,
    accessMode: control.accessMode,
    databasePath: join(directory, "control.sqlite")
  });

  return {
    store,
    security,
    control,
    studio,
    proxy,
    controlOrigin,
    studioOrigin: `http://127.0.0.1:${proxyAddress.port}`,
    async close() {
      await proxy.close();
      await studio.close();
      await control.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

/**
 * Evidence that the design choice (authenticated mode) is real: a Control server WITHOUT
 * `auth` — exactly what `apps/studio/src/main.ts` builds — answers 404 on presence routes.
 */
async function proveLocalModeLacksPresence(recorder) {
  const directory = await mkdtemp(join(tmpdir(), "lh-collab-local-mode-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  store.createProject({ projectId: PROJECT_ID, title: "local" });
  const control = createControlHttpServer({ store });
  const address = await control.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    if (control.accessMode !== "local-loopback-owner") {
      return recorder.fail("design-evidence: Studio-local mode answers 404 on /presence", `unexpected accessMode ${control.accessMode}`);
    }
    const response = await fetch(`${origin}/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/presence`, { headers: { origin } });
    const body = await response.json().catch(() => null);
    const code = body?.error?.code ?? null;
    if (response.status === 404 && code === "NOT_FOUND") {
      return recorder.ok("design-evidence: Studio-local mode answers 404 on /presence", { accessMode: control.accessMode, status: response.status, code });
    }
    return recorder.fail("design-evidence: Studio-local mode answers 404 on /presence", `status=${response.status} code=${code}`);
  } finally {
    await control.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function launchChrome(recorder, { chromePort, userDataDir }) {
  const executable = findChrome();
  if (executable === null) throw new Error("no Chrome/Edge executable found (set COLLAB_CHROME_PATH)");
  const endpoint = `http://127.0.0.1:${chromePort}`;
  const child = spawn(executable, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], { stdio: "ignore", detached: false });
  const version = await waitForChrome(endpoint);
  recorder.ok("chrome: headless remote debugging reachable", { executable, endpoint, browser: version.Browser });
  return { child, endpoint };
}

/** One browser context with its own cookie jar, pre-seeded with its account session. */
async function createContext(connection, recorder, name, studioOrigin, session) {
  const { browserContextId } = await connection.send("Target.createBrowserContext", {});
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  await connection.send("Page.enable", {}, sessionId);
  await connection.send("Runtime.enable", {}, sessionId);
  await connection.send("Network.enable", {}, sessionId);
  const { success } = await connection.send("Network.setCookie", {
    name: "lh_control_session",
    value: session.token,
    url: `${studioOrigin}/control/v1`,
    path: "/control/v1",
    httpOnly: true,
    sameSite: "Strict"
  }, sessionId);
  if (!success) recorder.fail(`context ${name}: session cookie installed`, "Network.setCookie returned success=false");
  await connection.send("Page.navigate", { url: studioOrigin }, sessionId);
  await sleep(1500);
  recorder.ok(`context ${name}: isolated browser context on Studio with its own session`, { browserContextId, targetId, url: studioOrigin });
  return { name, browserContextId, targetId, sessionId };
}

async function readStudioState(connection, context) {
  return connection.evaluate(context.sessionId, `(() => {
    const text = document.body ? document.body.innerText : "";
    return {
      title: document.title,
      hasProject: Boolean(document.querySelector('[data-action="open-project"][data-project-id=${JSON.stringify(PROJECT_ID)}]')),
      hasQuest: Boolean(document.querySelector('[data-action="select-quest"][data-quest-id=${JSON.stringify(QUEST_ID)}]')),
      hasBoard: Boolean(document.querySelector('[data-action="board-view"][data-view="board"]')),
      presenceBar: (document.querySelector('[data-presence-bar]')?.innerText ?? null),
      body: text.replace(/\\s+/g, " ").slice(0, 400)
    };
  })()`);
}

async function clickSelector(connection, sessionId, selector) {
  return connection.evaluate(sessionId, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
}

async function openSharedBoard(connection, recorder, context) {
  const deadline = Date.now() + 20_000;
  let state = await readStudioState(connection, context);
  while (!state.hasProject && Date.now() < deadline) {
    await sleep(300);
    state = await readStudioState(connection, context);
  }
  if (!state.hasProject) return recorder.fail(`context ${context.name}: authenticated project list`, `project card never appeared; body="${state.body}"`);

  await clickSelector(connection, context.sessionId, `[data-action="open-project"][data-project-id="${PROJECT_ID}"]`);
  await sleep(900);
  const afterProject = await readStudioState(connection, context);
  if (!afterProject.hasQuest) return recorder.fail(`context ${context.name}: opened the shared project`, `quest rail missing; body="${afterProject.body}"`);

  await clickSelector(connection, context.sessionId, `[data-action="select-quest"][data-quest-id="${QUEST_ID}"]`);
  await sleep(1500);
  const afterQuest = await readStudioState(connection, context);
  if (!afterQuest.hasBoard) return recorder.fail(`context ${context.name}: selected the shared quest`, `board never mounted; body="${afterQuest.body}"`);
  return recorder.ok(`context ${context.name}: opened the shared quest board`, { presenceBar: afterQuest.presenceBar });
}

async function waitForPresenceUsernames(connection, context, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let bar = null;
  for (;;) {
    bar = await connection.evaluate(context.sessionId, `document.querySelector('[data-presence-bar]')?.innerText ?? null`);
    if (typeof bar === "string" && expected.every((name) => bar.includes(name))) return bar;
    if (Date.now() > deadline) return bar;
    await sleep(300);
  }
}

async function captureScreenshot(connection, context, path) {
  const shot = await withTimeout(
    connection.send("Page.captureScreenshot", { format: "png" }, context.sessionId),
    45_000,
    `screenshot timed out for context ${context.name}`
  );
  await writeFile(path, Buffer.from(shot.data, "base64"));
  return path;
}

/** Node-side SSE reader that authenticates as an existing session (cookie), no browser. */
async function openPresenceStream({ controlOrigin, studioOrigin, cookie, timeoutMs = 20_000 }) {
  const controller = new AbortController();
  const response = await fetch(`${controlOrigin}/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/presence/stream`, {
    headers: { origin: studioOrigin, cookie, accept: "text/event-stream" },
    signal: controller.signal
  });
  if (!response.ok) throw new Error(`presence stream answered ${response.status}`);
  const collector = createSseCollector();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        collector.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // aborted on close — expected
    }
  })();
  return {
    collector,
    async waitFor(predicate) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(collector.frames)) return true;
        await sleep(150);
      }
      return false;
    },
    async close() {
      controller.abort();
      await pump.catch(() => undefined);
    }
  };
}

/** Real account session obtained from the same Control API the browsers use. */
async function nodeLogin({ controlOrigin, studioOrigin, user }) {
  const response = await fetch(`${controlOrigin}/control/v1/auth/login`, {
    method: "POST",
    headers: { origin: studioOrigin, "content-type": "application/json" },
    body: JSON.stringify({ username: user.username, password: user.password })
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || typeof body?.csrfToken !== "string") {
    throw new Error(`login(${user.userId}) → ${response.status} ${JSON.stringify(body)}`);
  }
  const cookie = cookieFromSetCookie(response.headers.get("set-cookie"));
  const token = cookie.slice("lh_control_session=".length);
  return { cookie, csrf: body.csrfToken, token, userId: body.user?.userId ?? null, sessionId: body.session?.sessionId ?? null };
}

export async function runCollabTwoSessions(options = {}) {
  const recorder = new StepRecorder();
  const artifacts = options.artifactsDir ?? process.env.COLLAB_ARTIFACTS_DIR ?? resolve(fileURLToPath(new URL("../artifacts/collab-two-sessions", import.meta.url)));
  await mkdir(artifacts, { recursive: true });

  const studioPort = Number(options.studioPort ?? process.env.COLLAB_STUDIO_PORT ?? 4191);
  const controlPort = Number(options.controlPort ?? process.env.COLLAB_CONTROL_PORT ?? 8891);
  const chromePort = Number(options.chromePort ?? process.env.COLLAB_CHROME_PORT ?? 9339);
  const expectedConflictStatus = Number(process.env.COLLAB_EXPECT_CONFLICT_STATUS ?? 409);

  const receipt = { projectId: PROJECT_ID, questId: QUEST_ID, artifacts, steps: [], screenshots: {}, conflictExpectation: expectedConflictStatus };

  await proveLocalModeLacksPresence(recorder);

  let servers = null;
  let chrome = null;
  let connection = null;
  try {
    servers = await bootServers(recorder, { studioPort, controlPort });
    chrome = await launchChrome(recorder, { chromePort, userDataDir: await mkdtemp(join(tmpdir(), "lh-collab-chrome-")) });

    const version = await waitForChrome(chrome.endpoint);
    connection = new CdpConnection(version.webSocketDebuggerUrl);
    await connection.ready;

    // Two account sessions, each installed into its own browser context's cookie jar.
    const aliceSession = await nodeLogin({ controlOrigin: servers.controlOrigin, studioOrigin: servers.studioOrigin, user: ALICE });
    const bobSession = await nodeLogin({ controlOrigin: servers.controlOrigin, studioOrigin: servers.studioOrigin, user: BOB });
    recorder.ok("sessions: two authenticated accounts issued really distinct sessions", {
      alice: aliceSession.userId,
      bob: bobSession.userId,
      distinct: aliceSession.sessionId !== bobSession.sessionId && aliceSession.token !== bobSession.token
    });

    const contextA = await createContext(connection, recorder, "A", servers.studioOrigin, aliceSession);
    const contextB = await createContext(connection, recorder, "B", servers.studioOrigin, bobSession);

    const openedA = await openSharedBoard(connection, recorder, contextA);
    const openedB = await openSharedBoard(connection, recorder, contextB);

    // Prove the two contexts really carry two different identities.
    const sessionA = await connection.evaluate(contextA.sessionId, `fetch('/control/v1/auth/session', { credentials: 'same-origin' }).then(r => r.json())`);
    const sessionB = await connection.evaluate(contextB.sessionId, `fetch('/control/v1/auth/session', { credentials: 'same-origin' }).then(r => r.json())`);
    const ids = [sessionA?.user?.userId, sessionB?.user?.userId];
    if (ids.includes(ALICE.userId) && ids.includes(BOB.userId)) {
      recorder.ok("sessions: each browser context resolves to its own user", { contextA: sessionA?.user?.userId, contextB: sessionB?.user?.userId });
    } else {
      recorder.fail("sessions: each browser context resolves to its own user", JSON.stringify(ids));
    }

    // 1. Mutual visibility, in the browser: each board's presence bar lists BOTH users.
    if (openedA && openedB) {
      const barA = await waitForPresenceUsernames(connection, contextA, [ALICE.username, BOB.username]);
      const barB = await waitForPresenceUsernames(connection, contextB, [ALICE.username, BOB.username]);
      const visible = typeof barA === "string" && barA.includes(BOB.username)
        && typeof barB === "string" && barB.includes(ALICE.username);
      if (visible) recorder.ok("presence: each browser context SEES the other participant", { contextA: barA, contextB: barB });
      else recorder.fail("presence: each browser context SEES the other participant", `A="${barA}" B="${barB}"`);
    } else {
      recorder.fail("presence: each browser context SEES the other participant", "board not opened in both contexts");
    }

    // 2. Server-side push proof. A DEDICATED session is used for the node-side stream:
    //    presence connections are keyed by (sessionId, project, quest), so reusing one
    //    of the browser sessions and then closing the reader would drop that participant
    //    from the room and skew the screenshots taken afterwards.
    const alice = makeClient(servers.controlOrigin, { origin: servers.studioOrigin, cookie: aliceSession.cookie, csrf: aliceSession.csrf });
    const bob = makeClient(servers.controlOrigin, { origin: servers.studioOrigin, cookie: bobSession.cookie, csrf: bobSession.csrf });
    const streamSession = await nodeLogin({ controlOrigin: servers.controlOrigin, studioOrigin: servers.studioOrigin, user: ALICE });

    const stream = await openPresenceStream({ controlOrigin: servers.controlOrigin, studioOrigin: servers.studioOrigin, cookie: streamSession.cookie });
    try {
      const sawSnapshot = await stream.waitFor((frames) => frames.some((frame) => frame.data?.type === "snapshot"));
      if (sawSnapshot) recorder.ok("presence stream: alice's session receives the room snapshot", { frames: stream.collector.frames.length });
      else recorder.fail("presence stream: alice's session receives the room snapshot", JSON.stringify(stream.collector.frames.slice(-3)));

      const bobCursor = await bob.json(`/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/presence`, { method: "POST", json: { cursor: { x: 120, y: 240 } } });
      const sawBob = await stream.waitFor((frames) => frames.some((frame) => (frame.data?.participant ?? null)?.userId === BOB.userId));
      if (bobCursor.status === 200 && sawBob) {
        recorder.ok("presence stream: a frame about bob is pushed into alice's live stream", { bobStatus: bobCursor.status });
      } else {
        recorder.fail("presence stream: a frame about bob is pushed into alice's live stream", `bobStatus=${bobCursor.status} frames=${JSON.stringify(stream.collector.frames.slice(-3))}`);
      }

      const snapshot = await alice.json(`/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/presence`);
      const userIds = snapshotUserIds(snapshot.body);
      if (snapshot.status === 200 && userIds.includes(ALICE.userId) && userIds.includes(BOB.userId)) {
        recorder.ok("presence snapshot: the shared room lists both accounts", { userIds });
      } else {
        recorder.fail("presence snapshot: the shared room lists both accounts", `status=${snapshot.status} userIds=${JSON.stringify(userIds)}`);
      }
    } finally {
      await stream.close();
    }

    // 3. Collaboration: one shared state, readable by both accounts.
    const collabPath = `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/collaboration`;
    const note = await alice.json(`${collabPath}/notes`, { method: "POST", headers: { "idempotency-key": "alice-note-1" }, json: { text: "Проверить фон сцены", position: { x: 40, y: 60 } } });
    if (note.status === 201) recorder.ok("collaboration: alice created a board note", { revision: note.body?.collaboration?.revision });
    else recorder.fail("collaboration: alice created a board note", `status=${note.status} body=${JSON.stringify(note.body)}`);

    const thread = await alice.json(`${collabPath}/comments`, {
      method: "POST",
      headers: { "idempotency-key": "alice-thread-1" },
      json: { anchor: { kind: "board", targetId: null, position: { x: 400, y: 500 } }, text: "Обсудить финал" }
    });
    const threadId = thread.body?.collaboration?.threads?.[0]?.threadId ?? null;
    if (thread.status === 201 && threadId !== null) recorder.ok("collaboration: alice opened a thread", { threadId });
    else recorder.fail("collaboration: alice opened a thread", `status=${thread.status} body=${JSON.stringify(thread.body)}`);

    const bobSees = await bob.json(collabPath);
    const bobSeesNote = (bobSees.body?.collaboration?.notes ?? []).some((entry) => entry.text === "Проверить фон сцены");
    const bobSeesThread = (bobSees.body?.collaboration?.threads ?? []).some((entry) => entry.threadId === threadId);
    if (bobSees.status === 200 && bobSeesNote && bobSeesThread) {
      recorder.ok("collaboration: bob reads alice's note and thread", { revision: bobSees.body?.collaboration?.revision });
    } else {
      recorder.fail("collaboration: bob reads alice's note and thread", `status=${bobSees.status} note=${bobSeesNote} thread=${bobSeesThread}`);
    }

    if (threadId !== null) {
      const reply = await bob.json(`${collabPath}/comments/${threadId}/messages`, { method: "POST", headers: { "idempotency-key": "bob-reply-1" }, json: { text: "Беру финал на себя" } });
      const aliceSees = await alice.json(collabPath);
      const aliceSeesReply = (aliceSees.body?.collaboration?.threads ?? [])
        .find((entry) => entry.threadId === threadId)?.messages?.some((message) => message.authorUserId === BOB.userId && message.text === "Беру финал на себя");
      if (reply.status === 200 && aliceSeesReply) recorder.ok("collaboration: bob's reply is visible to alice", { threadId });
      else recorder.fail("collaboration: bob's reply is visible to alice", `reply.status=${reply.status} visible=${aliceSeesReply}`);
    }

    // 4. Concurrent edit on the SAME thread revision: the stale writer must be rejected.
    if (threadId !== null) {
      const before = await alice.json(collabPath);
      const sharedRevision = (before.body?.collaboration?.threads ?? []).find((entry) => entry.threadId === threadId)?.revision ?? null;
      const first = await alice.json(`${collabPath}/comments/${threadId}/messages`, {
        method: "POST",
        headers: { "idempotency-key": "alice-cas-1" },
        json: { text: `Алиса: правка по ревизии ${sharedRevision}`, expectedRevision: sharedRevision }
      });
      const stale = await bob.json(`${collabPath}/comments/${threadId}/messages`, {
        method: "POST",
        headers: { "idempotency-key": "bob-cas-stale-1" },
        json: { text: "Боб: устаревшая правка", expectedRevision: sharedRevision }
      });
      const verdict = evaluateConflictExpectation({
        status: stale.status,
        code: stale.body?.error?.code ?? null,
        expectedStatus: expectedConflictStatus,
        expectedCode: expectedConflictStatus === 409 ? "COLLABORATION_REVISION_CONFLICT" : undefined
      });
      if (first.status === 200 && verdict.ok) {
        recorder.ok("concurrency: stale thread write rejected with a conflict", { firstStatus: first.status, staleStatus: stale.status, verdict: verdict.detail });
      } else {
        recorder.fail("concurrency: stale thread write rejected with a conflict", `first=${first.status} verdict=${verdict.detail}`);
      }

      const after = await alice.json(collabPath);
      const messages = (after.body?.collaboration?.threads ?? []).find((entry) => entry.threadId === threadId)?.messages ?? [];
      const texts = messages.map((message) => message.text);
      const staleApplied = texts.includes("Боб: устаревшая правка");
      const aliceKept = texts.includes(`Алиса: правка по ревизии ${sharedRevision}`);
      if (aliceKept && !staleApplied) recorder.ok("concurrency: no silent overwrite — alice's write survived, bob's stale write is absent", { texts });
      else recorder.fail("concurrency: no silent overwrite — alice's write survived, bob's stale write is absent", JSON.stringify(texts));
    }

    // 5. Concurrent draft edit: same CAS discipline on the gameplay draft.
    const draftPath = `/control/v1/projects/${PROJECT_ID}/quests/${QUEST_ID}/draft`;
    const draftBefore = await alice.json(draftPath);
    const baseRevision = draftBefore.body?.draft?.draftRevision ?? null;
    const aliceDraft = await alice.json(`${draftPath}/changes`, {
      method: "POST",
      json: { baseRevision, changes: [{ kind: "quest.title.set", title: "Квест после Алисы" }] }
    });
    const bobDraft = await bob.json(`${draftPath}/changes`, {
      method: "POST",
      json: { baseRevision, changes: [{ kind: "quest.title.set", title: "Квест после Боба" }] }
    });
    const draftVerdict = evaluateConflictExpectation({
      status: bobDraft.status,
      code: bobDraft.body?.error?.code ?? null,
      expectedStatus: expectedConflictStatus,
      expectedCode: expectedConflictStatus === 409 ? "DRAFT_REVISION_CONFLICT" : undefined
    });
    const draftAfter = await alice.json(draftPath);
    const finalTitle = draftAfter.body?.draft?.title ?? null;
    if (aliceDraft.status === 200 && draftVerdict.ok && finalTitle === "Квест после Алисы") {
      recorder.ok("concurrency: stale draft write rejected, alice's title is the stored one", { staleStatus: bobDraft.status, finalTitle });
    } else {
      recorder.fail("concurrency: stale draft write rejected, alice's title is the stored one", `alice=${aliceDraft.status} verdict=${draftVerdict.detail} finalTitle=${finalTitle}`);
    }

    // 6. Screenshots of each context, on the board and on the story view. The
    //    onboarding tour overlay is dismissed first so the board and its presence bar
    //    are actually visible in the artifact.
    for (const [context, user] of [[contextA, ALICE], [contextB, BOB]]) {
      const skippedTour = await clickSelector(connection, context.sessionId, `[data-onboarding-action="tour-skip"]`);
      await sleep(500);
      // A taller viewport keeps the board and its presence bar inside the artifact.
      await connection.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, context.sessionId);
      await sleep(500);
      const shots = {};
      let bar = null;
      for (const view of ["board", "story"]) {
        await clickSelector(connection, context.sessionId, `[data-action="board-view"][data-view="${view}"]`);
        await sleep(800);
        const path = join(artifacts, `studio-context-${context.name}-${view}-${user.username}.png`);
        try {
          await captureScreenshot(connection, context, path);
          shots[view] = path;
        } catch (error) {
          recorder.fail(`screenshot: context ${context.name} ${view}`, error?.message ?? error);
        }
        // Read the presence bar while the BOARD is still mounted: the story view
        // unmounts the board together with its presence layer.
        if (view === "board") bar = await connection.evaluate(context.sessionId, `document.querySelector('[data-presence-bar]')?.innerText ?? null`);
      }
      receipt.screenshots[context.name] = { userId: user.userId, username: user.username, ...shots, presenceBar: bar };
      const bothNames = typeof bar === "string" && bar.includes(ALICE.username) && bar.includes(BOB.username);
      if (shots.board && shots.story && bothNames) recorder.ok(`screenshot: context ${context.name} (${user.username})`, { ...shots, tourDismissed: skippedTour, presenceBar: bar });
      else recorder.fail(`screenshot: context ${context.name} (${user.username})`, `shots=${JSON.stringify(Object.keys(shots))} bothNames=${bothNames} bar="${bar}"`);
    }
  } catch (error) {
    recorder.fail("harness: fatal", error?.stack ?? String(error));
  } finally {
    try {
      if (connection) connection.close();
    } catch {
      // ignore
    }
    if (chrome?.child) {
      try {
        chrome.child.kill();
      } catch {
        // ignore
      }
    }
    if (servers) await servers.close().catch(() => undefined);
  }

  receipt.steps = recorder.results;
  receipt.exitCode = computeExitCode(recorder.results);
  const receiptPath = join(artifacts, "collab-two-sessions-receipt.json");
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  receipt.receiptPath = receiptPath;
  return receipt;
}

/* ───────────────────────────── CLI entry ───────────────────────────── */

export async function main() {
  const receipt = await runCollabTwoSessions({});
  const failed = receipt.steps.filter((step) => !step.ok);
  console.log(`collab-two-sessions: ${receipt.steps.length - failed.length}/${receipt.steps.length} steps ok`);
  for (const step of failed) console.error(`collab-two-sessions: FAILED ${step.name} — ${step.detail}`);
  for (const [name, shot] of Object.entries(receipt.screenshots)) {
    for (const [view, path] of Object.entries(shot)) {
      if (typeof path === "string" && path.endsWith(".png")) console.log(`screenshot ${name}/${view}: ${path}`);
    }
  }
  console.log(`receipt: ${receipt.receiptPath}`);
  process.exitCode = receipt.exitCode;
  // A live CDP socket or an SSE reader can keep the loop alive after the run; the
  // verdict is already decided, so exit explicitly rather than hang the caller.
  process.exit(receipt.exitCode);
  return receipt;
}

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/").toLowerCase() : "";
const self = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
if (invoked && invoked === self && process.env.COLLAB_TWO_SESSIONS_IMPORT !== "1") {
  await main();
}
