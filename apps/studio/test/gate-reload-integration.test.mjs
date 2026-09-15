// FIN-06 — перезагрузка вкладки Studio в режиме единого входа.
//
// Studio держит подтверждение мутаций (CSRF) только в памяти вкладки. После
// перезагрузки подтверждение терялось, и мастерская предлагала форму логина и
// пароля — которой в режиме единого входа не существует: владелец оказывался
// заперт («создание миссии недоступно», «роли не меняются»). Здесь проверяется
// реальный путь без моков: Control с `gateIdentity`, край (подписанный ассерт на
// каждый запрос, как nginx после auth_request), прокси Studio и клиент
// ControlApiClient — первый вход и перезагрузка.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { signGateIdentityAssertion } from "../../server/dist/gate-auth-identity.js";
import { ControlApiClient } from "../dist/src/api.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import { canEditProject, probeStudioAccess } from "../dist/src/access.js";

const ORIGIN = "http://studio.example";
const GATE_SECRET = "g".repeat(48);
const OWNER_TG = "332664273";
const OWNER_ID = `telegram:${OWNER_TG}`;

async function setup(t) {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  const control = createControlHttpServer({
    store,
    auth: {
      security,
      allowedOrigins: [ORIGIN],
      secureCookies: false,
      gateIdentity: { secret: GATE_SECRET }
    }
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const studioOrigin = `http://127.0.0.1:${studioAddress.port}`;

  t.after(async () => {
    await studio.close();
    await control.close();
  });

  /** Край: подтверждённая сессия gate даёт подписанный ассерт на каждый запрос. */
  const gateHeader = () => signGateIdentityAssertion({
    telegramId: OWNER_TG,
    username: "tg_user4273",
    issuedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000
  }, GATE_SECRET);

  /** Браузер: cookie-банка живёт между перезагрузками, CSRF — только в памяти вкладки. */
  const createBrowser = (withGate) => {
    const state = { cookie: null };
    const fetchImpl = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      if (state.cookie) headers.set("cookie", state.cookie);
      if (withGate) headers.set("x-lhc-gate-identity", gateHeader());
      const response = await fetch(new URL(String(input), studioOrigin), { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie !== null) state.cookie = setCookie.split(";", 1)[0];
      return response;
    };
    return { state, api: new ControlApiClient(fetchImpl) };
  };

  return { store, security, createBrowser };
}

test("FIN-06 gate: перезагрузка вкладки Studio не запирает владельца вне правок", async (t) => {
  const { createBrowser } = await setup(t);

  // Первый вход: сессии Control ещё нет, личность приходит ассертом gate.
  const browser = createBrowser(true);
  const initial = await probeStudioAccess(browser.api);
  assert.equal(initial.mode, "authenticated");
  assert.equal(initial.mutationProof, true, "первый вход получает подтверждение обменом");
  assert.match(String(browser.state.cookie ?? ""), /^lh_control_session=/);
  const created = await browser.api.createProject({ projectId: "project", title: "Проект" });
  assert.equal(created.role, "owner");

  // Перезагрузка: cookie жива, подтверждение в памяти вкладки потеряно.
  const reloaded = createBrowser(true);
  reloaded.state.cookie = browser.state.cookie;
  const afterReload = await probeStudioAccess(reloaded.api);
  assert.equal(afterReload.mode, "authenticated");
  assert.equal(afterReload.mutationProof, true, "перезагрузка возвращает подтверждение без пароля");
  const project = { projectId: "project", title: "Проект", role: "owner" };
  assert.equal(canEditProject(afterReload, project), true, "владелец снова может править");
  const second = await reloaded.api.createProject({ projectId: "project-two", title: "Второй" });
  assert.equal(second.role, "owner", "мутация после перезагрузки проходит с новым подтверждением");
});

test("FIN-06 gate: без ассерта края сессия не выдаётся вовсе (fail closed)", async (t) => {
  const { createBrowser } = await setup(t);

  const browser = createBrowser(true);
  await probeStudioAccess(browser.api);

  // Тот же браузер, но край больше не подтверждает личность: cookie-сессия
  // Control без ассерта не принимается, и Studio не выдумывает подтверждение.
  const withoutGate = createBrowser(false);
  withoutGate.state.cookie = browser.state.cookie;
  const reloaded = await probeStudioAccess(withoutGate.api);
  assert.equal(reloaded.mode, "anonymous");
  assert.equal(reloaded.mutationProof, false);
  assert.equal(canEditProject(reloaded, { projectId: "project", title: "Проект", role: "owner" }), false);
});
