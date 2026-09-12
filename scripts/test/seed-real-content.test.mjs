// seed-real-content.test.mjs — несущий тест сидирования реального квеста Florence.
//
//   node node_modules/typescript/bin/tsc -b --force
//   node --test scripts/test/seed-real-content.test.mjs
//
// Тест строит ВРЕМЕННУЮ копию базы с проектом florence (реальные блоки из
// examples/florence/blocks.json) и сентинелами acceptance/c18/m06, затем запускает
// scripts/seed-real-content.mjs и проверяет: 12 материалов с верными kind/mime/sha256,
// документ миссии с 6 сценами и >=2 достижимыми финалами, идемпотентность повторного
// запуска и неизменность чужих проектов.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteControlStore } from "../../packages/control/dist/index.js";
import { LocalAssetStore, ingestAsset } from "../../packages/assets/dist/index.js";

const SCRIPT = fileURLToPath(new URL("../seed-real-content.mjs", import.meta.url));
const worktree = fileURLToPath(new URL("../../", import.meta.url));
const EXAMPLES = join(worktree, "examples", "florence");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const sourceAssets = readJson(join(EXAMPLES, "source-assets.json"));
const manifest = readJson(join(EXAMPLES, "asset-migration-manifest.json"));
const blocks = readJson(join(EXAMPLES, "blocks.json"));
const release = readJson(join(EXAMPLES, "quest-release.json"));

// Минимальный валидный PNG (signature + IHDR + IEND). CRC инспектором не проверяется.
function pngBytes(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (length, type, data) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(length, 0);
    header.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    return Buffer.concat([header, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([signature, chunk(13, "IHDR", ihdr), chunk(0, "IEND", Buffer.alloc(0))]);
}

function expectedAssets() {
  const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const list = [];
  for (const visual of sourceAssets.visuals) {
    const entry = byPath.get(`examples/florence/${visual.targetPath}`);
    list.push({ assetId: visual.id, kind: "image", mimeType: "image/webp", sha256: entry.sha256, byteLength: entry.bytes });
  }
  for (const audio of sourceAssets.audio) {
    const entry = byPath.get(`examples/florence/${audio.targetPath}`);
    list.push({ assetId: audio.id, kind: "audio", mimeType: "audio/mpeg", sha256: entry.sha256, byteLength: entry.bytes });
  }
  return list;
}

const tmp = [];
test.after(() => {
  for (const dir of tmp) rmSync(dir, { recursive: true, force: true });
});

// Готовит временную базу: florence + сентинелы чужих проектов.
async function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "seed-real-"));
  tmp.push(dir);
  const dbPath = join(dir, "control.sqlite");
  const assetsRoot = join(dir, "assets");
  const store = new SQLiteControlStore({ path: dbPath });
  const assetStore = new LocalAssetStore(assetsRoot);
  try {
    assert.equal((await store.createProject({ projectId: "florence", title: release.title })).kind, "created");
    assert.equal((await store.createQuest({
      projectId: "florence",
      questId: release.questId,
      title: release.title,
      entryLocationId: release.entryLocationId,
      initialBlocks: blocks
    })).kind, "created");

    for (const projectId of ["acceptance", "c18", "m06"]) {
      assert.equal((await store.createProject({ projectId, title: `sentinel ${projectId}` })).kind, "created");
      assert.equal((await store.createQuest({
        projectId,
        questId: "quest",
        title: "Sentinel",
        entryLocationId: "workshop",
        initialBlocks: [{ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "sentinel", data: {} }]
      })).kind, "created");
      const record = await ingestAsset(assetStore, {
        assetId: `sentinel-${projectId}`,
        bytes: new Uint8Array(pngBytes(4, 4)),
        claimedMimeType: "image/png",
        originalFilename: "sentinel.png",
        altText: "sentinel"
      });
      const registered = await store.registerProjectAsset(projectId, {
        assetId: record.manifest.id,
        hash: record.manifest.hash,
        filename: record.originalFilename,
        mimeType: record.manifest.mimeType,
        kind: record.manifest.kind,
        widthPx: record.manifest.widthPx,
        heightPx: record.manifest.heightPx,
        durationMs: record.manifest.durationMs,
        byteLength: record.byteLength,
        idempotencyKey: `sentinel-${projectId}-asset`,
        actorUserId: "local-owner"
      });
      assert.equal(registered.kind, "registered");
    }
  } finally {
    store.close();
  }
  return { dir, dbPath };
}

function runSeed(dbPath, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, "--db", dbPath, ...extraArgs], {
    cwd: worktree,
    env: { ...process.env, LH_DATABASE_PATH: dbPath },
    encoding: "utf8"
  });
}

