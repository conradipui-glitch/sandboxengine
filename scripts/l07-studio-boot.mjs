import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SQLiteAuthorAgentJobStore, SQLiteAuthorAgentProposalArtifactStore, SQLiteAuthorConversationStore, SQLiteControlStore } from "../packages/control/dist/index.js";
import { createControlHttpServer } from "../apps/server/dist/control-server.js";
import { LocalAuthorProvider } from "../apps/studio/dist/src/local-author-provider.js";
import { createStudioDevServer } from "../apps/studio/dist/src/dev-server.js";
import { closeAllPlayers, launchFrozenPlayer } from "../apps/player/dist/src/launch.js";

const databasePath = resolve(process.env.LH_DATABASE_PATH ?? "./data/living-history-l07.sqlite");
await mkdir(dirname(databasePath), { recursive: true });

const authorProvider = new LocalAuthorProvider();
const store = new SQLiteControlStore({ path: databasePath });
const authorJobs = new SQLiteAuthorAgentJobStore({ path: databasePath });
const authorArtifacts = new SQLiteAuthorAgentProposalArtifactStore(authorJobs, { path: databasePath });
const authorConversation = new SQLiteAuthorConversationStore(authorJobs, { path: databasePath });
const control = createControlHttpServer({
  store,
  authorAssistant: {
    jobs: authorJobs, artifacts: authorArtifacts, conversation: authorConversation,
    backend: authorProvider.backend,
    profileId: "l07-author-profile",
    contextScope: "small_quest",
    nowMs: () => Date.now(),
    backendDeadlineMs: 60_000
  }
});
const controlAddress = await control.listen(Number(process.env.LH_CONTROL_PORT ?? 0), "127.0.0.1");
const studio = createStudioDevServer({
  controlOrigin: `http://127.0.0.1:${controlAddress.port}`,
  authorProvider,
  playerLauncher: async (playtestId) => {
    const launched = await launchFrozenPlayer({ databasePath, playtestId });
    return launched.ok ? { ok: true, url: launched.url, playtestId: launched.playtestId } : { ok: false, code: launched.code, message: launched.message };
  }
});
const studioAddress = await studio.listen(Number(process.env.LH_STUDIO_PORT ?? 0), "127.0.0.1");

console.log(`L07_STUDIO_URL=http://${studioAddress.host}:${studioAddress.port}`);

const shutdown = async () => {
  await closeAllPlayers();
  authorProvider.disconnect();
  await studio.close();
  await control.close();
  authorConversation.close();
  authorArtifacts.close();
  authorJobs.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
