import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "../../runtime/dist/index.js";
import { RuntimePlayerClient } from "../dist/index.js";
import {
  createMinimalPaintTemplate,
  createRuntimeHttpServer
} from "../../../apps/server/dist/server.js";

async function withRuntime(run, { narrator } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-player-client-"));
  const databasePath = join(dir, "runtime.sqlite");
  const storage = new SQLiteRuntimeStorage({ path: databasePath, clock: new ManualServiceClock(10_000) });
  const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
  let sessionOrdinal = 0;
  let credentialOrdinal = 0;
  const runtime = createRuntimeHttpServer({
    storage,
    guestAccess,
    templates: [createMinimalPaintTemplate()],
    ...(narrator ? { narrator, narrativeProfile: "strict" } : {}),
    createSessionId: () => `client-session-${++sessionOrdinal}`,
    createCredential: () => `${String(++credentialOrdinal).padStart(2, "0")}${"C".repeat(30)}`
  });
  const address = await runtime.listen(0, "127.0.0.1");
  const client = new RuntimePlayerClient(`http://${address.host}:${address.port}`);
  try {
    await run(client);
  } finally {
    await runtime.close();
    guestAccess.close();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("B05-03 RuntimePlayerClient owns create/action/reset transport without client simulation", async () => {
  await withRuntime(async (client) => {
    const created = await client.createSession("minimal-paint");
    assert.equal(created.playerView.revision, 0);
    assert.equal(created.playerView.resources[0].value, 2);

    const result = await client.paint(created, 1, "client-paint-1");
    assert.equal(result.action.status, "executed");
    assert.equal(result.action.completedUnits, 1);
    assert.equal(result.action.durationSeconds, 300);
    assert.equal(result.narrative, null, "legacy Runtime without narrator stays valid");
    assert.equal(result.session.playerView.revision, 1);
    assert.equal(result.session.playerView.resources[0].value, 1);

    const refreshed = await client.refresh(result.session);
    assert.deepEqual(refreshed.playerView, result.session.playerView);

    const reset = await client.reset(result.session);
    assert.notEqual(reset.sessionId, result.session.sessionId);
    assert.equal(reset.templateId, result.session.templateId);
    assert.equal(reset.playerView.revision, 0);
    assert.equal(reset.playerView.resources[0].value, 2);
  });
});

test("B06-03 RuntimePlayerClient exposes only validated optional narrative presentation", async () => {
  const narrator = Object.freeze({
    async narrate({ profile }) {
      return Object.freeze({
        profile,
        source: "model",
        content: Object.freeze({
          summary: "Мастер закончил первый участок.",
          dialogue: Object.freeze([Object.freeze({ speakerId: "painter", text: "Готово." })]),
          observationRefs: Object.freeze([])
        }),
        evidence: Object.freeze({ attempts: Object.freeze([]) })
      });
    }
  });
  await withRuntime(async (client) => {
    const created = await client.createSession("minimal-paint");
    const result = await client.paint(created, 1, "client-narrative-1");
    assert.deepEqual(result.narrative, {
      profile: "strict",
      source: "model",
      summary: "Мастер закончил первый участок.",
      dialogue: [{ speakerId: "painter", text: "Готово." }],
      observationRefs: []
    });
    assert.equal(Object.isFrozen(result.narrative), true);
    assert.equal("evidence" in result.narrative, false, "Player must not expose narrator provider evidence");
  }, { narrator });
});
