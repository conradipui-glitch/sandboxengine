from pathlib import Path

path = Path("apps/server/src/draft-version-http.ts")
text = path.read_text()

import_anchor = 'import { restoreControlDraft } from "./draft-version-authority.js";\n'
import_replacement = import_anchor + 'import { routeAuthoringProposalHttp } from "./authoring-proposal-http.js";\n'
if 'routeAuthoringProposalHttp' not in text:
    if import_anchor not in text:
        raise SystemExit("draft-version import anchor not found")
    text = text.replace(import_anchor, import_replacement, 1)

route_anchor = 'export async function routeDraftVersionHttp(context: DraftVersionHttpContext): Promise<boolean> {\n'
route_replacement = route_anchor + '  if (await routeAuthoringProposalHttp(context)) return true;\n\n'
if 'if (await routeAuthoringProposalHttp(context)) return true;' not in text:
    if route_anchor not in text:
        raise SystemExit("draft-version route anchor not found")
    text = text.replace(route_anchor, route_replacement, 1)

path.write_text(text)
