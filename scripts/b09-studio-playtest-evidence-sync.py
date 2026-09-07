from pathlib import Path


def replace_once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match: {old[:180]!r}"
    return text.replace(old, new, 1)


api = Path("apps/studio/src/api.ts")
text = api.read_text()
text = replace_once(
    text,
    'import type { Block } from "@living-history/contracts";',
    'import type { Block, JsonValue } from "@living-history/contracts";'
)
text = replace_once(
    text,
    '''export interface PlaytestView {\n  readonly playtestId: string;\n  readonly projectId: string;\n  readonly questId: string;\n  readonly draftRevision: number;\n  readonly contentHash: string;\n  readonly validationId: string;\n  readonly compiledContentHash: string;\n}\n''',
    '''export interface PlaytestView {\n  readonly playtestId: string;\n  readonly projectId: string;\n  readonly questId: string;\n  readonly draftRevision: number;\n  readonly contentHash: string;\n  readonly validationId: string;\n  readonly compiledContentHash: string;\n}\n\nexport interface PlaytestTraceTurnView {\n  readonly turnId: string;\n  readonly beforeRevision: number;\n  readonly afterRevision: number;\n  readonly stateHash: string;\n}\n\nexport interface PlaytestTraceOperationView {\n  readonly operationId: string;\n  readonly expectedRevision: number;\n  readonly status: "completed" | "finished_without_turn";\n  readonly completionKind: "turn" | "without_turn";\n  readonly turn: PlaytestTraceTurnView | null;\n  readonly publicResponse: Readonly<Record<string, JsonValue>>;\n}\n\nexport interface PlaytestTraceSessionView {\n  readonly sessionId: string;\n  readonly currentRevision: number;\n  readonly operations: readonly PlaytestTraceOperationView[];\n  readonly hasMoreOperations: boolean;\n}\n\nexport interface PlaytestTraceView {\n  readonly identityKind: "frozen_playtest";\n  readonly publishedRelease: false;\n  readonly playtest: PlaytestView;\n  readonly runtimePinnedRelease: {\n    readonly questId: string;\n    readonly releaseId: string;\n    readonly contentHash: string;\n  };\n  readonly sessions: readonly PlaytestTraceSessionView[];\n  readonly hasMoreSessions: boolean;\n}\n'''
)
text = replace_once(
    text,
    '''  async createPlaytest(\n    projectId: string,\n    questId: string,\n    draftRevision: number,\n    validationId: string\n  ): Promise<PlaytestView> {\n    const body = await this.request<{ readonly playtest: PlaytestView }>(\n      "POST",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/playtests`,\n      { draftRevision, validationId }\n    );\n    return body.playtest;\n  }\n''',
    '''  async createPlaytest(\n    projectId: string,\n    questId: string,\n    draftRevision: number,\n    validationId: string\n  ): Promise<PlaytestView> {\n    const body = await this.request<{ readonly playtest: PlaytestView }>(\n      "POST",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/playtests`,\n      { draftRevision, validationId }\n    );\n    return body.playtest;\n  }\n\n  async getPlaytestTrace(projectId: string, questId: string, playtestId: string): Promise<PlaytestTraceView> {\n    const body = await this.request<{ readonly trace: PlaytestTraceView }>(\n      "GET",\n      `/projects/${encodeURIComponent(projectId)}/quests/${encodeURIComponent(questId)}/playtests/${encodeURIComponent(playtestId)}/trace`\n    );\n    return body.trace;\n  }\n'''
)
api.write_text(text)


