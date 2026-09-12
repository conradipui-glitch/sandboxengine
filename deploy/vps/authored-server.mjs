// Authored-runtime entrypoint for the VPS engine: serves the published Florence
// authored scenario (B11) on /v1/* the way the application BFF expects.
// Runs as its own compose service (deploy/vps/docker-compose.yml: authored).
import { SQLiteGuestSessionAccess, SQLiteRuntimeStorage, ManualServiceClock } from "/engine/packages/runtime/dist/index.js";
import { SQLiteControlReleaseStore } from "/engine/packages/control/dist/index.js";
import { buildPluginRegistry } from "/engine/packages/plugins/dist/index.js";
import { SQLitePublishedSessionBindingStore } from "/engine/apps/server/dist/published-session-binding.js";
import { createAuthoredRuntimeHttpServer } from "/engine/apps/server/dist/authored-runtime-server.js";


const databasePath = process.env.AUTHORED_DB_PATH ?? "/data/living-history.sqlite";
const port = Number(process.env.AUTHORED_PORT ?? 8746);
const storage = new SQLiteRuntimeStorage({ path: databasePath, clock: new ManualServiceClock(0) });
const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
const releaseStore = new SQLiteControlReleaseStore({ path: databasePath });
// Durable bindings: a restart must not drop an already started authored session.
const bindings = new SQLitePublishedSessionBindingStore({ path: databasePath });
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
const shutdown = async () => { await runtime.close(); bindings.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
