// lhc-gate — бот-управляемый вход в Living History Studio (без паролей и ручных кодов).
//
// Поток:
//   1. Владелец вносит @username (предзаявка) или одобряет заявку из /start.
//      Права всегда привязываются к числовому Telegram ID, ник — только для поиска.
//   2. Человек открывает бота, жмёт /start: ID фиксируется, предзаявка закрывается
//      автоматически, бот присылает кнопку «Открыть Studio» с персональной ссылкой.
//   3. Кнопка «Открыть Studio» создаёт одноразовый тикет (TTL 90 с, привязан к ID)
//      и отдаёт ссылку https://studio/?ticket=….
//   4. Браузер по ссылке показывает «Войти как @username», один клик —
//      POST /gate/ticket/consume → сервер ставит HttpOnly+Secure cookie.
//      Без обмена тикета сессии нет; тикет одноразовый, повтор не проходит,
//      отзыв прав убивает и тикеты, и активные сессии.
//   5. Сессии серверные: cookie без Max-Age (живёт до закрытия браузера),
//      серверная запись — до отзыва.
//
// Тикет доставляется личным сообщением Telegram проверенному аккаунту —
// это и есть аутентификация. Окно перехвата: 90 секунд одноразового тикета.
// Владелец задан серверной настройкой LHC_OWNER_TELEGRAM_ID, самоназначение
// невозможно (нет такого API/команды).
//
// Права — только по числовому Telegram ID. Владелец задан серверной настройкой
// LHC_OWNER_TELEGRAM_ID, самоназначение невозможно (нет такого API/команды).
// Добавление через username — лишь предзаявка: права появляются, когда человек
// с таким username впервые пишет /start и бот фиксирует его числовой ID.
// Неизвестный пользователь после /start порождает запрос владельцу.
//
// Run: node lhc-gate.mjs  (слушает 127.0.0.1:8744, nginx проксирует /gate/;
//        в том же процессе — polling Telegram getUpdates отдельным ботом).
// Env: LHC_TELEGRAM_BOT_TOKEN (или TELEGRAM_BOT_TOKEN), LHC_GATE_SECRET (>=32),
//      LHC_OWNER_TELEGRAM_ID (default 332664273),
//      LHC_BOT_USERNAME (default living_history_gate_bot),
//      LHC_GATE_PORT, LHC_STORE, LHC_BOT_POLLING=0 чтобы отключить polling.
// @ts-nocheck
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const TICKET_TTL_MS = 90 * 1000;
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_CONSUME = 20;

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

export function defaultState() {
  return {
    version: 3,
    users: {}, // tgId -> { username, firstName, addedAt, revoked, role }
    nameClaims: {}, // lower(username) -> { createdAt, note }
    accessRequests: {}, // reqId -> { telegramId, username, firstName, createdAt, status }
    tickets: {}, // ticket -> { telegramId, username, createdAt, expiresAt, used, usedAt? }
    sessions: {}, // sid -> { telegramId, createdAt, expiresAt, revoked }
    ui: {}, // tgId -> { action }
    updateOffset: 0,
  };
}

// Мягкая миграция: v1 (invites/sessions) и v2 (login-попытки) → v3 (тикеты).
// Действующие сессии сохраняем, пользователей засеваем из них.
export function migrateState(raw) {
  const next = defaultState();
  if (!raw || typeof raw !== "object") return next;
  if (raw.version === 3) return Object.assign(next, raw);
  if (raw.version === 2 && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (k === "logins" || k === "contexts" || k === "version") continue;
      next[k] = v;
    }
    return next;
  }
  if (raw.sessions && typeof raw.sessions === "object") {
    for (const [sid, s] of Object.entries(raw.sessions)) {
      if (!s || s.revoked || (s.expiresAt ?? 0) < Date.now()) continue;
      const tid = String(s.telegramId ?? "");
      if (!/^\d{4,15}$/.test(tid)) continue;
      next.sessions[sid] = {
        telegramId: tid,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS,
        revoked: false,
      };
      if (!next.users[tid]) {
        next.users[tid] = { username: "", firstName: "", addedAt: Date.now(), revoked: false, role: "member" };
      }
    }
  }
  return next;
}

const rid = (n = 16) => randomBytes(n).toString("base64url");

