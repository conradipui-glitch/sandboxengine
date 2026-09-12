// COVER-01 — проектная обложка через продуктовый HTTP-маршрут.
//
// Автор выбирает только реальный image asset СВОЕГО проекта. Ссылка хранит и
// assetId, и sha256, поэтому URL остаётся привязанным к точным байтам. Запись
// оптимистична: устаревшая revision отвечает 409 и не затирает обложку.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteControlStore } from "@living-history/control";
import { LocalAssetStore } from "@living-history/assets";
import { createControlHttpServer } from "../dist/control-server.js";

const FLORENCE_ASSETS = fileURLToPath(new URL("../../../examples/florence/assets", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-project-cover-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  assert.equal((await store.createProject({ projectId: "project", title: "Проект" })).kind, "created");
  assert.equal((await store.createProject({ projectId: "other", title: "Другой проект" })).kind, "created");
  const control = createControlHttpServer({
    store,
    assetLibrary: store,
    assetStorage: new LocalAssetStore(join(dir, "objects"))
  });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  t.after(async () => {
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const upload = async (projectId, assetId, filename, key) => {
    const bytes = await readFile(join(FLORENCE_ASSETS, "visuals", filename));
    const response = await fetch(`${base}/control/v1/projects/${projectId}/assets`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "idempotency-key": key,
        "x-asset-id": assetId,
        "x-claimed-mime": "image/webp",
        "x-filename": encodeURIComponent(filename),
        "x-alt-text": encodeURIComponent(`Обложка ${projectId}`)
      },
      body: bytes
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.manifest.hash, sha256(bytes), "сервер хранит sha256 реальных байтов");
    return { assetId, hash: body.manifest.hash };
  };

  const setCover = async (projectId, body, key) => {
    const response = await fetch(`${base}/control/v1/projects/${projectId}/cover`, {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const list = async () => {
    const response = await fetch(`${base}/control/v1/projects`);
    return { status: response.status, body: await response.json() };
  };
  return { upload, setCover, list };
}

test("COVER-01: выбор, CAS-конфликт и снятие обложки проходят через HTTP", async (t) => {
  const h = await harness(t);
  const own = await h.upload("project", "workshop-cover", "workshop-background.webp", "cover-asset-own");
  const foreign = await h.upload("other", "foreign-cover", "piazza-background.webp", "cover-asset-foreign");

  const chosen = await h.setCover("project", { baseRevision: 0, cover: own }, "cover-write-1");
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  assert.deepEqual(chosen.body.project.cover, own, "сервер возвращает точную assetId+hash ссылку");
  assert.equal(chosen.body.project.coverRevision, 1);

  const visible = await h.list();
  assert.equal(visible.status, 200);
  assert.deepEqual(visible.body.projects.find((project) => project.projectId === "project").cover, own, "список карточек получает реальную обложку");

  const stale = await h.setCover("project", { baseRevision: 0, cover: null }, "cover-write-stale");
  assert.equal(stale.status, 409, "устаревшая форма не имеет права стереть чужую обложку");
  assert.equal(stale.body.error.code, "PROJECT_COVER_REVISION_CONFLICT");

  const crossProject = await h.setCover("project", { baseRevision: 1, cover: foreign }, "cover-write-foreign");
  assert.equal(crossProject.status, 422, "asset другого проекта нельзя назначить обложкой");
  assert.equal(crossProject.body.error.code, "PROJECT_COVER_ASSET_FOREIGN");

  const mismatchedHash = await h.setCover("project", { baseRevision: 1, cover: { assetId: own.assetId, hash: foreign.hash } }, "cover-write-hash");
  assert.equal(mismatchedHash.status, 422, "assetId с чужим хешем нельзя принять за обложку");
  assert.equal(mismatchedHash.body.error.code, "PROJECT_COVER_ASSET_HASH_MISMATCH");

  const removed = await h.setCover("project", { baseRevision: 1, cover: null }, "cover-write-remove");
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.project.cover, null);
  assert.equal(removed.body.project.coverRevision, 2);
});
