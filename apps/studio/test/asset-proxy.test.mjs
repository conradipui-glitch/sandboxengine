import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { LocalAuthorProvider } from "../dist/src/local-author-provider.js";
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

test("M03 Studio proxy forwards asset headers and allows asset bodies past the JSON limit", async () => {
  const seen = [];
  const stub = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        url: req.url,
        assetId: req.headers["x-asset-id"] ?? null,
        filename: req.headers["x-filename"] ?? null,
        bytes: Buffer.concat(chunks).byteLength
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", resolve);
  });
  const stubPort = stub.address().port;
  const provider = new LocalAuthorProvider(async () => {
    throw new Error("upstream must not be called");
  });
  const studio = createStudioDevServer({
    controlOrigin: `http://127.0.0.1:${stubPort}`,
    authorProvider: provider
  });
  const studioPort = await studio.listen(0, "127.0.0.1").then((value) => value.port);
  try {
    const payload = Buffer.alloc(300 * 1024, 7);
    const upload = await request(studioPort, "/control/v1/projects/project/assets", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(payload.byteLength),
        "idempotency-key": "proxy-asset-1",
        "x-asset-id": "proxy-knight",
        "x-filename": "knight.png"
      },
      body: payload
    });
    assert.equal(upload.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].assetId, "proxy-knight");
    assert.equal(seen[0].filename, "knight.png");
    assert.equal(seen[0].bytes, payload.byteLength);

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
  } finally {
    await studio.close();
    await new Promise((resolve) => stub.close(resolve));
  }
});
