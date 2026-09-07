from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match: {old[:180]!r}"
    return text.replace(old, new, 1)


server = Path("apps/server/src/control-server.ts")
text = server.read_text()
text = replace_once(
    text,
    'import type { DiceCheckDefinition } from "@living-history/plugins/dice-check";\n',
    'import type { DiceCheckDefinition } from "@living-history/plugins/dice-check";\nimport type { PlaytestTraceReader } from "@living-history/runtime";\n'
)
text = replace_once(
    text,
    '''export interface ControlServerDependencies {\n  readonly store: ControlStore;\n  readonly releases?: ControlReleaseModeOptions;\n  readonly auth?: ControlAuthenticatedModeOptions;\n}''',
    '''export interface ControlServerDependencies {\n  readonly store: ControlStore;\n  readonly releases?: ControlReleaseModeOptions;\n  readonly playtestTrace?: PlaytestTraceReader;\n  readonly auth?: ControlAuthenticatedModeOptions;\n}'''
)
text = replace_once(
    text,
    '''      await routeControlRequest(request, response, dependencies.store, releases, auth, failures);''',
    '''      await routeControlRequest(\n        request,\n        response,\n        dependencies.store,\n        releases,\n        dependencies.playtestTrace ?? null,\n        auth,\n        failures\n      );'''
)
text = replace_once(
    text,
    '''  store: ControlStore,\n  releases: ControlReleaseModeOptions | null,\n  auth: AuthRuntime | null,''',
    '''  store: ControlStore,\n  releases: ControlReleaseModeOptions | null,\n  playtestTrace: PlaytestTraceReader | null,\n  auth: AuthRuntime | null,'''
)
playtest_read = '''  const playtestReadMatch = /^\\/control\\/v1\\/projects\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/quests\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/playtests\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(url.pathname);\n  if (method === "GET" && playtestReadMatch) {\n    const projectId = playtestReadMatch[1];\n    const questId = playtestReadMatch[2];\n    const playtestId = playtestReadMatch[3];\n    if (!projectId || !questId || !playtestId) { sendNotFound(response); return; }\n    if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;\n    const playtest = await store.getPlaytest(playtestId);\n    if (!playtest || playtest.projectId !== projectId || playtest.questId !== questId) sendNotFound(response);\n    else sendJson(response, 200, { playtest: playtestView(playtest) });\n    return;\n  }\n'''
trace_route = playtest_read + '''\n  const playtestTraceMatch = /^\\/control\\/v1\\/projects\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/quests\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/playtests\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\\/trace$/.exec(url.pathname);\n  if (method === "GET" && playtestTraceMatch) {\n    const projectId = playtestTraceMatch[1];\n    const questId = playtestTraceMatch[2];\n    const playtestId = playtestTraceMatch[3];\n    if (!projectId || !questId || !playtestId) { sendNotFound(response); return; }\n    if (!(await requireProjectRole(response, auth, identity, projectId, "tester"))) return;\n    if (!playtestTrace) { sendNotFound(response); return; }\n    const playtest = await store.getPlaytest(playtestId);\n    if (!playtest || playtest.projectId !== projectId || playtest.questId !== questId) {\n      sendNotFound(response);\n      return;\n    }\n    const evidence = await playtestTrace.readPlaytestTrace({\n      questId: playtest.questId,\n      releaseId: `playtest-${playtest.playtestId}`,\n      contentHash: playtest.contentHash\n    });\n    sendJson(response, 200, {\n      trace: Object.freeze({\n        identityKind: "frozen_playtest",\n        publishedRelease: false,\n        playtest: playtestView(playtest),\n        runtimePinnedRelease: evidence.runtimePinnedRelease,\n        sessions: evidence.sessions,\n        hasMoreSessions: evidence.hasMoreSessions\n      })\n    });\n    return;\n  }\n'''
text = replace_once(text, playtest_read, trace_route)
server.write_text(text)


main = Path("apps/server/src/main.ts")
text = main.read_text()
text = replace_once(
    text,
    '''  SQLiteGuestSessionAccess,\n  SQLiteRuntimeStorage''',
    '''  SQLiteGuestSessionAccess,\n  SQLitePlaytestTraceReader,\n  SQLiteRuntimeStorage'''
)
text = replace_once(
    text,
    '''const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });\nconst controlStore''',
    '''const guestAccess = new SQLiteGuestSessionAccess({ path: databasePath });\nconst playtestTrace = new SQLitePlaytestTraceReader({ path: databasePath });\nconst controlStore'''
)
text = replace_once(
    text,
    '''  releases: {\n    store: releaseStore,\n    pluginRegistry,\n    nowMs: clock.nowMs\n  },\n  auth:''',
    '''  releases: {\n    store: releaseStore,\n    pluginRegistry,\n    nowMs: clock.nowMs\n  },\n  playtestTrace,\n  auth:'''
)
text = replace_once(
    text,
    '''  guestAccess.close();\n  storage.close();''',
    '''  guestAccess.close();\n  playtestTrace.close();\n  storage.close();'''
)
main.write_text(text)


studio = Path("apps/studio/src/main.ts")
text = studio.read_text()
text = replace_once(
    text,
    '''import { DICE_CHECK_MANIFEST } from "@living-history/plugins/dice-check";\nimport { createStudioDevServer }''',
    '''import { DICE_CHECK_MANIFEST } from "@living-history/plugins/dice-check";\nimport { SQLitePlaytestTraceReader } from "@living-history/runtime";\nimport { createStudioDevServer }'''
)
text = replace_once(
    text,
    '''const releaseStore = new SQLiteControlReleaseStore({ path: databasePath });''',
    '''const releaseStore = new SQLiteControlReleaseStore({ path: databasePath });\nconst playtestTrace = new SQLitePlaytestTraceReader({ path: databasePath });'''
)
text = replace_once(
    text,
    '''  releases: {\n    store: releaseStore,\n    pluginRegistry: builtPluginRegistry.registry,\n    nowMs: () => Date.now()\n  }\n});''',
    '''  releases: {\n    store: releaseStore,\n    pluginRegistry: builtPluginRegistry.registry,\n    nowMs: () => Date.now()\n  },\n  playtestTrace\n});'''
)
text = replace_once(
    text,
    '''  releaseStore.close();\n  store.close();''',
    '''  playtestTrace.close();\n  releaseStore.close();\n  store.close();'''
)
studio.write_text(text)
