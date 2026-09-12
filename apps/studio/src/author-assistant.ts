import type {
  AuthorAgentCheckpoint,
  AuthorAgentJobRecord,
  AuthorAgentProposalArtifact,
  AuthorConversationMessage,
  AuthoringProposalPreview
} from "@living-history/control";
import {
  ControlApiClient,
  type AuthorJobReadView
} from "./api.js";
import { escapeAttr, escapeHtml } from "./dom-escape.js";
import { shortHash } from "./short-hash.js";

export interface AuthorProposalCardView {
  readonly artifact: AuthorAgentProposalArtifact;
  readonly preview: AuthoringProposalPreview | null;
  readonly previewError: string | null;
}

export interface AuthorAssistantPanelModel {
  readonly job: AuthorAgentJobRecord;
  readonly checkpoints: readonly AuthorAgentCheckpoint[];
  readonly messages: readonly AuthorConversationMessage[];
  readonly proposalCards: readonly AuthorProposalCardView[];
}

export type AuthorAssistantPanelState =
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly model: AuthorAssistantPanelModel };

export async function loadAuthorAssistantPanel(
  api: Pick<ControlApiClient, "listAuthorJobs" | "getAuthorJob" | "previewAuthoringProposal">,
  projectId: string,
  questId: string
): Promise<AuthorAssistantPanelState> {
  try {
    const jobs = await api.listAuthorJobs(projectId, questId);
    const latest = jobs[0];
    if (!latest) return Object.freeze({ kind: "empty" });
    const read = await api.getAuthorJob(projectId, questId, latest.jobId);
    return Object.freeze({ kind: "ready", model: await buildModel(api, read) });
  } catch (error) {
    return Object.freeze({
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "Author assistant unavailable"
    });
  }
}

async function buildModel(
  api: Pick<ControlApiClient, "previewAuthoringProposal">,
  read: AuthorJobReadView
): Promise<AuthorAssistantPanelModel> {
  const cards: AuthorProposalCardView[] = [];
  for (const artifact of read.proposalArtifacts) {
    try {
      const preview = await api.previewAuthoringProposal(read.job.projectId, read.job.questId, artifact.proposal);
      cards.push(Object.freeze({ artifact, preview, previewError: null }));
    } catch (error) {
      cards.push(Object.freeze({
        artifact,
        preview: null,
        previewError: error instanceof Error ? error.message : "preview unavailable"
      }));
    }
  }
  return deepFreeze({
    job: read.job,
    checkpoints: [...read.checkpoints],
    messages: [...read.messages],
    proposalCards: cards
  });
}

export interface AuthorAssistantRenderOptions {
  readonly canMutate: boolean;
  readonly hasMutationProof: boolean;
  readonly busy?: boolean;
}

