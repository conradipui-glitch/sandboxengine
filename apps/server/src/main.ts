// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { mkdirSync } from "node:fs";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { dirname, resolve } from "node:path";
import { SQLiteControlStore } from "@living-history/control";
import {
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "@living-history/runtime";
import { createControlHttpServer } from "./control-server.js";
import { createMinimalPaintTemplate, createRuntimeHttpServer } from "./server.js";

declare const process: any;

const databasePath = resolve(String(process.env.RUNTIME_DB_PATH ?? "./data/runtime.sqlite"));
const port = Number(process.env.PORT ?? 8787);
const host = String(process.env.HOST ?? "127.0.0.1");
const controlPort = Number(process.env.CONTROL_PORT ?? 8788);
const controlHost = "127.0.0.1";

mkdirSync(dirname(databasePath), { recursive: true });
const clock = Object.freeze({ nowMs: () => Date.now() });
const storage = new SQLiteRuntimeStorage({ path: databasePath, clock });
const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
const controlStore = new SQLiteControlStore({ path: databasePath });
const runtime = createRuntimeHttpServer({
  storage,
  guestAccess,
  templates: [createMinimalPaintTemplate()]
});
const control = createControlHttpServer({ store: controlStore });

await runtime.listen(port, host);
await control.listen(controlPort, controlHost);
process.stdout.write(`Living History Runtime listening on http://${host}:${port}\n`);
process.stdout.write(`Living History Control listening on http://${controlHost}:${controlPort} (loopback only)\n`);

async function shutdown(): Promise<void> {
  await control.close();
  await runtime.close();
  controlStore.close();
  guestAccess.close();
  storage.close();
}

process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
