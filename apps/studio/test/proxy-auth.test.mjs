import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createStudioDevServer } from "../dist/src/dev-server.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing address"));
      resolve(address.port);
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("B09-03 Studio proxy preserves session/CSRF/idempotency boundary without forwarding arbitrary headers", async () => {
  let received = null;
  const upstream = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += String(chunk);
    received = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body
    };
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("set-cookie", "lh_control_session=opaque-session; Path=/control/v1; HttpOnly; SameSite=Strict");
    response.setHeader("retry-after", "17");
    response.setHeader("access-control-allow-origin", "http://127.0.0.1:4173");
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "Origin");
    response.end(JSON.stringify({ ok: true }));
  });

  const upstreamPort = await listen(upstream);
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${upstreamPort}` });
  try {
    const studioAddress = await studio.listen(0, "127.0.0.1");
    const response = await fetch(
      `http://127.0.0.1:${studioAddress.port}/control/v1/projects/project/publish?proof=1`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "lh_control_session=browser-session",
          origin: "http://127.0.0.1:4173",
          "x-csrf-token": "csrf-proof",
          "idempotency-key": "publish-1",
          "x-not-forwarded": "secret-browser-header"
        },
        body: JSON.stringify({ releaseId: "release-1" })
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.match(response.headers.get("set-cookie"), /lh_control_session=opaque-session/);
    assert.equal(response.headers.get("retry-after"), "17");
    assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.equal(response.headers.get("vary"), "Origin");

    assert.ok(received);
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/control/v1/projects/project/publish?proof=1");
    assert.equal(received.headers["content-type"], "application/json");
    assert.equal(received.headers.cookie, "lh_control_session=browser-session");
    assert.equal(received.headers.origin, "http://127.0.0.1:4173");
    assert.equal(received.headers["x-csrf-token"], "csrf-proof");
    assert.equal(received.headers["idempotency-key"], "publish-1");
    assert.equal(received.headers["x-not-forwarded"], undefined);
    assert.deepEqual(JSON.parse(received.body), { releaseId: "release-1" });
  } finally {
    await studio.close();
    await close(upstream);
  }
});