export function renderAuthorAssistantPanel(
  state: AuthorAssistantPanelState,
  options: AuthorAssistantRenderOptions
): string {
  if (state.kind === "unavailable") {
    return `<section class="author-assistant" data-author-assistant><div class="author-assistant-head"><div><h2>Author Assistant</h2><p>Server contract недоступен.</p></div></div><div class="assistant-empty">${escapeHtml(state.reason)}</div></section>`;
  }
  if (state.kind === "empty") {
    const start = options.canMutate && options.hasMutationProof && options.busy !== true
      ? `<button class="primary" type="button" data-action="author-start">Начать диалог</button>`
      : `<div class="assistant-empty">Для нового диалога нужна editor/owner роль и свежий CSRF proof.</div>`;
    return `<section class="author-assistant" data-author-assistant><div class="author-assistant-head"><div><h2>Соавтор</h2><p>Переписка хранится на сервере</p></div></div>${start}
      <div class="assistant-actions"><button class="secondary" type="button" data-action="author-configure-ai">Настроить подключение ИИ</button></div>
      <p class="assistant-hint">Диалог с помощником возможен только при настроенном подключении к ИИ: провайдер, модель и ключ задаются в блоке «Подключение ИИ-помощника».</p></section>`;
  }

  const { model } = state;
  const job = model.job;
  const terminal = job.state === "succeeded" || job.state === "failed" || job.state === "cancelled";
  const busy = options.busy === true;
  const canSend = options.canMutate && options.hasMutationProof && !busy && !terminal && job.state !== "running" && job.state !== "validating";
  const canStop = options.canMutate && options.hasMutationProof && !terminal;
  const proposalOptions: AuthorAssistantRenderOptions = terminal
    ? { ...options, canMutate: false }
    : options;
  const cardByProposal = new Map(model.proposalCards.map((card) => [card.artifact.proposal.proposalId, card]));

  return `<section class="author-assistant" data-author-assistant>
    <div class="author-assistant-head">
      <div><h2>Author Assistant</h2><p>Persistent author chat · factual checkpoints only</p></div>
      <div class="assistant-job-meta">
        <span>mode <strong>author</strong></span>
        <span>backend <code>${escapeHtml(job.backendId)}</code></span>
        <span>state <strong>${escapeHtml(job.state)}</strong></span>
        <span>segment tools ${job.toolCallsUsed}/${job.grant.maxToolCalls}</span>
      </div>
      ${canStop ? `<button class="danger" data-action="author-stop" data-job-id="${escapeAttr(job.jobId)}">Stop</button>` : ""}
    </div>

    <details class="assistant-progress"><summary>Фактический прогресс · ${model.checkpoints.length} событий</summary>
      <ol>${model.checkpoints.slice(-12).map((checkpoint) => `<li><span>#${checkpoint.ordinal}</span>${escapeHtml(checkpointLabel(checkpoint))}</li>`).join("")}</ol>
    </details>

    <div class="assistant-messages" aria-live="polite">
      ${model.messages.map((message) => renderMessage(message, cardByProposal.get(message.proposalId ?? "") ?? null, proposalOptions)).join("") || `<div class="assistant-empty">Сообщений пока нет.</div>`}
    </div>

    ${job.state === "paused_budget" ? `<div class="assistant-budget-note">Segment budget исчерпан. Следующее сообщение может явно открыть новый bounded segment.</div>` : ""}
    ${canSend ? `<form class="assistant-composer" data-form="author-message">
      <input type="hidden" name="jobId" value="${escapeAttr(job.jobId)}">
      <textarea name="instruction" required maxlength="20000" rows="3" placeholder="Опишите, что изменить в текущей миссии…"></textarea>
      ${job.state === "paused_budget" ? `<input type="hidden" name="resumeBudget" value="true">` : ""}
      <button class="primary" type="submit">Отправить</button>
    </form>` : terminal
      ? `<div class="assistant-empty">Job завершён. ${options.canMutate && options.hasMutationProof && !busy ? `<button class="primary" data-action="author-start">Новый диалог</button>` : ""}</div>`
      : `<div class="assistant-empty">Assistant сейчас занят или mutation proof недоступен.</div>`}
  </section>`;
}

function renderMessage(
  message: AuthorConversationMessage,
  card: AuthorProposalCardView | null,
  options: AuthorAssistantRenderOptions
): string {
  const label = message.role === "author" ? "Вы" : "Assistant";
  return `<article class="assistant-message ${escapeAttr(message.role)}">
    <div class="assistant-message-label">${label}</div>
    <p>${escapeHtml(message.text)}</p>
    ${message.role === "assistant" && message.proposalId !== null ? renderProposalCard(card, options) : ""}
  </article>`;
}

function renderProposalCard(
  card: AuthorProposalCardView | null,
  options: AuthorAssistantRenderOptions
): string {
  if (!card) return `<div class="assistant-proposal blocked"><strong>Proposal artifact недоступен</strong><p>Apply запрещён.</p></div>`;
  const proposal = card.artifact.proposal;
  if (!card.preview) {
    return `<div class="assistant-proposal blocked"><strong>${escapeHtml(proposal.proposalId)}</strong><p>Server preview недоступен: ${escapeHtml(card.previewError ?? "unknown")}. Apply запрещён.</p></div>`;
  }
  const preview = card.preview;
  const comparison = preview.comparison;
  const missing = proposal.missingCapabilities;
  const applyAllowed = options.canMutate && options.hasMutationProof && options.busy !== true && preview.applyAllowed && !preview.stale;
  return `<div class="assistant-proposal ${applyAllowed ? "ready" : "blocked"}" data-proposal-id="${escapeAttr(proposal.proposalId)}">
    <div class="assistant-proposal-head"><strong>${escapeHtml(proposal.proposalId)}</strong><span>base r${proposal.baseRevision} · ${escapeHtml(shortHash(proposal.baseContentHash))}</span></div>
    ${comparison ? `<p class="assistant-diff">diff: +${comparison.addedBlockIds.length} / −${comparison.removedBlockIds.length} / ~${comparison.replacedBlockIds.length}${comparison.titleChanged ? " · title" : ""}${comparison.entryLocationChanged ? " · entry" : ""}</p>` : `<p class="assistant-diff">Изменений draft нет.</p>`}
    ${missing.length > 0 ? `<ul class="assistant-missing">${missing.map((item) => `<li><code>${escapeHtml(item.capabilityId)}</code> — ${escapeHtml(item.reason)}</li>`).join("")}</ul>` : ""}
    ${preview.stale ? `<p class="stale-note">Proposal устарел: current r${preview.currentRevision}. Новый preview не разрешает silent overwrite.</p>` : ""}
    ${applyAllowed ? `<button class="primary" data-action="author-apply" data-proposal-id="${escapeAttr(proposal.proposalId)}">Apply proposal</button>` : `<span class="access-note">Apply недоступен по текущему server preview.</span>`}
  </div>`;
}

function checkpointLabel(checkpoint: AuthorAgentCheckpoint): string {
  const fact = checkpoint.fact;
  switch (fact.kind) {
    case "job.created": return "Job создан";
    case "job.started": return "Bounded segment начат";
    case "segment.requested": return "Сообщение автора сохранено";
    case "draft.read": return `Прочитан bounded authoring context: ${fact.blockCount} blocks`;
    case "context.selected": return `Context r${fact.draftRevision}: selected ${fact.selectedBlockIds.length}, included ${fact.includedBlockIds.length}`;
    case "broker.pinned": return `Broker pinned ${fact.policyVersion}: ${fact.allowedToolIds.length} tools`;
    case "proposal.produced": return `Сформирован ${fact.proposalId}`;
    case "proposal.previewed": return `Server preview ${fact.proposalId}: stale=${fact.stale}, applyAllowed=${fact.applyAllowed}`;
    case "proposal.applied": return `Применён ${fact.proposalId} → r${fact.resultRevision}`;
    case "budget.paused": return `Segment budget paused: ${fact.toolCallsUsed} tools, ${fact.activeTimeMsUsed}ms`;
    case "job.resumed": return "Открыт новый bounded segment";
    case "job.cancelled": return "Job остановлен пользователем";
    case "job.failed": return `Job failed: ${fact.code}${jobFailedHint(fact.code)}`;
    case "job.succeeded": return "Job completed";
  }
}

function jobFailedHint(code: string): string {
  if (code === "context_too_large") return " — контекст кампании превышает локальный лимит; сократите миссию до 32 блоков или уменьшите объём текста.";
  if (code === "backend.auth_required") return " — ИИ не подключён или ключ отклонён: укажите провайдера, модель и ключ в форме «Подключение ИИ-помощника» выше.";
  if (code === "backend.rate_limited") return " — провайдер отвечает 429 (лимит запросов); повторите позже.";
  if (code === "backend.timeout") return " — провайдер не ответил за отведённое время; повторите запрос.";
  if (code === "backend.invalid_response") return " — провайдер вернул нечитаемый ответ; проверьте модель и её поддержку JSON-ответов.";
  if (code === "backend.session_expired") return " — сессия истекла; отправьте сообщение заново.";
  if (code === "backend.aborted") return " — запрос был прерван; отправьте сообщение заново.";
  if (code === "backend.backend_error") return " — провайдер вернул ошибку; проверьте адрес API и модель, затем повторите.";
  return "";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