evidence = Path("apps/studio/src/playtest-evidence.ts")
evidence.write_text(r'''import type { PlaytestTraceView, PlaytestView } from "./api.js";

const MAX_RENDERED_RESPONSE_CHARS = 4_000;

export function renderPlaytestEvidence(
  playtest: PlaytestView | null,
  trace: PlaytestTraceView | null,
  errorMessage: string | null
): string {
  if (!playtest) return "";
  const identityMatches = trace !== null
    && trace.identityKind === "frozen_playtest"
    && trace.publishedRelease === false
    && trace.playtest.playtestId === playtest.playtestId
    && trace.playtest.draftRevision === playtest.draftRevision
    && trace.playtest.contentHash === playtest.contentHash
    && trace.playtest.validationId === playtest.validationId
    && trace.playtest.compiledContentHash === playtest.compiledContentHash;

  return `<section class="playtest-evidence" aria-labelledby="playtest-evidence-heading">
    <div class="section-title">
      <div>
        <h3 id="playtest-evidence-heading">Playtest evidence</h3>
        <p>Persisted evidence only: Studio ничего не переигрывает и не вычисляет заново.</p>
      </div>
      <button data-action="refresh-playtest-evidence">Обновить evidence</button>
    </div>
    <div class="evidence-identity">
      <div><span>frozen playtest</span><strong>${escapeHtml(playtest.playtestId)}</strong></div>
      <div><span>draft</span><strong>r${playtest.draftRevision}</strong><code>${escapeHtml(shortHash(playtest.contentHash))}</code></div>
      <div><span>validation</span><code>${escapeHtml(playtest.validationId)}</code></div>
      <div><span>compiled</span><code>${escapeHtml(shortHash(playtest.compiledContentHash))}</code></div>
    </div>
    ${errorMessage ? `<div class="evidence-error">${escapeHtml(errorMessage)}</div>` : ""}
    ${trace === null ? `<p class="form-hint">Runtime evidence ещё не загружена.</p>` : identityMatches ? renderTrace(trace) : `<div class="evidence-error">Trace identity не совпала с frozen playtest; данные скрыты fail-closed.</div>`}
  </section>`;
}

function renderTrace(trace: PlaytestTraceView): string {
  const sessions = trace.sessions.map((session) => `<article class="evidence-session">
    <div class="evidence-session-head">
      <div><strong>${escapeHtml(session.sessionId)}</strong><small>Runtime revision ${session.currentRevision}</small></div>
      <span>${session.operations.length}${session.hasMoreOperations ? "+" : ""} completed ops</span>
    </div>
    <div class="evidence-operation-list">
      ${session.operations.map((operation) => renderOperation(operation)).join("") || `<p class="form-hint">Session создана, но completed operations пока нет.</p>`}
    </div>
  </article>`).join("");

  return `<div class="runtime-evidence">
    <div class="runtime-pin">
      <span>Runtime pin · frozen playtest, <strong>НЕ published release</strong></span>
      <code>${escapeHtml(trace.runtimePinnedRelease.releaseId)}</code>
      <small>${escapeHtml(trace.runtimePinnedRelease.questId)} · ${escapeHtml(shortHash(trace.runtimePinnedRelease.contentHash))}</small>
    </div>
    ${sessions || `<p class="form-hint">Matching Runtime sessions пока нет: Player ещё не запускался или не создал session для этого frozen playtest.</p>`}
    ${trace.hasMoreSessions ? `<p class="form-hint">Показан bounded набор sessions; дополнительные persisted sessions существуют.</p>` : ""}
  </div>`;
}

function renderOperation(operation: PlaytestTraceView["sessions"][number]["operations"][number]): string {
  const response = renderedJson(operation.publicResponse);
  const turn = operation.turn
    ? `<span>turn ${escapeHtml(operation.turn.turnId)} · r${operation.turn.beforeRevision}→r${operation.turn.afterRevision} · ${escapeHtml(shortHash(operation.turn.stateHash))}</span>`
    : `<span>without turn · expected r${operation.expectedRevision}</span>`;
  return `<details class="evidence-operation">
    <summary><strong>${escapeHtml(operation.operationId)}</strong><span>${escapeHtml(operation.completionKind)}</span>${turn}</summary>
    <pre>${escapeHtml(response.text)}</pre>
    ${response.truncated ? `<small>UI preview truncated; authoritative response remains persisted on server.</small>` : ""}
  </details>`;
}

function renderedJson(value: unknown): { readonly text: string; readonly truncated: boolean } {
  let text: string;
  try { text = JSON.stringify(value, null, 2); } catch { text = "[unrenderable persisted response]"; }
  if (text.length <= MAX_RENDERED_RESPONSE_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_RENDERED_RESPONSE_CHARS)}\n…`, truncated: true };
}

function shortHash(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
''')


