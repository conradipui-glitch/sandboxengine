// FIN-07.a — серверное защищённое хранилище подключений ИИ-провайдеров.
//
// Покрывает: безопасное чтение (ключ наружу не уходит), CAS по ревизии,
// идемпотентность по Idempotency-Key, оба хранилища по одному интерфейсу,
// права 0600 на файл SQLite, испорченную строку БД и классификацию проверки
// соединения против ЛОКАЛЬНОГО стаб-сервера на 127.0.0.1 (внешних запросов и
// реальных ключей нет).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_CONNECTION_DB_FILE_MODE,
  MemoryControlProviderConnectionStore,
  SQLiteControlProviderConnectionStore,
  maskProviderApiKey,
  probeProviderConnection
} from "../dist/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const KEY = "sk-test-0000abcd";
const MASK = "sk-…abcd";

function saveInput(overrides = {}) {
  return {
    projectId: "project",
    userId: "owner",
    expectedRevision: null,
    providerPreset: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat",
    apiKey: KEY,
    idempotencyKey: "save-1",
    requestHash: HASH_A,
    updatedAtMs: 1000,
    ...overrides
  };
}

function stateInput(overrides = {}) {
  return {
    projectId: "project",
    userId: "owner",
    expectedRevision: 1,
    status: "connected",
    lastErrorCode: null,
    idempotencyKey: "state-1",
    requestHash: HASH_A,
    updatedAtMs: 2000,
    ...overrides
  };
}

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), "fin07-provider-"));
  const path = join(directory, "providers.sqlite");
  try {
    return await run(path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function withServer(handler, run) {
  const sockets = new Set();
  const server = createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run({ port, origin: `http://127.0.0.1:${port}` });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

test("FIN-07 memory: чтение не возвращает ключ, revealApiKey отдаёт сырой ключ", async () => {
  const store = new MemoryControlProviderConnectionStore();
  const saved = await store.saveConnection(saveInput());
  assert.equal(saved.kind, "saved");
  assert.equal(saved.connection.hasKey, true);
  assert.equal(saved.connection.apiKeyMask, MASK);
  assert.equal(saved.connection.status, "settings_saved");
  assert.equal(saved.connection.lastErrorCode, null);
  assert.equal(saved.connection.revision, 1);
  assert.ok(!("apiKey" in saved.connection), "в summary не должно быть поля apiKey");

  const view = await store.getConnection("project", "owner");
  assert.equal(JSON.stringify(view).includes(KEY), false, "сериализация чтения не содержит ключ");
  assert.equal(view.apiKeyMask, MASK);
  assert.equal(maskProviderApiKey(KEY), MASK);

  assert.equal(await store.revealApiKey({ projectId: "project", userId: "owner" }), KEY, "внутренний доступ к ключу работает");
});

test("FIN-07 memory: CAS по ревизии — устаревшая ревизия и создание поверх существующей дают revision_conflict", async () => {
  const store = new MemoryControlProviderConnectionStore();
  assert.equal((await store.saveConnection(saveInput())).kind, "saved");

  // Creating again while a record exists: expectedRevision null conflicts.
  const duplicate = await store.saveConnection(saveInput({ idempotencyKey: "save-2" }));
  assert.deepEqual([duplicate.kind, duplicate.currentRevision], ["revision_conflict", 1]);

  // Stale revision from a concurrent writer.
  const stale = await store.saveConnection(saveInput({ idempotencyKey: "save-3", expectedRevision: 5 }));
  assert.deepEqual([stale.kind, stale.currentRevision], ["revision_conflict", 1]);

  // Correct revision advances.
  const updated = await store.saveConnection(saveInput({ idempotencyKey: "save-4", expectedRevision: 1, requestHash: HASH_B }));
  assert.deepEqual([updated.kind, updated.connection.revision], ["saved", 2]);

  // State update against a stale revision is refused; unknown record is not_found.
  const staleState = await store.updateConnectionState(stateInput({ expectedRevision: 1, idempotencyKey: "state-stale" }));
  assert.deepEqual([staleState.kind, staleState.currentRevision], ["revision_conflict", 2]);
  const made = await store.updateConnectionState(stateInput({ expectedRevision: 2, idempotencyKey: "state-ok" }));
  assert.deepEqual([made.kind, made.connection.status, made.connection.revision], ["updated", "connected", 3]);
  const missing = await store.updateConnectionState(stateInput({ userId: "someone", idempotencyKey: "state-miss" }));
  assert.equal(missing.kind, "not_found");
});

test("FIN-07 memory: идемпотентность — тот же ключ реиграет, другой запрос с тем же ключом отклоняется", async () => {
  const store = new MemoryControlProviderConnectionStore();
  const first = await store.saveConnection(saveInput());
  assert.equal(first.kind, "saved");

  const replay = await store.saveConnection(saveInput());
  assert.deepEqual([replay.kind, replay.connection.revision], ["replay", 1]);
  assert.deepEqual(replay.connection, first.connection);

  const reused = await store.saveConnection(saveInput({ requestHash: HASH_B }));
  assert.equal(reused.kind, "idempotency_key_reused");

  // A different idempotency key is a new write and honours CAS.
  const fresh = await store.saveConnection(saveInput({ idempotencyKey: "save-2", requestHash: HASH_B, expectedRevision: 1 }));
  assert.deepEqual([fresh.kind, fresh.connection.revision], ["saved", 2]);
});

test("FIN-07 memory: чужой проект и чужой пользователь не читают и не раскрывают ключ", async () => {
  const store = new MemoryControlProviderConnectionStore();
  await store.saveConnection(saveInput());
  assert.equal(await store.getConnection("other", "owner"), null, "чужой проект закрыт");
  assert.equal(await store.getConnection("project", "stranger"), null, "чужой пользователь закрыт");
  assert.equal(await store.revealApiKey({ projectId: "other", userId: "owner" }), null, "чужой проект не раскрывает ключ");
  assert.equal(await store.revealApiKey({ projectId: "project", userId: "stranger" }), null, "чужой пользователь не раскрывает ключ");
  assert.notEqual(await store.getConnection("project", "owner"), null);
});

test("FIN-07 memory: граничные случаи входа — пустой/длинный ключ, baseUrl, статус ошибки", async () => {
  const store = new MemoryControlProviderConnectionStore();
  assert.equal((await store.saveConnection(saveInput({ apiKey: "" }))).kind, "invalid_request", "пустой ключ отклоняется");
  assert.equal((await store.saveConnection(saveInput({ apiKey: "k".repeat(4097) }))).kind, "invalid_request", "слишком длинный ключ отклоняется");
  assert.equal((await store.saveConnection(saveInput({ baseUrl: "ftp://example.com" }))).kind, "invalid_request");
  assert.equal((await store.saveConnection(saveInput({ baseUrl: "" }))).kind, "invalid_request");
  assert.equal((await store.saveConnection(saveInput({ model: "" }))).kind, "invalid_request");
  assert.equal((await store.saveConnection(saveInput({ requestHash: "not-a-hash" }))).kind, "invalid_request");

  await store.saveConnection(saveInput());
  // «error» требует код; успешные состояния не должны нести код.
  assert.equal((await store.updateConnectionState(stateInput({ status: "error", lastErrorCode: null }))).kind, "invalid_request");
  assert.equal((await store.updateConnectionState(stateInput({ status: "connected", lastErrorCode: "timeout" }))).kind, "invalid_request");
  const errorState = await store.updateConnectionState(stateInput({ status: "error", lastErrorCode: "auth_required", idempotencyKey: "state-err" }));
  assert.deepEqual([errorState.kind, errorState.connection.status, errorState.connection.lastErrorCode], ["updated", "error", "auth_required"]);
});

test("FIN-07 memory: состояние соединения после ошибки не содержит подстроки ключа", async () => {
  const store = new MemoryControlProviderConnectionStore();
  await store.saveConnection(saveInput());
  const failed = await store.updateConnectionState(stateInput({ status: "error", lastErrorCode: "network", idempotencyKey: "state-err" }));
  assert.equal(failed.kind, "updated");
  assert.equal(JSON.stringify(failed).includes(KEY), false, "ответ не содержит ключ");
  const view = await store.getConnection("project", "owner");
  assert.equal(JSON.stringify(view).includes(KEY), false, "состояние соединения не содержит ключ");
  assert.equal(view.status, "error");
  assert.equal(view.lastErrorCode, "network");
});

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

test("FIN-07 sqlite: сохранение, безопасное чтение и revealApiKey переживают переоткрытие файла", async () => {
  await withDatabase(async (path) => {
    const first = new SQLiteControlProviderConnectionStore({ path });
    assert.equal((await first.saveConnection(saveInput())).kind, "saved");
    assert.equal(await first.revealApiKey({ projectId: "project", userId: "owner" }), KEY, "ключ действительно сохранён");
    first.close();

    const reopened = new SQLiteControlProviderConnectionStore({ path });
    try {
      const view = await reopened.getConnection("project", "owner");
      assert.equal(view.apiKeyMask, MASK);
      assert.equal(view.hasKey, true);
      assert.equal(JSON.stringify(view).includes(KEY), false, "чтение из БД не отдаёт ключ");
      assert.equal(await reopened.revealApiKey({ projectId: "project", userId: "owner" }), KEY);
      assert.equal(await reopened.getConnection("other", "owner"), null);
      assert.equal(await reopened.revealApiKey({ projectId: "project", userId: "stranger" }), null);
    } finally {
      reopened.close();
    }
  });
});

test("FIN-07 sqlite: идемпотентность и CAS по ревизии переживают переоткрытие файла", async () => {
  await withDatabase(async (path) => {
    const first = new SQLiteControlProviderConnectionStore({ path });
    assert.equal((await first.saveConnection(saveInput())).kind, "saved");
    first.close();

    const reopened = new SQLiteControlProviderConnectionStore({ path });
    try {
      const replay = await reopened.saveConnection(saveInput());
      assert.deepEqual([replay.kind, replay.connection.revision], ["replay", 1], "повтор с тем же ключом реиграет после переоткрытия");
      assert.equal((await reopened.saveConnection(saveInput({ requestHash: HASH_B }))).kind, "idempotency_key_reused");

      const stale = await reopened.saveConnection(saveInput({ idempotencyKey: "save-2", expectedRevision: 9 }));
      assert.deepEqual([stale.kind, stale.currentRevision], ["revision_conflict", 1]);
      const advanced = await reopened.saveConnection(saveInput({ idempotencyKey: "save-3", expectedRevision: 1, requestHash: HASH_B }));
      assert.deepEqual([advanced.kind, advanced.connection.revision], ["saved", 2]);

      const db = new DatabaseSync(path);
      try {
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM control_provider_connections").get().n, 1, "CAS не создаёт дубликатов");
      } finally {
        db.close();
      }
    } finally {
      reopened.close();
    }
  });
});

test("FIN-07 sqlite: файл БД создаётся с правами 0600", { skip: process.platform === "win32" ? "NTFS не выражает POSIX-биты прав; строгая проверка выполняется на Linux/macOS" : false }, async () => {
  await withDatabase(async (path) => {
    const store = new SQLiteControlProviderConnectionStore({ path });
    try {
      assert.equal(statSync(path).mode & 0o777, PROVIDER_CONNECTION_DB_FILE_MODE);
    } finally {
      store.close();
    }
    // Повторное открытие не ослабляет права.
    const second = new SQLiteControlProviderConnectionStore({ path });
    try {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      second.close();
    }
  });
});

test("FIN-07 sqlite: испорченная строка БД читается как честная ошибка и не перезаписывается", async () => {
  await withDatabase(async (path) => {
    const store = new SQLiteControlProviderConnectionStore({ path });
    assert.equal((await store.saveConnection(saveInput())).kind, "saved");
    store.close();

    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE control_provider_connections SET provider_preset = ''").run();
    } finally {
      db.close();
    }

    const reopened = new SQLiteControlProviderConnectionStore({ path });
    try {
      await assert.rejects(() => reopened.getConnection("project", "owner"), /corrupt provider connection record/);
      await assert.rejects(() => reopened.revealApiKey({ projectId: "project", userId: "owner" }), /corrupt provider connection record/);
    } finally {
      reopened.close();
    }

    const check = new DatabaseSync(path);
    try {
      const row = check.prepare("SELECT provider_preset, api_key FROM control_provider_connections").get();
      assert.deepEqual([row.provider_preset, row.api_key], ["", KEY], "испорченная строка не была «починена» и ключ не потерян");
    } finally {
      check.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Проверка соединения (локальный стаб-сервер)
// ---------------------------------------------------------------------------

test("FIN-07 probe: успешный ответ стаб-сервера → connected, ключ уходит только в заголовке", async () => {
  let seenAuthorization = null;
  await withServer((request, response) => {
    seenAuthorization = request.headers.authorization ?? null;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "model-1" }] }));
  }, async ({ origin }) => {
    const outcome = await probeProviderConnection(
      { baseUrl: origin, model: "model-1", apiKey: KEY },
      fetch,
      { timeoutMs: 2000 }
    );
    assert.deepEqual([outcome.kind, outcome.httpStatus], ["connected", 200]);
    assert.equal(typeof outcome.latencyMs, "number");
    assert.equal(JSON.stringify(outcome).includes(KEY), false, "результат проверки не содержит ключ");
  });
  assert.equal(seenAuthorization, `Bearer ${KEY}`, "ключ передаётся только в заголовке Authorization");
});

test("FIN-07 probe: 401/403 → auth_required, 429 → rate_limited, 5xx → backend_error", async () => {
  for (const [status, kind] of [[401, "auth_required"], [403, "auth_required"], [429, "rate_limited"], [500, "backend_error"], [400, "backend_error"]]) {
    await withServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "stub" }));
    }, async ({ origin }) => {
      const outcome = await probeProviderConnection({ baseUrl: origin, model: "model-1", apiKey: KEY }, fetch, { timeoutMs: 2000 });
      assert.deepEqual([outcome.kind, outcome.httpStatus], [kind, status], `статус ${status}`);
    });
  }
});

