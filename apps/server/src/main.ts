// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { mkdirSync } from "node:fs";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { dirname, resolve } from "node:path";
import {
  SQLiteGuestSessionAccess,
  SQLiteRuntimeStorage
} from "@living-history/runtime";
import { createMinimalPaintTemplate, createRuntimeHttpServer } from "./server.js";

declare const process: any;

const databasePath = resolve(String(process.env.RUNTIME_DB_PATH ?? "./data/runtime.sqlite"));
const port = Number(process.env.PORT ?? 8787);
const host = String(process.env.HOST ?? "127.0.0.1");

mkdirSync(dirname(databasePath), { recursive: true });
const clock = Object.freeze({ nowMs: () => Date.now() });
const storage = new SQLiteRuntimeStorage({ path: databasePath, clock });
const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
const runtime = createRuntimeHttpServer({
  storage,
  guestAccess,
  templates: [createMinimalPaintTemplate()]
});

await runtime.listen(port, host);
process.stdout.write(`Living History Runtime listening on http://${host}:${port}\n`);

async function shutdown(): Promise<void> {
  await runtime.close();
  guestAccess.close();
  storage.close();
}

process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
