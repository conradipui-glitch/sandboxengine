import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ManualServiceClock,
  SQLiteRuntimeStorage
} from "../packages/runtime/dist/index.js";
import {
  claimInput,
  commitInput,
  publicResponse,
  seedSession
} from "../packages/runtime/test/storage-contract-suite.mjs";

const root = process.cwd();
const workspace = await mkdtemp(join(tmpdir(), "living-history-b12-restore-"));

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function copyVerified(source, target, expected) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  const info = await stat(target);
  assert.equal(info.size, expected.bytes, `byte length mismatch after restore: ${target}`);
  assert.equal(await sha256(target), expected.sha256, `sha256 mismatch after restore: ${target}`);
}

let sourceStorage;
let restoredStorage;
let backupConnection;

try {
  const sourceDir = join(workspace, "source");
  const backupDir = join(workspace, "backup");
  const restoredDir = join(workspace, "restored");
  await Promise.all([mkdir(sourceDir), mkdir(backupDir), mkdir(restoredDir)]);

  const sourceDbPath = join(sourceDir, "runtime.sqlite");
  const backupDbPath = join(backupDir, "runtime.sqlite");
  const restoredDbPath = join(restoredDir, "runtime.sqlite");
  const clock = new ManualServiceClock(1_000);

  sourceStorage = new SQLiteRuntimeStorage({
    path: sourceDbPath,
    clock,
    sessions: [seedSession()]
  });

  const claim = await sourceStorage.claimOperation(claimInput());
  assert.equal(claim.kind, "acquired");
  const committed = await sourceStorage.commitTurn(commitInput(claim.operation));
  assert.equal(committed.kind, "committed");

  const sourceSession = await sourceStorage.loadSession("session-1");
  const sourceTurns = sourceStorage.inspectTurnsForTest("session-1");
  assert.equal(sourceSession.revision, 1);
  assert.equal(sourceTurns.length, 1);
  assert.equal(sourceSession.release.releaseId, "release-1");

  // Use SQLite's online backup API rather than copying the main database file.
  // This remains consistent with WAL mode while the Runtime adapter is open.
  backupConnection = new DatabaseSync(sourceDbPath, { timeout: 5_000 });
  const backedUpPages = await backup(backupConnection, backupDbPath, { rate: 32 });
  backupConnection.close();
  backupConnection = undefined;

  // Simulate process shutdown after a durable backup artifact exists.
  sourceStorage.close();
  sourceStorage = undefined;

  // Restore into a clean location, not back over the source database.
  await copyFile(backupDbPath, restoredDbPath);
  restoredStorage = new SQLiteRuntimeStorage({ path: restoredDbPath, clock });

  const restoredSession = await restoredStorage.loadSession("session-1");
  const restoredTurns = restoredStorage.inspectTurnsForTest("session-1");
  assert.deepEqual(restoredSession, sourceSession);
  assert.deepEqual(restoredTurns, sourceTurns);

  const replay = await restoredStorage.claimOperation(claimInput());
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.publicResponse, publicResponse());
  assert.equal((await restoredStorage.loadSession("session-1")).revision, 1);
  assert.equal(restoredStorage.inspectTurnsForTest("session-1").length, 1);

  const manifestSourcePath = join(root, "examples/florence/asset-migration-manifest.json");
  const manifest = JSON.parse(await readFile(manifestSourcePath, "utf8"));
  assert.equal(manifest.format, "living-history.asset-migration/1");
  assert.equal(manifest.files.length, 12);

  const backupManifestPath = join(backupDir, "florence/asset-migration-manifest.json");
  const restoredManifestPath = join(restoredDir, "florence/asset-migration-manifest.json");
  await mkdir(dirname(backupManifestPath), { recursive: true });
  await copyFile(manifestSourcePath, backupManifestPath);
  await mkdir(dirname(restoredManifestPath), { recursive: true });
  await copyFile(backupManifestPath, restoredManifestPath);
  assert.deepEqual(
    JSON.parse(await readFile(restoredManifestPath, "utf8")),
    manifest,
    "asset migration manifest changed during backup/restore"
  );

  for (const file of manifest.files) {
    const relative = file.path.replace(/^examples\/florence\//, "");
    const sourceAsset = join(root, file.path);
    const backupAsset = join(backupDir, "florence", relative);
    const restoredAsset = join(restoredDir, "florence", relative);

    assert.equal((await stat(sourceAsset)).size, file.bytes, `source byte length mismatch: ${file.path}`);
    assert.equal(await sha256(sourceAsset), file.sha256, `source sha256 mismatch: ${file.path}`);
    await copyVerified(sourceAsset, backupAsset, file);
    await copyVerified(backupAsset, restoredAsset, file);
  }

  console.log(JSON.stringify({
    drill: "B12.2-backup-restore",
    result: "pass",
    database: {
      backedUpPages,
      sessionId: restoredSession.sessionId,
      revision: restoredSession.revision,
      releaseId: restoredSession.release.releaseId,
      contentHash: restoredSession.release.contentHash,
      turns: restoredTurns.length,
      idempotentReplay: replay.kind === "replay"
    },
    assets: {
      manifest: manifest.format,
      files: manifest.files.length,
      sourceCommit: manifest.source.commit,
      sha256VerifiedAfterRestore: true
    },
    scope: "local SQLite Runtime + repository Florence assets; not a Cloudflare Durable Object backup claim"
  }));
} finally {
  try { backupConnection?.close(); } catch {}
  try { sourceStorage?.close(); } catch {}
  try { restoredStorage?.close(); } catch {}
  await rm(workspace, { recursive: true, force: true });
}
