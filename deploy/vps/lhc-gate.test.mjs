// Unit/integration тесты бот-управляемого входа: персональная ссылка + тикет (lhc-gate v3).
// Run: node --test deploy/vps/lhc-gate.test.mjs
// Живую приёмку с реальными людьми не заменяют — см. ACCEPTANCE-checklist.md.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.LHC_GATE_NO_AUTOSTART = "1";
const { createGate, defaultState, migrateState, wireHttp, TICKET_TTL_MS } = await import("./lhc-gate.mjs");

const OWNER = "332664273";
const MEMBER = "111222333";
const STRANGER = "999888777";
const STUDIO = "https://studio.example:8741";

function fakeTg() {
  const sent = [];
  const edited = [];
  const answers = [];
  return {
    sent, edited, answers,
    sendMessage: async (chatId, text, extra = {}) => { sent.push({ chatId: String(chatId), text, extra }); return { message_id: sent.length }; },
    editMessageText: async (chatId, messageId, text) => { edited.push({ chatId, messageId, text }); return true; },
    answerCallbackQuery: async (id, text) => { answers.push({ id, text }); return true; },
    getChat: async () => { throw new Error("no chat"); },
  };
}

let now;
function setup() {
  now = 1_700_000_000_000;
  const tg = fakeTg();
  const state = defaultState();
  const gate = createGate({
    state,
    config: { ownerId: OWNER, botUsername: "living_history_gate_bot", studioOrigin: STUDIO, gateSecret: "x".repeat(40), persist: () => {} },
    tg,
    now: () => now,
  });
  return { gate, state, tg };
}

const msg = (id, text, extra = {}) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: {
    message_id: 1, chat: { id: Number(id), type: "private" },
    from: { id: Number(id), first_name: "Test", username: extra.username ?? "tester" },
    text,
  },
});
const cb = (id, data, messageId = 7, username = "tester") => ({
  update_id: Math.floor(Math.random() * 1e9),
  callback_query: {
    id: `q${Math.random()}`, data,
    from: { id: Number(id), first_name: "Test", username },
    message: { message_id: messageId, chat: { id: Number(id), type: "private" } },
  },
});
const linkMessages = (tg, chatId) => tg.sent.filter((m) => m.chatId === String(chatId) && m.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.url);

describe("права и владелец", () => {
  it("владелец авторизован без самоназначения; чужой ID — нет", () => {
    const { gate } = setup();
    assert.equal(gate.isOwner(OWNER), true);
    assert.equal(gate.isAuthorized(OWNER), true);
    assert.equal(gate.isAuthorized(STRANGER), false);
    assert.deepEqual(gate.addUser(OWNER, {}), { error: "owner_implicit" });
    assert.deepEqual(gate.addUser("abc", {}), { error: "bad_id" });
    assert.deepEqual(gate.revokeUser(OWNER), { error: "owner_irrevocable" });
  });
});

