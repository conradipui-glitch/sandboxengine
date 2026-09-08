// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { mkdir } from "node:fs/promises";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { dirname, resolve } from "node:path";
import { ScriptedAgentBackend } from "@living-history/ai";
import {
  SQLiteAuthorAgentJobStore,
  SQLiteAuthorAgentProposalArtifactStore,
  SQLiteAuthorConversationStore,
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
const playtestTrace = new SQLitePlaytestTraceReader({ path: databasePath });
const authorJobs = new SQLiteAuthorAgentJobStore({ path: databasePath });
const authorArtifacts = new SQLiteAuthorAgentProposalArtifactStore(authorJobs, { path: databasePath });
const authorConversation = new SQLiteAuthorConversationStore(authorJobs, { path: databasePath });
const devAuthorOutput = JSON.stringify({
  explanation: "Dev scripted backend demo: deterministic title proposal only. Configure a real AgentBackend for general authoring.",
  changes: [{ kind: "quest.title.set", title: "Assistant demo title" }],
  missingCapabilities: []
});
const devAuthorBackend = new ScriptedAgentBackend({
  backendId: "studio-dev-scripted-author",
  turnSteps: Array.from({ length: 64 }, () => ({ kind: "success" as const, outputText: devAuthorOutput }))
});
const builtPluginRegistry = buildPluginRegistry([DICE_CHECK_MANIFEST]);
if (!builtPluginRegistry.ok) throw new Error(`Studio plugin registry failed: ${builtPluginRegistry.code}`);

const controlServerModule = await import(new URL("../../../server/dist/control-server.js", import.meta.url).href) as ControlServerModule;
const control = controlServerModule.createControlHttpServer({
  store,
  releases: {
    store: releaseStore,
    pluginRegistry: builtPluginRegistry.registry,
    nowMs: () => Date.now()
  },
  playtestTrace,
  authorAssistant: {
    jobs: authorJobs,
    artifacts: authorArtifacts,
    conversation: authorConversation,
    backend: devAuthorBackend,
    profileId: "studio-dev-author-profile",
    nowMs: () => Date.now(),
    backendDeadlineMs: 30_000
  }
});
const controlAddress = await control.listen(Number(process.env.LH_CONTROL_PORT ?? 0), "127.0.0.1");
const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
const studioAddress = await studio.listen(Number(process.env.LH_STUDIO_PORT ?? 4173), "127.0.0.1");

console.log(`Living History Studio: http://${studioAddress.host}:${studioAddress.port}`);
console.log(`Control API (loopback only): http://${controlAddress.host}:${controlAddress.port}`);
console.log("Author Assistant: studio-dev-scripted-author (dev-only deterministic title proposal; no tools)");

const shutdown = async () => {
  await studio.close();
  await control.close();
  authorConversation.close();
  authorArtifacts.close();
  authorJobs.close();
  playtestTrace.close();
  releaseStore.close();
  store.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
