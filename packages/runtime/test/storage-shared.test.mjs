import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManualServiceClock,
  MemoryRuntimeStorage,
  SQLiteRuntimeStorage
} from "../dist/index.js";
import {
  registerRuntimeStorageContractSuite,
  seedSession
} from "./storage-contract-suite.mjs";

registerRuntimeStorageContractSuite("Memory shared contract", async () => {
  const clock = new ManualServiceClock(1_000);
  const storage = new MemoryRuntimeStorage({ clock, sessions: [seedSession()] });
  return {
    storage,
    clock,
    inspectTurns: () => storage.inspectTurnsForTest("session-1")
  };
});

registerRuntimeStorageContractSuite("SQLite shared contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "living-history-storage-"));
  const path = join(directory, "runtime.sqlite");
  const clock = new ManualServiceClock(1_000);
  const storage = new SQLiteRuntimeStorage({ path, clock, sessions: [seedSession()] });
  return {
    storage,
    clock,
    inspectTurns: () => storage.inspectTurnsForTest("session-1"),
    cleanup: async () => {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
});
