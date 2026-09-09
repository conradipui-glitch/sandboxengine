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
    const req = createServerRequest(port, path, { ...options, body });
    let responseBody = "";
    req.on("response", (response) => {
      response.setEncoding("utf8");
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

function createServerRequest(port, path, options) {
  const { body, ...requestOptions } = options;
  return httpRequest({
    host: "127.0.0.1",
    port,
    path,
    method: "GET",
    ...requestOptions,
    headers: { ...(requestOptions.headers ?? {}) }
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

test("L01 local Control and Studio proxy fail closed for foreign origin, fake Host and oversized JSON", async () => {
  const store = new MemoryControlStore();
  const control = createControlHttpServer({ store });
  const controlPort = await control.listen(0, "127.0.0.1").then((value) => value.port);
  const upstreamCalls = [];
  const upstream = createServer((req, res) => {
    upstreamCalls.push(req.url);
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const provider = new LocalAuthorProvider(async () => {
    throw new Error("upstream must not be called by rejected settings");
  });
  const studio = createStudioDevServer({
    controlOrigin: `http://127.0.0.1:${controlPort}`,
    authorProvider: provider
  });
  const studioPort = await studio.listen(0, "127.0.0.1").then((value) => value.port);
  const settings = {
    preset: "compatible",
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    model: "test-model",
    credential: "secret"
  };
  const jsonHeaders = { "content-type": "application/json", "x-lh-local-settings": "1" };

  try {
    const allowed = await request(studioPort, "/local/author-provider", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify(settings)
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.configured, true);
    assert.equal(Object.hasOwn(allowed.body.settings, "credential"), false);

    const unknownField = await request(studioPort, "/local/author-provider", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ ...settings, unknown: true })
    });
    assert.equal(unknownField.status, 400);
    assert.equal((await request(studioPort, "/local/author-provider")).body.settings.model, "test-model");

    const forbiddenUrl = await request(studioPort, "/local/author-provider", {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ ...settings, baseUrl: "http://169.254.169.254/v1" })
    });
    assert.equal(forbiddenUrl.status, 400);
    assert.equal((await request(studioPort, "/local/author-provider")).body.settings.model, "test-model");

    const unknownMethod = await request(studioPort, "/control/v1/projects", {
      method: "PATCH", headers: { origin: `http://127.0.0.1:${studioPort}` }
    });
    assert.equal(unknownMethod.status, 405);
    assert.deepEqual(upstreamCalls, []);

    const foreignSettings = await request(studioPort, "/local/author-provider", {
      method: "POST", headers: { ...jsonHeaders, origin: "https://evil.example" }, body: JSON.stringify({ ...settings, model: "evil" })
    });
    assert.equal(foreignSettings.status, 403);
    assert.equal((await request(studioPort, "/local/author-provider")).body.settings.model, "test-model");

    const fakeHost = await request(studioPort, "/local/author-provider", {
      method: "POST", headers: { ...jsonHeaders, host: `evil.example:${studioPort}` }, body: JSON.stringify({ ...settings, model: "evil-host" })
    });
    assert.equal(fakeHost.status, 403);

    const proxyForeign = await request(studioPort, "/control/v1/projects", {
      method: "GET", headers: { origin: "https://evil.example" }
    });
    assert.equal(proxyForeign.status, 403);
    assert.deepEqual(upstreamCalls, []);

    const tooLarge = await request(studioPort, "/control/v1/projects", {
      method: "POST",
      headers: { ...jsonHeaders, "content-length": String(262_145) },
      body: "x".repeat(262_145)
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(upstreamCalls, []);

    const directForeign = await request(controlPort, "/control/v1/projects", {
      method: "POST",
      headers: { ...jsonHeaders, origin: "https://evil.example" },
      body: JSON.stringify({ projectId: "evil", title: "Evil" })
    });
    assert.equal(directForeign.status, 403);
    assert.equal((await store.listProjects()).length, 0);

    const directCrossSiteNoOrigin = await request(controlPort, "/control/v1/projects", {
      method: "POST",
      headers: { ...jsonHeaders, "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ projectId: "cross-site", title: "Cross site" })
    });
    assert.equal(directCrossSiteNoOrigin.status, 403);
    assert.equal((await store.listProjects()).length, 0);

    const directFakeHost = await request(controlPort, "/control/v1/projects", {
      method: "POST",
      headers: { ...jsonHeaders, host: `evil.example:${controlPort}` },
      body: JSON.stringify({ projectId: "fake-host", title: "Fake host" })
    });
    assert.equal(directFakeHost.status, 403);
    assert.equal((await store.listProjects()).length, 0);

    const directTooLarge = await request(controlPort, "/control/v1/projects", {
      method: "POST",
      headers: { ...jsonHeaders, "content-length": String(262_145) },
      body: "x".repeat(262_145)
    });
    assert.equal(directTooLarge.status, 413);
    assert.equal((await store.listProjects()).length, 0);

    const allowedDirect = await request(controlPort, "/control/v1/projects", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ projectId: "cli", title: "CLI" })
    });
    assert.equal(allowedDirect.status, 201);
    assert.equal((await store.listProjects()).length, 1);
  } finally {
    await studio.close();
    await control.close();
    await close(upstream);
  }
});
