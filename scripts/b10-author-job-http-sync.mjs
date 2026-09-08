import fs from "node:fs";

function patch(path, fn) {
  const before = fs.readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`no change for ${path}`);
  fs.writeFileSync(path, after);
}

patch("packages/control/src/author-agent-jobs.ts", (text) => {
  const unionAnchor = '  | { readonly kind: "draft.read"; readonly blockCount: number }\n';
  if (!text.includes(unionAnchor)) throw new Error("checkpoint union anchor missing");
  text = text.replace(unionAnchor, unionAnchor + '  | { readonly kind: "segment.requested"; readonly requestId: string; readonly requestHash: string }\n');
  const switchAnchor = '    case "draft.read":\n      return hasExactKeys(value, ["kind", "blockCount"]) && isNonNegativeSafeInteger(value.blockCount);\n';
  if (!text.includes(switchAnchor)) throw new Error("checkpoint validation anchor missing");
  return text.replace(switchAnchor, switchAnchor + '    case "segment.requested":\n      return hasExactKeys(value, ["kind", "requestId", "requestHash"])\n        && isId(value.requestId) && isHash(value.requestHash);\n');
});

patch("apps/server/src/draft-version-http.ts", (text) => {
  const importAnchor = 'import { routeAuthoringProposalHttp } from "./authoring-proposal-http.js";\n';
  if (!text.includes(importAnchor)) throw new Error("draft version import anchor missing");
  text = text.replace(importAnchor, importAnchor + 'import { routeAuthorJobHttp } from "./author-job-http.js";\nimport type { AuthorAssistantDependencies } from "./author-assistant.js";\n');
  const contextAnchor = '  readonly releaseStore: Pick<ControlReleaseStore, "getRelease"> | null;\n';
  if (!text.includes(contextAnchor)) throw new Error("draft version context anchor missing");
  text = text.replace(contextAnchor, contextAnchor + '  readonly authorAssistant: AuthorAssistantDependencies | null;\n  readonly actorUserId: string;\n');
  const routeAnchor = 'export async function routeDraftVersionHttp(context: DraftVersionHttpContext): Promise<boolean> {\n  if (await routeAuthoringProposalHttp(context)) return true;\n';
  if (!text.includes(routeAnchor)) throw new Error("draft version route anchor missing");
  return text.replace(routeAnchor, 'export async function routeDraftVersionHttp(context: DraftVersionHttpContext): Promise<boolean> {\n  if (await routeAuthorJobHttp(context)) return true;\n  if (await routeAuthoringProposalHttp(context)) return true;\n');
});

patch("apps/server/src/control-server.ts", (text) => {
  const importAnchor = 'import { routeDraftVersionHttp } from "./draft-version-http.js";\n';
  if (!text.includes(importAnchor)) throw new Error("control server import anchor missing");
  text = text.replace(importAnchor, importAnchor + 'import type { AuthorAssistantDependencies } from "./author-assistant.js";\n');
  const depsAnchor = '  readonly playtestTrace?: PlaytestTraceReader;\n  readonly auth?: ControlAuthenticatedModeOptions;\n';
  if (!text.includes(depsAnchor)) throw new Error("control deps anchor missing");
  text = text.replace(depsAnchor, '  readonly playtestTrace?: PlaytestTraceReader;\n  readonly authorAssistant?: Omit<AuthorAssistantDependencies, "store">;\n  readonly auth?: ControlAuthenticatedModeOptions;\n');
  const callAnchor = '        releases,\n        dependencies.playtestTrace ?? null,\n        auth,\n';
  if (!text.includes(callAnchor)) throw new Error("route call anchor missing");
  text = text.replace(callAnchor, '        releases,\n        dependencies.playtestTrace ?? null,\n        dependencies.authorAssistant ?? null,\n        auth,\n');
  const sigAnchor = '  releases: ControlReleaseModeOptions | null,\n  playtestTrace: PlaytestTraceReader | null,\n  auth: AuthRuntime | null,\n';
  if (!text.includes(sigAnchor)) throw new Error("route signature anchor missing");
  text = text.replace(sigAnchor, '  releases: ControlReleaseModeOptions | null,\n  playtestTrace: PlaytestTraceReader | null,\n  authorAssistant: Omit<AuthorAssistantDependencies, "store"> | null,\n  auth: AuthRuntime | null,\n');
  const contextAnchor = '    store,\n    releaseStore: releases?.store ?? null,\n';
  if (!text.includes(contextAnchor)) throw new Error("draft route context anchor missing");
  return text.replace(contextAnchor, '    store,\n    releaseStore: releases?.store ?? null,\n    authorAssistant: authorAssistant ? { ...authorAssistant, store } : null,\n    actorUserId: identity?.user.userId ?? "local-owner",\n');
});
