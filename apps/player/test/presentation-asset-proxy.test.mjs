import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAssetStore, ingestAsset } from "@living-history/assets";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "@living-history/runtime";
import { createMinimalPaintTemplate, createRuntimeHttpServer } from "../../server/dist/server.js";
import { createPlayerDevServer } from "../dist/src/dev-server.js";

const metadata = Object.freeze({
  templateId: "minimal-paint",
  playtestId: "asset-proxy-test",
  questTitle: "Тест",
  locationTitle: "Мастерская",
  sceneText: "Сцена",
  resourceId: "blue_paint",
  resourceTitle: "Краска",
  resourceUnit: "portion",
  actionId: "paint",
  actionTitle: "Рисовать"
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "lhe-presentation-asset-proxy-"));
  const dbPath = join(directory, "runtime.sqlite");
  const assetRoot = join(directory, "assets");
  const rawStorage = new SQLiteRuntimeStorage({ path: dbPath, clock: new ManualServiceClock(10_000) });
  const guestAccess = new SQLiteGuestSessionAccess({ path: dbPath });
  const runtime = createRuntimeHttpServer({
    storage: rawStorage,
    guestAccess,
    templates: [createMinimalPaintTemplate()],
    createSessionId: () => "asset-session",
    createCredential: () => "A".repeat(32)
  });
  const runtimeAddress = await runtime.listen();

  const assetStore = new LocalAssetStore(assetRoot);
  const record = await ingestAsset(assetStore, {
    assetId: "workshop-bg",
    bytes: png(4, 3),
    claimedMimeType: "image/png",
    originalFilename: "workshop.png",
    altText: "Мастерская"
  });
  const player = createPlayerDevServer({
    runtimeOrigin: `http://${runtimeAddress.host}:${runtimeAddress.port}`,
    metadata,
    presentation: {
      assets: [record.manifest],
      initialForSession: () => null,
      assetReader: assetStore
    }
  });
  const playerAddress = await player.listen();
  t.after(async () => {
    await player.close();
    await runtime.close();
    guestAccess.close();
    rawStorage.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    baseUrl: `http://${playerAddress.host}:${playerAddress.port}`,
    record
  };
}

test("B07-04 presentation asset route requires guest auth and exact registered assetId+hash", async (t) => {
  const { baseUrl, record } = await fixture(t);
  const created = await (await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: "minimal-paint" })
  })).json();
  const assetUrl = `${baseUrl}/v1/sessions/${created.sessionId}/assets/${record.manifest.id}/${record.manifest.hash}`;

  const unauthenticated = await fetch(assetUrl);
  assert.equal(unauthenticated.status, 404, "asset existence is not disclosed without session credential");

  const exact = await fetch(assetUrl, {
    headers: { authorization: `Bearer ${created.credential}` }
  });
  assert.equal(exact.status, 200);
  assert.equal(exact.headers.get("content-type"), "image/png");
  assert.match(exact.headers.get("cache-control") ?? "", /immutable/);
  assert.deepEqual(new Uint8Array(await exact.arrayBuffer()), png(4, 3));

  const wrongHash = `${"f".repeat(64)}` === record.manifest.hash ? "e".repeat(64) : "f".repeat(64);
  const wrong = await fetch(
    `${baseUrl}/v1/sessions/${created.sessionId}/assets/${record.manifest.id}/${wrongHash}`,
    { headers: { authorization: `Bearer ${created.credential}` } }
  );
  assert.equal(wrong.status, 404, "same assetId never falls through to another immutable version");

  const traversal = await fetch(
    `${baseUrl}/v1/sessions/${created.sessionId}/assets/..%2Fsecret/${record.manifest.hash}`,
    { headers: { authorization: `Bearer ${created.credential}` } }
  );
  assert.equal(traversal.status, 404);
});

test("B07-04 wrong session credential cannot read another session asset", async (t) => {
  const { baseUrl, record } = await fixture(t);
  const created = await (await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: "minimal-paint" })
  })).json();
  const response = await fetch(
    `${baseUrl}/v1/sessions/${created.sessionId}/assets/${record.manifest.id}/${record.manifest.hash}`,
    { headers: { authorization: `Bearer ${"B".repeat(32)}` } }
  );
  assert.equal(response.status, 404);
});

function png(width, height) {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeU32BE(bytes, 8, 13);
  writeAscii(bytes, 12, "IHDR");
  writeU32BE(bytes, 16, width);
  writeU32BE(bytes, 20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  writeU32BE(bytes, 33, 0);
  writeAscii(bytes, 37, "IEND");
  return bytes;
}
function writeAscii(bytes, offset, value) {
  for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i);
}
function writeU32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