describe("тикеты: выдача и обмен", () => {
  it("чужому тикет не выдаётся; участник получает персональную ссылку", () => {
    const { gate } = setup();
    assert.deepEqual(gate.createTicket(STRANGER), { error: "forbidden" });
    gate.addUser(MEMBER, { username: "member" });
    const t = gate.createTicket(MEMBER);
    assert.ok(t.ticket);
    assert.equal(t.url, `${STUDIO}/?ticket=${t.ticket}`);
    assert.equal(t.expiresInMs, TICKET_TTL_MS);
  });

  it("обмен: одноразово, ставит сессию; повтор и чужой тикет отклоняются", () => {
    const { gate } = setup();
    gate.addUser(MEMBER, { username: "member" });
    const t = gate.createTicket(MEMBER);
    const info = gate.ticketInfo(t.ticket);
    assert.equal(info.valid, true);
    assert.equal(info.username, "member");
    const r = gate.consumeTicket(t.ticket, "1.2.3.4");
    assert.equal(r.ok, true);
    const s = gate.readSession(`lhc_session=${r.cookieValue}`);
    assert.equal(s?.telegramId, MEMBER);
    assert.deepEqual(gate.consumeTicket(t.ticket, "1.2.3.4"), { error: "unknown" });
    assert.deepEqual(gate.consumeTicket("nope", "1.2.3.4"), { error: "unknown" });
    assert.deepEqual(gate.ticketInfo(t.ticket), { valid: false });
  });

  it("просроченный тикет не обменивается", () => {
    const { gate } = setup();
    gate.addUser(MEMBER, { username: "member" });
    const t = gate.createTicket(MEMBER);
    now += TICKET_TTL_MS + 1000;
    assert.deepEqual(gate.consumeTicket(t.ticket, "1.2.3.4"), { error: "unknown" });
  });

  it("отзыв прав убивает тикеты и сессии", () => {
    const { gate } = setup();
    gate.addUser(MEMBER, { username: "member" });
    const t = gate.createTicket(MEMBER);
    const ok = gate.consumeTicket(t.ticket, "1.2.3.4");
    assert.equal(ok.ok, true);
    assert.ok(gate.readSession(`lhc_session=${ok.cookieValue}`));
    const t2 = gate.createTicket(MEMBER);
    const res = gate.revokeUser(MEMBER);
    assert.equal(res.ok, true);
    assert.equal(res.killed, 1);
    assert.equal(gate.readSession(`lhc_session=${ok.cookieValue}`), null);
    // Отозванный тикет неотличим от использованного — обмен закрыт в любом случае.
    assert.deepEqual(gate.consumeTicket(t2.ticket, "1.2.3.4"), { error: "unknown" });
  });
});

describe("бот: /start и «Открыть Studio»", () => {
  it("владелец получает меню и персональную ссылку", async () => {
    const { gate, tg } = setup();
    await gate.handleUpdate(msg(OWNER, "/start", { username: "owner" }));
    const links = linkMessages(tg, OWNER);
    assert.equal(links.length, 1);
    assert.match(links[0].extra.reply_markup.inline_keyboard[0][0].url, new RegExp(`^${STUDIO}/\\?ticket=`));
    assert.ok(tg.sent.some((m) => m.chatId === OWNER && /Меню владельца/.test(m.text)));
  });

  it("допущенный участник получает приветствие и ссылку; ID фиксируется", async () => {
    const { gate, state, tg } = setup();
    gate.addUser(MEMBER, {});
    await gate.handleUpdate(msg(MEMBER, "/start", { username: "member" }));
    assert.equal(state.users[MEMBER].username, "member");
    assert.equal(linkMessages(tg, MEMBER).length, 1);
  });

  it("неизвестный получает отказ, владелец — запрос; одобрение шлёт ссылку", async () => {
    const { gate, state, tg } = setup();
    await gate.handleUpdate(msg(STRANGER, "/start", { username: "stranger" }));
    assert.equal(linkMessages(tg, STRANGER).length, 0);
    assert.ok(tg.sent.some((m) => /Заявка отправлена/.test(m.text)));
    const reqId = Object.keys(state.accessRequests)[0];
    assert.ok(reqId);
    assert.ok(tg.sent.some((m) => m.chatId === OWNER && /Запрос доступа/.test(m.text)));
    await gate.handleUpdate(cb(OWNER, `approve_${reqId}`));
    assert.equal(gate.isAuthorized(STRANGER), true);
    assert.equal(linkMessages(tg, STRANGER).length, 1);
  });

  it("предзаявка по username закрывается первым /start, ссылка уходит сразу", async () => {
    const { gate, state, tg } = setup();
    await gate.handleUpdate(msg(OWNER, "/start", { username: "owner" }));
    await gate.handleUpdate(msg(OWNER, "➕ Добавить участника", { username: "owner" }));
    await gate.handleUpdate(msg(OWNER, "@newbie", { username: "owner" }));
    assert.ok(state.nameClaims["newbie"]);
    await gate.handleUpdate(msg(STRANGER, "/start", { username: "newbie" }));
    assert.equal(state.nameClaims["newbie"], undefined);
    assert.equal(gate.isAuthorized(STRANGER), true);
    assert.equal(linkMessages(tg, STRANGER).length, 1);
    assert.ok(tg.sent.some((m) => m.chatId === OWNER && /автоматически/.test(m.text)));
  });

  it("добавление по username известного человека привязывает ID и не требует /start", async () => {
    const { gate, state, tg } = setup();
    state.accessRequests["req9"] = { telegramId: STRANGER, username: "stranger", firstName: "S", createdAt: now, status: "pending" };
    await gate.handleUpdate(msg(OWNER, "/start", { username: "owner" }));
    await gate.handleUpdate(msg(OWNER, "➕ Добавить участника", { username: "owner" }));
    await gate.handleUpdate(msg(OWNER, "@stranger", { username: "owner" }));
    assert.equal(state.accessRequests["req9"].status, "approved");
    assert.equal(gate.isAuthorized(STRANGER), true);
    assert.equal(state.nameClaims["stranger"], undefined);
    const last = tg.sent[tg.sent.length - 1];
    assert.match(last.text, new RegExp(STRANGER));
  });

  it("«Участники» и «Отозвать доступ» работают из меню", async () => {
    const { gate, tg } = setup();
    gate.addUser(MEMBER, { username: "member" });
    await gate.handleUpdate(msg(OWNER, "👥 Участники", { username: "owner" }));
    assert.ok(tg.sent.some((m) => /member/.test(m.text)));
    await gate.handleUpdate(msg(OWNER, "🚫 Отозвать доступ", { username: "owner" }));
    await gate.handleUpdate(cb(OWNER, 'revoke_'+MEMBER));
    assert.equal(gate.isAuthorized(MEMBER), false);
  });
});

