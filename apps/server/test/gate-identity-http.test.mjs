// FIN-06 / C18 — единый вход в Studio через существующий Telegram-бот gate.
//
// Требование владельца: один вход через @living_history_gate_bot, без второй
// регистрации/логина/пароля в Studio; повторный вход возвращает того же
// пользователя; права берутся из `control_project_members`, а не «все вошедшие —
// владельцы». Доказательством входа является ТОЛЬКО проверенная серверная сессия
// gate (подписанный ассерт, который браузер не может подделать), а не
// присланный браузером Telegram-ID и не выставленный им заголовок.
//
// Проверяется РЕАЛЬНЫЙ путь продукта, без моков: настоящий deploy/vps/lhc-gate.mjs
// (бот → тикет → cookie), настоящий край (auth_request к gate и проброс
// подписанного ассерта — модель nginx в deploy/vps/nginx-lhc.conf), настоящий
// createControlHttpServer с `gateIdentity` и настоящие SQLite store/security.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteControlStore,
  SQLiteControlSecurityStore,
  controlUserIdForTelegram
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";
import { createGateIdentityVerifier, signGateIdentityAssertion } from "../dist/gate-auth-identity.js";

process.env.LHC_GATE_NO_AUTOSTART = "1";
const { createGate, defaultState, wireHttp } = await import("../../../deploy/vps/lhc-gate.mjs");

const ORIGIN = "https://studio.example:8741";
const GATE_SECRET = "g".repeat(48);
const OWNER_TG = "332664273";
const EDITOR_TG = "111222333";
const TESTER_TG = "555666777";
const OUTSIDER_TG = "999888777";
const PROJECT = "p1";
const QUEST = "q1";

let now = 1_800_000_000_000;

function fakeTelegram() {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, text, extra = {}) => {
      sent.push({ chatId: String(chatId), text, extra });
      return { message_id: sent.length };
    },
    editMessageText: async () => true,
    answerCallbackQuery: async () => true,
    getChat: async () => { throw new Error("no chat"); }
  };
}

const message = (telegramId, text) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: {
    message_id: 1,
    chat: { id: Number(telegramId), type: "private" },
    from: { id: Number(telegramId), first_name: "Test", username: `user${telegramId.slice(-4)}` },
    text
  }
});

const callback = (telegramId, data) => ({
  update_id: Math.floor(Math.random() * 1e9),
  callback_query: {
    id: `cb-${Math.random()}`,
    data,
    from: { id: Number(telegramId), first_name: "Test", username: `user${telegramId.slice(-4)}` },
    message: { message_id: 7, chat: { id: Number(telegramId), type: "private" } }
  }
});

function ticketFromBot(tg, telegramId) {
  const withLink = tg.sent.filter((entry) => String(entry.chatId) === String(telegramId)
    && entry.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.url);
  const last = withLink.at(-1);
  if (!last) return null;
  return new URL(last.extra.reply_markup.inline_keyboard[0][0].url).searchParams.get("ticket");
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Край — модель nginx: cookie браузера идёт в `/gate/check`; при 200 ассерт gate
 * ставится как `x-lhc-gate-identity`, а клиентские `x-lhc-gate-identity` /
 * `x-lhc-telegram-id` / `x-telegram-id` выбрасываются ДО проброса.
 */
function createEdge({ gateBase, controlBase }) {
  const gatePort = Number(new URL(gateBase).port);
  const controlPort = Number(new URL(controlBase).port);
  return createServer((request, response) => {
    const check = httpRequest({
      host: "127.0.0.1", port: gatePort, path: "/gate/check", method: "GET",
      headers: { cookie: String(request.headers.cookie ?? "") }
    }, (gateResponse) => {
      gateResponse.resume();
      if (gateResponse.statusCode !== 200) {
        response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: { code: "CONTROL_AUTH_REQUIRED" } }));
        return;
      }
      const assertion = gateResponse.headers["x-lhc-gate-identity"];
      const headers = { ...request.headers, host: `127.0.0.1:${controlPort}` };
      delete headers["x-lhc-gate-identity"];
      delete headers["x-lhc-telegram-id"];
      delete headers["x-telegram-id"];
      if (typeof assertion === "string") headers["x-lhc-gate-identity"] = assertion;
      const upstream = httpRequest({
        host: "127.0.0.1", port: controlPort, path: request.url, method: request.method, headers
      }, (controlResponse) => {
        response.writeHead(controlResponse.statusCode, controlResponse.headers);
        controlResponse.pipe(response);
      });
      upstream.on("error", () => { response.writeHead(502).end(); });
      request.pipe(upstream);
    });
    check.on("error", () => { response.writeHead(502).end(); });
    check.end();
  });
}