app = Path("apps/studio/src/app.ts")
text = app.read_text()
text = replace_once(
    text,
    '''  type DraftView,\n  type PlaytestView,''',
    '''  type DraftView,\n  type PlaytestTraceView,\n  type PlaytestView,'''
)
text = replace_once(
    text,
    '''} from "./access.js";\n''',
    '''} from "./access.js";\nimport { renderPlaytestEvidence } from "./playtest-evidence.js";\n'''
)
text = replace_once(
    text,
    '''  playtest: PlaytestView | null;\n  versions: VersionsReadModel | null;''',
    '''  playtest: PlaytestView | null;\n  playtestTrace: PlaytestTraceView | null;\n  playtestTraceError: string | null;\n  versions: VersionsReadModel | null;'''
)
text = replace_once(
    text,
    '''    playtest: null,\n    versions: null,''',
    '''    playtest: null,\n    playtestTrace: null,\n    playtestTraceError: null,\n    versions: null,'''
)
text = replace_once(
    text,
    '''    if (action === "logout") {''',
    '''    if (action === "refresh-playtest-evidence") {\n      await this.refreshPlaytestEvidence();\n      return;\n    }\n    if (action === "logout") {'''
)
# Clear evidence with playtest identity on logout/project/quest/new quest.
text = text.replace('''      this.state.playtest = null;\n      this.state.versions = null;''', '''      this.state.playtest = null;\n      this.state.playtestTrace = null;\n      this.state.playtestTraceError = null;\n      this.state.versions = null;''', 3)
# A newly created quest block also resets playtest.
text = replace_once(
    text,
    '''        this.state.playtest = null;\n        this.state.versions = null;''',
    '''        this.state.playtest = null;\n        this.state.playtestTrace = null;\n        this.state.playtestTraceError = null;\n        this.state.versions = null;'''
)
text = replace_once(
    text,
    '''      this.state.playtest = await this.api.createPlaytest(\n        projectId,\n        questId,\n        draft.draftRevision,\n        validation.validationId\n      );\n      this.state.phase = "saved";\n      this.state.message = `Frozen playtest ${this.state.playtest.playtestId} создан.`;''',
    '''      this.state.playtest = await this.api.createPlaytest(\n        projectId,\n        questId,\n        draft.draftRevision,\n        validation.validationId\n      );\n      this.state.playtestTrace = null;\n      this.state.playtestTraceError = null;\n      await this.refreshPlaytestEvidence(false);\n      this.state.phase = "saved";\n      this.state.message = `Frozen playtest ${this.state.playtest.playtestId} создан; persisted evidence загружена.`;'''
)
marker = '''  private setError(error: unknown): void {'''
method = '''  private async refreshPlaytestEvidence(renderAfter = true): Promise<void> {\n    const playtest = this.state.playtest;\n    if (!playtest) return;\n    const projectId = requireSelected(this.state.selectedProjectId, "Проект не выбран.");\n    const questId = requireSelected(this.state.selectedQuestId, "Квест не выбран.");\n    this.state.playtestTraceError = null;\n    try {\n      const trace = await this.api.getPlaytestTrace(projectId, questId, playtest.playtestId);\n      const identityMatches = trace.playtest.playtestId === playtest.playtestId\n        && trace.playtest.draftRevision === playtest.draftRevision\n        && trace.playtest.contentHash === playtest.contentHash\n        && trace.playtest.validationId === playtest.validationId\n        && trace.playtest.compiledContentHash === playtest.compiledContentHash\n        && trace.runtimePinnedRelease.questId === playtest.questId\n        && trace.runtimePinnedRelease.releaseId === `playtest-${playtest.playtestId}`\n        && trace.runtimePinnedRelease.contentHash === playtest.contentHash\n        && trace.identityKind === "frozen_playtest"\n        && trace.publishedRelease === false;\n      if (!identityMatches) throw new Error("Playtest trace identity mismatch.");\n      this.state.playtestTrace = trace;\n      if (renderAfter) {\n        const completed = trace.sessions.reduce((sum, session) => sum + session.operations.length, 0);\n        this.state.message = `Playtest evidence обновлена: ${trace.sessions.length} sessions · ${completed} completed ops.`;\n      }\n    } catch (error) {\n      this.state.playtestTrace = null;\n      this.state.playtestTraceError = error instanceof ControlApiError\n        ? `Playtest trace API: ${error.code}.`\n        : error instanceof Error\n          ? `Playtest trace: ${error.message}`\n          : "Playtest trace: неизвестная ошибка.";\n      if (renderAfter) this.state.message = "Persisted playtest evidence недоступна; frozen playtest не изменён.";\n    }\n    if (renderAfter) this.render();\n  }\n\n'''
text = replace_once(text, marker, method + marker)
text = replace_once(
    text,
    '''              ${playtestPanel(this.state.playtest, this.state.validation, draft, this.state.phase, allowTest)}\n            </section>''',
    '''              ${playtestPanel(this.state.playtest, this.state.validation, draft, this.state.phase, allowTest)}\n              ${renderPlaytestEvidence(this.state.playtest, this.state.playtestTrace, this.state.playtestTraceError)}\n            </section>'''
)
# Make frozen panel evidence explicit while keeping launch command.
text = replace_once(
    text,
    '''      <span>revision ${playtest.draftRevision} · ${id}</span>\n      <p>Player запустится именно из этой замороженной версии, даже если draft позже изменится.</p>''',
    '''      <span>revision ${playtest.draftRevision} · ${id}</span>\n      <p>validation <code>${escapeHtml(playtest.validationId)}</code> · compiled <code>${escapeHtml(shortHash(playtest.compiledContentHash))}</code></p>\n      <p>Player запустится именно из этой замороженной версии, даже если draft позже изменится. Это frozen playtest, а не published release.</p>'''
)
app.write_text(text)


