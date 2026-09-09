// @ts-ignore — Node 24.19.0 provides node:fs; no @types/node dependency yet.
import { mkdir } from "node:fs/promises";
// @ts-ignore — Node 24.19.0 provides node:path; no @types/node dependency yet.
import { dirname, resolve } from "node:path";
import type { ActionBlock, JsonValue, LocationBlock, ResourceBlock } from "@living-history/contracts";
import { SQLiteControlStore } from "@living-history/control";
import { bootstrapFrozenPlaytest } from "@living-history/player";
import { SQLiteGuestSessionAccess, SQLiteRuntimeStorage, type ServiceClock } from "@living-history/runtime";
import { createPlayerDevServer, type PlayerSurfaceMetadata } from "./dev-server.js";

type RuntimeServerModule = typeof import("../../server/src/server.js");
type ActionServiceModule = typeof import("../../server/src/action-service.js");
type PresentationStorageModule = typeof import("../../server/src/presentation-storage.js");

export interface LaunchFrozenPlayerOptions {
  readonly databasePath: string;
  readonly playtestId: string;
  readonly port?: number;
  readonly host?: string;
}

export type LaunchFrozenPlayerResult =
  | { readonly ok: true; readonly url: string; readonly playtestId: string; close(): Promise<void> }
  | { readonly ok: false; readonly code: "playtest_not_found" | "unsupported_playtest" | "invalid_playtest" | "display_incomplete" | "listen_failed"; readonly message: string };

interface ManagedPlayer {
  close(): Promise<void>;
}

const managedPlayers = new Map<string, ManagedPlayer>();

export function isPlayerRunning(playtestId: string): boolean {
  return managedPlayers.has(playtestId);
}

export function runningPlayerIds(): readonly string[] {
  return [...managedPlayers.keys()];
}

export async function closePlayer(playtestId: string): Promise<void> {
  const player = managedPlayers.get(playtestId);
  if (!player) return;
  managedPlayers.delete(playtestId);
  await player.close();
}

export async function closeAllPlayers(): Promise<void> {
  const ids = [...managedPlayers.keys()];
  for (const id of ids) await closePlayer(id);
}

/**
 * Launch one frozen playtest Player bound to databasePath. Reuses a running
 * Player for the same playtestId; callers must close it via the returned handle
 * or closePlayer/closeAllPlayers. Refusals are explicit codes, never guesses.
 */
const launchChains = new Map<string, Promise<LaunchFrozenPlayerResult>>();
let anyLaunchChain: Promise<unknown> = Promise.resolve();

export async function launchFrozenPlayer(options: LaunchFrozenPlayerOptions): Promise<LaunchFrozenPlayerResult> {
  const requestedId = String(options.playtestId ?? "").trim();
  // In-process mutex: two concurrent launches (same or different ids) must never race
  // past the managedPlayers cache and start duplicate servers.
  const chained = anyLaunchChain.catch(() => undefined).then(() => launchFrozenPlayerUncached(options, requestedId));
  anyLaunchChain = chained;
  return chained;
}

async function launchFrozenPlayerUncached(options: LaunchFrozenPlayerOptions, requestedId: string): Promise<LaunchFrozenPlayerResult> {
  const playtestId = requestedId;
  const databasePath = resolve(options.databasePath);
  if (playtestId.length === 0) return failure("invalid_playtest", "Playtest id is empty.");

  const existing = managedPlayers.get(playtestId);
  if (existing) {
    const url = playerUrls.get(playtestId);
    if (url) return Object.freeze({ ok: true as const, url, playtestId, close: () => closePlayer(playtestId) });
    managedPlayers.delete(playtestId);
  }

  const started = await startPlayer({ ...options, databasePath, playtestId });
  return started;
}

const playerUrls = new Map<string, string>();

