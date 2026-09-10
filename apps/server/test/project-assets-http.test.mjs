import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SQLiteControlStore } from "../../../packages/control/dist/index.js";
import { LocalAssetStore } from "../../../packages/assets/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  return out;
}

function minimalPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

async function raw(base, path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers, body });
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return { status: response.status, json: await response.json(), bytes: null };
  return { status: response.status, json: null, bytes: Buffer.from(await response.arrayBuffer()) };
}

test("M03 Control HTTP assets: upload/list/download PNG over the wire", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-asset-http-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const assets = new LocalAssetStore(join(dir, "objects"));
  const control = createControlHttpServer({ store, boardStore: store, assetStorage: assets, assetLibrary: store });
  try {
    assert.equal((await store.createProject({ projectId: "project", title: "Проект" })).kind, "created");
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;
    const png = minimalPng(2, 2);
    const hash = createHash("sha256").update(png).digest("hex");

    const uploaded = await raw(base, "/control/v1/projects/project/assets", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "idempotency-key": "asset-http-1",
        "x-asset-id": "hero-knight",
        "x-filename": "knight.png",
        "x-alt-text": "Knight"
      },
      body: png
    });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.json.manifest.mimeType, "image/png");
    assert.equal(uploaded.json.manifest.widthPx, 2);
    assert.equal(uploaded.json.manifest.hash, hash);

    const replay = await raw(base, "/control/v1/projects/project/assets", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "idempotency-key": "asset-http-1",
        "x-asset-id": "hero-knight",
        "x-filename": "knight.png",
        "x-alt-text": "Knight"
      },
      body: png
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.replay, true);

    const listed = await raw(base, "/control/v1/projects/project/assets");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.assets.map((entry) => entry.assetId), ["hero-knight"]);

    const downloaded = await raw(base, `/control/v1/projects/project/assets/hero-knight?hash=${hash}`);
    assert.equal(downloaded.status, 200);
    assert.ok(downloaded.bytes.equals(png));

    const unknownHash = await raw(base, `/control/v1/projects/project/assets/hero-knight?hash=${"0".repeat(64)}`);
    assert.equal(unknownHash.status, 404);

    const mismatch = await raw(base, "/control/v1/projects/project/assets", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "idempotency-key": "asset-http-2",
        "x-asset-id": "evil-page",
        "x-filename": "page.html"
      },
      body: Buffer.from("<html><script>alert(1)</script></html>", "utf8")
    });
    assert.equal(mismatch.status, 422);
    assert.equal(mismatch.json.error.code, "ASSET_UNSUPPORTED_TYPE");

    const wrongExt = await raw(base, "/control/v1/projects/project/assets", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "idempotency-key": "asset-http-3",
        "x-asset-id": "knight-jpg",
        "x-filename": "knight.jpg"
      },
      body: png
    });
    assert.equal(wrongExt.status, 422);
    assert.equal(wrongExt.json.error.code, "ASSET_EXTENSION_MISMATCH");
  } finally {
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
