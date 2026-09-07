// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { mkdirSync } from "node:fs";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { dirname, resolve } from "node:path";
import {
  SQLiteControlReleaseStore,
  SQLiteControlSecurityStore,
  SQLiteControlStore
} from "@living-history/control";
import { buildPluginRegistry } from "@living-history/plugins";
import { DICE_CHECK_MANIFEST } from "@living-history/plugins/dice-check";
import {
  SQLiteGuestSessionAccess,
  SQLitePlaytestTraceReader,
  SQLiteRuntimeStorage
} from "@living-history/runtime";
import { createControlHttpServer } from "./control-server.js";
import { SQLitePublishedSessionBindingStore } from "./published-session-binding.js";
import { createRuntimeHttpServer } from "./server.js";

declare const process: any;

const databasePath = resolve(String(process.env.RUNTIME_DB_PATH ?? "./data/runtime.sqlite"));
const port = Number(process.env.PORT ?? 8787);
const host = String(process.env.HOST ?? "127.0.0.1");
const controlPort = Number(process.env.CONTROL_PORT ?? 8788);
const controlAuthMode = String(process.env.CONTROL_AUTH_MODE ?? "local");
if (controlAuthMode !== "local" && controlAuthMode !== "authenticated") {
  throw new Error("CONTROL_AUTH_MODE must be local or authenticated");
}
const controlAuthenticated = controlAuthMode === "authenticated";
const controlHost = controlAuthenticated ? String(process.env.CONTROL_HOST ?? "127.0.0.1") : "127.0.0.1";
const controlSecureCookies = String(process.env.CONTROL_SECURE_COOKIES ?? "false") === "true";
const controlAllowedOrigins = String(process.env.CONTROL_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

mkdirSync(dirname(databasePath), { recursive: true });
const clock = Object.freeze({ nowMs: () => Date.now() });
const storage = new SQLiteRuntimeStorage({ path: databasePath, clock });
const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
const playtestTrace = new SQLitePlaytestTraceReader({ path: databasePath });
const controlStore = new SQLiteControlStore({ path: databasePath });
const releaseStore = new SQLiteControlReleaseStore({ path: databasePath });
const publishedBindings = new SQLitePublishedSessionBindingStore({ path: databasePath });
const controlSecurity = controlAuthenticated ? new SQLiteControlSecurityStore({ path: databasePath }) : null;
const builtPluginRegistry = buildPluginRegistry([DICE_CHECK_MANIFEST]);
if (!builtPluginRegistry.ok) {
  throw new Error(`Production plugin registry failed: ${builtPluginRegistry.code}`);
}
const pluginRegistry = builtPluginRegistry.registry;

if (controlSecurity) {
  const bootstrapUserId = process.env.CONTROL_BOOTSTRAP_USER_ID;
  const bootstrapUsername = process.env.CONTROL_BOOTSTRAP_USERNAME;
  const bootstrapPassword = process.env.CONTROL_BOOTSTRAP_PASSWORD;
  const present = [bootstrapUserId, bootstrapUsername, bootstrapPassword].filter((value) => typeof value === "string" && value.length > 0).length;
  if (present !== 0 && present !== 3) throw new Error("Control bootstrap requires user id, username and password together");
  if (present === 3) {
    const result = await controlSecurity.provisionUser({
      userId: String(bootstrapUserId),
      username: String(bootstrapUsername),
      password: String(bootstrapPassword)
    });
    if (result.kind === "username_exists") throw new Error("Control bootstrap username already belongs to another user id");
    if (result.kind === "invalid_request") throw new Error("Control bootstrap credentials are outside supported bounds");
    if (result.kind === "user_exists") {
      const existing = await controlSecurity.getUser(String(bootstrapUserId));
      if (!existing || existing.username !== String(bootstrapUsername)) throw new Error("Control bootstrap user id exists with another username");
    }
  }
}

const runtime = createRuntimeHttpServer({
  storage,
  guestAccess,
  templates: [],
  published: {
    releaseStore,
    pluginRegistry,
    bindings: publishedBindings
  }
});
const control = createControlHttpServer({
  store: controlStore,
  releases: {
    store: releaseStore,
    pluginRegistry,
    nowMs: clock.nowMs
  },
  playtestTrace,
  auth: controlSecurity ? {
    security: controlSecurity,
    allowedOrigins: controlAllowedOrigins,
    secureCookies: controlSecureCookies,
    nowMs: clock.nowMs
  } : undefined
});

await runtime.listen(port, host);
await control.listen(controlPort, controlHost);
process.stdout.write(`Living History Runtime listening on http://${host}:${port}\n`);
process.stdout.write(`Living History Control listening on http://${controlHost}:${controlPort} (${control.accessMode})\n`);

async function shutdown(): Promise<void> {
  await control.close();
  await runtime.close();
  controlSecurity?.close();
  publishedBindings.close();
  releaseStore.close();
  controlStore.close();
  guestAccess.close();
  playtestTrace.close();
  storage.close();
}

process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