describe("миграция v2", () => {
  it("login-попытки и контексты отбрасываются, пользователи и сессии живут", () => {
    const st = migrateState({
      version: 2, users: { [MEMBER]: { username: "m", addedAt: 1, revoked: false, role: "member" } },
      logins: { abc: { status: "pending" } }, contexts: { [MEMBER]: "abc" }, sessions: {},
      accessRequests: {}, nameClaims: {}, ui: {},
    });
    assert.equal(st.version, 3);
    assert.ok(st.users[MEMBER]);
    assert.deepEqual(st.tickets, {});
    assert.equal(st.logins, undefined);
    assert.equal(st.contexts, undefined);
  });
});

describe("HTTP: тикеты и cookie", () => {
  it("info + consume через HTTP: cookie HttpOnly, повтор — 404, старые пути — 410", async () => {
    const { gate, state } = setup();
    gate.addUser(MEMBER, { username: "member" });
    const t = gate.createTicket(MEMBER);
    const server = wireHttp(gate, { polling: true });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const info = await (await fetch(`http://127.0.0.1:${port}/gate/ticket/info?ticket=${t.ticket}`)).json();
      assert.equal(info.valid, true);
      assert.equal(info.username, "member");
      const bad = await fetch(`http://127.0.0.1:${port}/gate/ticket/info?ticket=nope`);
      assert.equal(bad.status, 404);
      const c1 = await fetch(`http://127.0.0.1:${port}/gate/ticket/consume`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: t.ticket }),
      });
      assert.equal(c1.status, 200);
      const cookie = c1.headers.get("set-cookie") || "";
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      assert.ok(!/Max-Age/i.test(cookie));
      const c2 = await fetch(`http://127.0.0.1:${port}/gate/ticket/consume`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: t.ticket }),
      });
      assert.equal(c2.status, 404);
      const old = await fetch(`http://127.0.0.1:${port}/gate/login/start`, { method: "POST", body: "{}" });
      assert.equal(old.status, 410);
      assert.equal(state.sessions && Object.keys(state.sessions).length, 1);
    } finally {
      server.close();
    }
  });
});
