from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one anchor in {path}, found {count}: {old!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "apps/server/src/author-backend-tool-protocol.ts",
    'import { createAuthorReferenceToolBridge } from "./author-tool-loop.js";',
    'import { createAuthorReferenceToolBridge, type AuthorReferenceToolBridgeResult } from "./author-tool-loop.js";'
)
replace_once(
    "apps/server/src/author-backend-tool-protocol.ts",
    '  if (input.signal?.aborted || tool.code === "mcp_aborted") {',
    '  if (input.signal?.aborted || (tool.kind === "unavailable" && tool.code === "mcp_aborted")) {'
)
replace_once(
    "apps/server/src/author-backend-tool-protocol.ts",
    'function toolResultJson(request: AuthorBackendReferenceToolRequest, result: Exclude<Awaited<ReturnType<ReturnType<typeof createAuthorReferenceToolBridge>["readReference"]>>, { kind: "pending" | "paused_budget" | "denied" }>): string {',
    'function toolResultJson(request: AuthorBackendReferenceToolRequest, result: Exclude<AuthorReferenceToolBridgeResult, { kind: "pending" | "paused_budget" | "denied" }>): string {'
)
replace_once(
    "apps/server/src/author-mcp.ts",
    '    removeParentAbort?.();',
    '    const cleanupParentAbort = removeParentAbort as (() => void) | null;\n    cleanupParentAbort?.();'
)
