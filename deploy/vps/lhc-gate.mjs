// lhc-gate — бот-управляемый вход в Living History Studio (без паролей и ручных кодов).
//
// Поток:
//   1. Страница входа создаёт login-попытку: POST /gate/login/start → { attemptId, botUrl }.
//      Попытка server-side pending, TTL 2 мин, одноразовая. Сама по себе сессию не даёт.
//   2. Участник открывает бота @living_history_gate_bot по ссылке со страницы
//      (start=login_<attemptId>) и подтверждает КОНКРЕТНУЮ попытку (видны UA/IP/время).
//   3. Браузер опрашивает GET /gate/login/status?id=… и после подтверждения вызывает
//      POST /gate/login/consume → сервер ставит HttpOnly+Secure cookie, редирект в Studio.
//   4. Сессии серверные: cookie без Max-Age (живёт до закрытия браузера),
//      серверная запись — до отзыва. Отзыв убивает все активные сессии пользователя.
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

export const LOGIN_TTL_MS = 2 * 60 * 1000;
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CONSUME_GRACE_MS = 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_STARTS = 20;

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
    version: 2,
    users: {}, // tgId -> { username, firstName, addedAt, revoked, role }
    nameClaims: {}, // lower(username) -> { createdAt, note }
    accessRequests: {}, // reqId -> { telegramId, username, firstName, attemptId, createdAt, status }
    logins: {}, // attemptId -> { createdAt, expiresAt, ip, ua, status, telegramId?, decidedAt? }
    sessions: {}, // sid -> { telegramId, createdAt, expiresAt, revoked }
    contexts: {}, // tgId -> last attemptId (из start-параметра)
    ui: {}, // tgId -> { action }
    updateOffset: 0,
  };
}

