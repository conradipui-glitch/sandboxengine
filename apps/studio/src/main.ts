// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { mkdir } from "node:fs/promises";
// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { dirname, resolve } from "node:path";
import { SQLiteControlStore } from "@living-history/control";
import { createStudioDevServer } from "./dev-server.js";

type ControlServerModule = typeof import("../../server/src/control-server.js");

declare const process: any;

const databasePath = resolve(String(process.env.LH_DATABASE_PATH ?? "./data/living-history.sqlite"));
await mkdir(dirname(databasePath), { recursive: true });

const store = new SQLiteControlStore({ path: databasePath });
const controlServerModule = await import(new URL("../../../server/dist/control-server.js", import.meta.url).href) as ControlServerModule;
const control = controlServerModule.createControlHttpServer({ store });
const controlAddress = await control.listen(Number(process.env.LH_CONTROL_PORT ?? 0), "127.0.0.1");
const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
const studioAddress = await studio.listen(Number(process.env.LH_STUDIO_PORT ?? 4173), "127.0.0.1");

console.log(`Living History Studio: http://${studioAddress.host}:${studioAddress.port}`);
console.log(`Control API (loopback only): http://${controlAddress.host}:${controlAddress.port}`);

const shutdown = async () => {
  await studio.close();
  await control.close();
  store.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
