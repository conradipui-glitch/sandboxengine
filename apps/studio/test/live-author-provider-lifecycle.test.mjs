import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { MemoryControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { LocalAuthorProvider } from "../dist/src/local-author-provider.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: options.method ?? "GET",
      headers: { ...(options.headers ?? {}) }
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: responseBody.length === 0 ? null : JSON.parse(responseBody)
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(typeof address, "string");
  return address.port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("L03 provider lifecycle: configure, safe status, failed update, rotation, disconnect, restart, turn states", async () => {
  let upstreamCalls = 0;
  let upstreamShouldFail = true;
  const upstream = createServer((req, res) => {
    let requestBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { requestBody += chunk; });
    req.on("end", () => {
      upstreamCalls += 1;
      const payload = JSON.parse(requestBody || "{}");
      res.setHeader("content-type", "application/json");
      if (upstreamShouldFail) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: "invalid key" } }));
      } else {
        res.end(JSON.stringify({
          id: "req-1",
          model: payload.model,
          choices: [{ message: { role: "assistant", content: JSON.stringify({ explanation: "ok", changes: [], missingCapabilities: [] }) } }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
        }));
      }
    });
  });
  const upstreamPort = await listen(upstream);

  const provider = new LocalAuthorProvider();
  const store = new MemoryControlStore();
  const control = createControlHttpServer({ store });
  const controlPort = await control.listen(0, "127.0.0.1").then((value) => value.port);
  const studio = createStudioDevServer({
    controlOrigin: `http://127.0.0.1:${controlPort}`,
    authorProvider: provider
  });
  const studioPort = await studio.listen(0, "127.0.0.1").then((value) => value.port);
  const jsonHeaders = { "content-type": "application/json", "x-lh-local-settings": "1" };

  const configure = (body) => request(studioPort, "/local/author-provider", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
  const statusRead = () => request(studioPort, "/local/author-provider");
  const openAndTurn = async () => {
    const opened = await provider.backend.openSession({
      profileId: "lifecycle-test",
      deadlineAtMs: Date.now() + 10_000
    });
    assert.equal(opened.ok, true);
    return provider.backend.runTurn({
      session: opened.session,
      messages: [{ role: "user", content: "тест" }],
      maxOutputTokens: 512,
      deadlineAtMs: Date.now() + 10_000
    });
  };

  try {
    // 1. Not configured: honest "not performed", no remaining-tokens invention
    const initial = await statusRead();
    assert.equal(initial.status, 200);
    assert.equal(initial.body.configured, false);
    assert.equal(initial.body.state, "not_configured");
    assert.equal(initial.body.connectionCheck, "not_performed");
    assert.equal(initial.body.remainingTokens, null);

    // 2. Configure with a bad key: saved without any paid call
    const configured = await configure({
      preset: "compatible",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "test-model",
      credential: "bad-key"
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.configured, true);
    assert.equal(configured.body.state, "settings_saved");
    assert.equal(Object.hasOwn(configured.body.settings, "credential"), false);
    assert.equal(configured.body.connectionCheck, "not_performed");
    assert.equal(upstreamCalls, 0);

    // 3. First assistant turn hits upstream; 401 maps to auth_required; state -> error
    const failedTurn = await openAndTurn();
    assert.equal(failedTurn.ok, false);
    assert.equal(failedTurn.error.code, "auth_required");
    assert.deepEqual(failedTurn.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
    assert.equal(upstreamCalls, 1);

    const erroredStatus = await statusRead();
    assert.equal(erroredStatus.body.state, "error");
    assert.equal(erroredStatus.body.connectionCheck, "error");
    assert.equal(erroredStatus.body.lastErrorCode, "auth_required");
    assert.equal(erroredStatus.body.remainingTokens, null);

    // 4. Rotation with a working key replaces the failing configuration
    upstreamShouldFail = false;
    const reconfigured = await configure({
      preset: "compatible",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "test-model",
      credential: "good-key"
    });
    assert.equal(reconfigured.status, 200);
    assert.equal(reconfigured.body.state, "settings_saved");

    // 5. Successful turn: state -> connected, usage and request id preserved
    const goodTurn = await openAndTurn();
    assert.equal(goodTurn.ok, true);
    assert.equal(goodTurn.backendRequestId, "req-1");
    assert.deepEqual(goodTurn.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    assert.equal(upstreamCalls, 2);

    const connectedStatus = await statusRead();
    assert.equal(connectedStatus.body.state, "connected");
    assert.equal(connectedStatus.body.connectionCheck, "connected");
    assert.equal(connectedStatus.body.lastErrorCode, null);

    // 6. Failed update keeps the working configuration; no key echo
    const badUpdate = await configure({
      preset: "compatible",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "test-model",
      credential: "good-key",
      unknown: true
    });
    assert.equal(badUpdate.status, 400);
    const stillWorking = await statusRead();
    assert.equal(stillWorking.body.configured, true);
    assert.equal(stillWorking.body.state, "connected");
    assert.equal(stillWorking.body.settings.model, "test-model");
    assert.equal(JSON.stringify(stillWorking.body).includes("good-key"), false);

    // 7. Settings body limit and unsupported method
    const tooLarge = await request(studioPort, "/local/author-provider", {
      method: "POST", headers: { ...jsonHeaders, "content-length": "8193" }, body: "x".repeat(8193)
    });
    assert.equal(tooLarge.status, 413);
    const unsupported = await request(studioPort, "/local/author-provider", { method: "PATCH", headers: jsonHeaders });
    assert.equal(unsupported.status, 405);

    // 8. Disconnect: state cleared, next turn fails closed without provider
    provider.disconnect();
    const afterDisconnect = await statusRead();
    assert.equal(afterDisconnect.body.configured, false);
    assert.equal(afterDisconnect.body.state, "not_configured");
    assert.equal(afterDisconnect.body.connectionCheck, "not_performed");
    assert.equal(afterDisconnect.body.lastErrorCode, null);
    const openAfterDisconnect = await provider.backend.openSession({
      profileId: "lifecycle-test",
      deadlineAtMs: Date.now() + 10_000
    });
    assert.equal(openAfterDisconnect.ok, false);
    assert.equal(openAfterDisconnect.error.code, "auth_required");

    // 9. Restart: fresh process state requires the key again
    const restarted = new LocalAuthorProvider();
    assert.equal(restarted.status().configured, false);
    const freshOpen = await restarted.backend.openSession({
      profileId: "lifecycle-test",
      deadlineAtMs: Date.now() + 10_000
    });
    assert.equal(freshOpen.ok, false);
    assert.equal(freshOpen.error.code, "auth_required");
  } finally {
    await studio.close();
    await control.close();
    await close(upstream);
  }
});