export function createGate({ state, config, tg, now = () => Date.now() }) {
  const ownerId = String(config.ownerId);
  const botUsername = String(config.botUsername || "living_history_gate_bot");
  const studioOrigin = String(config.studioOrigin || "https://85.137.95.104.sslip.io:8741").replace(/\/+$/, "");

  const save = () => config.persist?.();

  function sign(value) {
    return createHmac("sha256", config.gateSecret).update(value).digest("base64url");
  }

  // --- пользователи и права ---
  const isOwner = (tgId) => String(tgId) === ownerId;
  function isAuthorized(tgId) {
    const id = String(tgId);
    if (isOwner(id)) return true;
    const u = state.users[id];
    return !!u && !u.revoked;
  }
  function addUser(tgId, { username = "", firstName = "", role = "member" } = {}) {
    const id = String(tgId);
    if (!/^\d{4,15}$/.test(id)) return { error: "bad_id" };
    if (isOwner(id)) return { error: "owner_implicit" }; // владелец и так авторизован
    state.users[id] = {
      username: String(username || state.users[id]?.username || ""),
      firstName: String(firstName || state.users[id]?.firstName || ""),
      addedAt: state.users[id]?.addedAt ?? now(),
      revoked: false,
      role,
    };
    save();
    return { ok: true };
  }
  function revokeUser(tgId) {
    const id = String(tgId);
    if (isOwner(id)) return { error: "owner_irrevocable" };
    const u = state.users[id];
    if (!u) return { error: "not_found" };
    u.revoked = true;
    let killed = 0;
    for (const s of Object.values(state.sessions)) {
      if (s.telegramId === id && !s.revoked) { s.revoked = true; killed++; }
    }
    for (const tk of Object.values(state.tickets)) {
      if (tk.telegramId === id && !tk.used) { tk.used = true; tk.usedReason = "revoked"; }
    }
    save();
    return { ok: true, killed };
  }
  function listUsers() {
    return Object.entries(state.users)
      .filter(([id]) => !isOwner(String(id)))
      .map(([id, u]) => ({ telegramId: id, ...u }))
      .sort((a, b) => a.addedAt - b.addedAt);
  }

  // --- сессии ---
  function issueSession(telegramId) {
    const sid = rid(24);
    state.sessions[sid] = {
      telegramId: String(telegramId),
      createdAt: now(),
      expiresAt: now() + SESSION_TTL_MS,
      revoked: false,
    };
    save();
    return `${sid}.${sign(sid)}`;
  }
  function sessionCookie(value) {
    // Без Max-Age: cookie живёт до закрытия браузера; серверная запись — до отзыва.
    return `lhc_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }
  function readSession(cookieHeader) {
    const cookie = String(cookieHeader ?? "").match(/lhc_session=([^;]+)/)?.[1];
    if (!cookie) return null;
    const dot = cookie.lastIndexOf(".");
    if (dot < 1) return null;
    const sid = cookie.slice(0, dot);
    const sig = cookie.slice(dot + 1);
    let ok = false;
    try {
      ok = timingSafeEqual(Buffer.from(sig), Buffer.from(sign(sid)));
    } catch { return null; }
    if (!ok) return null;
    const s = state.sessions[sid];
    if (!s || s.revoked || s.expiresAt < now()) return null;
    if (!isAuthorized(s.telegramId)) return null; // отзыв убивает активные сессии
    return { sid, ...s };
  }

  // --- входные тикеты (персональная ссылка из бота) ---
  const rate = new Map(); // ip -> timestamps
  function checkRate(ip) {
    const t = now();
    const arr = (rate.get(ip) ?? []).filter((x) => t - x < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX_CONSUME) return false;
    arr.push(t);
    rate.set(ip, arr);
    return true;
  }
  function sweep() {
    const t = now();
    let dirty = false;
    for (const [id, tk] of Object.entries(state.tickets)) {
      if (!tk.used && tk.expiresAt < t) { tk.used = true; tk.usedReason = "expired"; dirty = true; }
      if (tk.used && tk.expiresAt + 10 * 60 * 1000 < t) { delete state.tickets[id]; dirty = true; }
    }
    for (const [reqId, r] of Object.entries(state.accessRequests)) {
      if (r.status === "pending" && r.createdAt + 24 * 60 * 60 * 1000 < t) { r.status = "expired"; dirty = true; }
    }
    if (dirty) save();
  }
  // Тикет создаёт только бот для проверенного пользователя; браузер лишь обменивает.
  function createTicket(tgId) {
    sweep();
    const id = String(tgId);
    if (!isAuthorized(id)) return { error: "forbidden" };
    const ticket = rid(16);
    state.tickets[ticket] = {
      telegramId: id,
      username: String(state.users[id]?.username || ""),
      createdAt: now(),
      expiresAt: now() + TICKET_TTL_MS,
      used: false,
    };
    save();
    return { ticket, url: `${studioOrigin}/?ticket=${ticket}`, expiresInMs: TICKET_TTL_MS };
  }
  function ticketInfo(ticket) {
    sweep();
    const tk = state.tickets[String(ticket)];
    if (!tk || tk.used) return { valid: false };
    const u = state.users[tk.telegramId];
    return {
      valid: true,
      username: String(tk.username || u?.username || ""),
      expiresInMs: Math.max(0, tk.expiresAt - now()),
    };
  }
  // Обмен тикета на сессию: одноразово, только для привязанного ID,
  // только пока права действуют. Перехваченный тикет без open-сессии Telegram
  // бесполезен после первого обмена; окно — 90 секунд.
  function consumeTicket(ticket, ip) {
    sweep();
    if (!checkRate(String(ip || ""))) return { error: "rate_limited" };
    const tk = state.tickets[String(ticket)];
    if (!tk || tk.used) return { error: "unknown" };
    if (!isAuthorized(tk.telegramId)) return { error: "access_revoked" };
    tk.used = true;
    tk.usedAt = now();
    const cookieValue = issueSession(tk.telegramId);
    save();
    return { ok: true, cookieValue };
  }

  // --- бот: тексты ---

  async function ownerNotify(text, extra) {
    try { await tg.sendMessage(ownerId, text, extra); } catch (e) { console.log("owner notify failed:", e?.message ?? e); }
  }

  function kb(rows) { return { keyboard: rows, resize_keyboard: true }; }
  const OWNER_KB = () => kb([[ "➕ Добавить участника" ], [ "👥 Участники", "🚫 Отозвать доступ" ], [ "🎭 Открыть Studio" ]]);
  const USER_KB = () => kb([[ "🎭 Открыть Studio" ]]);

  // Персональная ссылка в Studio: тикет одноразовый, 90 секунд, привязан к ID.
  // Тикет доставляется личным сообщением Telegram проверенному аккаунту —
  // это и есть аутентификация.
  async function sendStudioLink(chatId, tgId) {
    const t = createTicket(tgId);
    if (t.error) {
      await tg.sendMessage(chatId, "Нет доступа в Studio.");
      return;
    }
    await tg.sendMessage(chatId, "Ваша персональная ссылка в Studio (одноразовая, действует 90 секунд):", {
      reply_markup: { inline_keyboard: [[ { text: "🎭 Открыть Studio", url: t.url } ]] },
    });
  }


  async function sendRoleHome(chatId, tgId) {
    if (isOwner(String(tgId))) {
      await tg.sendMessage(chatId, "Меню владельца Living History Studio.", { reply_markup: OWNER_KB() });
      return;
    }
    if (!isAuthorized(tgId)) return; // недопущенным отвечает ветка заявок
    await tg.sendMessage(chatId, "Чтобы войти в Studio: нажмите «🎭 Открыть Studio» — бот пришлёт персональную ссылку. В браузере останется только нажать «Войти».", { reply_markup: USER_KB() });
  }


  async function handleStart(msg) {
    const from = msg.from;
    const tgId = String(from.id);
    const chatId = msg.chat.id;
    const username = String(from.username || "");
    // Владелец: всегда свой дом, самоназначение исключено (ветка только для ownerId).
    if (isOwner(tgId)) {
      if (username && !state.users[tgId]) {
        state.users[tgId] = { username, firstName: String(from.first_name || ""), addedAt: now(), revoked: false, role: "owner" };
        save();
      }
      await sendRoleHome(chatId, tgId);
      await sendStudioLink(chatId, tgId);
      return;
    }
    // Допущенный участник.
    if (isAuthorized(tgId)) {
      const u = state.users[tgId];
      if (u && username && u.username !== username) { u.username = username; save(); }
      await tg.sendMessage(chatId, "С возвращением в мастерскую Living History.", { reply_markup: USER_KB() });
      await sendStudioLink(chatId, tgId);
      return;
    }
    // Предзаявка по username: права только по числовому ID — фиксируем его сейчас.
    const claim = username ? state.nameClaims[username.toLowerCase()] : null;
    if (claim) {
      delete state.nameClaims[username.toLowerCase()];
      addUser(tgId, { username, firstName: String(from.first_name || "") });
      await ownerNotify(`Предзаявка @${username} подтверждена автоматически: пользователь написал боту (ID ${tgId}).`);
      await tg.sendMessage(chatId, "Вы в списке участников Living History — добро пожаловать.", { reply_markup: USER_KB() });
      await sendStudioLink(chatId, tgId);
      return;
    }
    // Неизвестный: понятное сообщение + запрос владельцу.
    const dup = Object.values(state.accessRequests).find((r) => r.telegramId === tgId && r.status === "pending");
    if (!dup) {
      const reqId = rid(8);
      state.accessRequests[reqId] = {
        telegramId: tgId, username, firstName: String(from.first_name || ""),
        createdAt: now(), status: "pending",
      };
      save();
      await ownerNotify(
        `Запрос доступа: ${username ? "@" + username : "(без username)"} ${String(from.first_name || "")} (ID ${tgId}) хочет войти в Studio.`,
        { reply_markup: { inline_keyboard: [[
          { text: "✅ Разрешить", callback_data: `approve_${reqId}` },
          { text: "❌ Отклонить", callback_data: `deny_${reqId}` },
        ]] } },
      );
    }
    await tg.sendMessage(chatId, "Доступ в Living History Studio — по приглашению владельца. Заявка отправлена, подождите подтверждения.");
  }

  async function handleOwnerText(chatId, tgId, text) {
    const pending = state.ui[String(tgId)];
    if (text === "➕ Добавить участника") {
      state.ui[String(tgId)] = { action: "await_add" };
      save();
      await tg.sendMessage(chatId, "Кого добавить? Пришлите @username, числовой Telegram ID или перешлите любое сообщение человека.", { reply_markup: kb([[ "◀️ Отмена" ]]) });
      return true;
    }
    if (text === "◀️ Отмена") {
      delete state.ui[String(tgId)];
      save();
      await tg.sendMessage(chatId, "Меню владельца.", { reply_markup: OWNER_KB() });
      return true;
    }
    if (text === "👥 Участники") {
      const list = listUsers().filter((u) => !u.revoked);
      await tg.sendMessage(chatId, list.length
        ? `Участники (${list.length}):\n` + list.map((u) => `• ${u.username ? "@" + u.username + " " : ""}(ID ${u.telegramId})`).join("\n")
        : "Список пуст — добавьте первого участника.", { reply_markup: OWNER_KB() });
      return true;
    }
    if (text === "🚫 Отозвать доступ") {
      const list = listUsers().filter((u) => !u.revoked);
      if (!list.length) {
        await tg.sendMessage(chatId, "Отзывать некого — список пуст.", { reply_markup: OWNER_KB() });
        return true;
      }
      await tg.sendMessage(chatId, "Чей доступ отозвать? (Сессии отозванного завершатся сразу.)", {
        reply_markup: { inline_keyboard: list.slice(0, 20).map((u) => [{ text: `${u.username ? "@" + u.username : "ID " + u.telegramId}`, callback_data: `revoke_${u.telegramId}` }]) },
      });
      return true;
    }
    if (text === "🎭 Открыть Studio") {
      await sendStudioLink(chatId, String(tgId));
      return true;
    }
    if (pending?.action === "await_add") {
      await handleAddInput(chatId, text);
      return true;
    }
    return false;
  }

  async function handleAddInput(chatId, text) {
    const t = String(text || "").trim();
    const num = /^(\d{4,15})$/.exec(t)?.[1];
    if (num) {
      if (isOwner(num)) {
        await tg.sendMessage(chatId, "Это ваш собственный ID — владелец уже имеет доступ.", { reply_markup: OWNER_KB() });
      } else {
        let username = "", firstName = "";
        try {
          const info = await tg.getChat?.(num);
          username = String(info?.username || ""); firstName = String(info?.first_name || "");
        } catch { /* chat может быть недоступен — добавим по ID */ }
        addUser(num, { username, firstName });
        delete state.ui[ownerId];
        save();
        await tg.sendMessage(chatId, `Готово: ID ${num}${username ? " (@" + username + ")" : ""} добавлен. Пусть человек один раз напишет боту /start — дальше входит через «Открыть Studio».`, { reply_markup: OWNER_KB() });
      }
      return;
    }
    const m = /^@?([A-Za-z0-9_]{5,32})$/.exec(t);
    if (m) {
      const want = m[1].toLowerCase();
      // Человек уже писал боту? Его числовой ID известен — привязываем сразу, без ожидания.
      const known = Object.entries(state.users).find(
        ([id, u]) => !u.revoked && String(u.username || "").toLowerCase() === want
      );
      if (known) {
        delete state.ui[ownerId];
        save();
        await tg.sendMessage(chatId, `Готово: @${m[1]} уже известен боту — доступ привязан к его ID ${known[0]}. Отдельного подтверждения не нужно.`, { reply_markup: OWNER_KB() });
        return;
      }
      // Человек писал боту, но ещё не одобрен (висит заявка)? Добавление по username = одобрение.
      const pendingReq = Object.entries(state.accessRequests).find(
        ([, r]) => r.status === "pending" && String(r.username || "").toLowerCase() === want
      );
      if (pendingReq) {
        const [reqId, r] = pendingReq;
        r.status = "approved";
        addUser(r.telegramId, { username: r.username, firstName: r.firstName });
        delete state.ui[ownerId];
        save();
        try { await tg.sendMessage(r.telegramId, "Владелец подтвердил доступ — добро пожаловать в Living History.", { reply_markup: USER_KB() }); } catch {}
        await tg.sendMessage(chatId, `Готово: @${m[1]} писал боту — заявка одобрена, доступ привязан к ID ${r.telegramId}.`, { reply_markup: OWNER_KB() });
        return;
      }
      state.nameClaims[want] = { createdAt: now(), note: "owner username claim" };
      delete state.ui[ownerId];
      save();
      await tg.sendMessage(chatId, `Предзаявка @${m[1]} записана. Пусть человек один раз откроет бота и нажмёт /start — доступ привяжется к его числовому ID, а персональную ссылку в Studio бот пришлёт сам. Ссылка на бота: https://t.me/${botUsername}`, { reply_markup: OWNER_KB() });
      return;
    }
    await tg.sendMessage(chatId, "Не похоже на @username или числовой ID. Пришлите ещё раз или нажмите «◀️ Отмена».");
  }

  async function handleCallback(q) {
    const from = q.from;
    const tgId = String(from.id);
    const chatId = q.message?.chat.id;
    const messageId = q.message?.message_id;
    const data = String(q.data || "");
    const answer = (text) => tg.answerCallbackQuery(q.id, text).catch(() => {});
    const [verb, arg] = [data.split("_")[0], data.slice(data.indexOf("_") + 1)];

    // Решения владельца по заявкам и отзывам — только ownerId.
    if (!isOwner(tgId)) { await answer("Только владелец."); return; }
    if (verb === "approve" || verb === "deny") {
      const r = state.accessRequests[arg];
      if (!r || r.status !== "pending") { await answer("Заявка уже обработана."); return; }
      r.status = verb === "approve" ? "approved" : "denied";
      save();
      if (verb === "approve") {
        addUser(r.telegramId, { username: r.username, firstName: r.firstName });
        try { await tg.sendMessage(r.telegramId, "Владелец подтвердил доступ — добро пожаловать в Living History.", { reply_markup: USER_KB() }); } catch {}
        try { await sendStudioLink(r.telegramId, r.telegramId); } catch {}
      } else {
        try { await tg.sendMessage(r.telegramId, "Владелец отклонил заявку на доступ в Studio."); } catch {}
      }
      try { await tg.editMessageText(chatId, messageId, `${verb === "approve" ? "Разрешено" : "Отклонено"}: ${r.username ? "@" + r.username + " " : ""}(ID ${r.telegramId}).`); } catch {}
      await answer("Готово.");
      return;
    }
    if (verb === "revoke") {
      const res = revokeUser(arg);
      await answer(res.ok ? "Доступ отозван, сессии завершены." : "Не найдено.");
      if (res.ok) {
        try { await tg.sendMessage(arg, "Доступ в Living History Studio отозван владельцем."); } catch {}
        try { await tg.editMessageText(chatId, messageId, `Доступ отозван (ID ${arg}), активные сессии завершены.`); } catch {}
      }
      return;
    }
    await answer("Неизвестная команда.");
  }

  async function handleUpdate(u) {
    if (u?.update_id !== undefined) {
      if ((state.updateOffset ?? 0) <= u.update_id) { state.updateOffset = u.update_id + 1; save(); }
    }
    if (u.callback_query) { await handleCallback(u.callback_query); return; }
    const msg = u.message;
    if (!msg || !msg.from) return;
    const tgId = String(msg.from.id);
    const chatId = msg.chat.id;
    // Пересланное сообщение владельцу в режиме добавления = добавить автора оригинала.
    const fwd = msg.forward_from;
    if (isOwner(tgId) && fwd && state.ui[tgId]?.action === "await_add") {
      const r = addUser(String(fwd.id), { username: String(fwd.username || ""), firstName: String(fwd.first_name || "") });
      delete state.ui[tgId];
      save();
      await tg.sendMessage(chatId, r.ok ? `Готово: ${fwd.username ? "@" + fwd.username + " " : ""}(ID ${fwd.id}) добавлен.` : "Не удалось добавить.", { reply_markup: OWNER_KB() });
      return;
    }
    const text = String(msg.text || "").trim();
    if (text.startsWith("/start")) {
      await handleStart(msg);
      return;
    }
    if (isOwner(tgId)) {
      const handled = await handleOwnerText(chatId, tgId, text);
      if (!handled) await tg.sendMessage(chatId, "Меню владельца.", { reply_markup: OWNER_KB() });
      return;
    }
    if (text === "🎭 Открыть Studio") {
      await sendStudioLink(chatId, tgId);
      return;
    }
    if (!isAuthorized(tgId)) {
      await tg.sendMessage(chatId, "Доступ в Living History Studio — по приглашению владельца. Ваша заявка уже у него; ждите подтверждения.");
      return;
    }
    await sendStudioLink(chatId, tgId);
  }

  return {
    isOwner, isAuthorized, addUser, revokeUser, listUsers,
    issueSession, sessionCookie, readSession,
    createTicket, ticketInfo, consumeTicket, sweep,
    handleUpdate, handleCallback, handleStart,
  };
}

