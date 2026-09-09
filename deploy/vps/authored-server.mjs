// Authored-runtime entrypoint for the VPS engine: serves the published Florence
// authored scenario (B11) on /v1/* the way the application BFF expects.
// Run inside the engine container: node /engine/deploy/vps/authored-server.mjs
import { SQLiteGuestSessionAccess, SQLiteRuntimeStorage, ManualServiceClock } from "/engine/packages/runtime/dist/index.js";
import { SQLiteControlReleaseStore } from "/engine/packages/control/dist/index.js";
import { buildPluginRegistry } from "/engine/packages/plugins/dist/index.js";
import { MemoryPublishedSessionBindingStore } from "/engine/apps/server/dist/published-session-binding.js";
import { createAuthoredRuntimeHttpServer } from "/engine/apps/server/dist/authored-runtime-server.js";


const databasePath = "/data/living-history.sqlite";
const port = Number(process.env.AUTHORED_PORT ?? 8746);
const storage = new SQLiteRuntimeStorage({ path: databasePath, clock: new ManualServiceClock(0) });
const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
const releaseStore = new SQLiteControlReleaseStore({ path: databasePath });
const bindings = new MemoryPublishedSessionBindingStore();
const registry = buildPluginRegistry([]);
if (!registry.ok) throw new Error("registry failed");
const runtime = createAuthoredRuntimeHttpServer({
  storage,
  guestAccess,
  releaseStore,
  pluginRegistry: registry.registry,
  bindings,
  createSessionId: () => `session-${crypto.randomUUID()}`,
  createCredential: () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
  leaseDurationMs: 30_000
});
const address = await runtime.listen(port, "0.0.0.0");
console.log(`Living History Authored Runtime: http://${address.host}:${address.port}`);
const shutdown = async () => { await runtime.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
