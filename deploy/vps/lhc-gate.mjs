// lhc-gate — Telegram Login Widget auth + invitation codes + session cookies
// for the hosted Studio/Engine on the VPS. No password; access reviewable.
//
// Flow: owner creates an address invitation (one-time code, TTL) → participant
// opens the invite URL → clicks "Log in with Telegram" (domain-bound widget) →
// callback POSTs Telegram-signed fields → gate verifies HMAC against the bot
// token, checks the code is unused and the Telegram id is the invited one →
// issues an HMAC-signed session cookie (TTL 12h, revocable).
//
// Run: node lhc-gate.mjs  (listens 127.0.0.1:8744, nginx proxies /gate/)
// Env: TELEGRAM_BOT_TOKEN (read from hermes .env at deploy), LHC_GATE_SECRET,
//      LHC_STUDIO_ORIGIN=https://85.137.95.104.sslip.io:8741
// @ts-nocheck
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";


const PORT = Number(process.env.LHC_GATE_PORT ?? 8744);
const STUDIO_ORIGIN = String(process.env.LHC_STUDIO_ORIGIN ?? "https://85.137.95.104.sslip.io:8741");
const STORE_PATH = String(process.env.LHC_STORE ?? "./lhc-gate-state.json");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const INVITE_TTL_MS = 15 * 60 * 1000;

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const envFile = loadEnvFile(process.env.LHC_ENV_FILE ?? "/home/hermes-pilot/.hermes/.env");
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN ?? envFile.TELEGRAM_BOT_TOKEN ?? "");
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required (LHC_ENV_FILE or env)");
const GATE_SECRET = String(process.env.LHC_GATE_SECRET ?? "");
if (GATE_SECRET.length < 32) throw new Error("LHC_GATE_SECRET must be >= 32 chars");

// state: { invites: {code: {telegramId, expiresAt, used}}, sessions: {sid: {telegramId, expiresAt, revoked}} }
const state = existsSync(STORE_PATH)
  ? JSON.parse(readFileSync(STORE_PATH, "utf8"))
  : { invites: {}, sessions: {} };
function persist() {
  writeFileSync(STORE_PATH, JSON.stringify(state), { mode: 0o600 });
}

function sign(value) {
  return createHmac("sha256", GATE_SECRET).update(value).digest("base64url");
}
function issueSession(telegramId) {
  const sid = randomBytes(24).toString("base64url");
  state.sessions[sid] = { telegramId, expiresAt: Date.now() + SESSION_TTL_MS, revoked: false };
  persist();
  return `${sid}.${sign(sid)}`;
}
function readSession(cookieHeader) {
  const cookie = String(cookieHeader ?? "").match(/lhc_session=([^;]+)/)?.[1];
  if (!cookie) return null;
  const [sid, sig] = cookie.split(".");
  if (!sid || !sig) return null;
  const expected = sign(sid);
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  const session = state.sessions[sid];
  if (!session || session.revoked || session.expiresAt < Date.now()) return null;
  return session;
}
function verifyTelegramAuth(fields) {
  const { hash, ...rest } = fields;
  if (!hash) return false;
  const dataCheckString = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computed = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(hash, "hex"));
  } catch { return false; }
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://gate.local");

  // Health
  if (url.pathname === "/gate/healthz") return json(res, 200, { ok: true });

  // Owner: create an address invitation (requires the owner session or the master key)
  if (url.pathname === "/gate/invite" && req.method === "POST") {
    const session = readSession(req.headers.cookie);
    const master = req.headers["x-lhc-master"];
    const isOwner = session || (master && timingSafeEqual(Buffer.from(master), Buffer.from(sign("master"))));
    if (!isOwner) return json(res, 403, { error: "forbidden" });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      const { telegramId } = JSON.parse(body || "{}");
      if (!/^\d{4,12}$/.test(String(telegramId))) return json(res, 400, { error: "telegram id required" });
      const code = randomBytes(6).toString("base64url");
      state.invites[code] = { telegramId: String(telegramId), expiresAt: Date.now() + INVITE_TTL_MS, used: false };
      persist();
      json(res, 201, { code, inviteUrl: `${STUDIO_ORIGIN}/?invite=${code}`, expiresInMs: INVITE_TTL_MS });
    });
    return;
  }

  // Owner: revoke a session or an invite
  if (url.pathname === "/gate/revoke" && req.method === "POST") {
    const session = readSession(req.headers.cookie);
    const master = req.headers["x-lhc-master"];
    const isOwner = session || (master && timingSafeEqual(Buffer.from(master), Buffer.from(sign("master"))));
    if (!isOwner) return json(res, 403, { error: "forbidden" });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      const { sessionId, inviteCode } = JSON.parse(body || "{}");
      if (sessionId && state.sessions[sessionId]) { state.sessions[sessionId].revoked = true; persist(); }
      if (inviteCode && state.invites[inviteCode]) { delete state.invites[inviteCode]; persist(); }
      json(res, 200, { ok: true });
    });
    return;
  }

  // Telegram Login Widget callback (browser posts the signed fields)
  if (url.pathname === "/gate/callback" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on("end", () => {
      const fields = JSON.parse(body || "{}");
      const { invite, ...auth } = fields;
      const inviteRecord = invite ? state.invites[invite] : null;
      const fail = (code, message) => {
        console.log(`callback reject: ${code} invite=${String(invite || "").slice(0, 6)}`);
        return json(res, 403, { error: message, code });
      };
      if (!inviteRecord) {
        return fail("invite_not_found", "invitation invalid or expired");
      }
      if (inviteRecord.used) {
        return fail("invite_used", "invitation already used — ask the owner for a fresh code");
      }
      if (inviteRecord.expiresAt < Date.now()) {
        return fail("invite_expired", "invitation expired — ask the owner for a fresh code");
      }
      if (!verifyTelegramAuth(auth)) {
        console.log(`callback reject: bad_signature`);
        return json(res, 403, { error: "telegram signature invalid", code: "bad_signature" });
      }
      if (String(auth.id) !== inviteRecord.telegramId) {
        return json(res, 403, { error: "this invitation was issued to another telegram account" });
      }
      inviteRecord.used = true;
      persist();
      const cookie = `lhc_session=${issueSession(auth.id)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}; Path=/`;
      json(res, 200, { ok: true, telegramId: auth.id, name: auth.first_name ?? "" , setCookie: cookie });
    });
    return;
  }

  // Session check for nginx auth_request
  if (url.pathname === "/gate/check") {
    const session = readSession(req.headers.cookie);
    if (!session) return json(res, 401, { error: "no session" });
    return json(res, 200, { ok: true, telegramId: session.telegramId });
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`lhc-gate listening on 127.0.0.1:${PORT}`));
