// @ts-ignore — repository is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createServer } from "node:http";
// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import { canonicalStringify } from "@living-history/core";
import {
  MAX_LHQUEST_ARCHIVE_BYTES,
  createControlOpaqueSecret,
  createControlSessionId,
  hashControlOpaqueSecret,
  isAllowedLocalHttpRequest,
  isControlProjectRole,
  type AuthorConversationStore,
  type ControlProjectRole,
  type ControlPublicationRecord,
  type ControlPublicationStore,
  type ControlReleaseRecord,
  type ControlReleaseStore,
  type ControlSecurityStore,
  type ControlSessionRecord,
  type ControlStore,
  type BoardDocumentStore,
  type CollaborationStore,
  type CollaborationWriteResult,
  type ControlUserRecord,
  type DraftSnapshot,
  type DraftValidationRecord,
  type FrozenPlaytestRecord,
  type MissionDocumentStore,
  type MissionSessionStore,
  type ProjectAssetLibrary,
  type SaveMissionResult
} from "@living-history/control";
import type { PluginRegistrySnapshot } from "@living-history/plugins";
import {
  AssetBoundaryError,
  DEFAULT_ASSET_LIMITS,
  LocalAssetStore,
  ingestAsset
} from "@living-history/assets";
import type { DiceCheckDefinition } from "@living-history/plugins/dice-check";
import type { PlaytestTraceReader } from "@living-history/runtime";
import { buildControlRelease } from "./release-authority.js";
import { publishControlRelease, rollbackControlRelease } from "./release-publication.js";
import { routeDraftVersionHttp } from "./draft-version-http.js";
import type { AuthorAssistantDependencies } from "./author-assistant.js";
import { buildInstalledAuthorContextCapabilityCatalog } from "./author-context-catalog.js";
import {
  AGENT_KIT_DOCS_HASH_HEADER,
  AGENT_KIT_ENGINE_VERSION_HEADER,
  AGENT_KIT_REGISTRY_HASH_HEADER,
  agentKitHandshakeMatches,
  loadInstalledAgentKit,
  type InstalledAgentKit
} from "./agent-kit.js";

const MAX_CONTROL_BODY_CHARS = 262_144;
const MAX_CONTROL_IMPORT_BODY_CHARS = Math.ceil(MAX_LHQUEST_ARCHIVE_BYTES / 3) * 4 + 1_024;
const CONTROL_SESSION_COOKIE = "lh_control_session";
const CONTROL_CSRF_HEADER = "x-csrf-token";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_LOGIN_WINDOW_MS = 60_000;
const DEFAULT_LOGIN_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;

export interface ControlAuthenticatedModeOptions {
  readonly security: ControlSecurityStore;
  readonly allowedOrigins: readonly string[];
  readonly secureCookies: boolean;
  readonly sessionTtlMs?: number;
  readonly loginWindowMs?: number;
  readonly loginCooldownMs?: number;
  readonly maxLoginAttempts?: number;
  readonly nowMs?: () => number;
}

export interface ControlReleaseModeOptions {
  readonly store: ControlReleaseStore;
  readonly publicationStore?: ControlPublicationStore;
  readonly publicMissionSessionSecret?: string;
  readonly pluginRegistry: PluginRegistrySnapshot;
  readonly nowMs?: () => number;
}

export interface ControlServerDependencies {
  readonly store: ControlStore;
  readonly boardStore?: BoardDocumentStore;
  readonly collaborationStore?: CollaborationStore;
  readonly missionStore?: MissionDocumentStore & MissionSessionStore;
  readonly assetStorage?: LocalAssetStore;
  readonly assetLibrary?: ProjectAssetLibrary;
  readonly releases?: ControlReleaseModeOptions;
  readonly playtestTrace?: PlaytestTraceReader;
  readonly authorAssistant?: Omit<AuthorAssistantDependencies, "store"> & { readonly conversation: AuthorConversationStore };
  readonly auth?: ControlAuthenticatedModeOptions;
}

export interface ControlHttpServer {
  readonly server: any;
  readonly accessMode: "local-loopback-owner" | "authenticated";
  listen(port?: number, host?: string): Promise<{ readonly port: number; readonly host: string }>;
  close(): Promise<void>;
}

interface AuthRuntime {
  readonly security: ControlSecurityStore;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly secureCookies: boolean;
  readonly sessionTtlMs: number;
  readonly loginWindowMs: number;
  readonly loginCooldownMs: number;
  readonly maxLoginAttempts: number;
  readonly nowMs: () => number;
}

interface AuthIdentity {
  readonly user: ControlUserRecord;
  readonly session: ControlSessionRecord;
}

interface LoginFailureState {
  count: number;
  windowStartedAtMs: number;
  blockedUntilMs: number;
}

export function createControlHttpServer(dependencies: ControlServerDependencies): ControlHttpServer {
  const auth = dependencies.auth ? buildAuthRuntime(dependencies.auth) : null;
  const releases = dependencies.releases ?? null;
  const boardStore = dependencies.boardStore ?? (isBoardDocumentStore(dependencies.store) ? dependencies.store as BoardDocumentStore : null);
  const collaborationStore = dependencies.collaborationStore ?? (isCollaborationStore(dependencies.store) ? dependencies.store as CollaborationStore : null);
  const missionStore = dependencies.missionStore ?? (isMissionStore(dependencies.store) ? dependencies.store as MissionDocumentStore & MissionSessionStore : null);
  const assetLibrary = dependencies.assetLibrary ?? (isProjectAssetLibrary(dependencies.store) ? dependencies.store as ProjectAssetLibrary : null);
  const authorAssistant = dependencies.authorAssistant
    ? Object.freeze({
        ...dependencies.authorAssistant,
        capabilityCatalog: buildInstalledAuthorContextCapabilityCatalog(releases?.pluginRegistry ?? null)
      })
    : null;
  const agentKit = loadInstalledAgentKit();
  const failures = new Map<string, LoginFailureState>();
  const server = createServer(async (request: any, response: any) => {
    try {
      await routeControlRequest(
        request,
        response,
        dependencies.store,
        boardStore,
        collaborationStore,
        missionStore,
        dependencies.assetStorage ?? null,
        assetLibrary,
        releases,
        dependencies.playtestTrace ?? null,
        authorAssistant,
        agentKit,
        auth,
        failures
      );
    } catch (error) {
      if (isSqliteBusy(error)) {
        sendJson(response, 503, { error: { code: "CONTROL_STORAGE_BUSY" } });
        return;
      }
      sendJson(response, 500, { error: { code: "CONTROL_INTERNAL_ERROR" } });
    }
  });

  return Object.freeze({
    server,
    accessMode: auth ? "authenticated" as const : "local-loopback-owner" as const,
    listen(port = 0, host = "127.0.0.1"): Promise<{ readonly port: number; readonly host: string }> {
      if (!isLoopbackHost(host)) {
        if (!auth) return Promise.reject(new Error("Control API may listen on non-loopback only in authenticated mode"));
        if (!auth.secureCookies) return Promise.reject(new Error("authenticated non-loopback Control requires Secure cookies"));
        if (auth.allowedOrigins.size < 1) return Promise.reject(new Error("authenticated non-loopback Control requires at least one allowed origin"));
      }
      return new Promise((resolve, reject) => {
        const onError = (error: unknown) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("control server has no TCP address"));
            return;
          }
          resolve(Object.freeze({ port: address.port, host }));
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close(): Promise<void> {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve, reject) => {
        server.close((error: unknown) => error ? reject(error) : resolve());
      });
    }
  });
}

