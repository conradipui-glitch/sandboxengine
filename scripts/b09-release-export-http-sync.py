from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match for: {old[:80]!r}"
    return text.replace(old, new, 1)


draft = Path("apps/server/src/draft-version-http.ts")
text = draft.read_text()
text = replace_once(
    text,
    "  buildDraftQuestExport,\n  cloneQuestFromStore,",
    "  buildDraftQuestExport,\n  buildReleaseQuestExport,\n  cloneQuestFromStore,",
)
text = replace_once(
    text,
    "  type ControlProjectRole,\n  type ControlStore,",
    "  type ControlProjectRole,\n  type ControlReleaseStore,\n  type ControlStore,",
)
text = replace_once(
    text,
    "  readonly store: ControlStore;\n  readonly requireRole:",
    '  readonly store: ControlStore;\n  readonly releaseStore: Pick<ControlReleaseStore, "getRelease"> | null;\n  readonly requireRole:',
)

start_marker = "  const exportMatch = /^\\/control\\/v1\\/projects"
end_marker = "  const clone = /^\\/control\\/v1\\/projects"
start = text.index(start_marker)
end = text.index(end_marker, start)
block = r'''  const exportMatch = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/export$/.exec(context.url.pathname);
  if (exportMatch) {
    if (context.method !== "GET") { context.sendNotFound(); return true; }
    const projectId = exportMatch[1];
    const questId = exportMatch[2];
    if (!projectId || !questId) { context.sendNotFound(); return true; }
    if (!(await context.requireRole(projectId, "editor"))) return true;

    const draftSelected = hasExactQuery(context.url.searchParams, ["draftRevision"]);
    const releaseSelected = hasExactQuery(context.url.searchParams, ["releaseId"]);
    if (draftSelected === releaseSelected) {
      context.sendJson(400, { error: { code: "INVALID_QUEST_EXPORT_REQUEST" } });
      return true;
    }

    if (draftSelected) {
      const draftRevision = parseRevisionQuery(context.url.searchParams.get("draftRevision"));
      if (draftRevision === null) {
        context.sendJson(400, { error: { code: "INVALID_QUEST_EXPORT_REQUEST" } });
        return true;
      }
      const result = await buildDraftQuestExport(context.store, projectId, questId, draftRevision);
      if (result.kind === "quest_not_found") context.sendNotFound();
      else if (result.kind === "revision_not_found") {
        context.sendJson(404, { error: { code: "DRAFT_REVISION_NOT_FOUND", revision: result.revision } });
      } else if (result.kind === "invalid_request") {
        context.sendJson(400, { error: { code: "INVALID_QUEST_EXPORT_REQUEST" } });
      } else {
        context.sendJson(200, exportEnvelope(result.value));
      }
      return true;
    }

    const releaseId = context.url.searchParams.get("releaseId");
    if (!isId(releaseId)) {
      context.sendJson(400, { error: { code: "INVALID_QUEST_EXPORT_REQUEST" } });
      return true;
    }
    if (context.releaseStore === null) {
      context.sendNotFound();
      return true;
    }
    const result = await buildReleaseQuestExport(context.releaseStore, projectId, questId, releaseId);
    if (result.kind === "release_not_found") context.sendNotFound();
    else if (result.kind === "release_integrity_failed") {
      context.sendJson(422, { error: { code: "RELEASE_EXPORT_INTEGRITY_FAILED" } });
    } else if (result.kind === "unsupported_dependencies") {
      context.sendJson(422, { error: { code: "QUEST_EXPORT_UNSUPPORTED_DEPENDENCIES" } });
    } else if (result.kind === "invalid_request") {
      context.sendJson(400, { error: { code: "INVALID_QUEST_EXPORT_REQUEST" } });
    } else {
      context.sendJson(200, exportEnvelope(result.value));
    }
    return true;
  }

'''
text = text[:start] + block + text[end:]
text = replace_once(
    text,
    "function base64(bytes: Uint8Array): string {",
    '''function exportEnvelope(value: { readonly filename: string; readonly mediaType: string; readonly archive: Uint8Array; readonly manifest: unknown }): object {
  return Object.freeze({
    filename: value.filename,
    mediaType: value.mediaType,
    encoding: "base64",
    archiveBase64: base64(value.archive),
    manifest: value.manifest
  });
}

function base64(bytes: Uint8Array): string {''',
)
draft.write_text(text)

control = Path("apps/server/src/control-server.ts")
text = control.read_text()
text = replace_once(
    text,
    "  if (await routeDraftVersionHttp({\n    method,\n    url,\n    store,\n    requireRole:",
    "  if (await routeDraftVersionHttp({\n    method,\n    url,\n    store,\n    releaseStore: releases?.store ?? null,\n    requireRole:",
)
control.write_text(text)
