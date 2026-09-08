import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { MemoryControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const req = httpRequest({
      host: "127.0.0.1", port, path, method: options.method ?? "GET",
      headers: { ...(options.headers ?? {}) }
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        body: responseBody.length === 0 ? null : JSON.parse(responseBody)
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function stubStudio(launcher) {
  const store = new MemoryControlStore();
  const control = createControlHttpServer({ store });
  return control.listen(0, "127.0.0.1").then((value) => {
    const studio = createStudioDevServer({
      controlOrigin: `http://127.0.0.1:${value.port}`,
      playerLauncher: launcher
    });
    return studio.listen(0, "127.0.0.1").then((studioAddress) => ({ studio, control, port: studioAddress.port }));
  });
}

test("L05 Studio launch endpoint: guard, unknown id, serialized single launch, repeat reuses running player", async () => {
  let launches = 0;
  const running = new Map();
  const launcher = async (playtestId) => {
    if (running.has(playtestId)) return { ok: true, url: running.get(playtestId), playtestId };
    launches += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (playtestId === "playtest-missing") return { ok: false, code: "playtest_not_found", message: "not found" };
    if (playtestId === "playtest-unsupported") return { ok: false, code: "unsupported_playtest", message: "2 actions" };
    const url = `http://127.0.0.1:91${launches}`;
    running.set(playtestId, url);
    return { ok: true, url, playtestId };
  };
  const context = await stubStudio(launcher);
  const jsonHeaders = { "content-type": "application/json", "x-lh-local-settings": "1" };
  try {
    const unsupportedMethod = await request(context.port, "/local/launch-player", { method: "GET", headers: jsonHeaders });
    assert.equal(unsupportedMethod.status, 405);

    const foreign = await request(context.port, "/local/launch-player", {
      method: "POST", headers: { ...jsonHeaders, origin: "https://evil.example" }, body: JSON.stringify({ playtestId: "playtest-1" })
    });
    assert.equal(foreign.status, 403);
    assert.equal(launches, 0);

    const invalidBody = await request(context.port, "/local/launch-player", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ wrong: true })
    });
    assert.equal(invalidBody.status, 400);

    const unknown = await request(context.port, "/local/launch-player", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ playtestId: "playtest-missing" })
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "playtest_not_found");

    const unsupported = await request(context.port, "/local/launch-player", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ playtestId: "playtest-unsupported" })
    });
    assert.equal(unsupported.status, 409);
    assert.equal(unsupported.body.error.code, "unsupported_playtest");

    const [first, concurrent] = await Promise.all([
      request(context.port, "/local/launch-player", {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ playtestId: "playtest-ok" })
      }),
      request(context.port, "/local/launch-player", {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ playtestId: "playtest-ok" })
      })
    ]);
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(concurrent.status, 200);
    assert.equal(concurrent.body.url, first.body.url);
    assert.equal(launches, 3);
  } finally {
    await context.studio.close();
    await context.control.close();
  }
});