async function routeControlRequest(
  request: any,
  response: any,
  store: ControlStore,
  boardStore: BoardDocumentStore | null,
  collaborationStore: CollaborationStore | null,
  missionStore: (MissionDocumentStore & MissionSessionStore) | null,
  assetStorage: LocalAssetStore | null,
  assetLibrary: ProjectAssetLibrary | null,
  releases: ControlReleaseModeOptions | null,
  playtestTrace: PlaytestTraceReader | null,
  authorAssistant: (Omit<AuthorAssistantDependencies, "store"> & { readonly conversation: AuthorConversationStore }) | null,
  agentKit: InstalledAgentKit,
  auth: AuthRuntime | null,
  failures: Map<string, LoginFailureState>
): Promise<void> {
  const method = String(request.method ?? "GET").toUpperCase();
  const url = new URL(String(request.url ?? "/"), "http://control.local");
  const isPublicMissionEndpoint = url.pathname.startsWith("/public/v1/missions");
  // Public identifiers (e.g. `mission:project:quest`) arrive percent-encoded from
  // HTTP clients; match public routes against the decoded form.
  let publicPathname = url.pathname;
  if (isPublicMissionEndpoint) {
    try { publicPathname = decodeURIComponent(url.pathname); } catch { publicPathname = url.pathname; }
  }

  if (!isPublicMissionEndpoint && !auth && !isAllowedLocalHttpRequest(request)) {
    sendJson(response, 403, { error: { code: "CONTROL_LOCAL_ORIGIN_DENIED" } });
    return;
  }
  if (!isPublicMissionEndpoint && auth && !originAllowed(request, auth)) {
    sendJson(response, 403, { error: { code: "CONTROL_ORIGIN_DENIED" } });
    return;
  }
  if (auth) {
    const origin = readHeader(request, "origin");
    if (origin) applyCorsHeaders(response, origin);
    if (method === "OPTIONS" && url.pathname.startsWith("/control/v1/")) {
      sendCorsPreflight(response);
      return;
    }
  }

  const publicMissionMatch = /^\/public\/v1\/missions(?:\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199}))?$/.exec(publicPathname);
  if (method === "GET" && releases?.publicationStore && publicMissionMatch) {
    if (url.searchParams.size !== 0) {
      sendJson(response, 400, { error: { code: "INVALID_PUBLIC_CATALOG_REQUEST" } });
      return;
    }
    const identifier = publicMissionMatch[1];
    if (identifier) {
      const mission = await releases.publicationStore.getPublicMission(identifier);
      if (!mission) sendNotFound(response);
      else sendJson(response, 200, { mission: publicPublicationView(mission) });
    } else {
      const missions = await releases.publicationStore.listPublished();
      sendJson(response, 200, { missions: missions.map(publicPublicationView) });
    }
    return;
  }

  const publicSessionMatch = /^\/public\/v1\/missions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/sessions(?:\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})(\/turns)?)?$/.exec(publicPathname);
  if (publicSessionMatch && releases?.publicationStore && missionStore) {
    await routePublicMissionSession(request, response, method, publicSessionMatch, releases, missionStore);
    return;
  }

  // Assets of the revision a *started* game is pinned to. This is the path the
  // published-mission BFF uses: it carries the session credential, so a game
  // that is already running keeps its own artwork after the mission is
  // republished — or taken down.
  const publicSessionAssetMatch = /^\/public\/v1\/missions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/assets\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(publicPathname);
  if (method === "GET" && publicSessionAssetMatch && releases?.publicationStore && missionStore) {
    await routePublicMissionSessionAsset(request, response, publicSessionAssetMatch, releases, missionStore, assetStorage, assetLibrary);
    return;
  }

  // Public, credentialless bytes of an asset that belongs to the *pinned*
  // published revision. Anything else stays private.
  const publicAssetMatch = /^\/public\/v1\/missions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/assets\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(publicPathname);
  if (method === "GET" && publicAssetMatch && releases?.publicationStore && missionStore) {
    await routePublicMissionAsset(response, publicAssetMatch, releases, missionStore, assetStorage, assetLibrary);
    return;
  }

  if (auth && url.pathname === "/control/v1/auth/login" && method === "POST") {
    await handleLogin(request, response, auth, failures);
    return;
  }

  const identity = auth ? await resolveIdentity(request, auth) : null;
  if (auth && !identity) {
    sendJson(response, 401, { error: { code: "CONTROL_AUTH_REQUIRED" } });
    return;
  }

  if (auth && url.pathname === "/control/v1/auth/session" && method === "GET") {
    sendJson(response, 200, { user: identity!.user, session: safeSessionView(identity!.session) });
    return;
  }

  if (auth && url.pathname === "/control/v1/auth/logout" && method === "POST") {
    if (!(await requireMutationProof(request, response, auth, identity!))) return;
    await auth.security.revokeSession(identity!.session.sessionId);
    response.setHeader("set-cookie", expiredSessionCookie(auth.secureCookies));
    sendJson(response, 200, { revoked: true });
    return;
  }

  if (url.pathname === "/control/v1/agent-kit") {
    if (method !== "GET") { sendNotFound(response); return; }
    if (url.searchParams.size !== 0) {
      sendJson(response, 400, { error: { code: "INVALID_AGENT_KIT_REQUEST" } });
      return;
    }
    sendJson(response, 200, agentKit);
    return;
  }

  if (url.pathname === "/control/v1/projects") {
    if (method === "GET") {
      if (auth) {
        const projects = await auth.security.listProjectsForUser(identity!.user.userId);
        const views = await Promise.all(projects.map(async (project) => {
          const role = await auth.security.getProjectRole(project.projectId, identity!.user.userId);
          if (role === null) throw new Error("Control project membership disappeared during project listing");
          return Object.freeze({ ...project, role });
        }));
        sendJson(response, 200, { projects: views });
      } else {
        const projects = await store.listProjects();
        sendJson(response, 200, {
          projects: projects.map((project) => Object.freeze({ ...project, role: "owner" as const }))
        });
      }
      return;
    }
    if (method === "POST") {
      if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
      const body = await requireJsonObject(request, response);
      if (body === null) return;
      if (!hasExactKeys(body, ["projectId", "title"]) || !isId(body.projectId) || !isTitle(body.title)) {
        sendJson(response, 400, { error: { code: "INVALID_PROJECT" } });
        return;
      }
      const result = auth
        ? await auth.security.createProjectAsOwner({ projectId: body.projectId, title: body.title }, identity!.user.userId)
        : await store.createProject({ projectId: body.projectId, title: body.title });
      if (result.kind === "created") {
        sendJson(response, 201, { project: Object.freeze({ ...result.project, role: "owner" as const }) });
      }
      else if (result.kind === "project_exists") sendJson(response, 409, { error: { code: "PROJECT_EXISTS" } });
      else sendJson(response, 400, { error: { code: "INVALID_PROJECT" } });
      return;
    }
  }

  const memberCollectionMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/members$/.exec(url.pathname);
  if (memberCollectionMatch) {
    if (!auth) { sendNotFound(response); return; }
    const projectId = memberCollectionMatch[1];
    if (!projectId) { sendNotFound(response); return; }
    const role = await authorizeProject(response, auth, identity!, projectId, "owner");
    if (!role) return;
    if (method === "GET") {
      const members = await auth.security.listProjectMembers(projectId);
      if (members === null) sendNotFound(response);
      else sendJson(response, 200, { members });
      return;
    }
  }

  const memberItemMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/members\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(url.pathname);
  if (memberItemMatch) {
    if (!auth) { sendNotFound(response); return; }
    const projectId = memberItemMatch[1];
    const userId = memberItemMatch[2];
    if (!projectId || !userId) { sendNotFound(response); return; }
    const role = await authorizeProject(response, auth, identity!, projectId, "owner");
    if (!role) return;
    if (method === "PUT") {
      if (!(await requireMutationProof(request, response, auth, identity!))) return;
      const body = await requireJsonObject(request, response);
      if (body === null) return;
      if (!hasExactKeys(body, ["role"]) || !isControlProjectRole(body.role)) {
        sendJson(response, 400, { error: { code: "INVALID_PROJECT_ROLE" } });
        return;
      }
      if (userId === identity!.user.userId && body.role !== "owner") {
        sendJson(response, 409, { error: { code: "SELF_MEMBERSHIP_CHANGE_FORBIDDEN" } });
        return;
      }
      const result = await auth.security.setProjectMemberRole(projectId, userId, body.role);
      if (result.kind === "updated") sendJson(response, 200, { member: result.member });
      else if (result.kind === "last_owner") sendJson(response, 409, { error: { code: "LAST_PROJECT_OWNER" } });
      else if (result.kind === "user_not_found") sendJson(response, 404, { error: { code: "USER_NOT_FOUND" } });
      else if (result.kind === "project_not_found") sendNotFound(response);
      else sendJson(response, 400, { error: { code: "INVALID_PROJECT_ROLE" } });
      return;
    }
    if (method === "DELETE") {
      if (!(await requireMutationProof(request, response, auth, identity!))) return;
      if (userId === identity!.user.userId) {
        sendJson(response, 409, { error: { code: "SELF_MEMBERSHIP_CHANGE_FORBIDDEN" } });
        return;
      }
      const result = await auth.security.removeProjectMember(projectId, userId);
      if (result.kind === "removed") sendJson(response, 200, { removed: true });
      else if (result.kind === "last_owner") sendJson(response, 409, { error: { code: "LAST_PROJECT_OWNER" } });
      else if (result.kind === "member_not_found") sendJson(response, 404, { error: { code: "MEMBER_NOT_FOUND" } });
      else if (result.kind === "project_not_found") sendNotFound(response);
      else sendJson(response, 400, { error: { code: "INVALID_MEMBER_REQUEST" } });
      return;
    }
  }

  const questsMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests$/.exec(url.pathname);
  if (questsMatch) {
    const projectId = questsMatch[1];
    if (!projectId) { sendNotFound(response); return; }
    if (!(await requireProjectRole(response, auth, identity, projectId, method === "POST" ? "editor" : "tester"))) return;
    if (method === "GET") {
      const quests = await store.listQuests(projectId);
      if (quests === null) sendNotFound(response);
      else sendJson(response, 200, { quests: quests.map(projectDraftView) });
      return;
    }
    if (method === "POST") {
      if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
      const body = await requireJsonObject(request, response);
      if (body === null) return;
      if (!hasExactKeys(body, ["questId", "title", "entryLocationId", "initialBlocks"])
        || !isId(body.questId) || !isTitle(body.title) || !isId(body.entryLocationId) || !Array.isArray(body.initialBlocks)) {
        sendJson(response, 400, { error: { code: "INVALID_QUEST" } });
        return;
      }
      const result = await store.createQuest({
        projectId,
        questId: body.questId,
        title: body.title,
        entryLocationId: body.entryLocationId,
        initialBlocks: body.initialBlocks as any
      });
      if (result.kind === "created") sendJson(response, 201, { draft: result.draft });
      else if (result.kind === "project_not_found") sendNotFound(response);
      else if (result.kind === "quest_exists") sendJson(response, 409, { error: { code: "QUEST_EXISTS" } });
      else sendJson(response, 422, { error: { code: "INVALID_QUEST", details: result.errors } });
      return;
    }
  }

  const draftMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/draft$/.exec(url.pathname);
  if (method === "GET" && draftMatch) {
    const projectId = draftMatch[1];
    const questId = draftMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
    const draft = await store.getDraft(projectId, questId);
    if (!draft) sendNotFound(response);
    else sendJson(response, 200, { draft });
    return;
  }

  const changesMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/draft\/changes$/.exec(url.pathname);
  if (method === "POST" && changesMatch) {
    const projectId = changesMatch[1];
    const questId = changesMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    if (!(await requireProjectRole(response, auth, identity, projectId, "editor"))) return;
    if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
    const body = await requireJsonObject(request, response);
    if (body === null) return;
    const result = await store.applyDraftChanges(projectId, questId, body as any);
    if (result.kind === "updated") sendJson(response, 200, { draft: result.draft });
    else if (result.kind === "project_not_found" || result.kind === "quest_not_found") sendNotFound(response);
    else if (result.kind === "revision_conflict") {
      sendJson(response, 409, { error: { code: "DRAFT_REVISION_CONFLICT", currentRevision: result.currentRevision } });
    } else {
      sendJson(response, 422, { error: { code: "INVALID_DRAFT_CHANGE_SET", details: result.errors } });
    }
    return;
  }

  const boardMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/board(?:\/changes)?$/.exec(url.pathname);
  if (boardMatch) {
    const projectId = boardMatch[1];
    const questId = boardMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    if (boardStore === null) {
      sendJson(response, 501, { error: { code: "BOARD_STORAGE_UNAVAILABLE" } });
      return;
    }
    const isChanges = url.pathname.endsWith("/changes");
    if (!isChanges && method === "GET") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
      const board = await boardStore.getBoardDocument(projectId, questId);
      if (!board) sendNotFound(response);
      else sendJson(response, 200, { board });
      return;
    }
    if (isChanges && method === "POST") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "editor"))) return;
      if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
      const idempotencyKey = requireIdempotencyKey(request, response);
      if (idempotencyKey === null) return;
      const body = await requireJsonObject(request, response);
      if (body === null) return;
      if (!hasExactKeys(body, ["baseRevision", "positions"])
        || !isRevision(body.baseRevision) || !isPlainObject(body.positions)) {
        sendJson(response, 400, { error: { code: "INVALID_BOARD_CHANGE_SET" } });
        return;
      }
      const result = await boardStore.applyBoardChanges(projectId, questId, {
        baseRevision: body.baseRevision,
        positions: body.positions,
        idempotencyKey,
        actorUserId: identity?.user.userId ?? "local-owner"
      });
      if (result.kind === "updated") sendJson(response, 200, { board: result.board });
      else if (result.kind === "replay") sendJson(response, 200, { board: result.board, replay: true });
      else if (result.kind === "project_not_found" || result.kind === "quest_not_found") sendNotFound(response);
      else if (result.kind === "revision_conflict") {
        sendJson(response, 409, { error: { code: "BOARD_REVISION_CONFLICT", currentRevision: result.currentRevision } });
      } else if (result.kind === "idempotency_key_reused") {
        sendJson(response, 409, { error: { code: "BOARD_IDEMPOTENCY_KEY_REUSED" } });
      } else {
        sendJson(response, 422, { error: { code: "INVALID_BOARD_CHANGE_SET", details: result.errors } });
      }
      return;
    }
    sendNotFound(response);
    return;
  }

  const collaborationMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/collaboration(\/.*)?$/.exec(url.pathname);
  if (collaborationMatch) {
    const projectId = collaborationMatch[1];
    const questId = collaborationMatch[2];
    const rest = collaborationMatch[3] ?? "";
    if (!projectId || !questId) { sendNotFound(response); return; }
    if (collaborationStore === null) {
      sendJson(response, 501, { error: { code: "COLLABORATION_STORAGE_UNAVAILABLE" } });
      return;
    }

    const sendCollaboration = (result: CollaborationWriteResult): void => {
      if (result.kind === "created") sendJson(response, 201, { collaboration: result.view });
      else if (result.kind === "updated") sendJson(response, 200, { collaboration: result.view });
      else if (result.kind === "replay") sendJson(response, 200, { collaboration: result.view, replay: true });
      else if (result.kind === "project_not_found" || result.kind === "quest_not_found" || result.kind === "not_found") sendNotFound(response);
      else if (result.kind === "forbidden") sendJson(response, 403, { error: { code: "COLLABORATION_FORBIDDEN" } });
      else if (result.kind === "revision_conflict") {
        sendJson(response, 409, { error: { code: "COLLABORATION_REVISION_CONFLICT", currentRevision: result.currentRevision } });
      } else if (result.kind === "idempotency_key_reused") {
        sendJson(response, 409, { error: { code: "COLLABORATION_IDEMPOTENCY_KEY_REUSED" } });
      } else {
        sendJson(response, 422, { error: { code: "INVALID_COLLABORATION_REQUEST", details: result.errors } });
      }
    };

    const beginCollaborationWrite = async (): Promise<{ idempotencyKey: string; body: Record<string, any> } | null> => {
      if (!(await requireProjectRole(response, auth, identity, projectId, "editor"))) return null;
      if (auth && !(await requireMutationProof(request, response, auth, identity!))) return null;
      const idempotencyKey = requireIdempotencyKey(request, response);
      if (idempotencyKey === null) return null;
      const body = await requireJsonObject(request, response);
      if (body === null) return null;
      return { idempotencyKey, body };
    };

    const collaborationActorUserId = identity?.user.userId ?? "local-owner";
    const collaborationActorRole = auth && identity
      ? (await auth.security.getProjectRole(projectId, identity.user.userId)) ?? "tester"
      : "owner";

    if (rest === "" || rest === "/") {
      if (method !== "GET") { sendNotFound(response); return; }
      if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
      const view = await collaborationStore.getCollaboration(projectId, questId);
      if (!view) sendNotFound(response);
      else sendJson(response, 200, { collaboration: view });
      return;
    }

    if (method !== "POST") {
      // Reads beyond the collection root are not part of the FIN-12 surface.
      sendNotFound(response);
      return;
    }

    const noteChangeMatch = /^\/notes\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/changes$/.exec(rest);
    if (noteChangeMatch) {
      const write = await beginCollaborationWrite();
      if (!write) return;
      if (!hasExactKeys(write.body, ["expectedRevision", "text", "position"])
        || !isRevision(write.body.expectedRevision) || !isPlainObject(write.body.position) || typeof write.body.text !== "string") {
        sendJson(response, 400, { error: { code: "INVALID_COLLABORATION_REQUEST" } });
        return;
      }
      sendCollaboration(await collaborationStore.changeNote(projectId, questId, {
        noteId: noteChangeMatch[1]!,
        expectedRevision: write.body.expectedRevision,
        text: write.body.text,
        position: write.body.position as any,
        idempotencyKey: write.idempotencyKey,
        actorUserId: collaborationActorUserId,
        actorRole: collaborationActorRole
      }));
      return;
    }

    const noteDeleteMatch = /^\/notes\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/delete$/.exec(rest);
    if (noteDeleteMatch) {
      const write = await beginCollaborationWrite();
      if (!write) return;
      if (!hasExactKeys(write.body, ["expectedRevision"]) || !isRevision(write.body.expectedRevision)) {
        sendJson(response, 400, { error: { code: "INVALID_COLLABORATION_REQUEST" } });
        return;
      }
      sendCollaboration(await collaborationStore.deleteNote(projectId, questId, {
        noteId: noteDeleteMatch[1]!,
        expectedRevision: write.body.expectedRevision,
        idempotencyKey: write.idempotencyKey,
        actorUserId: collaborationActorUserId,
        actorRole: collaborationActorRole
      }));
      return;
    }

    if (rest === "/notes") {
      const write = await beginCollaborationWrite();
      if (!write) return;
      if (!hasExactKeys(write.body, ["text", "position"]) || !isPlainObject(write.body.position) || typeof write.body.text !== "string") {
        sendJson(response, 400, { error: { code: "INVALID_COLLABORATION_REQUEST" } });
        return;
      }
      sendCollaboration(await collaborationStore.createNote(projectId, questId, {
        text: write.body.text,
        position: write.body.position as any,
        idempotencyKey: write.idempotencyKey,
        actorUserId: collaborationActorUserId
      }));
      return;
    }

    if (rest === "/comments") {
      const write = await beginCollaborationWrite();
      if (!write) return;
      if (!hasExactKeys(write.body, ["anchor", "text"]) || !isPlainObject(write.body.anchor) || typeof write.body.text !== "string") {
        sendJson(response, 400, { error: { code: "INVALID_COLLABORATION_REQUEST" } });
        return;
      }
      sendCollaboration(await collaborationStore.createThread(projectId, questId, {
        anchor: write.body.anchor as any,
        text: write.body.text,
        idempotencyKey: write.idempotencyKey,
        actorUserId: collaborationActorUserId
      }));
      return;
    }

    const messageChangeMatch = /^\/comments\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/messages\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/changes$/.exec(rest);
    if (messageChangeMatch) {
      const write = await beginCollaborationWrite();
      if (!write) return;
      if (!hasExactKeys(write.body, ["expectedRevision", "text"])
        || !isRevision(write.body.expectedRevision) || typeof write.body.text !== "string") {
        sendJson(response, 400, { error: { code: "INVALID_COLLABORATION_REQUEST" } });
        return;
      }
      sendCollaboration(await collaborationStore.changeMessage(projectId, questId, {
        threadId: messageChangeMatch[1]!,
        messageId: messageChangeMatch[2]!,
        expectedRevision: write.body.expectedRevision,
        text: write.body.text,
        idempotencyKey: write.idempotencyKey,
        actorUserId: collaborationActorUserId,
        actorRole: collaborationActorRole
      }));
      return;
    }

    const messageDeleteMatch = /^\/comments\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/messages\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/delete$/.exec(rest);
    if (messageDeleteMatch) {
      const write = await beginCollaborationWrite();
      if (!write) return;
      if (!hasExactKeys(write.body, ["expectedRevision"]) || !isRevision(write.body.expectedRevision)) {
        sendJson(response, 400, { error: { code: "INVALID_COLLABORATION_REQUEST" } });
        return;
      }
      sendCollaboration(await collaborationStore.deleteMessage(projectId, questId, {
        threadId: messageDeleteMatch[1]!,
        messageId: messageDeleteMatch[2]!,
        expectedRevision: write.body.expectedRevision,
        idempotencyKey: write.idempotencyKey,
        actorUserId: collaborationActorUserId,
        actorRole: collaborationActorRole
      }));
      return;
    }

    const replyMatch = /^\/comments\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/messages$/.exec(rest);
    if (replyMatch) {
      const write = await beginCollaborationWrite();
      if (!write) return;
      if (!hasExactKeys(write.body, ["text"]) || typeof write.body.text !== "string") {
        sendJson(response, 400, { error: { code: "INVALID_COLLABORATION_REQUEST" } });
        return;
      }
      sendCollaboration(await collaborationStore.addMessage(projectId, questId, {
        threadId: replyMatch[1]!,
        text: write.body.text,
        idempotencyKey: write.idempotencyKey,
        actorUserId: collaborationActorUserId
      }));
      return;
    }

    const statusMatch = /^\/comments\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/status$/.exec(rest);
    if (statusMatch) {
      const write = await beginCollaborationWrite();
      if (!write) return;
      if (!hasExactKeys(write.body, ["expectedRevision", "status"])
        || !isRevision(write.body.expectedRevision) || (write.body.status !== "open" && write.body.status !== "resolved")) {
        sendJson(response, 400, { error: { code: "INVALID_COLLABORATION_REQUEST" } });
        return;
      }
      sendCollaboration(await collaborationStore.setThreadStatus(projectId, questId, {
        threadId: statusMatch[1]!,
        expectedRevision: write.body.expectedRevision,
        status: write.body.status,
        idempotencyKey: write.idempotencyKey,
        actorUserId: collaborationActorUserId
      }));
      return;
    }

    sendNotFound(response);
    return;
  }

  const publicationUnpublishMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/publication\/unpublish$/.exec(url.pathname);
  if (publicationUnpublishMatch) {
    if (!releases?.publicationStore || method !== "POST") { sendNotFound(response); return; }
    const projectId = publicationUnpublishMatch[1];
    const questId = publicationUnpublishMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    if (!(await requireProjectRole(response, auth, identity, projectId, "owner"))) return;
    if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
    const idempotencyKey = requireIdempotencyKey(request, response);
    if (idempotencyKey === null) return;
    const body = await requireJsonObject(request, response);
    if (body === null || !hasExactKeys(body, ["publicMissionId", "expectedReleaseId"]) || !isId(body.publicMissionId) || !isId(body.expectedReleaseId)) {
      sendJson(response, 400, { error: { code: "INVALID_PUBLICATION_UNPUBLISH_REQUEST" } });
      return;
    }
    const current = await releases.publicationStore.getPublicationForQuest(projectId, questId);
    if (!current || current.publicMissionId !== body.publicMissionId) { sendNotFound(response); return; }
    const result = await releases.publicationStore.unpublish({ publicMissionId: body.publicMissionId, expectedReleaseId: body.expectedReleaseId, idempotencyKey, requestHash: current.contentHash });
    if (result.kind === "unpublished" || result.kind === "replay") sendJson(response, 200, { publication: publicPublicationView(result.publication), ...(result.kind === "replay" ? { replay: true } : {}) });
    else if (result.kind === "not_found") sendNotFound(response);
    else if (result.kind === "current_release_conflict") sendJson(response, 409, { error: { code: "CURRENT_RELEASE_CONFLICT", currentReleaseId: result.currentReleaseId } });
    else if (result.kind === "idempotency_key_reused") sendJson(response, 409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    else sendJson(response, 400, { error: { code: "INVALID_PUBLICATION_UNPUBLISH_REQUEST" } });
    return;
  }

  const missionMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/mission(\/sessions(?:\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})(\/turns)?)?)?$/.exec(url.pathname);
  if (missionMatch) {
    const projectId = missionMatch[1];
    const questId = missionMatch[2];
    const sessionsPart = missionMatch[3] ?? "";
    const sessionId = missionMatch[4] ?? null;
    const isTurns = (missionMatch[5] ?? "") === "/turns";
    if (!projectId || !questId) { sendNotFound(response); return; }
    if (missionStore === null) {
      sendJson(response, 501, { error: { code: "MISSION_STORAGE_UNAVAILABLE" } });
      return;
    }
    if (sessionsPart === "" && method === "GET") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
      const mission = await missionStore.getMission(projectId, questId);
      if (!mission) sendNotFound(response);
      else sendJson(response, 200, { mission });
      return;
    }
    if (sessionsPart === "" && method === "POST") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "editor"))) return;
      if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
      const idempotencyKey = requireIdempotencyKey(request, response);
      if (idempotencyKey === null) return;
      const body = await requireJsonObject(request, response);
      if (body === null) return;
      if (!hasExactKeys(body, ["baseRevision", "mission"])
        || !isRevision(body.baseRevision) || !isPlainObject(body.mission)) {
        sendJson(response, 400, { error: { code: "INVALID_MISSION_DOCUMENT" } });
        return;
      }
      const result = await missionStore.saveMission(projectId, questId, {
        baseRevision: body.baseRevision,
        mission: body.mission as never,
        idempotencyKey,
        actorUserId: identity?.user.userId ?? "local-owner"
      });
      sendMissionSaveResult(response, result);
      return;
    }
    if (sessionsPart === "/sessions" && method === "POST") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "editor"))) return;
      if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
      const idempotencyKey = requireIdempotencyKey(request, response);
      if (idempotencyKey === null) return;
      const body = await requireJsonObject(request, response);
      if (body === null) return;
      if (!hasExactKeys(body, ["sessionId", "initialWorld"])
        || !isPlainObject(body.initialWorld)) {
        sendJson(response, 400, { error: { code: "INVALID_MISSION_SESSION_REQUEST" } });
        return;
      }
      const result = await missionStore.createMissionSession(projectId, questId, {
        sessionId: body.sessionId,
        idempotencyKey,
        actorUserId: identity?.user.userId ?? "local-owner",
        initialWorld: body.initialWorld as never
      });
      if (result.kind === "created") sendJson(response, 201, { session: result.session });
      else if (result.kind === "replay") sendJson(response, 200, { session: result.session, replay: true });
      else if (result.kind === "project_not_found" || result.kind === "quest_not_found" || result.kind === "mission_not_found") {
        sendNotFound(response);
      } else if (result.kind === "session_binding_conflict" || result.kind === "idempotency_key_reused") {
        sendJson(response, 409, { error: { code: "MISSION_SESSION_CONFLICT" } });
      } else {
        sendJson(response, 422, { error: { code: "INVALID_MISSION_SESSION_REQUEST", details: result.errors } });
      }
      return;
    }
    if (sessionId && !isTurns && method === "GET") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
      const session = await missionStore.getMissionSession(sessionId);
      if (!session || session.projectId !== projectId || session.questId !== questId) sendNotFound(response);
      else sendJson(response, 200, { session });
      return;
    }
    if (sessionId && isTurns && method === "POST") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "editor"))) return;
      if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
      const idempotencyKey = requireIdempotencyKey(request, response);
      if (idempotencyKey === null) return;
      const body = await requireJsonObject(request, response);
      if (body === null) return;
      if (!hasExactKeys(body, ["baseTurn", "choiceId"]) || !isRevision(body.baseTurn)) {
        sendJson(response, 400, { error: { code: "INVALID_MISSION_TURN" } });
        return;
      }
      const existing = await missionStore.getMissionSession(sessionId);
      if (!existing || existing.projectId !== projectId || existing.questId !== questId) {
        sendNotFound(response);
        return;
      }
      const result = await missionStore.applyMissionTurn(sessionId, {
        baseTurn: body.baseTurn,
        choiceId: body.choiceId,
        idempotencyKey,
        actorUserId: identity?.user.userId ?? "local-owner"
      });
      if (result.kind === "applied") sendJson(response, 200, { session: result.session, target: result.target });
      else if (result.kind === "replay") sendJson(response, 200, { session: result.session, target: result.target, replay: true });
      else if (result.kind === "session_not_found") sendNotFound(response);
      else if (result.kind === "turn_conflict") {
        sendJson(response, 409, { error: { code: "MISSION_TURN_CONFLICT", currentTurn: result.currentTurn } });
      } else if (result.kind === "idempotency_key_reused") {
        sendJson(response, 409, { error: { code: "MISSION_IDEMPOTENCY_KEY_REUSED" } });
      } else if (result.kind === "choice_not_in_scene" || result.kind === "choice_blocked" || result.kind === "effect_failed" || result.kind === "mission_ended") {
        sendJson(response, 422, { error: { code: `MISSION_TURN_${result.kind.toUpperCase()}` } });
      } else {
        sendJson(response, 422, { error: { code: "INVALID_MISSION_TURN", details: result.errors } });
      }
      return;
    }
    sendNotFound(response);
    return;
  }

  const assetsMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/assets(?:\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199}))?$/.exec(url.pathname);
  if (assetsMatch) {
    const projectId = assetsMatch[1];
    const assetId = assetsMatch[2] ?? null;
    if (!projectId) { sendNotFound(response); return; }
    if (assetStorage === null || assetLibrary === null) {
      sendJson(response, 501, { error: { code: "ASSET_STORAGE_UNAVAILABLE" } });
      return;
    }
    if (assetId === null && method === "GET") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
      const editorView = url.searchParams.get("all") === "1";
      if (editorView && !(await requireProjectRole(response, auth, identity, projectId, "editor"))) return;
      const assets = await assetLibrary.listProjectAssets(projectId, !editorView);
      sendJson(response, 200, { assets });
      return;
    }
    if (assetId === null && method === "POST") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "editor"))) return;
      if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
      const idempotencyKey = requireIdempotencyKey(request, response);
      if (idempotencyKey === null) return;
      const contentType = readHeader(request, "content-type");
      if (typeof contentType !== "string" || !/^application\/octet-stream(?:\s*;|$)/i.test(contentType)) {
        sendJson(response, 415, { error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
        return;
      }
      const meta = readAssetMetadata(request);
      if (meta === null) {
        sendJson(response, 400, { error: { code: "INVALID_ASSET_METADATA" } });
        return;
      }
      const raw = await readOctetBody(request, DEFAULT_ASSET_LIMITS.maxInputBytes + 1);
      if (!raw.ok) {
        sendJson(response, raw.status, { error: { code: raw.code } });
        return;
      }
      let record;
      try {
        record = await ingestAsset(assetStorage, {
          assetId: meta.assetId,
          bytes: raw.bytes,
          claimedMimeType: meta.claimedMimeType,
          originalFilename: meta.filename,
          altText: meta.altText,
          source: meta.source,
          rights: meta.rights
        });
      } catch (error) {
        if (error instanceof AssetBoundaryError) {
          sendJson(response, error.code === "too_large" ? 413 : 422, { error: { code: `ASSET_${error.code.toUpperCase()}`, message: error.message } });
        } else {
          sendJson(response, 500, { error: { code: "CONTROL_INTERNAL_ERROR" } });
        }
        return;
      }
      const registered = await assetLibrary.registerProjectAsset(projectId, {
        assetId: record.manifest.id,
        hash: record.manifest.hash,
        filename: record.originalFilename,
        mimeType: record.manifest.mimeType,
        kind: record.manifest.kind,
        widthPx: record.manifest.widthPx,
        heightPx: record.manifest.heightPx,
        durationMs: record.manifest.durationMs,
        byteLength: record.byteLength,
        idempotencyKey,
        actorUserId: identity?.user.userId ?? "local-owner"
      });
      if (registered.kind === "registered") sendJson(response, 201, { manifest: record.manifest, listed: true });
      else if (registered.kind === "replay") sendJson(response, 200, { manifest: record.manifest, listed: true, replay: true });
      else if (registered.kind === "project_not_found") sendNotFound(response);
      else if (registered.kind === "idempotency_key_reused") {
        sendJson(response, 409, { error: { code: "ASSET_IDEMPOTENCY_KEY_REUSED" } });
      } else {
        sendJson(response, 422, { error: { code: "INVALID_ASSET_METADATA", details: registered.errors } });
      }
      return;
    }
    if (assetId !== null && method === "GET") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
      const hash = url.searchParams.get("hash");
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
        sendJson(response, 400, { error: { code: "INVALID_ASSET_IDENTITY" } });
        return;
      }
      const entries = await assetLibrary.listProjectAssets(projectId, false);
      const entry = entries.find((candidate) => candidate.assetId === assetId && candidate.hash === hash) ?? null;
      if (!entry) { sendNotFound(response); return; }
      let stored;
      try {
        stored = await assetStorage.read(assetId, hash);
      } catch (error) {
        if (error instanceof AssetBoundaryError && (error.code === "not_found" || error.code === "corrupt_object")) {
          sendJson(response, error.code === "not_found" ? 404 : 502, { error: { code: error.code === "not_found" ? "NOT_FOUND" : "ASSET_CORRUPT_OBJECT" } });
        } else {
          sendJson(response, 500, { error: { code: "CONTROL_INTERNAL_ERROR" } });
        }
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", stored.record.manifest.mimeType);
      response.setHeader("content-length", String(stored.bytes.byteLength));
      response.setHeader("cache-control", "public, max-age=31536000, immutable");
      response.setHeader("x-content-type-options", "nosniff");
      response.end(stored.bytes);
      return;
    }
    sendNotFound(response);
    return;
  }

  if (await routeDraftVersionHttp({
    method,
    url,
    store,
    releaseStore: releases?.store ?? null,
    authorAssistant: authorAssistant ? { ...authorAssistant, store } : null,
    authorConversation: authorAssistant?.conversation ?? null,
    actorUserId: identity?.user.userId ?? "local-owner",
    requireRole: (projectId, role) => requireProjectRole(response, auth, identity, projectId, role),
    requireMutation: () => auth ? requireMutationProof(request, response, auth, identity!) : Promise.resolve(true),
    requireIdempotencyKey: () => requireIdempotencyKey(request, response),
    requireAgentKitHandshake: () => requireAgentKitHandshake(request, response, agentKit),
    requireJsonObject: () => requireJsonObject(request, response),
    sendJson: (status, body) => sendJson(response, status, body),
    sendNotFound: () => sendNotFound(response)
  })) return;

  const validationsMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/validations$/.exec(url.pathname);
  if (method === "POST" && validationsMatch) {
    const projectId = validationsMatch[1];
    const questId = validationsMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
    if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
    const body = await requireJsonObject(request, response);
    if (body === null) return;
    if (!hasExactKeys(body, ["draftRevision"]) || !isRevision(body.draftRevision)) {
      sendJson(response, 400, { error: { code: "INVALID_VALIDATION_REQUEST" } });
      return;
    }
    const result = await store.validateDraft(projectId, questId, body.draftRevision);
    if (result.kind === "validated") sendJson(response, 201, { validation: validationView(result.validation) });
    else sendNotFound(response);
    return;
  }

  const releaseCollectionMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/releases$/.exec(url.pathname);
  if (releaseCollectionMatch) {
    if (!releases) { sendNotFound(response); return; }
    const projectId = releaseCollectionMatch[1];
    const questId = releaseCollectionMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    if (method === "GET") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
      if (!(await store.getDraft(projectId, questId))) { sendNotFound(response); return; }
      const [records, currentReleaseId, events] = await Promise.all([
        releases.store.listReleases(projectId, questId),
        releases.store.getCurrentReleaseId(projectId, questId),
        releases.store.listPublicationEvents(projectId, questId)
      ]);
      const publishedIds = new Set(events.map((event) => event.toReleaseId));
      sendJson(response, 200, {
        currentReleaseId,
        releases: records.map((release) => releaseSummaryView(release, currentReleaseId, publishedIds.has(release.releaseId)))
      });
      return;
    }
    if (method === "POST") {
      if (!(await requireProjectRole(response, auth, identity, projectId, "editor"))) return;
      if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
      const idempotencyKey = requireIdempotencyKey(request, response);
      if (idempotencyKey === null) return;
      const body = await requireJsonObject(request, response);
      if (body === null) return;
      const allowedKeys = body.diceCheckDefinitions === undefined
        ? ["releaseId", "draftRevision", "validationId"]
        : ["releaseId", "draftRevision", "validationId", "diceCheckDefinitions"];
      if (!hasExactKeys(body, allowedKeys)
        || !isId(body.releaseId) || !isRevision(body.draftRevision) || !isId(body.validationId)
        || (body.diceCheckDefinitions !== undefined && !Array.isArray(body.diceCheckDefinitions))) {
        sendJson(response, 400, { error: { code: "INVALID_RELEASE_BUILD_REQUEST" } });
        return;
      }
      if (missionStore) {
        // Freeze *before* the release exists. A bundle that cannot be reproduced
        // (missing asset, unavailable revision) must fail loudly rather than
        // register a release with no pin: publishing such a release would later
        // resolve "whatever the draft says now", serving a revision it never
        // shipped.
        const freeze = await resolveReleaseBundle(
          releases,
          missionStore,
          projectId,
          questId,
          body.releaseId,
          null,
          "publish"
        );
        if (freeze.kind !== "resolved") {
          sendJson(response, 422, {
            error: {
              code: "RELEASE_FREEZE_FAILED",
              detailCode: freeze.kind === "bundle_unavailable" ? freeze.code : freeze.kind
            }
          });
          return;
        }
      }
      const result = await buildControlRelease({
        controlStore: store,
        releaseStore: releases.store,
        pluginRegistry: releases.pluginRegistry
      }, {
        projectId,
        questId,
        releaseId: body.releaseId,
        draftRevision: body.draftRevision,
        validationId: body.validationId,
        idempotencyKey,
        ...(body.diceCheckDefinitions === undefined
          ? {}
          : { diceCheckDefinitions: body.diceCheckDefinitions as readonly DiceCheckDefinition[] })
      });
      if (result.kind === "created") {
        sendJson(response, 201, { release: releaseSummaryView(result.release, null, false) });
      } else if (result.kind === "replay") {
        const currentReleaseId = await releases.store.getCurrentReleaseId(projectId, questId);
        const events = await releases.store.listPublicationEvents(projectId, questId);
        sendJson(response, 200, {
          release: releaseSummaryView(result.release, currentReleaseId, events.some((event) => event.toReleaseId === result.release.releaseId)),
          replay: true
        });
      } else if (result.kind === "snapshot_not_found" || result.kind === "validation_not_found") {
        sendNotFound(response);
      } else if (result.kind === "validation_snapshot_mismatch" || result.kind === "release_exists" || result.kind === "idempotency_key_reused") {
        sendJson(response, 409, { error: { code: releaseBuildErrorCode(result.kind) } });
      } else if (result.kind === "invalid_request") {
        sendJson(response, 400, { error: { code: "INVALID_RELEASE_BUILD_REQUEST" } });
      } else {
        sendJson(response, 422, {
          error: {
            code: releaseBuildErrorCode(result.kind),
            ...(result.kind === "release_compile_failed" ? { details: result.errors } : {}),
            ...(result.kind === "plugin_preflight_failed" ? { detailCode: result.code } : {})
          }
        });
      }
      return;
    }
    sendNotFound(response);
    return;
  }

  const publishMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/publish$/.exec(url.pathname);
  if (publishMatch) {
    if (!releases || method !== "POST") { sendNotFound(response); return; }
    const projectId = publishMatch[1];
    const questId = publishMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    if (!(await requireProjectRole(response, auth, identity, projectId, "owner"))) return;
    if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
    const idempotencyKey = requireIdempotencyKey(request, response);
    if (idempotencyKey === null) return;
    const body = await requireJsonObject(request, response);
    if (body === null) return;
    if (!hasExactKeys(body, ["releaseId", "expectedCurrentReleaseId"])
      || !isId(body.releaseId) || !(body.expectedCurrentReleaseId === null || isId(body.expectedCurrentReleaseId))) {
      sendJson(response, 400, { error: { code: "INVALID_PUBLISH_REQUEST" } });
      return;
    }
    // A publish is staged, never compensated. The candidate catalog record is
    // written durably but stays invisible (`beginPublicationCandidate`), the
    // release pointer is promoted with its CAS check, and only a successful
    // promotion commits the record. A rejected publish therefore leaves no
    // trace: there is no window in which the catalog points at a release that
    // is not live, and nothing has to be rolled back afterwards.
    const staged = await beginPublicationCandidate(releases, missionStore, projectId, questId, body.releaseId, idempotencyKey, releaseNowMs(releases, auth), "publish");
    if (staged.kind === "source_stale") {
      sendJson(response, 409, { error: { code: "PUBLICATION_SOURCE_STALE" } });
      return;
    }
    if (staged.kind === "bundle_unavailable") {
      sendJson(response, 409, { error: { code: "PUBLICATION_BUNDLE_UNAVAILABLE", detailCode: staged.code } });
      return;
    }
    if (staged.kind === "store_failure") {
      // The catalog could not be written, so the release pointer must not move.
      sendJson(response, 500, { error: { code: "PUBLICATION_STORE_UNAVAILABLE" } });
      return;
    }
    if (staged.kind === "conflict") {
      sendJson(response, 409, { error: { code: "PUBLICATION_CONFLICT" } });
      return;
    }
    if (staged.kind === "replay") {
      sendJson(response, 200, { publication: { kind: "replay" }, catalog: publicPublicationView(staged.record) });
      return;
    }
    const result = await publishControlRelease({ releaseStore: releases.store, pluginRegistry: releases.pluginRegistry }, {
      projectId,
      questId,
      releaseId: body.releaseId,
      expectedCurrentReleaseId: body.expectedCurrentReleaseId,
      actorUserId: identity?.user.userId ?? "local-owner",
      createdAtMs: releaseNowMs(releases, auth),
      idempotencyKey
    });
    const promoted = result.kind === "published" || result.kind === "unchanged" || result.kind === "replay";
    if (promoted && staged.kind === "ready") {
      const committed = await commitPublicationCandidate(releases, projectId, questId, staged.operationKey, releaseNowMs(releases, auth));
      if (!committed) {
        sendJson(response, 500, { error: { code: "PUBLICATION_COMMIT_FAILED" } });
        return;
      }
      sendJson(response, 200, { publication: result, catalog: publicPublicationView(committed) });
      return;
    }
    if (!promoted && staged.kind === "ready") {
      // Nothing became visible, so abandoning the staged record restores exactly
      // the state the caller started from.
      await abortPublicationCandidate(releases, projectId, questId, staged.operationKey, releaseNowMs(releases, auth));
    }
    if (promoted) {
      sendJson(response, 200, { publication: result });
    } else if (result.kind === "release_not_found") {
      sendNotFound(response);
    } else if (result.kind === "current_release_conflict") {
      sendJson(response, 409, { error: { code: "CURRENT_RELEASE_CONFLICT", currentReleaseId: result.currentReleaseId } });
    } else if (result.kind === "idempotency_key_reused") {
      sendJson(response, 409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    } else if (result.kind === "release_preflight_failed") {
      sendJson(response, 422, { error: { code: "RELEASE_PREFLIGHT_FAILED", detailCode: result.code } });
    } else {
      sendJson(response, 400, { error: { code: "INVALID_PUBLISH_REQUEST" } });
    }
    return;
  }

  const rollbackMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/rollback$/.exec(url.pathname);
  if (rollbackMatch) {
    if (!releases || method !== "POST") { sendNotFound(response); return; }
    const projectId = rollbackMatch[1];
    const questId = rollbackMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    if (!(await requireProjectRole(response, auth, identity, projectId, "owner"))) return;
    if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
    const idempotencyKey = requireIdempotencyKey(request, response);
    if (idempotencyKey === null) return;
    const body = await requireJsonObject(request, response);
    if (body === null) return;
    if (!hasExactKeys(body, ["targetReleaseId", "expectedCurrentReleaseId"])
      || !isId(body.targetReleaseId) || !isId(body.expectedCurrentReleaseId)) {
      sendJson(response, 400, { error: { code: "INVALID_ROLLBACK_REQUEST" } });
      return;
    }
    // Preflight the target bundle before the pointer moves. A rollback that
    // cannot prove which content it points at must not detach the catalog from
    // the release it currently serves.
    const preflight = missionStore
      ? await resolveReleaseBundle(releases, missionStore, projectId, questId, body.targetReleaseId, await releases.publicationStore?.getPublicationForQuest(projectId, questId) ?? null, "rollback")
      : { kind: "not_attempted" as const };
    if (preflight.kind === "bundle_unavailable") {
      sendJson(response, 409, { error: { code: "PUBLICATION_BUNDLE_UNAVAILABLE", detailCode: preflight.code } });
      return;
    }
    // The catalog change is staged before the pointer moves: a rollback that
    // cannot write the catalog record must leave the release pointer exactly
    // where it was, the same way a rejected publish does.
    const publication = await beginPublicationCandidate(releases, missionStore, projectId, questId, body.targetReleaseId, idempotencyKey, releaseNowMs(releases, auth), "rollback", preflight.kind === "resolved" ? preflight : undefined);
    if (publication.kind === "conflict" || publication.kind === "source_stale") {
      sendJson(response, 409, { error: { code: publication.kind === "conflict" ? "PUBLICATION_CONFLICT" : "PUBLICATION_SOURCE_STALE" } });
      return;
    }
    if (publication.kind === "bundle_unavailable") {
      sendJson(response, 409, { error: { code: "PUBLICATION_BUNDLE_UNAVAILABLE", detailCode: publication.code } });
      return;
    }
    if (publication.kind === "store_failure") {
      sendJson(response, 500, { error: { code: "PUBLICATION_STORE_UNAVAILABLE" } });
      return;
    }
    if (publication.kind === "replay") {
      sendJson(response, 200, { publication: { kind: "replay" }, catalog: publicPublicationView(publication.record) });
      return;
    }
    const result = await rollbackControlRelease({ releaseStore: releases.store, pluginRegistry: releases.pluginRegistry }, {
      projectId,
      questId,
      targetReleaseId: body.targetReleaseId,
      expectedCurrentReleaseId: body.expectedCurrentReleaseId,
      actorUserId: identity?.user.userId ?? "local-owner",
      createdAtMs: releaseNowMs(releases, auth),
      idempotencyKey
    });
    if (publication.kind === "ready" && (result.kind === "rolled_back" || result.kind === "unchanged" || result.kind === "replay")) {
      const committed = await commitPublicationCandidate(releases, projectId, questId, publication.operationKey, releaseNowMs(releases, auth));
      if (!committed) {
        sendJson(response, 500, { error: { code: "PUBLICATION_COMMIT_FAILED" } });
        return;
      }
      sendJson(response, 200, { publication: result, catalog: publicPublicationView(committed) });
      return;
    }
    if (publication.kind === "ready") {
      await abortPublicationCandidate(releases, projectId, questId, publication.operationKey, releaseNowMs(releases, auth));
    }
    if (publication.kind === "not_attempted" && (result.kind === "rolled_back" || result.kind === "unchanged" || result.kind === "replay")) {
      // Without a catalog store there is nothing to stage.
      sendJson(response, 200, { publication: result });
    } else if (result.kind === "release_not_found") {
      sendNotFound(response);
    } else if (result.kind === "target_not_previously_published") {
      sendJson(response, 409, { error: { code: "ROLLBACK_TARGET_NOT_PUBLISHED" } });
    } else if (result.kind === "current_release_conflict") {
      sendJson(response, 409, { error: { code: "CURRENT_RELEASE_CONFLICT", currentReleaseId: result.currentReleaseId } });
    } else if (result.kind === "idempotency_key_reused") {
      sendJson(response, 409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    } else if (result.kind === "release_preflight_failed") {
      sendJson(response, 422, { error: { code: "RELEASE_PREFLIGHT_FAILED", detailCode: result.code } });
    } else {
      sendJson(response, 400, { error: { code: "INVALID_ROLLBACK_REQUEST" } });
    }
    return;
  }

  const playtestsMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/playtests$/.exec(url.pathname);
  if (method === "POST" && playtestsMatch) {
    const projectId = playtestsMatch[1];
    const questId = playtestsMatch[2];
    if (!projectId || !questId) { sendNotFound(response); return; }
    if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
    if (auth && !(await requireMutationProof(request, response, auth, identity!))) return;
    const body = await requireJsonObject(request, response);
    if (body === null) return;
    if (!hasExactKeys(body, ["draftRevision", "validationId"]) || !isRevision(body.draftRevision) || !isId(body.validationId)) {
      sendJson(response, 400, { error: { code: "INVALID_PLAYTEST_REQUEST" } });
      return;
    }
    const result = await store.createPlaytest({
      projectId,
      questId,
      draftRevision: body.draftRevision,
      validationId: body.validationId
    });
    if (result.kind === "created") sendJson(response, 201, { playtest: playtestView(result.playtest) });
    else if (result.kind === "validation_snapshot_mismatch") {
      sendJson(response, 409, { error: { code: "VALIDATION_SNAPSHOT_MISMATCH" } });
    } else if (result.kind === "validation_not_valid") {
      sendJson(response, 422, { error: { code: "VALIDATION_NOT_VALID" } });
    } else {
      sendNotFound(response);
    }
    return;
  }

  const playtestReadMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/playtests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(url.pathname);
  if (method === "GET" && playtestReadMatch) {
    const projectId = playtestReadMatch[1];
    const questId = playtestReadMatch[2];
    const playtestId = playtestReadMatch[3];
    if (!projectId || !questId || !playtestId) { sendNotFound(response); return; }
    if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
    const playtest = await store.getPlaytest(playtestId);
    if (!playtest || playtest.projectId !== projectId || playtest.questId !== questId) sendNotFound(response);
    else sendJson(response, 200, { playtest: playtestView(playtest) });
    return;
  }

  const playtestTraceMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/playtests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/trace$/.exec(url.pathname);
  if (method === "GET" && playtestTraceMatch) {
    const projectId = playtestTraceMatch[1];
    const questId = playtestTraceMatch[2];
    const playtestId = playtestTraceMatch[3];
    if (!projectId || !questId || !playtestId) { sendNotFound(response); return; }
    if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;
    if (!playtestTrace) { sendNotFound(response); return; }
    const playtest = await store.getPlaytest(playtestId);
    if (!playtest || playtest.projectId !== projectId || playtest.questId !== questId) {
      sendNotFound(response);
      return;
    }
    const evidence = await playtestTrace.readPlaytestTrace({
      questId: playtest.questId,
      releaseId: `playtest-${playtest.playtestId}`,
      contentHash: playtest.contentHash
    });
    sendJson(response, 200, {
      trace: Object.freeze({
        identityKind: "frozen_playtest",
        publishedRelease: false,
        playtest: playtestView(playtest),
        runtimePinnedRelease: evidence.runtimePinnedRelease,
        sessions: evidence.sessions,
        hasMoreSessions: evidence.hasMoreSessions
      })
    });
    return;
  }

  sendNotFound(response);
}

async function handleLogin(
  request: any,
  response: any,
  auth: AuthRuntime,
  failures: Map<string, LoginFailureState>
): Promise<void> {
  const body = await requireJsonObject(request, response);
  if (body === null) return;
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!hasExactKeys(body, ["username", "password"])) {
    sendJson(response, 401, { error: { code: "INVALID_CREDENTIALS" } });
    return;
  }
  const nowMs = auth.nowMs();
  const key = `${loginRemoteKey(request)}|${boundedLoginIdentity(username)}`;
  const retryAfterMs = loginRetryAfter(failures, key, nowMs, auth.loginWindowMs);
  if (retryAfterMs > 0) {
    response.setHeader("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    sendJson(response, 429, { error: { code: "LOGIN_RATE_LIMITED", retryAfterMs } });
    return;
  }

  const user = await auth.security.verifyCredentials(username, password);
  if (!user) {
    recordLoginFailure(failures, key, nowMs, auth);
    sendJson(response, 401, { error: { code: "INVALID_CREDENTIALS" } });
    return;
  }
  failures.delete(key);

  const sessionToken = createControlOpaqueSecret();
  const csrfToken = createControlOpaqueSecret();
  const sessionId = createControlSessionId();
  const expiresAtMs = nowMs + auth.sessionTtlMs;
  if (!Number.isSafeInteger(expiresAtMs)) {
    sendJson(response, 500, { error: { code: "CONTROL_AUTH_CONFIGURATION_ERROR" } });
    return;
  }
  const created = await auth.security.createSession({
    sessionId,
    userId: user.userId,
    tokenHash: hashControlOpaqueSecret(sessionToken),
    csrfHash: hashControlOpaqueSecret(csrfToken),
    createdAtMs: nowMs,
    expiresAtMs
  });
  if (created.kind !== "created") {
    sendJson(response, 500, { error: { code: "CONTROL_SESSION_CREATE_FAILED" } });
    return;
  }

  response.setHeader("set-cookie", sessionCookie(sessionToken, auth));
  sendJson(response, 200, {
    user,
    session: safeSessionView(created.session),
    csrfToken
  });
}

async function resolveIdentity(request: any, auth: AuthRuntime): Promise<AuthIdentity | null> {
  const token = readCookie(request, CONTROL_SESSION_COOKIE);
  if (!token) return null;
  let tokenHash: string;
  try { tokenHash = hashControlOpaqueSecret(token); } catch { return null; }
  const session = await auth.security.getSessionByTokenHash(tokenHash, auth.nowMs());
  if (!session) return null;
  const user = await auth.security.getUser(session.userId);
  return user ? Object.freeze({ user, session }) : null;
}

async function requireMutationProof(
  request: any,
  response: any,
  auth: AuthRuntime,
  identity: AuthIdentity
): Promise<boolean> {
  const token = readHeader(request, CONTROL_CSRF_HEADER);
  if (!token) {
    sendJson(response, 403, { error: { code: "CONTROL_CSRF_REQUIRED" } });
    return false;
  }
  let csrfHash: string;
  try { csrfHash = hashControlOpaqueSecret(token); } catch {
    sendJson(response, 403, { error: { code: "CONTROL_CSRF_INVALID" } });
    return false;
  }
  if (!(await auth.security.validateSessionCsrf(identity.session.sessionId, csrfHash, auth.nowMs()))) {
    sendJson(response, 403, { error: { code: "CONTROL_CSRF_INVALID" } });
    return false;
  }
  return true;
}

async function requireProjectRole(
  response: any,
  auth: AuthRuntime | null,
  identity: AuthIdentity | null,
  projectId: string,
  required: ControlProjectRole
): Promise<boolean> {
  if (!auth) return true;
  return Boolean(await authorizeProject(response, auth, identity!, projectId, required));
}

async function authorizeProject(
  response: any,
  auth: AuthRuntime,
  identity: AuthIdentity,
  projectId: string,
  required: ControlProjectRole
): Promise<ControlProjectRole | null> {
  const role = await auth.security.getProjectRole(projectId, identity.user.userId);
  if (role === null) {
    sendNotFound(response);
    return null;
  }
  if (roleRank(role) < roleRank(required)) {
    sendJson(response, 403, { error: { code: "CONTROL_FORBIDDEN" } });
    return null;
  }
  return role;
}

function buildAuthRuntime(options: ControlAuthenticatedModeOptions): AuthRuntime {
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const loginWindowMs = options.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS;
  const loginCooldownMs = options.loginCooldownMs ?? DEFAULT_LOGIN_COOLDOWN_MS;
  const maxLoginAttempts = options.maxLoginAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS;
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60_000 || sessionTtlMs > 7 * 24 * 60 * 60 * 1000) throw new RangeError("Control session TTL outside bounds");
  if (!Number.isSafeInteger(loginWindowMs) || loginWindowMs < 1_000 || loginWindowMs > 60 * 60 * 1000) throw new RangeError("Control login window outside bounds");
  if (!Number.isSafeInteger(loginCooldownMs) || loginCooldownMs < 1_000 || loginCooldownMs > 60 * 60 * 1000) throw new RangeError("Control login cooldown outside bounds");
  if (!Number.isSafeInteger(maxLoginAttempts) || maxLoginAttempts < 2 || maxLoginAttempts > 20) throw new RangeError("Control max login attempts outside bounds");
  if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length > 20) throw new TypeError("Control allowed origins outside bounds");
  const origins = new Set<string>();
  for (const origin of options.allowedOrigins) {
    if (typeof origin !== "string" || origin.length < 1 || origin.length > 300 || origin === "*") throw new TypeError("invalid Control allowed origin");
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new TypeError("invalid Control allowed origin"); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin) throw new TypeError("Control origin must be an exact http(s) origin");
    origins.add(origin);
  }
  return Object.freeze({
    security: options.security,
    allowedOrigins: origins,
    secureCookies: options.secureCookies,
    sessionTtlMs,
    loginWindowMs,
    loginCooldownMs,
    maxLoginAttempts,
    nowMs: options.nowMs ?? (() => Date.now())
  });
}

