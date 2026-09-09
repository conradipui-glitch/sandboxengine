// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { resolve } from "node:path";
import { closeAllPlayers, launchFrozenPlayer } from "./launch.js";

declare const process: any;

const databasePath = resolve(String(process.env.LH_DATABASE_PATH ?? "./data/living-history.sqlite"));
const playtestId = String(process.env.LH_PLAYTEST_ID ?? "").trim();
if (playtestId.length === 0) {
  throw new Error("LH_PLAYTEST_ID is required. Create a valid frozen playtest first, then start Player with that playtest id.");
}

const launched = await launchFrozenPlayer({
  databasePath,
  playtestId,
  port: envPort(process.env.LH_PLAYER_PORT, 4180),
  runtimePort: envPort(process.env.LH_RUNTIME_PORT, 0)
});
if (!launched.ok) throw new Error(launched.message);

console.log(`Living History Player: ${launched.url}`);
console.log(`Frozen playtest: ${launched.playtestId}`);

const shutdown = async () => {
  await closeAllPlayers();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function envPort(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error("Invalid local port");
  return parsed;
}