async function startPlayer(options: LaunchFrozenPlayerOptions & { readonly playtestId: string }): Promise<LaunchFrozenPlayerResult> {
  const { databasePath, playtestId } = options;
  await mkdir(dirname(databasePath), { recursive: true });
  const controlStore = new SQLiteControlStore({ path: databasePath });
  try {
    const playtest = await controlStore.getPlaytest(playtestId);
    if (!playtest) {
      controlStore.close();
      return failure("playtest_not_found", `Frozen playtest not found: ${playtestId}`);
    }

    const bootstrapped = bootstrapFrozenPlaytest(playtest);
    if (!bootstrapped.ok) {
      controlStore.close();
      return failure(bootstrapped.code === "unsupported_playtest" ? "unsupported_playtest" : "invalid_playtest",
        `Frozen playtest cannot start Player: ${bootstrapped.code}`);
    }
    const template = bootstrapped.template;
    if (template.paintActions.length !== 1) {
      controlStore.close();
      return failure("unsupported_playtest", `Player supports exactly one core.paint action, playtest has ${template.paintActions.length}`);
    }
    const definition = template.paintActions[0];
    if (!definition) {
      controlStore.close();
      return failure("unsupported_playtest", "Player has no supported action definition");
    }

    const actionBlock = playtest.snapshot.blocks.find(
      (block): block is ActionBlock => block.kind === "core.action" && block.id === definition.id
    );
    const resourceBlock = playtest.snapshot.blocks.find(
      (block): block is ResourceBlock => block.kind === "core.resource" && block.id === definition.resourceId
    );
    const locationBlock = playtest.snapshot.blocks.find(
      (block): block is LocationBlock => block.kind === "core.location" && block.id === playtest.snapshot.entryLocationId
    );
    if (!actionBlock || !resourceBlock || !locationBlock) {
      controlStore.close();
      return failure("display_incomplete", "Frozen playtest display metadata is incomplete");
    }

    const runtimeServerModule = await import(new URL("../../../server/dist/server.js", import.meta.url).href) as RuntimeServerModule;
    const actionServiceModule = await import(new URL("../../../server/dist/action-service.js", import.meta.url).href) as ActionServiceModule;
    const presentationStorageModule = await import(new URL("../../../server/dist/presentation-storage.js", import.meta.url).href) as PresentationStorageModule;
    const serviceClock: ServiceClock = Object.freeze({ nowMs: () => Date.now() });
    const rawStorage = new SQLiteRuntimeStorage({ path: databasePath, clock: serviceClock });
    const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });
    const presentationTemplate = presentationStorageModule.createReferencePresentationTemplate({
      sceneId: locationBlock.id,
      state: template.initialState
    });
    const storage = new presentationStorageModule.PresentationRuntimeStorage(rawStorage, [
      Object.freeze({ release: template.release, presentation: presentationTemplate })
    ]);
    const runtime = runtimeServerModule.createRuntimeHttpServer({
      storage,
      guestAccess,
      templates: [{
        templateId: template.templateId,
        release: template.release,
        initialState: template.initialState,
        intentCatalog: actionServiceModule.createPaintIntentCatalog()
      }],
      executor: actionServiceModule.createCoreExplicitActionExecutorForDefinition(definition)
    });

    const host = options.host ?? "127.0.0.1";
    let runtimeAddress: { readonly host: string; readonly port: number };
    try {
      runtimeAddress = await runtime.listen(0, host);
    } catch (error) {
      guestAccess.close();
      rawStorage.close();
      controlStore.close();
      return failure("listen_failed", error instanceof Error ? error.message : "Runtime listen failed");
    }

    const metadata: PlayerSurfaceMetadata = Object.freeze({
      templateId: template.templateId,
      playtestId: template.playtestId,
      questTitle: template.title,
      locationTitle: locationBlock.title,
      sceneText: locationBlock.description || actionBlock.description || "Проверьте действие в замороженной версии квеста.",
      resourceId: resourceBlock.id,
      resourceTitle: resourceBlock.title,
      resourceUnit: resourceBlock.data.unit,
      actionId: actionBlock.id,
      actionTitle: actionBlock.title
    });
    const player = createPlayerDevServer({
      runtimeOrigin: `http://${runtimeAddress.host}:${runtimeAddress.port}`,
      metadata,
      presentation: {
        release: Object.freeze({ questId: template.release.questId, releaseId: template.release.releaseId }),
        assets: presentationTemplate.catalog.assets,
        initialForSession(sessionId): JsonValue | null {
          const initial = presentationStorageModule.buildInitialReferencePresentation({
            template: presentationTemplate,
            sessionId,
            release: template.release
          });
          return initial === null ? null : JSON.parse(JSON.stringify(initial)) as JsonValue;
        }
      }
    });

    let playerAddress: { readonly host: string; readonly port: number };
    try {
      playerAddress = await player.listen(options.port ?? 0, host);
    } catch (error) {
      await runtime.close();
      guestAccess.close();
      rawStorage.close();
      controlStore.close();
      return failure("listen_failed", error instanceof Error ? error.message : "Player listen failed");
    }

    const url = `http://${playerAddress.host}:${playerAddress.port}`;
    const closeOnce = once(() => {
      playerUrls.delete(playtestId);
    });
    const handle: ManagedPlayer = Object.freeze({
      close: async () => {
        closeOnce();
        await player.close();
        await runtime.close();
        guestAccess.close();
        rawStorage.close();
        controlStore.close();
      }
    });
    managedPlayers.set(playtestId, handle);
    playerUrls.set(playtestId, url);
    return Object.freeze({ ok: true as const, url, playtestId, close: () => closePlayer(playtestId) });
  } catch (error) {
    try { controlStore.close(); } catch { /* already closed on a failure path */ }
    return failure("invalid_playtest", error instanceof Error ? error.message : "Player launch failed");
  }
}

function failure(code: Extract<LaunchFrozenPlayerResult, { ok: false }>["code"], message: string): LaunchFrozenPlayerResult {
  return Object.freeze({ ok: false as const, code, message });
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
