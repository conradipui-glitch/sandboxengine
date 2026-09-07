// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { mkdir } from "node:fs/promises";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { dirname, resolve } from "node:path";
import type { ActionBlock, JsonValue, LocationBlock, ResourceBlock } from "@living-history/contracts";
import { SQLiteControlStore } from "@living-history/control";
import { bootstrapFrozenPlaytest } from "@living-history/player";
import { SQLiteGuestSessionAccess, SQLiteRuntimeStorage, type ServiceClock } from "@living-history/runtime";
import { createPlayerDevServer, type PlayerSurfaceMetadata } from "./dev-server.js";

type RuntimeServerModule = typeof import("../../server/src/server.js");
type ActionServiceModule = typeof import("../../server/src/action-service.js");
type PresentationStorageModule = typeof import("../../server/src/presentation-storage.js");

declare const process: any;

const databasePath = resolve(String(process.env.LH_DATABASE_PATH ?? "./data/living-history.sqlite"));
const playtestId = String(process.env.LH_PLAYTEST_ID ?? "").trim();
if (playtestId.length === 0) {
  throw new Error("LH_PLAYTEST_ID is required. Create a valid frozen playtest first, then start Player with that playtest id.");
}
await mkdir(dirname(databasePath), { recursive: true });

const controlStore = new SQLiteControlStore({ path: databasePath });
const playtest = await controlStore.getPlaytest(playtestId);
if (!playtest) {
  controlStore.close();
  throw new Error(`Frozen playtest not found: ${playtestId}`);
}

const bootstrapped = bootstrapFrozenPlaytest(playtest);
if (!bootstrapped.ok) {
  controlStore.close();
  throw new Error(`Frozen playtest cannot start Player: ${bootstrapped.code}`);
}
const template = bootstrapped.template;
if (template.paintActions.length !== 1) {
  controlStore.close();
  throw new Error("B05-03 Player requires exactly one core.paint action");
}
const definition = template.paintActions[0];
if (!definition) {
  controlStore.close();
  throw new Error("B05-03 Player has no supported action definition");
}

const actionBlock = playtest.snapshot.blocks.find(
  (block): block is ActionBlock => block.kind === "core.action" && block.id === definition.id
);
const resourceBlock = playtest.snapshot.blocks.find(
  (block): block is ResourceBlock => block.kind === "core.resource" && block.id === definition.resourceId
);
const locationBlock = playtest.snapshot.blocks.find(
  (block): block is LocationBlock => block.kind === "core.location" && block.id === playtest.snapshot.entryLocationId
);
if (!actionBlock || !resourceBlock || !locationBlock) {
  controlStore.close();
  throw new Error("Frozen playtest display metadata is incomplete");
}

const runtimeServerModule = await import(new URL("../../../server/dist/server.js", import.meta.url).href) as RuntimeServerModule;
const actionServiceModule = await import(new URL("../../../server/dist/action-service.js", import.meta.url).href) as ActionServiceModule;
const presentationStorageModule = await import(new URL("../../../server/dist/presentation-storage.js", import.meta.url).href) as PresentationStorageModule;
const serviceClock: ServiceClock = Object.freeze({ nowMs: () => Date.now() });
const rawStorage = new SQLiteRuntimeStorage({ path: databasePath, clock: serviceClock });
const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
const presentationTemplate = presentationStorageModule.createReferencePresentationTemplate({
  sceneId: locationBlock.id,
  state: template.initialState
});
const storage = new presentationStorageModule.PresentationRuntimeStorage(rawStorage, [
  Object.freeze({ release: template.release, presentation: presentationTemplate })
]);
const runtime = runtimeServerModule.createRuntimeHttpServer({
  storage,
  guestAccess,
  templates: [{
    templateId: template.templateId,
    release: template.release,
    initialState: template.initialState,
    intentCatalog: actionServiceModule.createPaintIntentCatalog()
  }],
  executor: actionServiceModule.createCoreExplicitActionExecutorForDefinition(definition)
});
const runtimeAddress = await runtime.listen(Number(process.env.LH_RUNTIME_PORT ?? 0), "127.0.0.1");

const metadata: PlayerSurfaceMetadata = Object.freeze({
  templateId: template.templateId,
  playtestId: template.playtestId,
  questTitle: template.title,
  locationTitle: locationBlock.title,
  sceneText: locationBlock.description || actionBlock.description || "Проверьте действие в замороженной версии квеста.",
  resourceId: resourceBlock.id,
  resourceTitle: resourceBlock.title,
  resourceUnit: resourceBlock.data.unit,
  actionId: actionBlock.id,
  actionTitle: actionBlock.title
});
const player = createPlayerDevServer({
  runtimeOrigin: `http://${runtimeAddress.host}:${runtimeAddress.port}`,
  metadata,
  presentation: {
    assets: presentationTemplate.catalog.assets,
    initialForSession(sessionId): JsonValue | null {
      const initial = presentationStorageModule.buildInitialReferencePresentation({
        template: presentationTemplate,
        sessionId,
        release: template.release
      });
      return initial === null ? null : JSON.parse(JSON.stringify(initial)) as JsonValue;
    }
  }
});
const playerAddress = await player.listen(Number(process.env.LH_PLAYER_PORT ?? 4180), "127.0.0.1");

console.log(`Living History Player: http://${playerAddress.host}:${playerAddress.port}`);
console.log(`Frozen playtest: ${template.playtestId}`);
console.log(`Runtime API (loopback only): http://${runtimeAddress.host}:${runtimeAddress.port}`);

const shutdown = async () => {
  await player.close();
  await runtime.close();
  guestAccess.close();
  rawStorage.close();
  controlStore.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
