import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { LocalAuthorProvider } from "../dist/src/local-author-provider.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";

// Дефект: прокси-лимит тела 262144 Б применялся и к маршруту /imports, поэтому
// импорт реального .lhquest.zip (JSON с archiveBase64 > 256 КиБ) падал 413.
const IMPORT_PAYLOAD_BYTES = 400 * 1024; // заметно больше общего лимита 262144
const GENERAL_LIMIT_BYTES = 262_144;

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ?? null;
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: options.method ?? "GET",
      headers: { ...(options.headers ?? {}) }
    });
    req.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function startStub(seen) {
  const stub = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url, bytes: Buffer.concat(chunks).byteLength });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", () => resolve({ stub, port: stub.address().port }));
  });
}

test("M03 Studio proxy lets /imports carry mission archives past the JSON limit without widening other routes", async () => {
  const seen = [];
  const { stub, port: stubPort } = await startStub(seen);
  const provider = new LocalAuthorProvider(async () => {
    throw new Error("upstream must not be called");
  });
  const studio = createStudioDevServer({
    controlOrigin: `http://127.0.0.1:${stubPort}`,
    authorProvider: provider
  });
  const studioPort = await studio.listen(0, "127.0.0.1").then((value) => value.port);
  try {
    const payload = Buffer.alloc(IMPORT_PAYLOAD_BYTES, 7);

    const imported = await request(studioPort, "/control/v1/projects/project/imports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(payload.byteLength),
        "idempotency-key": "proxy-import-1"
      },
      body: payload
    });
    assert.equal(imported.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].bytes, payload.byteLength);

    // Общий лимит для остальных маршрутов не ослаблен.
    const blocked = await request(studioPort, "/control/v1/projects/project/draft/changes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(payload.byteLength),
        "idempotency-key": "proxy-draft-1"
      },
      body: payload
    });
    assert.equal(blocked.status, 413);
    assert.equal(seen.length, 1);

    // Ровно общий лимит на обычном маршруте по-прежнему проходит.
    const atLimit = Buffer.alloc(GENERAL_LIMIT_BYTES, 3);
    const allowed = await request(studioPort, "/control/v1/projects/project/draft/changes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(atLimit.byteLength),
        "idempotency-key": "proxy-draft-2"
      },
      body: atLimit
    });
    assert.equal(allowed.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].bytes, atLimit.byteLength);
  } finally {
    await studio.close();
    await new Promise((resolve) => stub.close(resolve));
  }
});
