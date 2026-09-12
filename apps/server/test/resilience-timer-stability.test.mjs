// Регрессия: сбой стора в фоновом тике presence/editing-lock не должен ронять
// процесс (unhandled rejection) и не должен останавливать тики навсегда.
// Мутация: вернуть `void advance()` вместо `advance().catch(...)` → тест краснеет.
import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceOnlyHttpServer } from "../dist/presence.js";
import { createEditingLockOnlyHttpServer } from "../dist/editing-lock.js";

const ORIGIN = "https://studio.example";

function flakySecurity(state) {
  return {
    async getSessionByTokenHash() {
      if (state.fail) throw new Error("SQLITE_BUSY: database is locked");
      return { sessionId: "sess-1", userId: "u1" };
    },
    async getUser() { return { userId: "u1", username: "u1.user" }; },
    async getProjectRole() { return "editor"; },
    async validateSessionCsrf() { return true; }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

test("presence: сбой стора в таймере не даёт unhandled rejection и тики продолжаются", async (t) => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(String((reason && reason.message) || reason));
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));

  const state = { fail: false };
  const service = createPresenceOnlyHttpServer({
    security: flakySecurity(state),
    allowedOrigins: [ORIGIN],
    requireCsrf: false,
    clockIntervalMs: 20,
    revalidateIntervalMs: 0,
    heartbeatIntervalMs: 30,
    participantTtlMs: 60_000
  });
  const address = await service.listen();
  const url = `http://${address.host}:${address.port}/control/v1/projects/project/quests/quest/presence/stream`;
  const response = await fetch(url, {
    headers: { origin: ORIGIN, cookie: `lh_control_session=${"a".repeat(64)}` }
  });
  assert.equal(response.status, 200);

  let text = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  })();
  pump.catch(() => {});
  t.after(() => { reader.cancel().catch(() => {}); service.close(); });

  const countPings = () => (text.match(/"type":"ping"/g) ?? []).length;

  await waitFor(() => countPings() > 0);
  assert.ok(countPings() > 0, "здоровый таймер обязан слать heartbeat");
  assert.equal(rejections.length, 0);

  // Стор начинает бросать: таймер продолжает тикать, но тик падает.
  state.fail = true;
  await sleep(140);
  const pingsDuringFailure = countPings();
  assert.equal(rejections.length, 0, `unhandled rejections: ${JSON.stringify(rejections.slice(0, 2))}`);
  assert.ok(service.clockState.tickFailures > 0, "сбой стора должен фиксироваться в счётчике");
  assert.equal(service.clockState.lastTickErrorMessage, "SQLITE_BUSY: database is locked");

  // Стор восстановился: тики снова доходят до heartbeat.
  state.fail = false;
  const resumed = await waitFor(() => countPings() > pingsDuringFailure, 1000);
  assert.ok(resumed, "после восстановления стора тики должны продолжаться");
  assert.equal(rejections.length, 0);
});

test("editing-lock: сбой стора в таймере не даёт unhandled rejection и тики продолжаются", async (t) => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(String((reason && reason.message) || reason));
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));

  const state = { fail: false };
  const service = createEditingLockOnlyHttpServer({
    security: flakySecurity(state),
    allowedOrigins: [ORIGIN],
    requireCsrf: false,
    clockIntervalMs: 20,
    revalidateIntervalMs: 0
  });
  const address = await service.listen();
  const base = `http://${address.host}:${address.port}`;
  const headers = {
    origin: ORIGIN,
    cookie: `lh_control_session=${"a".repeat(64)}`,
    "content-type": "application/json"
  };
  const acquire = await fetch(`${base}/control/v1/projects/project/locks`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "acquire", kind: "board", targetId: "board-main" })
  });
  assert.equal(acquire.status, 200);
  await acquire.text();
  assert.equal(service.hub.leaseCount, 1);
  t.after(() => service.close());

  await sleep(80);
  assert.equal(rejections.length, 0);
  assert.ok(service.clockState.ticks > 0, "таймер обязан тикать при активной аренде");

  state.fail = true;
  await sleep(140);
  assert.equal(rejections.length, 0, `unhandled rejections: ${JSON.stringify(rejections.slice(0, 2))}`);
  const failuresDuringFailure = service.clockState.tickFailures;
  assert.ok(failuresDuringFailure > 0, "сбой стора должен фиксироваться в счётчике");
  assert.equal(service.hub.leaseCount, 1, "аренда не должна теряться из-за сбоя стора");

  state.fail = false;
  const ticksBefore = service.clockState.ticks;
  const ticksResumed = await waitFor(() => service.clockState.ticks > ticksBefore + 2, 1000);
  assert.ok(ticksResumed, "после восстановления стора тики должны продолжаться");
  assert.equal(service.clockState.tickFailures, failuresDuringFailure, "после восстановления сбоев больше нет");
  assert.equal(rejections.length, 0);
});
