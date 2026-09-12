// Регрессия для двух дефектов, найденных на живом контуре 2026-09-11:
//
// 1) Продуктовая сборка Studio (apps/studio/src/main.ts) поднимала Control-сервер
//    без assetStorage/assetLibrary, поэтому ЛЮБОЙ запрос материалов отвечал
//    `501 ASSET_STORAGE_UNAVAILABLE` — библиотека материалов в интерфейсе была
//    невозможна по построению. Здесь это зафиксировано статической проверкой
//    проводки (guard) и функциональной проверкой поведения маршрута.
// 2) Текстовые поля материала (имя файла, alt-текст, источник, права) передаются
//    HTTP-заголовками, а заголовки допускают только ASCII: русское имя файла или
//    alt-текст до сервера не доезжали. Клиент кодирует такие значения
//    percent-encoding, сервер обязан раскодировать.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

async function jsonRequest(base, path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers, body });
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return { status: response.status, json: await response.json() };
  return { status: response.status, json: null };
}

async function withServer(configure, run) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-asset-headers-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const assets = new LocalAssetStore(join(dir, "objects"));
  const dependencies = { store, boardStore: store, assetStorage: assets, assetLibrary: store };
  if (configure) configure(dependencies);
  const control = createControlHttpServer(dependencies);
  try {
    assert.equal((await store.createProject({ projectId: "project", title: "Проект" })).kind, "created");
    const address = await control.listen();
    return await run({ base: `http://${address.host}:${address.port}` });
  } finally {
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function upload(base, { assetId, filename, altText, body = minimalPng(2, 2), idempotencyKey = "asset-text-1", encode = true }) {
  const encodeValue = (value) => (encode ? encodeURIComponent(value) : value);
  return jsonRequest(base, "/control/v1/projects/project/assets", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "idempotency-key": idempotencyKey,
      "x-asset-id": assetId,
      "x-claimed-mime": "image/png",
      "x-filename": encodeValue(filename),
      // alt-текст обязателен для визуальных материалов: сервер честно отвергает
      // визуал без описания (ASSET_INVALID_REQUEST).
      "x-alt-text": encodeValue(altText ?? "Описание")
    },
    body
  });
}

test("материалы: русский alt-текст и имя файла приходят percent-encoded и раскодируются", async () => {
  await withServer(null, async ({ base }) => {
    const uploaded = await upload(base, {
      assetId: "asset-blue-pigment",
      filename: "Синий пигмент.png",
      altText: "Банка синего пигмента в мастерской"
    });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.json.manifest.altText, "Банка синего пигмента в мастерской");

    const listed = await jsonRequest(base, "/control/v1/projects/project/assets?all=1");
    assert.equal(listed.status, 200);
    assert.equal(listed.json.assets[0].filename, "Синий пигмент.png");
  });
});

test("материалы: чистый ASCII не меняется (обратная совместимость)", async () => {
  await withServer(null, async ({ base }) => {
    const uploaded = await upload(base, { assetId: "asset-ascii", filename: "knight.png", altText: "Knight" });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.json.manifest.altText, "Knight");
    const listed = await jsonRequest(base, "/control/v1/projects/project/assets?all=1");
    assert.equal(listed.json.assets[0].filename, "knight.png");
  });
});

test("материалы: битое percent-кодирование не ломает запрос (значение остаётся как есть)", async () => {
  await withServer(null, async ({ base }) => {
    const uploaded = await upload(base, { assetId: "asset-broken", filename: "report%2f%zz.png", altText: "broken", encode: false });
    assert.equal(uploaded.status, 201);
    const listed = await jsonRequest(base, "/control/v1/projects/project/assets?all=1");
    assert.equal(listed.json.assets[0].filename, "report%2f%zz.png");
  });
});

test("материалы: корректное кодирование раскодируется ровно один раз", async () => {
  await withServer(null, async ({ base }) => {
    const uploaded = await upload(base, { assetId: "asset-once", filename: "report/1.png", altText: "100% готово" });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.json.manifest.altText, "100% готово");
    const listed = await jsonRequest(base, "/control/v1/projects/project/assets?all=1");
    assert.equal(listed.json.assets[0].filename, "report/1.png");
  });
});

test("материалы: без хранилища байтов маршрут честно отвечает 501 (дефект проводки Studio)", async () => {
  await withServer((dependencies) => {
    delete dependencies.assetStorage;
    delete dependencies.assetLibrary;
  }, async ({ base }) => {
    const listed = await jsonRequest(base, "/control/v1/projects/project/assets?all=1");
    assert.equal(listed.status, 501);
    assert.equal(listed.json.error.code, "ASSET_STORAGE_UNAVAILABLE");
    const uploaded = await upload(base, { assetId: "asset-nowhere", filename: "knight.png", altText: "Knight" });
    assert.equal(uploaded.status, 501);
  });
});

test("материалы: сборка Studio подключает хранилище материалов и библиотеку", async () => {
  const mainPath = fileURLToPath(new URL("../../studio/src/main.ts", import.meta.url));
  const source = await readFile(mainPath, "utf8");
  assert.match(source, /assetStorage:\s*new LocalAssetStore\(/, "Studio обязан передавать assetStorage, иначе материалы недоступны (501)");
  assert.match(source, /assetLibrary:\s*store/, "Studio обязан передавать assetLibrary");
  assert.match(source, /import \{ LocalAssetStore \} from "@living-history\/assets";/, "нужен импорт хранилища материалов");
  assert.match(source, /join, dirname, resolve/, "хранилище кладётся рядом с базой: нужен join");
});