styles = Path("apps/studio/styles.css")
css = styles.read_text()
marker = "\n@media (max-width: 900px) {"
assert css.count(marker) == 1
extra = r'''

.playtest-evidence { margin-top: 16px; padding-top: 16px; border-top: 1px solid #d9dee8; }
.evidence-identity { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 10px 0; }
.evidence-identity > div, .runtime-pin { padding: 9px 10px; border: 1px solid #d8dfeb; border-radius: 8px; background: #f8fafc; display: grid; gap: 3px; }
.evidence-identity span, .evidence-identity code, .runtime-pin small { font-size: 11px; color: #68758a; }
.runtime-pin { margin: 10px 0; }
.evidence-error { padding: 9px 10px; border: 1px solid #e6bcbc; border-radius: 8px; background: #fff5f5; color: #7d3030; }
.evidence-session { margin-top: 10px; border: 1px solid #d8dfeb; border-radius: 8px; overflow: hidden; }
.evidence-session-head { padding: 9px 10px; background: #f7f9fc; display: flex; justify-content: space-between; gap: 10px; }
.evidence-session-head div { display: grid; gap: 2px; }
.evidence-session-head small, .evidence-session-head span { color: #68758a; font-size: 11px; }
.evidence-operation { padding: 8px 10px; border-top: 1px solid #e4e8ef; }
.evidence-operation summary { cursor: pointer; display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }
.evidence-operation summary span { font-size: 11px; color: #68758a; }
.evidence-operation pre { max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: #111827; color: #e5e7eb; padding: 10px; border-radius: 6px; font-size: 11px; }
@media (max-width: 700px) { .evidence-identity { grid-template-columns: 1fr 1fr; } }
'''
css = css.replace(marker, extra + marker, 1)
styles.write_text(css)
