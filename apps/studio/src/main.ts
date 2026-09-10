// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { mkdir } from "node:fs/promises";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { dirname, resolve } from "node:path";
import { LocalAuthorProvider } from "./local-author-provider.js";
import {
  SQLiteAuthorAgentJobStore,
  SQLiteAuthorAgentProposalArtifactStore,
  SQLiteAuthorConversationStore,
  SQLiteControlPublicationStore,
  SQLiteControlReleaseStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { DICE_CHECK_MANIFEST } from "@living-history/plugins/dice-check";
import { SQLitePlaytestTraceReader } from "@living-history/runtime";
import { createStudioDevServer } from "./dev-server.js";

type ControlServerModule = typeof import("../../server/src/control-server.js");

declare const process: any;

const databasePath = resolve(String(process.env.LH_DATABASE_PATH ?? "./data/living-history.sqlite"));
await mkdir(dirname(databasePath), { recursive: true });

const store = new SQLiteControlStore({ path: databasePath });
const releaseStore = new SQLiteControlReleaseStore({ path: databasePath });
const publicationStore = new SQLiteControlPublicationStore({ path: databasePath });
const playtestTrace = new SQLitePlaytestTraceReader({ path: databasePath });
const authorJobs = new SQLiteAuthorAgentJobStore({ path: databasePath });
const authorArtifacts = new SQLiteAuthorAgentProposalArtifactStore(authorJobs, { path: databasePath });
const authorConversation = new SQLiteAuthorConversationStore(authorJobs, { path: databasePath });
const authorProvider = new LocalAuthorProvider();
const builtPluginRegistry = buildPluginRegistry([DICE_CHECK_MANIFEST]);
if (!builtPluginRegistry.ok) throw new Error(`Studio plugin registry failed: ${builtPluginRegistry.code}`);

const controlServerModule = await import(new URL("../../../server/dist/control-server.js", import.meta.url).href) as ControlServerModule;
const control = controlServerModule.createControlHttpServer({
  store,
  releases: {
    store: releaseStore,
    publicationStore,
    publicMissionSessionSecret: String(process.env.LH_PUBLIC_MISSION_SESSION_SECRET ?? ""),
    pluginRegistry: builtPluginRegistry.registry,
    nowMs: () => Date.now()
  },
  playtestTrace,
  authorAssistant: {
    jobs: authorJobs,
    artifacts: authorArtifacts,
    conversation: authorConversation,
    backend: authorProvider.backend,
    profileId: "studio-dev-author-profile",
    contextScope: "small_quest",
    nowMs: () => Date.now(),
    backendDeadlineMs: 60_000
  }
});
const controlAddress = await control.listen(Number(process.env.LH_CONTROL_PORT ?? 0), "127.0.0.1");
type PlayerLaunchOutcome =
  | { readonly ok: true; readonly url: string; readonly playtestId: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

interface PlayerLaunchModule {
  launchFrozenPlayer(options: { databasePath: string; playtestId: string }): Promise<PlayerLaunchOutcome>;
  closeAllPlayers(): Promise<void>;
}
const playerLaunchModule = await import(new URL("../../../player/dist/src/launch.js", import.meta.url).href) as PlayerLaunchModule;
const playerLauncher = async (playtestId: string) => {
  // Reverse-proxy hosting: fixed loopback port + a public base URL returned to the
  // browser instead of the loopback address (the Player itself stays loopback-only).
  const fixedPort = Number(process.env.LH_PLAYER_FIXED_PORT ?? "");
  const publicBase = String(process.env.LH_PLAYER_PUBLIC_BASE ?? "").replace(/\/+$/, "");
  const launched = await playerLaunchModule.launchFrozenPlayer({
    databasePath,
    playtestId,
    ...Number.isSafeInteger(fixedPort) && fixedPort > 0 ? { port: fixedPort } : {}
  } as Parameters<PlayerLaunchModule["launchFrozenPlayer"]>[0]);
  if (launched.ok) {
    const url = publicBase.length > 0 ? `${publicBase}/p/${playtestId}` : launched.url;
    return { ok: true as const, url, playtestId: launched.playtestId };
  }
  return { ok: false as const, code: launched.code, message: launched.message };
};
const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}`, authorProvider, playerLauncher });
const studioAddress = await studio.listen(Number(process.env.LH_STUDIO_PORT ?? 4173), "127.0.0.1");

console.log(`Living History Studio: http://${studioAddress.host}:${studioAddress.port}`);
console.log(`Control API (loopback only): http://${controlAddress.host}:${controlAddress.port}`);
console.log("Author Assistant: configure an API provider in Studio (key held in process memory; no tools)");

const shutdown = async () => {
  await playerLaunchModule.closeAllPlayers();
  authorProvider.disconnect();
  await studio.close();
  await control.close();
  authorConversation.close();
  authorArtifacts.close();
  authorJobs.close();
  playtestTrace.close();
  publicationStore.close();
  releaseStore.close();
  store.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
