// Unit/integration тесты бот-управляемого входа (lhc-gate v2).
// Run: node --test deploy/vps/lhc-gate.test.mjs
// Живую приёмку с реальными людьми не заменяют — см. ACCEPTANCE-checklist.md.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.LHC_GATE_NO_AUTOSTART = "1";
const { createGate, defaultState, migrateState, LOGIN_TTL_MS } = await import("./lhc-gate.mjs");

const OWNER = "332664273";
const MEMBER = "111222333";
const STRANGER = "999888777";

function fakeTg() {
  const sent = []; // { chatId, text, extra }
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
    config: { ownerId: OWNER, botUsername: "living_history_gate_bot", gateSecret: "x".repeat(40), persist: () => {} },
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

describe("права и владелец", () => {
  it("владелец авторизован без самоназначения; чужой ID — нет", () => {
    const { gate } = setup();
    assert.equal(gate.isOwner(OWNER), true);
    assert.equal(gate.isAuthorized(OWNER), true);
    assert.equal(gate.isAuthorized(STRANGER), false);
    // нет API сменить владельца: addUser(owner) отклоняется
    assert.equal(gate.addUser(OWNER).error, "owner_implicit");
  });

  it("добавление по числовому ID, отзыв убивает сессии", () => {
    const { gate, state } = setup();
    assert.ok(gate.addUser(MEMBER, { username: "ivan" }).ok);
    assert.equal(gate.isAuthorized(MEMBER), true);
    const cookie = gate.sessionCookie(gate.issueSession(MEMBER));
    assert.ok(gate.readSession(`lhc_session=${cookie.split("=")[1]}`));
    const r = gate.revokeUser(MEMBER);
    assert.ok(r.ok);
    assert.equal(r.killed, 1);
    assert.equal(gate.isAuthorized(MEMBER), false);
    assert.equal(gate.readSession(`lhc_session=${cookie.split("=")[1]}`), null);
    // владельца отозвать нельзя
    assert.equal(gate.revokeUser(OWNER).error, "owner_irrevocable");
  });

  it("предзаявка по username: прав нет, пока человек не напишет /start", async () => {
    const { gate, state, tg } = setup();
    state.nameClaims["future"] = { createdAt: now, note: "owner claim" };
    assert.equal(gate.isAuthorized("555666777"), false);
    await gate.handleUpdate(msg("555666777", "/start", { username: "future" }));
    assert.equal(gate.isAuthorized("555666777"), true);
    assert.equal(state.nameClaims["future"], undefined); // предзаявка consumed
    assert.ok(tg.sent.some((m) => /списке участников/.test(m.text)));
  });

  it("неизвестный после /start получает понятное сообщение + запрос владельцу", async () => {
    const { gate, state, tg } = setup();
    await gate.handleUpdate(msg(STRANGER, "/start", { username: "stranger" }));
    assert.ok(tg.sent.some((m) => m.chatId === STRANGER && /по приглашению владельца/.test(m.text)));
    const toOwner = tg.sent.find((m) => m.chatId === OWNER && /Запрос доступа/.test(m.text));
    assert.ok(toOwner);
    const btn = toOwner.extra.reply_markup.inline_keyboard[0][0];
    assert.match(btn.callback_data, /^approve_/);
    // владелец разрешает → доступ есть
    const reqId = btn.callback_data.slice("approve_".length);
    assert.ok(state.accessRequests[reqId]);
    await gate.handleUpdate(cb(OWNER, `approve_${reqId}`, 3, "owner"));
    assert.equal(gate.isAuthorized(STRANGER), true);
    assert.ok(tg.sent.some((m) => m.chatId === STRANGER && /подтвердил доступ/.test(m.text)));
  });

  it("владелец отклоняет заявку: доступа нет, попытка отклонена", async () => {
    const { gate, state } = setup();
    const l = gate.createLogin({ ip: "1.2.3.4", ua: "TestUA" });
    await gate.handleUpdate(msg(STRANGER, `/start login_${l.attemptId}`, { username: "stranger" }));
    const reqId = Object.keys(state.accessRequests)[0];
    await gate.handleUpdate(cb(OWNER, `deny_${reqId}`, 3, "owner"));
    assert.equal(gate.isAuthorized(STRANGER), false);
    assert.equal(gate.loginStatus(l.attemptId).status, "denied");
  });
});

describe("login-попытка без ручных кодов", () => {
  it("полный цикл: start → confirm в боте → consume → сессия; повтор запрещён", async () => {
    const { gate, tg } = setup();
    gate.addUser(MEMBER, { username: "ivan" });
    const l = gate.createLogin({ ip: "5.6.7.8", ua: "Mozilla/5.0 (Windows NT 10.0)" });
    assert.match(l.botUrl, /^https:\/\/t\.me\/living_history_gate_bot\?start=login_/);
    // перехваченная ссылка без подтверждения сессию не даёт
    assert.equal(gate.consumeLogin(l.attemptId).error, "not_approved");
    // участник открывает ссылку → карточка с UA/IP
    await gate.handleUpdate(msg(MEMBER, `/start login_${l.attemptId}`, { username: "ivan" }));
    const card = tg.sent.find((m) => /Подтвердить вход/.test(JSON.stringify(m.extra)));
    assert.ok(card);
    assert.match(card.text, /5\.6\.7\.8/);
    assert.match(card.text, /Windows/);
    // чужой confirm по перехваченному ID не проходит
    gate.addUser(STRANGER, {});
    await gate.handleUpdate(cb(STRANGER, `confirm_${l.attemptId}`));
    assert.equal(gate.loginStatus(l.attemptId).status, "pending");
    // свой confirm → approved → consume → сессия
    await gate.handleUpdate(cb(MEMBER, `confirm_${l.attemptId}`));
    assert.equal(gate.loginStatus(l.attemptId).status, "approved");
    const c = gate.consumeLogin(l.attemptId);
    assert.ok(c.ok);
    const sess = gate.readSession(`lhc_session=${c.cookieValue}`);
    assert.ok(sess);
    assert.equal(sess.telegramId, MEMBER);
    // одноразовая: повторный consume отклоняется
    assert.equal(gate.consumeLogin(l.attemptId).error, "consumed");
  });

  it("просроченная попытка (TTL ~2 мин) подтвердить нельзя", async () => {
    const { gate, tg } = setup();
    gate.addUser(MEMBER, {});
    const l = gate.createLogin({ ip: "9.9.9.9", ua: "UA" });
    now += LOGIN_TTL_MS + 1000;
    assert.equal(gate.loginStatus(l.attemptId).status, "expired");
    await gate.handleUpdate(cb(MEMBER, `confirm_${l.attemptId}`));
    assert.ok(tg.answers.some((a) => /недействительна/.test(a.text || "")));
    assert.match(gate.consumeLogin(l.attemptId).error, /expired/);
  });

  it("cookie без Max-Age (сессионная), серверная запись долгоживущая", () => {
    const { gate } = setup();
    gate.addUser(MEMBER, {});
    const setCookie = gate.sessionCookie(gate.issueSession(MEMBER));
    assert.ok(/HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Lax/.test(setCookie));
    assert.ok(!/Max-Age/i.test(setCookie));
  });
});

describe("бот: меню владельца", () => {
  it("добавление через username создаёт предзаявку, не права", async () => {
    const { gate, state, tg } = setup();
    await gate.handleUpdate(msg(OWNER, "/start", { username: "owner" }));
    await gate.handleUpdate(msg(OWNER, "➕ Добавить участника", { username: "owner" }));
    await gate.handleUpdate(msg(OWNER, "@newbie", { username: "owner" }));
    assert.ok(state.nameClaims["newbie"]);
    assert.equal(gate.isAuthorized("123123123"), false);
    const last = tg.sent[tg.sent.length - 1];
    assert.match(last.text, /Предзаявка @newbie/);
  });

  it("добавление через username известного боту человека привязывает ID сразу", async () => {
    const { gate, state, tg } = setup();
    // Человек уже писал боту (заявка висит) — владелец добавляет по username.
    state.accessRequests["req9"] = { telegramId: STRANGER, username: "stranger", firstName: "S", attemptId: "", createdAt: now, status: "pending" };
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
    gate.addUser(MEMBER, { username: "ivan" });
    await gate.handleUpdate(msg(OWNER, "👥 Участники", { username: "owner" }));
    assert.ok(tg.sent.some((m) => /@ivan/.test(m.text)));
    await gate.handleUpdate(msg(OWNER, "🚫 Отозвать доступ", { username: "owner" }));
    const withKb = tg.sent.find((m) => m.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `revoke_${MEMBER}`);
    assert.ok(withKb);
    await gate.handleUpdate(cb(OWNER, `revoke_${MEMBER}`, 9, "owner"));
    assert.equal(gate.isAuthorized(MEMBER), false);
  });

  it("не-владелец не может решать заявки и отзывы", async () => {
    const { gate, state, tg } = setup();
    gate.addUser(MEMBER, {});
    state.accessRequests["req1"] = { telegramId: STRANGER, username: "s", firstName: "", attemptId: "", createdAt: now, status: "pending" };
    await gate.handleUpdate(cb(MEMBER, "approve_req1"));
    assert.equal(state.accessRequests["req1"].status, "pending");
    assert.ok(tg.answers.some((a) => /Только владелец/.test(a.text || "")));
  });
});

describe("миграция v1", () => {
  it("старые сессии сохраняются, пользователи засеваются", () => {
    const old = { invites: { abc: { telegramId: "1", expiresAt: 1, used: false } }, sessions: { sid1: { telegramId: MEMBER, expiresAt: Date.now() + 99999, revoked: false } } };
    const s = migrateState(old);
    assert.equal(s.version, 2);
    assert.ok(s.sessions.sid1);
    assert.ok(s.users[MEMBER]);
    assert.equal(s.invites, undefined);
  });
});
