import type { PlaytestTraceView, PlaytestView } from "./api.js";
import { escapeHtml } from "./dom-escape.js";
import { shortHashWide as shortHash } from "./short-hash.js";

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