/** Браузер: своя cookie-банка + CSRF в памяти вкладки (как ControlApiClient). */
function createBrowser(edgeBase) {
  const state = { cookie: null, cookieValue: null, csrf: null, jar: {} };
  const applyCookie = (setCookie) => {
    if (typeof setCookie !== "string") return;
    for (const part of setCookie.split(/,(?=[^;]+=)/)) {
      const pair = part.split(";", 1)[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      state.jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  };
  const cookieHeader = () => Object.entries(state.jar)
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const call = async (method, path, { json, headers = {} } = {}) => {
    // Явно переданная cookie вливается в банку: как в браузере, оба cookie
    // (lhc_session от gate и lh_control_session от Control) уходят вместе.
    if (typeof headers.cookie === "string") applyCookie(headers.cookie);
    const requestHeaders = { origin: ORIGIN, ...headers };
    delete requestHeaders.cookie;
    const jarHeader = cookieHeader();
    if (jarHeader.length > 0) requestHeaders.cookie = jarHeader;
    const mutation = method !== "GET" && method !== "HEAD";
    if (mutation && state.csrf !== null && requestHeaders["x-csrf-token"] === undefined) {
      requestHeaders["x-csrf-token"] = state.csrf;
    }
    let body;
    if (json !== undefined) {
      requestHeaders["content-type"] = "application/json";
      body = JSON.stringify(json);
    }
    const response = await fetch(`${edgeBase}${path}`, { method, headers: requestHeaders, body, redirect: "manual" });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) {
      applyCookie(setCookie);
      state.cookieValue = setCookie.split(";", 1)[0];
    }
    const text = await response.text();
    return { status: response.status, setCookie, body: text.length === 0 ? null : JSON.parse(text) };
  };
  /** Обмен подтверждённой сессии gate на сессию Control: без логина и пароля. */
  const openGateSession = async (gateCookie) => {
    if (gateCookie !== undefined) applyCookie(gateCookie);
    const response = await call("POST", "/control/v1/auth/gate/session");
    if (response.status === 200 && typeof response.body?.csrfToken === "string") state.csrf = response.body.csrfToken;
    if (response.setCookie !== null) state.cookie = response.setCookie.split(";", 1)[0];
    return response;
  };
  return { call, openGateSession, state };
}

/** Вход человека через бота: /start → персональная ссылка → обмен тикета. */
async function enterThroughBot(world, telegramId) {
  await world.gate.handleUpdate(message(telegramId, "/start"));
  const ticket = ticketFromBot(world.tg, telegramId);
  assert.ok(ticket, `бот обязан выдать персональную ссылку для ${telegramId}`);
  const consumed = await fetch(`${world.gateBase}/gate/ticket/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket })
  });
  assert.equal(consumed.status, 200, "обмен тикета обязан пройти");
  const gateCookie = String(consumed.headers.get("set-cookie")).split(";", 1)[0];
  assert.match(gateCookie, /^lhc_session=/);
  return gateCookie;
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "lh-gate-identity-"));
  const dbPath = join(directory, "control.sqlite");
  const store = new SQLiteControlStore({ path: dbPath });
  const security = new SQLiteControlSecurityStore({ path: dbPath });

  const control = createControlHttpServer({
    store,
    boardStore: store,
    missionStore: store,
    auth: {
      security,
      allowedOrigins: [ORIGIN],
      secureCookies: false,
      nowMs: () => now,
      gateIdentity: { secret: GATE_SECRET, nowMs: () => now }
    }
  });
  const controlBase = await listen(control.server);

  const tg = fakeTelegram();
  const gate = createGate({
    state: defaultState(),
    config: {
      ownerId: OWNER_TG,
      botUsername: "living_history_gate_bot",
      studioOrigin: ORIGIN,
      gateSecret: GATE_SECRET,
      identitySecret: GATE_SECRET,
      identityTtlMs: 120_000,
      persist: () => {}
    },
    tg,
    now: () => now
  });
  const gateServer = wireHttp(gate, { polling: false });
  const gateBase = await listen(gateServer);

  const edge = createEdge({ gateBase, controlBase });
  const edgeBase = await listen(edge);

  const world = { store, security, control, controlBase, gate, gateBase, edgeBase, tg, owner: null };

  t.after(async () => {
    await new Promise((resolve) => edge.close(resolve));
    await new Promise((resolve) => gateServer.close(resolve));
    await control.close();
    security.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  // Проект создаёт ВЛАДЕЛЕЦ через продукт: вход через бота, обмен сессии,
  // POST /projects с подтверждением запроса.
  const owner = createBrowser(edgeBase);
  const ownerGateCookie = await enterThroughBot(world, OWNER_TG);
  const ownerSession = await owner.openGateSession(ownerGateCookie);
  assert.equal(ownerSession.status, 200, `владелец обязан войти: ${JSON.stringify(ownerSession.body)}`);
  assert.equal(ownerSession.body.user.userId, `telegram:${OWNER_TG}`);
  const created = await owner.call("POST", "/control/v1/projects", { json: { projectId: PROJECT, title: "Проект" } });
  assert.equal(created.status, 201, `проект обязан создаться: ${JSON.stringify(created.body)}`);
  assert.equal((await store.createQuest({
    projectId: PROJECT,
    questId: QUEST,
    title: "Миссия",
    entryLocationId: "workshop",
    initialBlocks: [{ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: {} }]
  })).kind, "created");

  world.owner = owner;
  return world;
}

test("FIN-06/GATE: идентичность Studio берётся из проверенной сессии gate", async (t) => {
  const world = await setup(t);

  await t.test("GATE-01: вход через бота даёт постоянного пользователя Control без пароля", async () => {
    const browser = createBrowser(world.edgeBase);
    const gateCookie = await enterThroughBot(world, OWNER_TG);
    const session = await browser.call("GET", "/control/v1/auth/session", { headers: { cookie: gateCookie } });
    assert.equal(session.status, 200, JSON.stringify(session.body));
    assert.equal(session.body.user.userId, `telegram:${OWNER_TG}`);
    assert.match(String(session.body.session.sessionId), /^control-session-[0-9a-f]{32}$/);
    assert.equal(controlUserIdForTelegram(OWNER_TG), `telegram:${OWNER_TG}`);
    // Парольного входа в эту личность нет: личность создана gate-ассертом,
    // а не bootstrap-учёткой CONTROL_BOOTSTRAP_*.
    assert.equal(await world.security.verifyCredentials(`telegram:${OWNER_TG}`, "owner password 123"), null);

    const projects = await browser.call("GET", "/control/v1/projects", { headers: { cookie: gateCookie } });
    assert.deepEqual(projects.body.projects, [{ projectId: PROJECT, title: "Проект", cover: null, coverRevision: 0, role: "owner" }]);
  });

  await t.test("GATE-02: повторный вход возвращает того же пользователя", async () => {
    const again = await enterThroughBot(world, OWNER_TG);
    const browser = createBrowser(world.edgeBase);
    const session = await browser.call("GET", "/control/v1/auth/session", { headers: { cookie: again } });
    assert.equal(session.status, 200);
    assert.equal(session.body.user.userId, `telegram:${OWNER_TG}`);
    const projects = await browser.call("GET", "/control/v1/projects", { headers: { cookie: again } });
    assert.deepEqual(projects.body.projects, [{ projectId: PROJECT, title: "Проект", cover: null, coverRevision: 0, role: "owner" }]);
    assert.equal((await world.security.getUser(`telegram:${OWNER_TG}`)).username, `tg_user4273`);
  });

  await t.test("GATE-03: второй участник получает только фактическое членство", async () => {
    await world.gate.handleUpdate(message(OWNER_TG, "➕ Добавить участника"));
    await world.gate.handleUpdate(message(OWNER_TG, EDITOR_TG));
    await world.gate.handleUpdate(message(OWNER_TG, "➕ Добавить участника"));
    await world.gate.handleUpdate(message(OWNER_TG, TESTER_TG));

    const editor = createBrowser(world.edgeBase);
    const editorCookie = await enterThroughBot(world, EDITOR_TG);
    const editorSession = await editor.call("GET", "/control/v1/auth/session", { headers: { cookie: editorCookie } });
    assert.equal(editorSession.body.user.userId, `telegram:${EDITOR_TG}`);
    assert.notEqual(editorSession.body.user.userId, `telegram:${OWNER_TG}`);
    // Вход сам по себе не даёт ни проекта, ни роли.
    const before = await editor.call("GET", "/control/v1/projects", { headers: { cookie: editorCookie } });
    assert.deepEqual(before.body.projects, []);

    const granted = await world.owner.call("PUT", `/control/v1/projects/${PROJECT}/members/telegram:${EDITOR_TG}`, {
      json: { role: "editor" }
    });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.member.role, "editor");

    const after = await editor.call("GET", "/control/v1/projects", { headers: { cookie: editorCookie } });
    assert.deepEqual(after.body.projects, [{ projectId: PROJECT, title: "Проект", cover: null, coverRevision: 0, role: "editor" }]);
  });

  await t.test("GATE-04: участник gate без членства получает 404, а не доступ", async () => {
    const tester = createBrowser(world.edgeBase);
    const gateCookie = await enterThroughBot(world, TESTER_TG);
    const session = await tester.call("GET", "/control/v1/auth/session", { headers: { cookie: gateCookie } });
    assert.equal(session.status, 200, "вход в gate подтверждён — личность известна");
    assert.equal(session.body.user.userId, `telegram:${TESTER_TG}`);
    const projects = await tester.call("GET", "/control/v1/projects", { headers: { cookie: gateCookie } });
    assert.deepEqual(projects.body.projects, [], "вход не выдаёт роль владельца и чужие проекты");

    const foreign = await tester.call("GET", `/control/v1/projects/${PROJECT}/quests/${QUEST}/draft`, { headers: { cookie: gateCookie } });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    assert.equal(foreign.body.error.code, "NOT_FOUND");
  });

  await t.test("GATE-05: недостаточная роль — 403, редактор не получает owner-прав", async () => {
    const editor = createBrowser(world.edgeBase);
    const gateCookie = await enterThroughBot(world, EDITOR_TG);
    await editor.openGateSession(gateCookie);
    const ownerOnly = await editor.call("PUT", `/control/v1/projects/${PROJECT}/members/telegram:${TESTER_TG}`, {
      json: { role: "tester" }
    });
    assert.equal(ownerOnly.status, 403, JSON.stringify(ownerOnly.body));
    assert.equal(ownerOnly.body.error.code, "CONTROL_FORBIDDEN");
  });

  await t.test("GATE-06: поддельный ассерт и присланный браузером Telegram-ID не дают доступа", async () => {
    const forged = signGateIdentityAssertion({
      telegramId: OUTSIDER_TG,
      username: "outsider",
      issuedAtMs: now,
      expiresAtMs: now + 120_000
    }, "x".repeat(48));

    // (а) Прямой запрос мимо края: подпись чужим секретом.
    const direct = await fetch(`${world.controlBase}/control/v1/auth/session`, {
      headers: { origin: ORIGIN, "x-lhc-gate-identity": forged }
    });
    assert.equal(direct.status, 401, "подпись чужим секретом обязана быть отвергнута");
    assert.equal((await direct.json()).error.code, "CONTROL_AUTH_REQUIRED");

    // (б) Голый Telegram-ID в заголовке — не доказательство.
    const raw = await fetch(`${world.controlBase}/control/v1/auth/session`, {
      headers: { origin: ORIGIN, "x-lhc-telegram-id": OWNER_TG }
    });
    assert.equal(raw.status, 401, "присланный браузером Telegram-ID не является доказательством");

    // (в) Браузер без сессии gate со своим «ассертом» через край.
    const stranger = createBrowser(world.edgeBase);
    const viaEdge = await stranger.call("GET", "/control/v1/auth/session", {
      headers: { "x-lhc-gate-identity": forged, "x-lhc-telegram-id": OUTSIDER_TG }
    });
    assert.equal(viaEdge.status, 401, JSON.stringify(viaEdge.body));

    // (г) Подмена заголовка не меняет личность: край всегда берёт ассерт у gate.
    const editor = createBrowser(world.edgeBase);
    const editorCookie = await enterThroughBot(world, EDITOR_TG);
    const impersonation = await editor.call("GET", "/control/v1/projects", {
      headers: { cookie: editorCookie, "x-lhc-gate-identity": forged, "x-lhc-telegram-id": OUTSIDER_TG }
    });
    assert.equal(impersonation.status, 200);
    assert.deepEqual(impersonation.body.projects, [{ projectId: PROJECT, title: "Проект", cover: null, coverRevision: 0, role: "editor" }]);
    const editorIdentity = await editor.call("GET", "/control/v1/auth/session", { headers: { cookie: editorCookie } });
    assert.equal(editorIdentity.body.user.userId, `telegram:${EDITOR_TG}`);

    // Посторонний вообще не авторизован в боте — тикета ему не выдаётся.
    await world.gate.handleUpdate(message(OUTSIDER_TG, "/start"));
    assert.equal(ticketFromBot(world.tg, OUTSIDER_TG), null, "постороннему бот не выдаёт ссылку");
  });

  await t.test("GATE-07: без ассерта и по просроченному ассерту — отказ, а не гостевой владелец", async () => {
    const browser = createBrowser(world.edgeBase);
    const gateCookie = await enterThroughBot(world, OWNER_TG);
    await browser.openGateSession(gateCookie);
    assert.ok(browser.state.cookie, "сессия Control выдана");

    // (а) Валидная cookie сессии Control, но край личность не подтвердил.
    const cookieOnly = await fetch(`${world.controlBase}/control/v1/projects`, {
      headers: { origin: ORIGIN, cookie: browser.state.cookie }
    });
    assert.equal(cookieOnly.status, 401, "без подтверждения gate доступ не выдаётся");
    assert.equal((await cookieOnly.json()).error.code, "CONTROL_AUTH_REQUIRED");

    // (б) Просроченный ассерт.
    const expired = signGateIdentityAssertion({
      telegramId: OWNER_TG, username: "owner", issuedAtMs: now, expiresAtMs: now + 60_000
    }, GATE_SECRET);
    now += 61_000;
    const stale = await fetch(`${world.controlBase}/control/v1/auth/session`, {
      headers: { origin: ORIGIN, "x-lhc-gate-identity": expired }
    });
    assert.equal(stale.status, 401, "просроченный ассерт обязан быть отвергнут");
    now -= 61_000;

    // (в) Ассерт с чужим (неизвестным) полем версии.
    const tampered = `${expired.split(".").slice(0, 2).join(".")}.${"a".repeat(43)}`;
    const wrongSignature = await fetch(`${world.controlBase}/control/v1/auth/session`, {
      headers: { origin: ORIGIN, "x-lhc-gate-identity": tampered }
    });
    assert.equal(wrongSignature.status, 401);
  });

  await t.test("GATE-08: отзыв в боте закрывает вход (сессия gate мертва)", async () => {
    const editor = createBrowser(world.edgeBase);
    const gateCookie = await enterThroughBot(world, EDITOR_TG);
    const before = await editor.call("GET", "/control/v1/auth/session", { headers: { cookie: gateCookie } });
    assert.equal(before.status, 200);

    await world.gate.handleUpdate(callback(OWNER_TG, `revoke_${EDITOR_TG}`));

    const check = await fetch(`${world.gateBase}/gate/check`, { headers: { cookie: gateCookie } });
    assert.equal(check.status, 401, "gate перестаёт подтверждать отозванную сессию");
    const after = await editor.call("GET", "/control/v1/auth/session", { headers: { cookie: gateCookie } });
    assert.equal(after.status, 401, "отозванный участник не получает ни сессии, ни роли");
    assert.equal(await world.gate.readSession(gateCookie), null, "серверная сессия gate отозвана");
    assert.equal(await world.gate.identityAssertion(EDITOR_TG), null, "личность вне доступа не получает ассерта");
  });
});

test("FIN-06/GATE: CSRF, идемпотентность и ревизии сохраняются в gate-режиме", async (t) => {
  const world = await setup(t);

  await t.test("GATE-09: сессия для правок выдаётся без пароля и подтверждает CSRF", async () => {
    const browser = createBrowser(world.edgeBase);
    const gateCookie = await enterThroughBot(world, OWNER_TG);
    const response = await browser.openGateSession(gateCookie);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.user.userId, `telegram:${OWNER_TG}`);
    assert.equal(typeof response.body.csrfToken, "string");
    assert.ok(response.body.csrfToken.length >= 20);
    assert.match(String(response.setCookie), /^lh_control_session=/);
  });

  await t.test("GATE-10: без подтверждения запроса мутация отклоняется, с подтверждением — идемпотентна", async () => {
    const browser = createBrowser(world.edgeBase);
    const gateCookie = await enterThroughBot(world, OWNER_TG);
    await browser.openGateSession(gateCookie);

    const noCsrf = await browser.call("POST", `/control/v1/projects/${PROJECT}/quests/${QUEST}/board/changes`, {
      json: { baseRevision: 0, positions: { workshop: { x: 10, y: 20 } } },
      headers: { "idempotency-key": "gate-board-1", "x-csrf-token": "" }
    });
    assert.equal(noCsrf.status, 403, JSON.stringify(noCsrf.body));
    assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");

    const saved = await browser.call("POST", `/control/v1/projects/${PROJECT}/quests/${QUEST}/board/changes`, {
      json: { baseRevision: 0, positions: { workshop: { x: 10, y: 20 } } },
      headers: { "idempotency-key": "gate-board-1" }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.board.boardRevision, 1);

    const replay = await browser.call("POST", `/control/v1/projects/${PROJECT}/quests/${QUEST}/board/changes`, {
      json: { baseRevision: 0, positions: { workshop: { x: 10, y: 20 } } },
      headers: { "idempotency-key": "gate-board-1" }
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true, "повтор с тем же ключом — идемпотентный ответ");

    const stale = await browser.call("POST", `/control/v1/projects/${PROJECT}/quests/${QUEST}/board/changes`, {
      json: { baseRevision: 0, positions: { workshop: { x: 30, y: 40 } } },
      headers: { "idempotency-key": "gate-board-2" }
    });
    assert.equal(stale.status, 409, "устаревшая база обязана конфликтовать");
    assert.equal(stale.body.error.code, "BOARD_REVISION_CONFLICT");
  });

  await t.test("GATE-11: ассерт настоящего gate и верификатор Control совпадают байт-в-байт", async () => {
    const gateCookie = await enterThroughBot(world, OWNER_TG);
    const response = await fetch(`${world.gateBase}/gate/check`, { headers: { cookie: gateCookie } });
    assert.equal(response.status, 200);
    const header = response.headers.get("x-lhc-gate-identity");
    assert.equal(typeof header, "string", "проверенная сессия gate обязана нести подписанный ассерт");
    const verifier = createGateIdentityVerifier({ secret: GATE_SECRET, ttlMs: 120_000, nowMs: () => now });
    const verified = verifier.verify(header);
    assert.ok(verified, "Control обязан принять ассерт, выпущенный настоящим gate");
    assert.equal(verified.telegramId, OWNER_TG);
    const rebuilt = signGateIdentityAssertion({
      telegramId: OWNER_TG,
      username: `user${OWNER_TG.slice(-4)}`,
      issuedAtMs: verified.issuedAtMs,
      expiresAtMs: verified.expiresAtMs
    }, GATE_SECRET);
    assert.equal(header, rebuilt, "формат ассерта не должен расходиться между gate и Control");
  });
});