function originAllowed(request: any, auth: AuthRuntime): boolean {
  const origin = readHeader(request, "origin");
  return origin === undefined || auth.allowedOrigins.has(origin);
}

function applyCorsHeaders(response: any, origin: string): void {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("vary", "Origin");
}

function sendCorsPreflight(response: any): void {
  response.statusCode = 204;
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, x-csrf-token, idempotency-key, x-lh-engine-version, x-lh-registry-hash, x-lh-docs-hash");
  response.setHeader("access-control-max-age", "600");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end();
}

function loginRetryAfter(
  failures: Map<string, LoginFailureState>,
  key: string,
  nowMs: number,
  loginWindowMs: number
): number {
  const state = failures.get(key);
  if (!state) return 0;
  if (state.blockedUntilMs > nowMs) return state.blockedUntilMs - nowMs;
  if (nowMs - state.windowStartedAtMs >= loginWindowMs && state.blockedUntilMs <= nowMs) failures.delete(key);
  return 0;
}

function recordLoginFailure(failures: Map<string, LoginFailureState>, key: string, nowMs: number, auth: AuthRuntime): void {
  const current = failures.get(key);
  const state = !current || nowMs - current.windowStartedAtMs >= auth.loginWindowMs
    ? { count: 0, windowStartedAtMs: nowMs, blockedUntilMs: 0 }
    : current;
  state.count += 1;
  if (state.count >= auth.maxLoginAttempts) state.blockedUntilMs = nowMs + auth.loginCooldownMs;
  failures.set(key, state);
}