// ---------- Telegram API ----------
export function realTelegram(token) {
  const api = async (method, payload) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
    return j.result;
  };
  return {
    sendMessage: (chat_id, text, extra = {}) => api("sendMessage", { chat_id, text, ...extra }),
    editMessageText: (chat_id, message_id, text, extra = {}) =>
      api("editMessageText", { chat_id, message_id, text, ...extra }).catch((e) => {
        if (/message to edit not found|message can't be edited/i.test(String(e?.message))) return null;
        throw e;
      }),
    answerCallbackQuery: (callback_query_id, text) =>
      api("answerCallbackQuery", { callback_query_id, ...(text ? { text } : {}) }),
    getChat: (chat_id) => api("getChat", { chat_id }),
    getUpdates: (offset) => api("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }),
    setMyCommands: (commands) => api("setMyCommands", { commands }).catch(() => null),
  };
}

// ---------- wiring: state file, HTTP, polling ----------
function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return fallback; }
}

export function wireHttp(gate, config) {
  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req, limit = 4096) => new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > limit) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
  const clientIp = (req) =>
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || String(req.socket.remoteAddress || "");

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://gate.local");
    try {
      if (url.pathname === "/gate/healthz") {
        return json(res, 200, { ok: true, bot: config.polling ? "polling" : "disabled", version: 3 });
      }
      if (url.pathname === "/gate/ticket/info" && req.method === "GET") {
        const t = gate.ticketInfo(url.searchParams.get("ticket") || "");
        if (!t.valid) return json(res, 404, t);
        return json(res, 200, t);
      }
      if (url.pathname === "/gate/ticket/consume" && req.method === "POST") {
        const body = await readBody(req).catch(() => null);
        if (!body || typeof body.ticket !== "string") return json(res, 400, { error: "bad request" });
        const r = gate.consumeTicket(body.ticket, clientIp(req));
        if (!r.ok) {
          const code = r.error === "unknown" ? 404 : r.error === "rate_limited" ? 429 : 410;
          return json(res, code, { error: r.error });
        }
        return json(res, 200, { ok: true }, { "set-cookie": gate.sessionCookie(r.cookieValue) });
      }
      // Старые пути входа удалены: страница и бот используют тикеты.
      if (url.pathname === "/gate/login/start" || url.pathname === "/gate/login/status" || url.pathname === "/gate/login/consume") {
        return json(res, 410, { error: "gone", hint: "войдите через бота: кнопка «Открыть Studio» пришлёт персональную ссылку" });
      }
      if (url.pathname === "/gate/check") {
        const s = gate.readSession(req.headers.cookie);
        if (!s) return json(res, 401, { error: "no session" });
        res.setHeader("x-telegram-id", s.telegramId);
        return json(res, 200, { ok: true, telegramId: s.telegramId });
      }
      // Старый invite/widget-путь удалён.
      if (url.pathname === "/gate/invite" || url.pathname === "/gate/callback" || url.pathname === "/gate/revoke") {
        return json(res, 410, { error: "gone", hint: "вход теперь через бота: откройте страницу входа" });
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: "internal" });
    }
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split(":/").pop() ?? "");
if (!process.env.LHC_GATE_NO_AUTOSTART && (isMain || process.env.LHC_GATE_FORCE_START)) {
  const envFile = loadEnvFile(process.env.LHC_ENV_FILE ?? "/opt/lhc/engine/deploy/vps/.env");
  const BOT_TOKEN = String(process.env.LHC_TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? envFile.LHC_TELEGRAM_BOT_TOKEN ?? envFile.TELEGRAM_BOT_TOKEN ?? "");
  if (!BOT_TOKEN) throw new Error("LHC_TELEGRAM_BOT_TOKEN is required");
  const GATE_SECRET = String(process.env.LHC_GATE_SECRET ?? "");
  if (GATE_SECRET.length < 32) throw new Error("LHC_GATE_SECRET must be >= 32 chars");

  const PORT = Number(process.env.LHC_GATE_PORT ?? 8744);
  const STORE_PATH = String(process.env.LHC_STORE ?? "./lhc-gate-state.json");
  const OWNER_ID = String(process.env.LHC_OWNER_TELEGRAM_ID ?? "332664273");
  const BOT_USERNAME = String(process.env.LHC_BOT_USERNAME ?? "living_history_gate_bot");
  const STUDIO_ORIGIN = String(process.env.LHC_STUDIO_ORIGIN ?? "https://85.137.95.104.sslip.io:8741");
  const POLLING = process.env.LHC_BOT_POLLING !== "0";

  const state = migrateState(readJson(STORE_PATH, null) ?? defaultState());
  const persist = () => {
    try { writeFileSync(STORE_PATH, JSON.stringify(state), { mode: 0o600 }); }
    catch (e) { console.log("persist failed:", e?.message ?? e); }
  };
  const tg = realTelegram(BOT_TOKEN);
  const gate = createGate({ state, config: { ownerId: OWNER_ID, botUsername: BOT_USERNAME, studioOrigin: STUDIO_ORIGIN, gateSecret: GATE_SECRET, persist }, tg });
  persist();

  const server = wireHttp(gate, { polling: POLLING });
  server.listen(PORT, "127.0.0.1", () => console.log(`lhc-gate v3 listening on 127.0.0.1:${PORT}`));
  setInterval(() => gate.sweep(), 30_000).unref?.();

  if (POLLING) {
    tg.setMyCommands([
      { command: "start", description: "Открыть меню / войти в Studio" },
    ]);
    let backoff = 1000;
    const loop = async () => {
      for (;;) {
        try {
          const updates = await tg.getUpdates(state.updateOffset || 0);
          backoff = 1000;
          for (const u of updates) {
            try { await gate.handleUpdate(u); }
            catch (e) { console.log("update failed:", e?.message ?? e); }
          }
          persist();
        } catch (e) {
          console.log("poll failed:", e?.message ?? e);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    };
    loop();
    console.log("bot polling started");
  }
}