test("FIN-07 probe: нечитаемый JSON → invalid_response, таймаут → timeout, закрытый порт → network", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("this is not json");
  }, async ({ origin }) => {
    const outcome = await probeProviderConnection({ baseUrl: origin, model: "model-1", apiKey: KEY }, fetch, { timeoutMs: 2000 });
    assert.equal(outcome.kind, "invalid_response");
  });

  await withServer(() => { /* никогда не отвечает */ }, async ({ origin }) => {
    const outcome = await probeProviderConnection({ baseUrl: origin, model: "model-1", apiKey: KEY }, fetch, { timeoutMs: 150 });
    assert.deepEqual([outcome.kind, outcome.httpStatus], ["timeout", null]);
  });

  // Свободный, но уже закрытый порт → сеть.
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const value = probe.address().port;
      probe.close(() => resolve(value));
    });
  });
  const outcome = await probeProviderConnection(
    { baseUrl: `http://127.0.0.1:${port}`, model: "model-1", apiKey: KEY },
    fetch,
    { timeoutMs: 2000 }
  );
  assert.equal(outcome.kind, "network");
});

test("FIN-07 probe: некорректная цель → backend_error, ключ не попадает в результат", async () => {
  const outcome = await probeProviderConnection({ baseUrl: "not-a-url", model: "model-1", apiKey: KEY }, fetch, { timeoutMs: 100 });
  assert.deepEqual([outcome.kind, outcome.httpStatus], ["backend_error", null]);
  assert.equal(JSON.stringify(outcome).includes(KEY), false);
});
