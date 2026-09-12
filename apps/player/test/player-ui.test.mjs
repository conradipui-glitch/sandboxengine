import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteControlStore } from "@living-history/control";
import { RuntimePlayerClient } from "@living-history/player";
import {
  ManualServiceClock,
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "@living-history/runtime";
import {
  createMinimalPaintTemplate,
  createRuntimeHttpServer
} from "../../server/dist/server.js";
import { createPlayerDevServer } from "../dist/src/dev-server.js";

const metadata = Object.freeze({
  templateId: "minimal-paint",
  playtestId: "playtest-ui",
  questTitle: "Тестовый квест",
  locationTitle: "Мастерская",
  sceneText: "Проверьте действие в замороженной версии квеста.",
  resourceId: "blue_paint",
  resourceTitle: "Синяя краска",
  resourceUnit: "portion",
  actionId: "paint",
  actionTitle: "Рисовать"
});

async function makeProxyFixture() {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-player-ui-"));
  const databasePath = join(directory, "runtime.sqlite");
  const storage = new SQLiteRuntimeStorage({ path: databasePath, clock: new ManualServiceClock(10_000) });
  const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
  const runtime = createRuntimeHttpServer({
    storage,
    guestAccess,
    templates: [createMinimalPaintTemplate()],
    createSessionId: (() => {
      let index = 0;
      return () => `player-ui-session-${++index}`;
    })(),
    createCredential: () => "P".repeat(32)
  });
  const runtimeAddress = await runtime.listen();
  const player = createPlayerDevServer({
    runtimeOrigin: `http://${runtimeAddress.host}:${runtimeAddress.port}`,
    metadata
  });
  const playerAddress = await player.listen();
  const baseUrl = `http://${playerAddress.host}:${playerAddress.port}`;

  return {
    baseUrl,
    async cleanup() {
      await player.close();
      await runtime.close();
      guestAccess.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("B05-03 Player UI serves human surface, safe metadata and the compiled RuntimePlayerClient", async (t) => {
  const fixture = await makeProxyFixture();
  t.after(fixture.cleanup);

  const page = await fetch(`${fixture.baseUrl}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Living History Player/);
  assert.match(html, /player-assets\/app\.js/);

  const css = await fetch(`${fixture.baseUrl}/player-assets/styles.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /\.scene-surface/);

  const browserEntry = await fetch(`${fixture.baseUrl}/player-assets/app.js`);
  assert.equal(browserEntry.status, 200);
  const browserCode = await browserEntry.text();
  assert.match(browserCode, /RuntimePlayerClient/);
  assert.match(browserCode, /client\.paint/);
  assert.match(browserCode, /client\.reset/);
  assert.doesNotMatch(browserCode, /resourceUnitsPerUnit/);
  assert.doesNotMatch(browserCode, /compiledContentHash/);

  const clientLibrary = await fetch(`${fixture.baseUrl}/player-lib/client.js`);
  assert.equal(clientLibrary.status, 200);
  assert.match(await clientLibrary.text(), /class RuntimePlayerClient/);

  // V00: корневые пути статики больше не обслуживаются (их забирала чужая поверхность).
  assert.equal((await fetch(`${fixture.baseUrl}/styles.css`)).status, 404);
  assert.equal((await fetch(`${fixture.baseUrl}/app.js`)).status, 404);
  assert.equal((await fetch(`${fixture.baseUrl}/presentation-renderer.js`)).status, 404);
  const renderer = await fetch(`${fixture.baseUrl}/player-assets/presentation-renderer.js`);
  assert.equal(renderer.status, 200);

  const metaResponse = await fetch(`${fixture.baseUrl}/player-meta.json`);
  assert.equal(metaResponse.status, 200);
  const meta = await metaResponse.json();
  assert.deepEqual(Object.keys(meta).sort(), [
    "actionId", "actionTitle", "locationTitle", "playtestId", "questTitle",
    "resourceId", "resourceTitle", "resourceUnit", "sceneText", "templateId"
  ]);
  assert.equal("contentHash" in meta, false);
  assert.equal("compiledContentHash" in meta, false);
  assert.equal("resourceUnitsPerUnit" in meta, false);
});

test("B05-03 Player proxy carries the exact RuntimePlayerClient create/action/reset path", async (t) => {
  const fixture = await makeProxyFixture();
  t.after(fixture.cleanup);
  const client = new RuntimePlayerClient(fixture.baseUrl);

  const initial = await client.createSession("minimal-paint");
  assert.equal(initial.playerView.resources[0].value, 2);
  assert.equal(initial.playerView.clock.elapsedSeconds, 0);

  const action = await client.paint(initial, 1, "ui-proxy-paint-1");
  assert.equal(action.action.status, "executed");
  assert.equal(action.action.completedUnits, 1);
  assert.equal(action.session.playerView.resources[0].value, 1);
  assert.equal(action.session.playerView.clock.elapsedSeconds, 300);

  const reset = await client.reset(action.session);
  assert.notEqual(reset.sessionId, action.session.sessionId);
  assert.equal(reset.playerView.revision, 0);
  assert.equal(reset.playerView.resources[0].value, 2);
  assert.equal(reset.playerView.clock.elapsedSeconds, 0);
});

test("B05-03 Player dev server refuses non-loopback exposure and non-loopback Runtime target", async () => {
  assert.throws(
    () => createPlayerDevServer({ runtimeOrigin: "https://runtime.example.com", metadata }),
    /loopback Runtime/
  );

  const fixture = await makeProxyFixture();
  try {
    const second = createPlayerDevServer({ runtimeOrigin: fixture.baseUrl, metadata });
    await assert.rejects(() => second.listen(0, "0.0.0.0"), /loopback only/);
    await second.close();
  } finally {
    await fixture.cleanup();
  }
});

test("B05-03 dev:player process boots from a real durable frozen playtest and serves the authored cost", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-player-process-"));
  const databasePath = join(directory, "living-history.sqlite");
  const store = new SQLiteControlStore({ path: databasePath });
  let child = null;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  const project = await store.createProject({ projectId: "project", title: "Проект" });
  assert.equal(project.kind, "created");
  const quest = await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Мастерская",
    entryLocationId: "workshop",
    initialBlocks: [locationBlock()]
  });
  assert.equal(quest.kind, "created");
  const changed = await store.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [
      { kind: "block.add", block: resourceBlock() },
      { kind: "block.add", block: paintActionBlock(2) }
    ]
  });
  assert.equal(changed.kind, "updated");
  const validated = await store.validateDraft("project", "quest", 1);
  assert.equal(validated.kind, "validated");
  assert.equal(validated.validation.status, "valid");
  const frozen = await store.createPlaytest({
    projectId: "project",
    questId: "quest",
    draftRevision: 1,
    validationId: validated.validation.validationId
  });
  assert.equal(frozen.kind, "created");
  const playtestId = frozen.playtest.playtestId;
  store.close();

  const mainPath = fileURLToPath(new URL("../dist/src/main.js", import.meta.url));
  child = spawn(process.execPath, [mainPath], {
    env: {
      ...process.env,
      LH_DATABASE_PATH: databasePath,
      LH_PLAYTEST_ID: playtestId,
      LH_PLAYER_PORT: "0",
      LH_RUNTIME_PORT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const baseUrl = await waitForPlayerUrl(child, stderr);
  const meta = await (await fetch(`${baseUrl}/player-meta.json`)).json();
  assert.equal(meta.playtestId, playtestId);
  assert.equal(meta.questTitle, "Мастерская");
  assert.equal(meta.resourceTitle, "Синяя краска");
  assert.equal("resourceUnitsPerUnit" in meta, false);

  const client = new RuntimePlayerClient(baseUrl);
  const session = await client.createSession(meta.templateId);
  const result = await client.paint(session, 2, "process-cost-two");
  assert.equal(result.action.status, "partial");
  assert.equal(result.action.requestedUnits, 2);
  assert.equal(result.action.completedUnits, 1);
  assert.equal(result.action.durationSeconds, 300);
  assert.equal(result.session.playerView.resources[0].value, 0);

  const reset = await client.reset(result.session);
  assert.equal(reset.playerView.resources[0].value, 2);
  assert.equal(reset.playerView.clock.elapsedSeconds, 0);
});

async function waitForPlayerUrl(child, getStderr) {
  child.stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Player did not start. stderr: ${getStderr}`)), 10_000);
    const onData = (chunk) => {
      stdout += String(chunk);
      const match = /Living History Player: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      resolve(match[1]);
    };
    const onExit = (code) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      reject(new Error(`Player exited before listening (${code}). stderr: ${getStderr}`));
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function locationBlock() {
  return Object.freeze({
    schemaVersion: "1.0",
    id: "workshop",
    kind: "core.location",
    title: "Мастерская",
    description: "На столе лежат материалы для работы.",
    data: Object.freeze({})
  });
}

function resourceBlock() {
  return Object.freeze({
    schemaVersion: "1.0",
    id: "blue_paint",
    kind: "core.resource",
    title: "Синяя краска",
    description: "",
    data: Object.freeze({ unit: "portion", initialValue: 2, min: 0, max: 20 })
  });
}

function paintActionBlock(cost) {
  return Object.freeze({
    schemaVersion: "1.0",
    id: "paint",
    kind: "core.action",
    title: "Рисовать",
    description: "Потратить краску на работу.",
    data: Object.freeze({
      actionType: "core.paint",
      resourceId: "blue_paint",
      resourceUnitsPerUnit: cost,
      durationSecondsPerUnit: 300,
      allowPartial: true
    })
  });
}
