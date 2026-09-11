// Регрессия: транзиентный SQLITE_BUSY в commitTurn не должен навсегда помечать
// ход как failed. Ожидание: 503 STORAGE_BUSY (повторяемо), после выздоровления
// стора тот же запрос с тем же idempotency-key проходит успешно.
// Мутация: вернуть `catch {` вместо разбора SQLiteStorageBusyError → тест краснеет.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage,
  SQLiteStorageBusyError
} from "@living-history/runtime";
import { createCoreExplicitActionExecutor } from "../dist/action-service.js";
import { createMinimalPaintTemplate, createRuntimeHttpServer } from "../dist/server.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-busy-retry-"));
  const databasePath = join(directory, "runtime.sqlite");
  const clock = new ManualServiceClock(30_000);
  const storage = new SQLiteRuntimeStorage({ path: databasePath, clock, busyTimeoutMs: 20 });
  const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath, busyTimeoutMs: 20 });
  const realExecutor = createCoreExplicitActionExecutor();
  let executionCount = 0;
  const state = { failCommit: true };
  const flakyStorage = new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === "commitTurn") {
        return async (input) => {
          if (state.failCommit) throw new SQLiteStorageBusyError("database is locked");
          return target.commitTurn(input);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const runtime = createRuntimeHttpServer({
    storage: flakyStorage,
    guestAccess,
    templates: [createMinimalPaintTemplate()],
    executor: {
      execute(sessionState, command) {
        executionCount += 1;
        return realExecutor.execute(sessionState, command);
      }
    },
    createSessionId: () => "session-busy",
    createCredential: () => "A".repeat(32),
    leaseDurationMs: 1_000
  });
  const address = await runtime.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  async function close() {
    await runtime.close();
    guestAccess.close();
    storage.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }

  return { baseUrl, storage, clock, state, close, executionCount: () => executionCount };
}

async function postAction(baseUrl, idempotencyKey) {
  const response = await fetch(`${baseUrl}/v1/sessions/session-busy/actions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      authorization: `Bearer ${"A".repeat(32)}`
    },
    body: JSON.stringify({ expectedRevision: 0, action: { type: "core.paint", units: 1 } })
  });
  return { status: response.status, body: await response.json() };
}

test("SQLITE_BUSY в commitTurn даёт повторяемый 503, а не вечный failed", async (t) => {
  const f = await fixture();
  t.after(f.close);

  const created = await fetch(`${f.baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: "minimal-paint" })
  });
  assert.equal(created.status, 201);
  await created.json();

  // 1. Стор занят на записи хода: ход не должен стать терминальным failed.
  const busy = await postAction(f.baseUrl, "turn-busy");
  assert.equal(busy.status, 503);
  assert.deepEqual(busy.body, { error: { code: "STORAGE_BUSY" } });
  assert.notEqual(busy.body.kind, "failed");
  assert.ok(f.executionCount() >= 1, "исполнение действия прошло до сбоя записи");

  // Ход не сгорел: ревизия не изменилась, операция осталась в обработке.
  const claimed = await f.storage.loadSession("session-busy");
  assert.equal(claimed.revision, 0);
  assert.notEqual(claimed.activeOperationId, null);

  // 2. Стор восстановился; после истечения аренды тот же запрос проходит честно.
  f.state.failCommit = false;
  f.clock.advanceBy(2_000);
  const retried = await postAction(f.baseUrl, "turn-busy");
  assert.equal(retried.status, 200);
  assert.equal(retried.body.kind, "action_result");
  assert.equal(retried.body.operationId, "op-1");
  assert.equal(retried.body.turnId, "turn-op-1");

  const committed = await f.storage.loadSession("session-busy");
  assert.equal(committed.revision, 1);
  assert.equal(committed.activeOperationId, null);

  // 3. Повтор уже завершённого хода — идемпотентный replay того же ответа.
  const replay = await postAction(f.baseUrl, "turn-busy");
  assert.equal(replay.status, 200);
  assert.equal(replay.body.kind, "action_result");
  assert.equal(replay.body.turnId, "turn-op-1");
});