function loginRemoteKey(request: any): string {
  const address = String(request.socket?.remoteAddress ?? "unknown");
  return address.length <= 100 ? address : address.slice(0, 100);
}

function boundedLoginIdentity(username: string): string {
  return username.length <= 100 ? username : username.slice(0, 100);
}

function sessionCookie(token: string, auth: AuthRuntime): string {
  const maxAge = Math.max(1, Math.floor(auth.sessionTtlMs / 1000));
  return `${CONTROL_SESSION_COOKIE}=${token}; Path=/control/v1; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${auth.secureCookies ? "; Secure" : ""}`;
}

function expiredSessionCookie(secure: boolean): string {
  return `${CONTROL_SESSION_COOKIE}=; Path=/control/v1; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function readCookie(request: any, name: string): string | null {
  const header = readHeader(request, "cookie");
  if (!header) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    if (!value || found !== null) return null;
    found = value;
  }
  return found;
}

function safeSessionView(session: ControlSessionRecord): object {
  return Object.freeze({
    sessionId: session.sessionId,
    createdAtMs: session.createdAtMs,
    expiresAtMs: session.expiresAtMs
  });
}

function projectDraftView(draft: DraftSnapshot): object {
  return Object.freeze({
    projectId: draft.projectId,
    questId: draft.questId,
    draftRevision: draft.draftRevision,
    title: draft.title,
    entryLocationId: draft.entryLocationId,
    contentHash: draft.contentHash
  });
}

function validationView(validation: DraftValidationRecord): object {
  return Object.freeze({
    validationId: validation.validationId,
    projectId: validation.projectId,
    questId: validation.questId,
    draftRevision: validation.draftRevision,
    contentHash: validation.contentHash,
    status: validation.status,
    errors: validation.errors,
    compiledContentHash: validation.compiledContentHash
  });
}

function playtestView(playtest: FrozenPlaytestRecord): object {
  return Object.freeze({
    playtestId: playtest.playtestId,
    projectId: playtest.projectId,
    questId: playtest.questId,
    draftRevision: playtest.draftRevision,
    contentHash: playtest.contentHash,
    validationId: playtest.validationId,
    compiledContentHash: playtest.compiledContentHash
  });
}

async function routePublicMissionSession(
  request: any,
  response: any,
  method: string,
  match: RegExpExecArray,
  releases: ControlReleaseModeOptions,
  missionStore: MissionDocumentStore & MissionSessionStore
): Promise<void> {
  const identifier = match[1] ?? "";
  const sessionId = match[2] ?? null;
  const isTurns = match[3] === "/turns";
  const secret = releases.publicMissionSessionSecret ?? "";
  if (typeof secret !== "string" || secret.length < 16) {
    sendJson(response, 503, { error: { code: "PUBLIC_MISSION_RUNTIME_UNAVAILABLE" } });
    return;
  }

  // Starting a new game is gated by an active publication. Continuing a game
  // that was already started is not: the session carries its own immutable
  // revision pin, so unpublishing or editing the draft never interrupts play.
  if (sessionId === null && !isTurns) {
    if (method !== "POST") { sendNotFound(response); return; }
    const publication = await releases.publicationStore?.getPublicMission(identifier);
    if (!publication) { sendNotFound(response); return; }
    const pinned = await missionStore.getMissionAtRevision(publication.projectId, publication.questId, publication.draftRevision);
    if (!pinned || pinned.contentHash !== publication.draftContentHash) {
      sendJson(response, 409, { error: { code: "PUBLIC_MISSION_RELEASE_STALE" } });
      return;
    }
    const mission = pinned.mission;
    // A release is playable only while its pinned bundle is still reproducible.
    // The public asset route resolves by pinned digest, so without this check a
    // player would get a session on a release whose artwork no longer matches.
    const releasePin = await releases.publicationStore?.getReleasePin(
      publication.projectId,
      publication.questId,
      publication.releaseId
    );
    if (releasePin?.assetsVerified) {
      const liveAssets = await resolveReferencedAssets(missionStore, publication.projectId, mission);
      for (const assetId of collectReferencedAssetIds(mission)) {
        const pinnedAsset = releasePin.assets.find((asset) => asset.assetId === assetId);
        const liveAsset = liveAssets.find((asset) => asset.assetId === assetId);
        if (!pinnedAsset || !liveAsset || liveAsset.hash !== pinnedAsset.hash) {
          sendJson(response, 409, { error: { code: "PUBLIC_MISSION_ASSET_CHANGED", assetId } });
          return;
        }
      }
    }
    const idempotencyKey = requireIdempotencyKey(request, response);
    if (idempotencyKey === null) return;
    const body = await requireJsonObject(request, response);
    if (body === null || !hasExactKeys(body, ["sessionId", "initialWorld"]) || !isId(body.sessionId) || !isPlainObject(body.initialWorld)) {
      sendJson(response, 400, { error: { code: "INVALID_PUBLIC_MISSION_SESSION_REQUEST" } });
      return;
    }
    const credential = publicMissionCredential(secret, publication.publicMissionId, body.sessionId);
    const result = await missionStore.createMissionSession(publication.projectId, publication.questId, {
      sessionId: body.sessionId,
      idempotencyKey,
      actorUserId: `public:${publication.publicMissionId}`,
      contentRevision: publication.draftRevision,
      initialWorld: body.initialWorld as never
    });
    if (result.kind === "created" || result.kind === "replay") {
      sendJson(response, result.kind === "created" ? 201 : 200, { mission, session: result.session, credential, ...(result.kind === "replay" ? { replay: true } : {}) });
    } else if (result.kind === "project_not_found" || result.kind === "quest_not_found" || result.kind === "mission_not_found") {
      sendNotFound(response);
    } else if (result.kind === "session_binding_conflict" || result.kind === "idempotency_key_reused") {
      sendJson(response, 409, { error: { code: "PUBLIC_MISSION_SESSION_CONFLICT" } });
    } else {
      sendJson(response, 422, { error: { code: "INVALID_PUBLIC_MISSION_SESSION_REQUEST", details: result.errors } });
    }
    return;
  }

  if (sessionId === null || !isId(sessionId)) { sendNotFound(response); return; }
  const existing = await missionStore.getMissionSession(sessionId);
  if (!existing) { sendNotFound(response); return; }
  const sessionPublicMissionId = `mission:${existing.projectId}:${existing.questId}`;
  let identifierMatches = identifier === sessionPublicMissionId;
  if (!identifierMatches) {
    const questPublication = await releases.publicationStore?.getPublicationForQuest(existing.projectId, existing.questId);
    identifierMatches = !!questPublication && questPublication.slug === identifier;
  }
  if (!identifierMatches) { sendNotFound(response); return; }
  const credential = publicMissionCredential(secret, sessionPublicMissionId, sessionId);
  if (readHeader(request, "authorization") !== `Bearer ${credential}`) {
    sendJson(response, 401, { error: { code: "PUBLIC_MISSION_CREDENTIAL_REQUIRED" } });
    return;
  }
  const pinned = await missionStore.getMissionAtRevision(existing.projectId, existing.questId, existing.contentRevision);
  if (!pinned || pinned.contentHash !== existing.contentHash) {
    sendJson(response, 409, { error: { code: "PUBLIC_MISSION_RELEASE_STALE" } });
    return;
  }
  const mission = pinned.mission;
  if (!isTurns && method === "GET") {
    sendJson(response, 200, { mission, session: existing });
    return;
  }
  if (isTurns && method === "POST") {
    const idempotencyKey = requireIdempotencyKey(request, response);
    if (idempotencyKey === null) return;
    const body = await requireJsonObject(request, response);
    if (body === null || !hasExactKeys(body, ["baseTurn", "choiceId"]) || !isRevision(body.baseTurn) || !isId(body.choiceId)) {
      sendJson(response, 400, { error: { code: "INVALID_PUBLIC_MISSION_TURN" } });
      return;
    }
    const result = await missionStore.applyMissionTurn(sessionId, {
      baseTurn: body.baseTurn,
      choiceId: body.choiceId,
      idempotencyKey,
      actorUserId: `public:${sessionPublicMissionId}`
    });
    if (result.kind === "applied" || result.kind === "replay") {
      sendJson(response, 200, { mission, session: result.session, target: result.target, ...(result.kind === "replay" ? { replay: true } : {}) });
    } else if (result.kind === "session_not_found") sendNotFound(response);
    else if (result.kind === "turn_conflict") sendJson(response, 409, { error: { code: "MISSION_TURN_CONFLICT", currentTurn: result.currentTurn } });
    else if (result.kind === "idempotency_key_reused") sendJson(response, 409, { error: { code: "MISSION_IDEMPOTENCY_KEY_REUSED" } });
    else if (result.kind === "choice_not_in_scene" || result.kind === "choice_blocked" || result.kind === "effect_failed" || result.kind === "mission_ended") {
      sendJson(response, 422, { error: { code: `MISSION_TURN_${result.kind.toUpperCase()}` } });
    } else sendJson(response, 422, { error: { code: "INVALID_PUBLIC_MISSION_TURN", details: result.errors } });
    return;
  }
  sendNotFound(response);
}

async function routePublicMissionAsset(
  response: any,
  match: RegExpExecArray,
  releases: ControlReleaseModeOptions,
  missionStore: MissionDocumentStore & MissionSessionStore,
  assetStorage: LocalAssetStore | null,
  assetLibrary: ProjectAssetLibrary | null
): Promise<void> {
  const identifier = match[1] ?? "";
  const assetId = match[2] ?? "";
  const publication = await releases.publicationStore?.getPublicMission(identifier);
  if (!publication) { sendNotFound(response); return; }
  const pinned = await missionStore.getMissionAtRevision(publication.projectId, publication.questId, publication.draftRevision);
  if (!pinned || pinned.contentHash !== publication.draftContentHash) { sendNotFound(response); return; }
  if (assetStorage === null || assetLibrary === null) {
    sendJson(response, 501, { error: { code: "ASSET_STORAGE_UNAVAILABLE" } });
    return;
  }
  // Only assets actually referenced by the pinned revision are published.
  if (!collectReferencedAssetIds(pinned.mission).includes(assetId)) { sendNotFound(response); return; }
  // The bytes come from the release's immutable asset pin, never from "whatever
  // the library entry points at now": re-uploading an assetId later must not
  // rewrite what an already published revision serves under a one-year
  // `immutable` cache header.
  const pinnedHash = await resolvePinnedAssetHash(releases, publication.projectId, publication.questId, publication.releaseId, assetId);
  if (pinnedHash === null) { sendNotFound(response); return; }
  let stored;
  try {
    stored = await assetStorage.read(assetId, pinnedHash);
  } catch (error) {
    if (error instanceof AssetBoundaryError && (error.code === "not_found" || error.code === "corrupt_object")) {
      sendJson(response, error.code === "not_found" ? 404 : 502, { error: { code: error.code === "not_found" ? "NOT_FOUND" : "ASSET_CORRUPT_OBJECT" } });
    } else {
      sendJson(response, 500, { error: { code: "CONTROL_INTERNAL_ERROR" } });
    }
    return;
  }
  response.statusCode = 200;
  response.setHeader("content-type", stored.record.manifest.mimeType);
  response.setHeader("content-length", String(stored.bytes.byteLength));
  response.setHeader("cache-control", "public, max-age=31536000, immutable");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(stored.bytes);
}

/**
 * Serves the bytes of an asset the *started game* is pinned to.
 *
 * The published-mission BFF proxies here with the session credential, so the
 * artwork a player is looking at does not depend on what the catalog says right
 * now: republishing a newer revision, or taking the mission down entirely,
 * leaves a running game on its own revision and its own assets.
 */
async function routePublicMissionSessionAsset(
  request: any,
  response: any,
  match: RegExpExecArray,
  releases: ControlReleaseModeOptions,
  missionStore: MissionDocumentStore & MissionSessionStore,
  assetStorage: LocalAssetStore | null,
  assetLibrary: ProjectAssetLibrary | null
): Promise<void> {
  const identifier = match[1] ?? "";
  const sessionId = match[2] ?? "";
  const assetId = match[3] ?? "";
  const secret = releases.publicMissionSessionSecret ?? "";
  if (typeof secret !== "string" || secret.length < 16) {
    sendJson(response, 503, { error: { code: "PUBLIC_MISSION_RUNTIME_UNAVAILABLE" } });
    return;
  }
  const existing = await missionStore.getMissionSession(sessionId);
  if (!existing) { sendNotFound(response); return; }
  const sessionPublicMissionId = `mission:${existing.projectId}:${existing.questId}`;
  let identifierMatches = identifier === sessionPublicMissionId;
  if (!identifierMatches) {
    // The publication record survives unpublish, so the slug still identifies
    // the mission whose session is asking for bytes.
    const questPublication = await releases.publicationStore?.getPublicationForQuest(existing.projectId, existing.questId);
    identifierMatches = !!questPublication && questPublication.slug === identifier;
  }
  if (!identifierMatches) { sendNotFound(response); return; }
  const credential = publicMissionCredential(secret, sessionPublicMissionId, sessionId);
  if (readHeader(request, "authorization") !== `Bearer ${credential}`) {
    sendJson(response, 401, { error: { code: "PUBLIC_MISSION_CREDENTIAL_REQUIRED" } });
    return;
  }
  const pinned = await missionStore.getMissionAtRevision(existing.projectId, existing.questId, existing.contentRevision);
  if (!pinned || pinned.contentHash !== existing.contentHash) {
    sendJson(response, 409, { error: { code: "PUBLIC_MISSION_RELEASE_STALE" } });
    return;
  }
  if (assetStorage === null || assetLibrary === null) {
    sendJson(response, 501, { error: { code: "ASSET_STORAGE_UNAVAILABLE" } });
    return;
  }
  // Only assets the *pinned* revision references are served through the session.
  if (!collectReferencedAssetIds(pinned.mission).includes(assetId)) { sendNotFound(response); return; }
  // Same rule as the catalog route, but the revision is the one the session is
  // pinned to — its own asset pin, not the currently published one.
  const pinnedHash = await resolvePinnedAssetHashForRevision(releases, existing.projectId, existing.questId, existing, assetId);
  if (pinnedHash === null) { sendNotFound(response); return; }
  let stored;
  try {
    stored = await assetStorage.read(assetId, pinnedHash);
  } catch (error) {
    if (error instanceof AssetBoundaryError && (error.code === "not_found" || error.code === "corrupt_object")) {
      sendJson(response, error.code === "not_found" ? 404 : 502, { error: { code: error.code === "not_found" ? "NOT_FOUND" : "ASSET_CORRUPT_OBJECT" } });
    } else {
      sendJson(response, 500, { error: { code: "CONTROL_INTERNAL_ERROR" } });
    }
    return;
  }
  response.statusCode = 200;
  response.setHeader("content-type", stored.record.manifest.mimeType);
  response.setHeader("content-length", String(stored.bytes.byteLength));
  // The URL names one session and one pinned revision, so these bytes cannot go
  // stale — but they stay private to the credential that asked for them.
  response.setHeader("cache-control", "private, max-age=31536000, immutable");
  response.setHeader("etag", `"${existing.contentHash.slice(0, 32)}-${assetId}"`);
  response.setHeader("x-content-type-options", "nosniff");
  response.end(stored.bytes);
}

/**
 * Resolves the bytes an immutable published revision pinned for one asset.
 *
 * `null` means "this release never pinned that asset", which callers turn into a
 * 404: falling back to the library's current entry would let a later re-upload
 * silently rewrite content a player was already promised.
 */
async function resolvePinnedAssetHash(
  releases: ControlReleaseModeOptions,
  projectId: string,
  questId: string,
  releaseId: string,
  assetId: string
): Promise<string | null> {
  const pin = await releases.publicationStore?.getReleasePin(projectId, questId, releaseId);
  return pin?.assets.find((entry) => entry.assetId === assetId)?.hash ?? null;
}

/**
 * The same question for a *started game*: it knows only the revision it was
 * created from, so the release carrying that exact revision is found first.
 */
async function resolvePinnedAssetHashForRevision(
  releases: ControlReleaseModeOptions,
  projectId: string,
  questId: string,
  revision: { readonly contentRevision: number; readonly contentHash: string },
  assetId: string
): Promise<string | null> {
  const publicationStore = releases.publicationStore;
  if (!publicationStore) return null;
  // A session only records the revision it started on, so the release has to be
  // found by that revision — and a release pin is exactly the record that says
  // which revision it publishes.
  const known = await releases.store.listReleases(projectId, questId);
  for (const candidate of known) {
    const pin = await publicationStore.getReleasePin(projectId, questId, candidate.releaseId);
    if (!pin) continue;
    if (pin.missionRevision !== revision.contentRevision || pin.missionContentHash !== revision.contentHash) continue;
    return pin.assets.find((entry) => entry.assetId === assetId)?.hash ?? null;
  }
  return null;
}

function publicMissionCredential(secret: string, publicMissionId: string, sessionId: string): string {
  return hashControlOpaqueSecret(`${secret}\0${publicMissionId}\0${sessionId}`);
}

type ResolvedReleaseBundle = {
  readonly kind: "resolved";
  readonly missionRevision: number;
  readonly missionContentHash: string;
  readonly mission: NonNullable<Awaited<ReturnType<MissionDocumentStore["getMission"]>>>;
  readonly assets: readonly { readonly assetId: string; readonly hash: string }[];
  readonly bundleHash: string;
};

type PublicationStaging =
  | { readonly kind: "ready"; readonly operationKey: string }
  | { readonly kind: "replay"; readonly record: ControlPublicationRecord }
  | { readonly kind: "source_stale" | "not_attempted" }
  | { readonly kind: "bundle_unavailable"; readonly code: string }
  | { readonly kind: "store_failure" }
  | { readonly kind: "conflict" };

/**
 * Stages a catalog change without making it visible.
 *
 * The candidate record is written durably as a pending publication operation,
 * so an interrupted publish survives a restart and can be committed or
 * abandoned later, while the public catalog still serves exactly what it served
 * before. Visibility only changes in `commitPublicationCandidate`.
 */
async function beginPublicationCandidate(
  releases: ControlReleaseModeOptions,
  missionStore: (MissionDocumentStore & MissionSessionStore) | null,
  projectId: string,
  questId: string,
  releaseId: string,
  idempotencyKey: string,
  publishedAtMs: number,
  kind: "publish" | "rollback",
  preResolved?: ResolvedReleaseBundle
): Promise<PublicationStaging> {
  const publicationStore = releases.publicationStore;
  if (!publicationStore) return { kind: "not_attempted" };
  const release = await releases.store.getRelease(projectId, questId, releaseId);
  if (!release || !missionStore) return { kind: "source_stale" };
  const existing = await publicationStore.getPublicationForQuest(projectId, questId);
  // A release owns an immutable bundle: the exact authored revision it publishes
  // and the digests of the assets that revision references. Resolving through
  // the pin is what makes rollback truthful — the catalog is repointed, the
  // content behind it is not re-read from the latest draft.
  const resolved = preResolved ?? await resolveReleaseBundle(releases, missionStore, projectId, questId, releaseId, existing, kind);
  if (resolved.kind !== "resolved") return resolved;
  const { mission, bundleHash } = resolved;
  const record: ControlPublicationRecord = {
    schemaVersion: "1.0",
    publicMissionId: existing?.publicMissionId ?? `mission:${projectId}:${questId}`,
    slug: existing?.slug ?? mission.listing.slug,
    projectId,
    questId,
    draftRevision: resolved.missionRevision,
    draftContentHash: resolved.missionContentHash,
    releaseId,
    contentHash: bundleHash,
    channel: "production",
    status: "published",
    listing: mission.listing,
    publishedAtMs
  };
  const operationKey = `catalog-${idempotencyKey}`.slice(0, 200);
  const begun = await publicationStore.beginPublicationOperation({
    operation: {
      schemaVersion: "1.0",
      projectId,
      questId,
      operationKey,
      kind,
      requestHash: hashControlOpaqueSecret(`${bundleHash}\u0000${releaseId.slice(0, 120)}`),
      targetReleaseId: releaseId,
      candidate: record,
      state: "pending",
      startedAtMs: publishedAtMs,
      finishedAtMs: null
    }
  });
  if (begun.kind === "invalid_request") return { kind: "store_failure" };
  if (begun.kind === "operation_conflict") return { kind: "conflict" };
  if (begun.kind === "replay") {
    // The same request already finished: there is nothing left to do, and the
    // answer must name the content that is actually live.
    return begun.operation.state === "committed"
      ? { kind: "replay", record: begun.operation.candidate }
      : { kind: "ready", operationKey };
  }
  return { kind: "ready", operationKey };
}

/** Publishes the staged record, atomically with marking the operation committed. */
async function commitPublicationCandidate(
  releases: ControlReleaseModeOptions,
  projectId: string,
  questId: string,
  operationKey: string,
  committedAtMs: number
): Promise<ControlPublicationRecord | null> {
  const publicationStore = releases.publicationStore;
  if (!publicationStore) return null;
  const result = await publicationStore.commitPublicationOperation({ projectId, questId, operationKey, committedAtMs });
  if (result.kind === "committed" || result.kind === "replay") return result.publication;
  return null;
}

/** Abandons a staged record. It was never visible, so there is nothing to undo. */
async function abortPublicationCandidate(
  releases: ControlReleaseModeOptions,
  projectId: string,
  questId: string,
  operationKey: string,
  abortedAtMs: number
): Promise<void> {
  const publicationStore = releases.publicationStore;
  if (!publicationStore) return;
  try {
    await publicationStore.abortPublicationOperation({ projectId, questId, operationKey, abortedAtMs });
  } catch {
    // The staged record was never visible; a stuck operation is recoverable.
  }
}

/**
 * Resolves, and when necessary establishes, the immutable bundle of a release.
 *
 *  - An existing pin is authoritative: the mission is read at the pinned
 *    revision and its digest and asset manifest are re-verified.
 *  - A publication record that already names this release is accepted as proof
 *    of its revision (it was written when that release was published) and
 *    adopted as a pin.
 *  - Otherwise this is a build freezing a brand-new release: the authored
 *    revision named by the build request is pinned. Every referenced asset must
 *    exist; a missing asset is a loud failure, never a silently hashed null.
 *  - A release with neither a pin nor a matching record is never publishable:
 *    there is no proof of what it ships, so it fails closed instead of being
 *    re-pointed at the newest draft.
 *
 * A release whose historical revision cannot be proven is never re-pointed at
 * the latest draft: it fails closed with `bundle_unavailable`.
 */
async function resolveReleaseBundle(
  releases: ControlReleaseModeOptions,
  missionStore: MissionDocumentStore & MissionSessionStore,
  projectId: string,
  questId: string,
  releaseId: string,
  existing: ControlPublicationRecord | null,
  mode: "publish" | "rollback" = "publish"
): Promise<
  | ResolvedReleaseBundle
  | { readonly kind: "source_stale" | "not_attempted" }
  | { readonly kind: "bundle_unavailable"; readonly code: string }
> {
  const publicationStore = releases.publicationStore;
  if (!publicationStore) return { kind: "not_attempted" };
  let pin = await publicationStore.getReleasePin(projectId, questId, releaseId);
  let adopted = false;
  if (!pin) {
    if (existing && existing.releaseId === releaseId) {
      // Provable legacy mapping: this release is the one the record was written
      // for. Its asset manifest is not provable and stays flagged.
      pin = {
        schemaVersion: "1.0",
        releaseId,
        projectId,
        questId,
        missionRevision: existing.draftRevision,
        missionContentHash: existing.draftContentHash,
        assets: [],
        assetsVerified: false,
        pinnedAtMs: existing.publishedAtMs
      };
      adopted = true;
    } else {
      // A release is frozen when it is first published. Rolling back to a
      // release whose revision cannot be proven must not fall back to the
      // newest draft: that would serve content the release never published.
      if (mode === "rollback") return { kind: "bundle_unavailable", code: "LEGACY_PIN_UNPROVABLE" };
      // Publishing must never read "whatever the draft says *later*": a release
      // published after the author kept editing could otherwise start serving a
      // revision it never contained. Builds freeze the pin (asset-checked); the
      // fallback below only covers releases built outside this server, where the
      // newest authored revision is the best — and only — available evidence.
      const history = await missionStore.getMissionHistory(projectId, questId);
      const latest = history[history.length - 1];
      let authoredRevisionNumber: number;
      let authoredContentHash: string;
      if (latest) {
        authoredRevisionNumber = latest.contentRevision;
        authoredContentHash = latest.contentHash;
      } else {
        // A release may be built before any authored revision exists (the very
        // first draft); then that draft is the only content there is.
        const current = await missionStore.getMission(projectId, questId);
        if (!current) return { kind: "bundle_unavailable", code: "MISSION_REVISION_UNAVAILABLE" };
        authoredRevisionNumber = current.contentRevision;
        authoredContentHash = current.contentHash;
      }
      const authoredRevision = await missionStore.getMissionAtRevision(projectId, questId, authoredRevisionNumber);
      if (!authoredRevision || authoredRevision.contentHash !== authoredContentHash) {
        return { kind: "bundle_unavailable", code: "MISSION_REVISION_UNAVAILABLE" };
      }
      const manifest = await resolveReferencedAssets(missionStore, projectId, authoredRevision.mission);
      const missing = collectReferencedAssetIds(authoredRevision.mission)
        .filter((assetId) => !manifest.some((asset) => asset.assetId === assetId));
      if (missing.length > 0) return { kind: "bundle_unavailable", code: "ASSET_MISSING" };
      pin = {
        schemaVersion: "1.0",
        releaseId,
        projectId,
        questId,
        missionRevision: authoredRevisionNumber,
        missionContentHash: authoredContentHash,
        assets: manifest,
        assetsVerified: true,
        pinnedAtMs: Date.now()
      };
    }
  }
  const pinnedMission = await missionStore.getMissionAtRevision(projectId, questId, pin.missionRevision);
  if (!pinnedMission || pinnedMission.contentHash !== pin.missionContentHash) {
    return { kind: "bundle_unavailable", code: adopted ? "LEGACY_PIN_UNPROVABLE" : "MISSION_REVISION_UNAVAILABLE" };
  }
  const mission = pinnedMission.mission;
  const liveAssets = await resolveReferencedAssets(missionStore, projectId, mission);
  if (pin.assetsVerified) {
    for (const assetId of collectReferencedAssetIds(mission)) {
      const pinnedAsset = pin.assets.find((asset) => asset.assetId === assetId);
      if (!pinnedAsset) return { kind: "bundle_unavailable", code: "ASSET_MISSING" };
      const live = liveAssets.find((asset) => asset.assetId === assetId);
      if (!live || live.hash !== pinnedAsset.hash) return { kind: "bundle_unavailable", code: "ASSET_CHANGED" };
    }
  }
  // A pin adopted from a pre-freeze publication has no asset manifest to check,
  // so the release keeps the identity it already advertised: re-deriving the
  // hash from the live library would let the same releaseId start reporting
  // different content for content a player already ran.
  const bundleHash = adopted && existing ? existing.contentHash : await missionBundleHash(mission, liveAssets);
  const write = await publicationStore.pinRelease({
    pin,
    idempotencyKey: `bundle-${releaseId}-${pin.missionRevision}-${bundleHash.slice(0, 16)}`.slice(0, 200),
    requestHash: bundleHash
  });
  if (write.kind === "pin_conflict") return { kind: "bundle_unavailable", code: "RELEASE_PIN_CONFLICT" };
  return {
    kind: "resolved",
    missionRevision: pin.missionRevision,
    missionContentHash: pin.missionContentHash,
    mission,
    assets: liveAssets,
    bundleHash
  };
}

/**
 * Identity of everything a player can execute and see: the authored mission
 * document (story, screens, listing, defaults), the digest of every asset the
 * document references, and the renderer contract the release was authored for.
 * A board/compile hash is deliberately not used here — it cannot cover the
 * authored mission document.
 */
const RENDERER_CONTRACT_VERSION = "mission-renderer-v1";

async function missionBundleHash(
  mission: any,
  assets: readonly { readonly assetId: string; readonly hash: string }[]
): Promise<string> {
  const byId = new Map(assets.map((asset) => [asset.assetId, asset.hash]));
  const referenced = collectReferencedAssetIds(mission);
  return createHash("sha256").update(canonicalStringify({
    renderer: RENDERER_CONTRACT_VERSION,
    missionContentHash: String(mission.contentHash ?? ""),
    assets: referenced.map((assetId) => ({ assetId, hash: byId.get(assetId) ?? null }))
  }), "utf8").digest("hex");
}

function collectReferencedAssetIds(value: any, found = new Set<string>()): string[] {
  if (typeof value === "string") return [...found].sort();
  if (value === null || typeof value !== "object") return [...found].sort();
  if (Array.isArray(value)) {
    for (const child of value) collectReferencedAssetIds(child, found);
    return [...found].sort();
  }
  for (const [key, child] of Object.entries(value)) {
    if (/assetId$/i.test(key) && isId(child)) found.add(child as string);
    else collectReferencedAssetIds(child, found);
  }
  return [...found].sort();
}

async function resolveReferencedAssets(
  missionStore: (MissionDocumentStore & MissionSessionStore) | null,
  projectId: string,
  mission: any
): Promise<readonly { readonly assetId: string; readonly hash: string }[]> {
  const library = missionStore as unknown as Partial<ProjectAssetLibrary> | null;
  if (!library || typeof library.listProjectAssets !== "function") return Object.freeze([]);
  const referenced = new Set(collectReferencedAssetIds(mission));
  if (referenced.size === 0) return Object.freeze([]);
  const assets = await library.listProjectAssets(projectId, false);
  return Object.freeze(assets
    .filter((asset) => referenced.has(asset.assetId))
    .map((asset) => Object.freeze({ assetId: asset.assetId, hash: asset.hash })));
}

function publicPublicationView(record: ControlPublicationRecord): object {
  return Object.freeze({
    publicMissionId: record.publicMissionId,
    slug: record.slug,
    releaseId: record.releaseId,
    contentHash: record.contentHash,
    channel: record.channel,
    listing: record.listing,
    publishedAtMs: record.publishedAtMs
  });
}

function releaseSummaryView(
  release: ControlReleaseRecord,
  currentReleaseId: string | null,
  wasPublished: boolean
): object {
  return Object.freeze({
    releaseId: release.releaseId,
    projectId: release.projectId,
    questId: release.questId,
    draftRevision: release.draftRevision,
    draftContentHash: release.draftContentHash,
    validationId: release.validationId,
    compiledContentHash: release.compiledContentHash,
    contentHashAlgorithm: release.contentHashAlgorithm,
    isCurrent: currentReleaseId === release.releaseId,
    wasPublished
  });
}

function releaseBuildErrorCode(kind: string): string {
  if (kind === "validation_not_valid") return "VALIDATION_NOT_VALID";
  if (kind === "validation_snapshot_mismatch") return "VALIDATION_SNAPSHOT_MISMATCH";
  if (kind === "validation_integrity_failed") return "VALIDATION_INTEGRITY_FAILED";
  if (kind === "release_compile_failed") return "RELEASE_COMPILE_FAILED";
  if (kind === "plugin_authoring_invalid") return "PLUGIN_AUTHORING_INVALID";
  if (kind === "plugin_preflight_failed") return "PLUGIN_PREFLIGHT_FAILED";
  if (kind === "release_exists") return "RELEASE_EXISTS";
  if (kind === "idempotency_key_reused") return "IDEMPOTENCY_KEY_REUSED";
  return "INVALID_RELEASE_BUILD_REQUEST";
}

function releaseNowMs(releases: ControlReleaseModeOptions, auth: AuthRuntime | null): number {
  const value = releases.nowMs ? releases.nowMs() : auth ? auth.nowMs() : Date.now();
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Control release clock outside bounds");
  return value;
}

function requireAgentKitHandshake(request: any, response: any, agentKit: InstalledAgentKit): boolean {
  const headers = Object.freeze({
    [AGENT_KIT_ENGINE_VERSION_HEADER]: readHeader(request, AGENT_KIT_ENGINE_VERSION_HEADER),
    [AGENT_KIT_REGISTRY_HASH_HEADER]: readHeader(request, AGENT_KIT_REGISTRY_HASH_HEADER),
    [AGENT_KIT_DOCS_HASH_HEADER]: readHeader(request, AGENT_KIT_DOCS_HASH_HEADER)
  });
  if (agentKitHandshakeMatches(headers, agentKit.identity)) return true;
  sendJson(response, 409, {
    error: {
      code: "AGENT_KIT_STALE",
      message: "Refresh /control/v1/agent-kit before applying assistant-authored draft changes.",
      expected: agentKit.identity
    }
  });
  return false;
}

function requireIdempotencyKey(request: any, response: any): string | null {
  const value = readHeader(request, "idempotency-key");
  if (!isId(value)) {
    sendJson(response, 400, { error: { code: "INVALID_IDEMPOTENCY_KEY" } });
    return null;
  }
  return value;
}

async function requireJsonObject(request: any, response: any): Promise<Record<string, any> | null> {
  const body = await readJsonBody(request, controlBodyLimit(request));
  if (!body.ok) {
    sendJson(response, body.status, { error: { code: body.code } });
    return null;
  }
  if (!isPlainObject(body.value)) {
    sendJson(response, 400, { error: { code: "INVALID_REQUEST" } });
    return null;
  }
  return body.value;
}

function controlBodyLimit(request: any): number {
  const rawUrl = typeof request?.url === "string" ? request.url : "";
  const pathname = rawUrl.split("?", 1)[0] ?? "";
  return /^\/control\/v1\/projects\/[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\/imports$/.test(pathname)
    ? MAX_CONTROL_IMPORT_BODY_CHARS
    : MAX_CONTROL_BODY_CHARS;
}

async function readJsonBody(request: any, maxChars = MAX_CONTROL_BODY_CHARS): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly code: string }
> {
  const contentType = readHeader(request, "content-type");
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return Object.freeze({ ok: false, status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > maxChars) {
      return Object.freeze({ ok: false, status: 413, code: "BODY_TOO_LARGE" });
    }
  }
  try {
    return Object.freeze({ ok: true, value: JSON.parse(body) });
  } catch {
    return Object.freeze({ ok: false, status: 400, code: "INVALID_JSON" });
  }
}

function readHeader(request: any, name: string): string | undefined {
  const value = request.headers?.[name];
  return typeof value === "string" ? value : undefined;
}

function sendNotFound(response: any): void {
  sendJson(response, 404, { error: { code: "NOT_FOUND" } });
}

function sendJson(response: any, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(json);
}

function roleRank(role: ControlProjectRole): number {
  if (role === "owner") return 3;
  if (role === "editor") return 2;
  return 1;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoardDocumentStore(value: ControlStore): value is ControlStore & BoardDocumentStore {
  return typeof (value as Partial<BoardDocumentStore>).getBoardDocument === "function"
    && typeof (value as Partial<BoardDocumentStore>).applyBoardChanges === "function";
}

function isCollaborationStore(value: ControlStore): value is ControlStore & CollaborationStore {
  const candidate = value as Partial<CollaborationStore>;
  return typeof candidate.getCollaboration === "function"
    && typeof candidate.createNote === "function"
    && typeof candidate.changeNote === "function"
    && typeof candidate.deleteNote === "function"
    && typeof candidate.createThread === "function"
    && typeof candidate.addMessage === "function"
    && typeof candidate.changeMessage === "function"
    && typeof candidate.deleteMessage === "function"
    && typeof candidate.setThreadStatus === "function";
}

function isMissionStore(value: ControlStore): value is ControlStore & MissionDocumentStore & MissionSessionStore {
  const candidate = value as Partial<MissionDocumentStore & MissionSessionStore>;
  return typeof candidate.getMission === "function"
    && typeof candidate.getMissionAtRevision === "function"
    && typeof candidate.saveMission === "function"
    && typeof candidate.createMissionSession === "function"
    && typeof candidate.getMissionSession === "function"
    && typeof candidate.applyMissionTurn === "function";
}

function isProjectAssetLibrary(value: ControlStore): value is ControlStore & ProjectAssetLibrary {
  const candidate = value as Partial<ProjectAssetLibrary>;
  return typeof candidate.registerProjectAsset === "function"
    && typeof candidate.listProjectAssets === "function"
    && typeof candidate.setProjectAssetListed === "function";
}

const MAX_ASSET_TEXT_HEADER_CHARS = 2_000;

function readAssetTextHeader(request: any, name: string, maxChars: number): string | null | undefined {
  const value = readHeader(request, name);
  if (value === undefined) return undefined;
  if (value.length > maxChars) return null;
  return value;
}

function readAssetMetadata(request: any): {
  readonly assetId: string;
  readonly filename: string | null;
  readonly claimedMimeType: string | null;
  readonly altText: string | null;
  readonly source: string | null;
  readonly rights: string | null;
} | null {
  const assetId = readHeader(request, "x-asset-id");
  if (typeof assetId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(assetId)) return null;
  const filename = readAssetTextHeader(request, "x-filename", 255);
  const claimedMimeType = readAssetTextHeader(request, "x-claimed-mime", 127);
  const altText = readAssetTextHeader(request, "x-alt-text", MAX_ASSET_TEXT_HEADER_CHARS);
  const source = readAssetTextHeader(request, "x-source", MAX_ASSET_TEXT_HEADER_CHARS);
  const rights = readAssetTextHeader(request, "x-rights", MAX_ASSET_TEXT_HEADER_CHARS);
  if (filename === null || claimedMimeType === null || altText === null || source === null || rights === null) {
    return null;
  }
  return {
    assetId,
    filename: filename ?? null,
    claimedMimeType: claimedMimeType ?? null,
    altText: altText ?? null,
    source: source ?? null,
    rights: rights ?? null
  };
}

async function readOctetBody(request: any, maxBytes: number): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly status: number; readonly code: string }
> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const view = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
    total += view.byteLength;
    if (total > maxBytes) {
      return Object.freeze({ ok: false, status: 413, code: "ASSET_TOO_LARGE" });
    }
    chunks.push(view);
  }
  if (total < 1) return Object.freeze({ ok: false, status: 400, code: "ASSET_EMPTY" });
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Object.freeze({ ok: true, bytes });
}

function sendMissionSaveResult(response: any, result: SaveMissionResult): void {
  if (result.kind === "saved") sendJson(response, 200, { mission: result.mission });
  else if (result.kind === "replay") sendJson(response, 200, { mission: result.mission, replay: true });
  else if (result.kind === "project_not_found" || result.kind === "quest_not_found") sendNotFound(response);
  else if (result.kind === "revision_conflict") {
    sendJson(response, 409, { error: { code: "MISSION_REVISION_CONFLICT", currentRevision: result.currentRevision } });
  } else if (result.kind === "idempotency_key_reused") {
    sendJson(response, 409, { error: { code: "MISSION_IDEMPOTENCY_KEY_REUSED" } });
  } else {
    sendJson(response, 422, { error: { code: "INVALID_MISSION_DOCUMENT", details: result.errors } });
  }
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "SQLITE_BUSY" || (typeof value.message === "string" && value.message.includes("SQLITE_BUSY"));
}