// Мягкая миграция со старого формата (invites/sessions v1): сессии сохраняем,
// пользователей засеваем из действующих сессий (роль уточнится ботом/владельцем).
export function migrateState(raw) {
  const next = defaultState();
  if (!raw || typeof raw !== "object") return next;
  if (raw.version === 2) return Object.assign(next, raw);
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
    for (const l of Object.values(state.logins)) {
      if (l.telegramId === id && l.status === "pending") l.status = "denied";
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

  // --- login-попытки ---
  const rate = new Map(); // ip -> timestamps
  function checkRate(ip) {
    const t = now();
    const arr = (rate.get(ip) ?? []).filter((x) => t - x < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX_STARTS) return false;
    arr.push(t);
    rate.set(ip, arr);
    return true;
  }
  function sweep() {
    const t = now();
    let dirty = false;
    for (const [id, l] of Object.entries(state.logins)) {
      if (l.status === "pending" && l.expiresAt < t) { l.status = "expired"; dirty = true; }
      if ((l.status === "consumed" || l.status === "expired" || l.status === "denied") && (l.decidedAt ?? l.expiresAt) + 10 * 60 * 1000 < t) {
        delete state.logins[id]; dirty = true;
      }
    }
    for (const [reqId, r] of Object.entries(state.accessRequests)) {
      if (r.status === "pending" && r.createdAt + 24 * 60 * 60 * 1000 < t) { r.status = "expired"; dirty = true; }
    }
    if (dirty) save();
  }
  function createLogin({ ip, ua }) {
    sweep();
    if (!checkRate(ip)) return { error: "rate_limited" };
    const id = rid(16);
    state.logins[id] = {
      createdAt: now(),
      expiresAt: now() + LOGIN_TTL_MS,
      ip: String(ip || "").slice(0, 64),
      ua: String(ua || "").slice(0, 160),
      status: "pending",
    };
    save();
    return { attemptId: id, botUrl: `https://t.me/${botUsername}?start=login_${id}`, expiresInMs: LOGIN_TTL_MS };
  }
  function loginStatus(id) {
    sweep();
    const l = state.logins[String(id)];
    if (!l) return { status: "unknown" };
    return { status: l.status };
  }
  // Перехваченная ссылка без подтверждения сессию не даёт: consume работает
  // только после approve через бота и только один раз.
  function consumeLogin(id) {
    sweep();
    const lid = String(id);
    const l = state.logins[lid];
    if (!l) return { error: "unknown" };
    if (l.status !== "approved") return { error: l.status === "pending" ? "not_approved" : l.status };
    if (!isAuthorized(l.telegramId)) return { error: "access_revoked" };
    l.status = "consumed";
    l.decidedAt = now();
    const cookieValue = issueSession(l.telegramId);
    save();
    return { ok: true, cookieValue };
  }

  // --- бот: тексты ---
  const SHORT_UA = (ua) => {
    const s = String(ua || "");
    const m = /(Windows|Android|iPhone|iPad|Macintosh|Linux)[^;)]*/.exec(s);
    return (m ? m[0] : s.slice(0, 40)).slice(0, 48) || "неизвестное устройство";
  };
  const fmtTime = (ts) => new Date(ts).toLocaleString("ru-RU", { hour12: false });
  function attemptCard(l, id) {
    return `Вход в Living History Studio\n\nУстройство: ${SHORT_UA(l.ua)}\nIP: ${l.ip || "?"}\nЗапрошено: ${fmtTime(l.createdAt)}\n\nЕсли это вы — подтвердите. Иначе отклоните.`;
  }

  async function ownerNotify(text, extra) {
    try { await tg.sendMessage(ownerId, text, extra); } catch (e) { console.log("owner notify failed:", e?.message ?? e); }
  }

  function kb(rows) { return { keyboard: rows, resize_keyboard: true }; }
  const OWNER_KB = () => kb([[ "➕ Добавить участника" ], [ "👥 Участники", "🚫 Отозвать доступ" ], [ "🎭 Открыть Studio" ]]);
  const USER_KB = () => kb([[ "🎭 Открыть Studio" ]]);

  async function showAttemptCard(chatId, attemptId, intro = "") {
    const l = state.logins[attemptId];
    if (!l || l.status !== "pending" || l.expiresAt < now()) {
      await tg.sendMessage(chatId, `${intro}Эта попытка входа уже недействительна (истекла или использована). Откройте страницу входа заново.`.trim());
      return;
    }
    await tg.sendMessage(chatId, `${intro}${attemptCard(l, attemptId)}`.trim(), {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Подтвердить вход", callback_data: `confirm_${attemptId}` },
          { text: "❌ Отклонить", callback_data: `reject_${attemptId}` },
        ]],
      },
    });
  }

  async function sendRoleHome(chatId, tgId, attemptId) {
    if (isOwner(String(tgId))) {
      if (attemptId) await showAttemptCard(chatId, attemptId, "Заявка на вход из браузера.\n\n");
      else {
        await tg.sendMessage(chatId, "Меню владельца Living History Studio.", { reply_markup: OWNER_KB() });
      }
      return;
    }
    if (!isAuthorized(tgId)) return; // недопущенным отвечает ветка заявок
    if (attemptId) await showAttemptCard(chatId, attemptId, "");
    else {
      const ctx = state.contexts[String(tgId)];
      const l = ctx && state.logins[ctx];
      if (l && l.status === "pending" && l.expiresAt >= now()) await showAttemptCard(chatId, ctx, "");
      else {
        await tg.sendMessage(chatId, "Чтобы войти в Studio: откройте страницу входа в браузере, нажмите «Войти через Telegram» и вернитесь сюда по ссылке со страницы — здесь появится подтверждение.", { reply_markup: USER_KB() });
      }
    }
  }

  async function handleStart(msg, param) {
    const from = msg.from;
    const tgId = String(from.id);
    const chatId = msg.chat.id;
    const username = String(from.username || "");
    let attemptId = "";
    if (param && param.startsWith("login_")) {
      const cand = param.slice("login_".length);
      if (/^[A-Za-z0-9_-]{16,}$/.test(cand) && state.logins[cand]) {
        attemptId = cand;
        state.contexts[tgId] = cand;
        save();
      }
    }
    // Владелец: всегда свой дом, самоназначение исключено (ветка только для ownerId).
    if (isOwner(tgId)) {
      if (username && !state.users[tgId]) {
        state.users[tgId] = { username, firstName: String(from.first_name || ""), addedAt: now(), revoked: false, role: "owner" };
        save();
      }
      await sendRoleHome(chatId, tgId, attemptId);
      return;
    }
    // Допущенный участник.
    if (isAuthorized(tgId)) {
      const u = state.users[tgId];
      if (u && username && u.username !== username) { u.username = username; save(); }
      await tg.sendMessage(chatId, "С возвращением в мастерскую Living History.", { reply_markup: USER_KB() });
      await sendRoleHome(chatId, tgId, attemptId);
      return;
    }
    // Предзаявка по username: права только по числовому ID — фиксируем его сейчас.
    const claim = username ? state.nameClaims[username.toLowerCase()] : null;
    if (claim) {
      delete state.nameClaims[username.toLowerCase()];
      addUser(tgId, { username, firstName: String(from.first_name || "") });
      await ownerNotify(`Предзаявка @${username} подтверждена автоматически: пользователь написал боту (ID ${tgId}).`);
      await tg.sendMessage(chatId, "Вы в списке участников Living History — добро пожаловать.", { reply_markup: USER_KB() });
      await sendRoleHome(chatId, tgId, attemptId);
      return;
    }
    // Неизвестный: понятное сообщение + запрос владельцу.
    const dup = Object.values(state.accessRequests).find((r) => r.telegramId === tgId && r.status === "pending");
    if (!dup) {
      const reqId = rid(8);
      state.accessRequests[reqId] = {
        telegramId: tgId, username, firstName: String(from.first_name || ""),
        attemptId: attemptId || state.contexts[tgId] || "", createdAt: now(), status: "pending",
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
      const ctx = state.contexts[String(tgId)];
      const l = ctx && state.logins[ctx];
      if (l && l.status === "pending" && l.expiresAt >= now()) await showAttemptCard(chatId, ctx, "");
      else await tg.sendMessage(chatId, "Откройте страницу входа в браузере и перейдите по ссылке со страницы — здесь появится подтверждение.", { reply_markup: OWNER_KB() });
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
      await tg.sendMessage(chatId, `Предзаявка @${m[1]} записана. Права появятся, когда этот человек напишет боту /start (права привяжутся к его числовому ID). Одну ссылку на бота можно дать сразу: https://t.me/${botUsername}`, { reply_markup: OWNER_KB() });
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

    if (verb === "confirm" || verb === "reject") {
      const l = state.logins[arg];
      if (!l) { await answer("Попытка не найдена."); return; }
      if (!isAuthorized(tgId)) { await answer("Нет доступа."); return; }
      if (l.status !== "pending" || l.expiresAt < now()) { await answer("Попытка уже недействительна."); return; }
      // Подтверждать можно только попытку, привязанную к этому пользователю
      // через его ссылку (контекст), — чужой confirm по перехваченному ID не пройдёт.
      if (state.contexts[tgId] !== arg && !isOwner(tgId)) { await answer("Это не ваша попытка входа."); return; }
      l.status = verb === "confirm" ? "approved" : "denied";
      l.telegramId = tgId;
      l.decidedAt = now();
      save();
      try {
        await tg.editMessageText(chatId, messageId,
          verb === "confirm"
            ? "Вход подтверждён — вернитесь в браузер, Studio откроется само."
            : "Попытка отклонена. Если это были не вы — ничего делать не нужно.");
      } catch { /* сообщение могли удалить */ }
      await answer(verb === "confirm" ? "Подтверждено." : "Отклонено.");
      return;
    }

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
        if (r.attemptId && state.logins[r.attemptId]?.status === "pending") {
          state.contexts[r.telegramId] = r.attemptId;
          save();
          try { await tg.sendMessage(r.telegramId, "Осталось подтвердить вход в браузере:"); } catch {}
          // Карточку покажет сам пользователь кнопкой «Открыть Studio» (контекст сохранён).
        }
      } else {
        const l = r.attemptId && state.logins[r.attemptId];
        if (l && l.status === "pending") { l.status = "denied"; l.decidedAt = now(); save(); }
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
      const param = text.split(/\s+/)[1] || "";
      await handleStart(msg, param);
      return;
    }
    if (isOwner(tgId)) {
      const handled = await handleOwnerText(chatId, tgId, text);
      if (!handled) await tg.sendMessage(chatId, "Меню владельца.", { reply_markup: OWNER_KB() });
      return;
    }
    if (text === "🎭 Открыть Studio") {
      await sendRoleHome(chatId, tgId, "");
      return;
    }
    if (!isAuthorized(tgId)) {
      await tg.sendMessage(chatId, "Доступ в Living History Studio — по приглашению владельца. Ваша заявка уже у него; ждите подтверждения.");
      return;
    }
    await sendRoleHome(chatId, tgId, "");
  }

  return {
    isOwner, isAuthorized, addUser, revokeUser, listUsers,
    issueSession, sessionCookie, readSession,
    createLogin, loginStatus, consumeLogin, sweep,
    handleUpdate, handleCallback, handleStart,
    attemptTextForTest: (id) => { const l = state.logins[id]; return l ? attemptCard(l, id) : ""; },
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
        return json(res, 200, { ok: true, bot: config.polling ? "polling" : "disabled", version: 2 });
      }
      if (url.pathname === "/gate/login/start" && req.method === "POST") {
        await readBody(req).catch(() => ({}));
        const r = gate.createLogin({ ip: clientIp(req), ua: req.headers["user-agent"] });
        if (r.error) return json(res, 429, { error: r.error });
        return json(res, 201, r);
      }
      if (url.pathname === "/gate/login/status" && req.method === "GET") {
        const s = gate.loginStatus(url.searchParams.get("id") || "");
        if (s.status === "unknown") return json(res, 404, s);
        return json(res, 200, s);
      }
      if (url.pathname === "/gate/login/consume" && req.method === "POST") {
        const body = await readBody(req).catch(() => null);
        if (!body) return json(res, 400, { error: "bad json" });
        const r = gate.consumeLogin(body.id);
        if (!r.ok) {
          const code = r.error === "not_approved" ? 403 : r.error === "unknown" ? 404 : 410;
          return json(res, code, { error: r.error });
        }
        return json(res, 200, { ok: true }, { "set-cookie": gate.sessionCookie(r.cookieValue) });
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
  const POLLING = process.env.LHC_BOT_POLLING !== "0";

  const state = migrateState(readJson(STORE_PATH, null) ?? defaultState());
  const persist = () => {
    try { writeFileSync(STORE_PATH, JSON.stringify(state), { mode: 0o600 }); }
    catch (e) { console.log("persist failed:", e?.message ?? e); }
  };
  const tg = realTelegram(BOT_TOKEN);
  const gate = createGate({ state, config: { ownerId: OWNER_ID, botUsername: BOT_USERNAME, gateSecret: GATE_SECRET, persist }, tg });
  persist();

  const server = wireHttp(gate, { polling: POLLING });
  server.listen(PORT, "127.0.0.1", () => console.log(`lhc-gate v2 listening on 127.0.0.1:${PORT}`));
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