async function forbiddenFingerprint(dbPath) {
  const store = new SQLiteControlStore({ path: dbPath });
  try {
    const result = {};
    for (const projectId of ["acceptance", "c18", "m06"]) {
      const assets = (await store.listProjectAssets(projectId, false)).map((entry) => `${entry.assetId}:${entry.hash}`).sort();
      const quests = (await store.listQuests(projectId)) ?? [];
      result[projectId] = { assets, quests: quests.map((quest) => `${quest.questId}:${quest.contentHash}`).sort() };
    }
    return result;
  } finally {
    store.close();
  }
}

test("seed-real-content: 12 материалов, миссия с 6 сценами и >=2 финалами, идемпотентность", async () => {
  const { dbPath } = await makeFixture();
  const before = await forbiddenFingerprint(dbPath);

  // Без --confirm на уже наполненном проекте скрипт отказывается (код 2).
  const gated = runSeed(dbPath);
  assert.equal(gated.status, 2, `expected confirmation gate, got ${gated.status}\n${gated.stderr}`);

  const first = runSeed(dbPath, ["--confirm"]);
  assert.equal(first.status, 0, `seed failed: ${first.status}\n${first.stdout}\n${first.stderr}`);

  const expected = expectedAssets();
  assert.equal(expected.length, 12);
  const store = new SQLiteControlStore({ path: dbPath });
  let revision;
  let historyLength;
  try {
    const assets = await store.listProjectAssets("florence", false);
    assert.equal(assets.length, 12, `expected 12 listed assets, got ${assets.length}`);
    for (const want of expected) {
      const found = assets.find((entry) => entry.assetId === want.assetId);
      assert.ok(found, `missing asset ${want.assetId}`);
      assert.equal(found.kind, want.kind, `${want.assetId} kind`);
      assert.equal(found.mimeType, want.mimeType, `${want.assetId} mime`);
      assert.equal(found.hash, want.sha256, `${want.assetId} sha256`);
      assert.equal(found.byteLength, want.byteLength, `${want.assetId} bytes`);
    }

    const mission = await store.getMission("florence", release.questId);
    assert.ok(mission, "mission document missing");
    assert.equal(mission.story.scenes.length, 6, "expected 6 scenes");
    assert.equal(mission.story.entrySceneId, "contract-pressure");
    const endingIds = new Set(mission.story.endings.map((ending) => ending.id));
    assert.ok(endingIds.size >= 2, `expected >=2 endings, got ${endingIds.size}`);
    const reachable = new Set();
    for (const scene of mission.story.scenes) {
      for (const choice of scene.choices) {
        if (typeof choice.endingId === "string" && choice.endingId.length > 0) reachable.add(choice.endingId);
      }
    }
    assert.ok(reachable.size >= 2, `expected >=2 reachable endings, got ${reachable.size}`);
    for (const endingId of reachable) assert.ok(endingIds.has(endingId), `reachable ending ${endingId} not declared`);
    // Фон, музыка и портретные слои ссылаются на реально загруженные материалы.
    const hashes = new Set(assets.map((entry) => entry.hash));
    for (const screen of Object.values(mission.screens.scenes)) {
      assert.ok(screen.background && hashes.has(screen.background.hash), "scene background ref must resolve to a loaded asset");
      assert.ok(screen.music && hashes.has(screen.music.hash), "scene music ref must resolve to a loaded asset");
      for (const layer of screen.layers) {
        assert.ok(layer.asset && hashes.has(layer.asset.hash), "layer asset ref must resolve to a loaded asset");
      }
    }
    revision = mission.contentRevision;
    historyLength = (await store.getMissionHistory("florence", release.questId)).length;
  } finally {
    store.close();
  }

  // Повторный запуск идемпотентен: ни новых ревизий, ни дубликатов материалов.
  const second = runSeed(dbPath, ["--confirm"]);
  assert.equal(second.status, 0, `second seed failed: ${second.status}\n${second.stderr}`);
  const store2 = new SQLiteControlStore({ path: dbPath });
  try {
    const assets2 = await store2.listProjectAssets("florence", false);
    assert.equal(assets2.length, 12, "re-run must not duplicate assets");
    const mission2 = await store2.getMission("florence", release.questId);
    assert.equal(mission2.contentRevision, revision, "re-run must not create a new revision");
    const history2 = await store2.getMissionHistory("florence", release.questId);
    assert.equal(history2.length, historyLength, "re-run must not append mission history");
  } finally {
    store2.close();
  }

  const after = await forbiddenFingerprint(dbPath);
  assert.deepEqual(after, before, "forbidden projects must be unchanged");
});
