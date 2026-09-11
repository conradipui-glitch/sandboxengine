import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";

import { createStudioDevServer } from "../dist/src/dev-server.js";

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
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startStub() {
  const seen = [];
  const stub = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url, bytes: Buffer.concat(chunks).byteLength });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", resolve);
  });
  return { stub, seen, port: stub.address().port };
}

// 400 044 символа — реальный .lhquest.zip (base64 с ресурсами) из ревью заведомо
// больше общего JSON-лимита 262 144 Б (ФАКТ-2).
const IMPORT_PAYLOAD_BYTES = 400_044;

test("Studio proxy /imports accepts archives past the general JSON body limit", async () => {
  const { stub, seen, port } = await startStub();
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${port}` });
  const studioPort = await studio.listen(0, "127.0.0.1").then((value) => value.port);
  try {
    const payload = Buffer.alloc(IMPORT_PAYLOAD_BYTES, 65); // "A" — base64-подобное тело
    const imported = await request(studioPort, "/control/v1/projects/project/imports", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(payload.byteLength), "idempotency-key": "import-1" },
      body: payload
    });
    assert.equal(imported.status, 200, `import body ${payload.byteLength} must pass: ${imported.body}`);
    assert.equal(seen.length, 1, "import reached Control");
    assert.equal(seen[0].url, "/control/v1/projects/project/imports");
    assert.equal(seen[0].bytes, payload.byteLength, "full archive body forwarded");

    // обычный маршрут сохраняет прежний лимит
    const blocked = await request(studioPort, "/control/v1/projects/project/draft/changes", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(payload.byteLength), "idempotency-key": "draft-1" },
      body: payload
    });
    assert.equal(blocked.status, 413, "general route still rejects oversized bodies");
    assert.equal(seen.length, 1, "oversized general body never reached Control");
  } finally {
    await studio.close();
    await new Promise((resolve) => stub.close(resolve));
  }
});

test("Studio proxy /imports limit is configurable and bounded by the general limit", async () => {
  const { stub, seen, port } = await startStub();
  const studio = createStudioDevServer({
    controlOrigin: `http://127.0.0.1:${port}`,
    importBodyLimitBytes: 300_000
  });
  const studioPort = await studio.listen(0, "127.0.0.1").then((value) => value.port);
  try {
    const allowed = Buffer.alloc(280_000, 66);
    const ok = await request(studioPort, "/control/v1/projects/project/imports", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(allowed.byteLength) },
      body: allowed
    });
    assert.equal(ok.status, 200, "import below configured limit passes");
    assert.equal(seen.at(-1).bytes, allowed.byteLength);

    const tooBig = Buffer.alloc(320_000, 66);
    const rejected = await request(studioPort, "/control/v1/projects/project/imports", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(tooBig.byteLength) },
      body: tooBig
    });
    assert.equal(rejected.status, 413, "import above configured limit is rejected");
    assert.equal(seen.length, 1, "rejected import never reached Control");
  } finally {
    await studio.close();
    await new Promise((resolve) => stub.close(resolve));
  }
});
