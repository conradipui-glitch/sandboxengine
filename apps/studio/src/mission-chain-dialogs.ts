/**
 * AI-CHAIN: хранилище диалогов создания миссии (stateful conversation).
 *
 * Каждый диалог — отдельная машина состояний с бэкенд-сессией:
 *   interview (вопрос → ответ автора) → chain_ready → generating → ready.
 *
 * Хранится в памяти процесса Studio: диалог — это живая сессия с локальным
 * провайдером автора, а не артефакт проекта. Перезапуск сервера честно
 * возвращает «диалог не найден»: автор начинает заново, идея у него сохраняется
 * в поле на клиенте.
 *
 * Сгенерированный документ миссии живёт здесь же до применения: клиент
 * применяет его штатным CAS-маршрутом сохранения миссии (saveMission с
 * ожидаемой ревизией), как и раньше — в обход CAS диалог не идёт.
 */
import {
  MissionChainAgent,
  MISSION_CHAIN_MIN_QUESTIONS,
  MISSION_CHAIN_MAX_QUESTIONS,
  missionIntentFromChain,
  ModelMissionWriter,
  type MissionChainSummary,
  type MissionChainTurnResult,
  type AgentBackend,
  type MissionWriterIntent
} from "@living-history/ai";
import type { MissionDraft } from "@living-history/contracts";

const MAX_SESSIONS = 16;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_MESSAGE_CHARS = 1_000;
const CHAIN_BACKEND_DEADLINE_MS = 60_000;
// Ход сборки цепочки — один длинный ответ модели: весь документ сцен, выборов и
// финалов приходит одним сообщением. Живой прогон на стенде отдавал его за 60–90 с,
// и прежние 60 с давали автору «Помощник не ответил за отведённое время» при живом
// ключе. Вопросы интервью отвечаются за секунды, поэтому общий бюджет не трогаем.
const CHAIN_ASSEMBLE_DEADLINE_MS = 420_000;
// Бюджет писателя миссии: документ — это десятки сцен, выборов и финалов в JSON,
// и писатель делит бюджет между двумя попытками (attempt 1 получает половину).
// 240 с давали первой попытке 120 с — reasoning-модель не успевала, и автор
// видел «Mission writer backend deadline expired» при живом ключе. Живой прогон
// на стенде (0e31651) показал, что и 540 с бывает мало: обе попытки по 270 с
// выгорели в timeout, документ не пришёл. 900 с дают по 450 с на попытку.
const CHAIN_WRITER_DEADLINE_MS = 900_000;

export interface MissionChainMessage {
  readonly role: "author" | "assistant";
  readonly text: string;
}

export type MissionChainStage = "interview" | "chain_ready" | "generating" | "ready" | "failed";

export interface MissionChainStats {
  readonly sceneCount: number;
  readonly endingCount: number;
  readonly choiceCount: number;
  readonly repairs: readonly string[];
}

export interface MissionChainSessionView {
  readonly sessionId: string;
  readonly stage: MissionChainStage;
  readonly messages: readonly MissionChainMessage[];
  readonly questionsAnswered: number;
  readonly questionsMin: number;
  readonly questionsMax: number;
  readonly summary: MissionChainSummary | null;
  readonly stats: MissionChainStats | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly updatedAtMs: number;
}

interface SessionRecord {
  readonly sessionId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly agent: MissionChainAgent;
  readonly messages: MissionChainMessage[];
  stage: MissionChainStage;
  summary: MissionChainSummary | null;
  document: MissionDraft | null;
  stats: MissionChainStats | null;
  error: { readonly code: string; readonly message: string } | null;
  busy: boolean;
  updatedAtMs: number;
}

export interface MissionChainDialogStoreOptions {
  readonly backend: AgentBackend;
  readonly profileId: string;
  readonly nowMs?: () => number;
  readonly ttlMs?: number;
  readonly maxSessions?: number;
}

export class MissionChainDialogStore {
  readonly #backend: AgentBackend;
  readonly #profileId: string;
  readonly #nowMs: () => number;
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #sessions = new Map<string, SessionRecord>();
  #ordinal = 0;

  constructor(options: MissionChainDialogStoreOptions) {
    this.#backend = options.backend;
    this.#profileId = options.profileId;
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    this.#maxSessions = options.maxSessions ?? MAX_SESSIONS;
  }

  get activeCount(): number {
    return this.#sessions.size;
  }

  /**
   * Начало диалога: по идее автора бэкенд задаёт первый уточняющий вопрос.
   * Сбой старта не создаёт диалога — автор сразу видит ошибку и может повторить.
   */
  async start(request: {
    readonly projectId: string;
    readonly questId: string;
    readonly idea: string;
  }): Promise<MissionChainSessionView> {
    const idea = typeof request.idea === "string" ? request.idea.trim() : "";
    if (idea.length === 0 || idea.length > 4_000) {
      return failedView("invalid_idea", "Опишите идею текстом от 1 до 4 000 символов.");
    }
    this.#evictExpired();
    while (this.#sessions.size >= this.#maxSessions) {
      const oldest = [...this.#sessions.values()].sort((a, b) => a.updatedAtMs - b.updatedAtMs)[0];
      if (oldest === undefined) break;
      this.#sessions.delete(oldest.sessionId);
    }
    const agent = new MissionChainAgent({
      backend: this.#backend,
      profileId: this.#profileId,
      idea
    });
    const turn = await agent.start(this.#nowMs() + CHAIN_BACKEND_DEADLINE_MS);
    if (turn.kind === "failed") {
      return failedView(mapTurnCode(turn.code), turn.message);
    }
    if (turn.kind !== "question") {
      return failedView("invalid_response", "Помощник не задал первый вопрос: попробуйте начать диалог ещё раз.");
    }
    const sessionId = `chain-${Date.now().toString(36)}-${(++this.#ordinal).toString(36)}`;
    const record: SessionRecord = {
      sessionId,
      projectId: request.projectId,
      questId: request.questId,
      agent,
      messages: [
        { role: "author", text: idea },
        { role: "assistant", text: turn.text }
      ],
      stage: "interview",
      summary: null,
      document: null,
      stats: null,
      error: null,
      busy: false,
      updatedAtMs: this.#nowMs()
    };
    this.#sessions.set(sessionId, record);
    return view(record);
  }

  /** Ход автора: ответ на текущий вопрос помощника. */
  async reply(sessionId: string, text: string): Promise<MissionChainSessionView> {
    const session = this.#liveSession(sessionId);
    if (session === null) return unknownSession();
    if (session.stage !== "interview") {
      return view(session, "Ответ можно отправить только на текущий вопрос интервью.");
    }
    const message = typeof text === "string" ? text.trim() : "";
    if (message.length === 0 || message.length > MAX_MESSAGE_CHARS) {
      return view(session, `Ответ — текст от 1 до ${MAX_MESSAGE_CHARS} символов.`);
    }
    if (session.busy) return view(session, "Помощник ещё отвечает: подождите завершения хода.");
    session.busy = true;
    let turn: MissionChainTurnResult;
    try {
      turn = await session.agent.reply(message, this.#nowMs() + CHAIN_BACKEND_DEADLINE_MS);
    } finally {
      session.busy = false;
    }
    session.updatedAtMs = this.#nowMs();
    if (turn.kind === "failed") {
      // Ответ автора не потерян: он остался в поле на клиенте, ход можно повторить.
      session.error = Object.freeze({ code: mapTurnCode(turn.code), message: turn.message });
      return view(session);
    }
    session.error = null;
    session.messages.push({ role: "author", text: message });
    if (turn.kind === "question") {
      session.messages.push({ role: "assistant", text: turn.text });
      session.stage = "interview";
      return view(session);
    }
    // chain_ready: показываем автору собранную цепочку и нарратив.
    session.messages.push({ role: "assistant", text: chainReportText(turn.summary) });
    session.summary = turn.summary;
    session.stage = "chain_ready";
    return view(session);
  }

  /**
   * Подтверждение цепочки автором: генерация полной миссии штатным
   * mission-writer по интенту, собранному из цепочки. Документ возвращается
   * вызывающей стороне и применяется потом штатным CAS-маршрутом.
   */
  async confirm(sessionId: string): Promise<MissionChainSessionView> {
    const session = this.#liveSession(sessionId);
    if (session === null) return unknownSession();
    if (session.stage === "interview") {
      // Автор просит собрать по уже сказанному: интервью закрывает тот же
      // агент, который его вёл, — цепочка собирается моделью, а не сервером.
      const refusal = await this.#closeInterview(session);
      if (refusal !== null) return view(session, refusal);
    }
    if (session.stage !== "chain_ready" || session.summary === null) {
      return view(session, "Сначала соберите цепочку: ответьте на вопросы помощника.");
    }
    if (session.busy) return view(session, "Генерация уже идёт: подождите.");
    session.busy = true;
    session.stage = "generating";
    session.error = null;
    try {
      const intent: MissionWriterIntent = missionIntentFromChain(session.summary);
      const writer = new ModelMissionWriter({
        backend: this.#backend,
        profileId: this.#profileId,
        projectId: session.projectId,
        questId: session.questId
      });
      const result = await writer.write({ intent, deadlineAtMs: this.#nowMs() + CHAIN_WRITER_DEADLINE_MS });
      if (result.kind === "ok") {
        session.document = result.document;
        const scenes = result.document.story.scenes;
        session.stats = Object.freeze({
          sceneCount: scenes.length,
          endingCount: result.document.story.endings.length,
          choiceCount: scenes.reduce((total, scene) => total + (scene.choices?.length ?? 0), 0),
          repairs: [...result.repairs]
        });
        session.stage = "ready";
      } else {
        session.stage = "chain_ready";
        session.error = Object.freeze({
          code: writerFailureCode(result.kind),
          message: writerFailureMessage(result)
        });
      }
    } catch (error) {
      // Исключение не прячем за общим текстом: автору нужна причина, а стенду —
      // след в журнале. Секретов в этих сообщениях нет (идентификаторы и код).
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`[mission-chain] генерация документа сорвалась: ${detail}`);
      session.stage = "chain_ready";
      session.error = Object.freeze({
        code: "backend_failure",
        message: `Генерация миссии сорвалась: ${detail.slice(0, 160)}. Повторите подтверждение.`
      });
    } finally {
      session.busy = false;
      session.updatedAtMs = this.#nowMs();
    }
    return view(session);
  }

  /** Отмена диалога: сессия снимается, документ не применяется. */
  cancel(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /** Документ миссии для применения (CAS сохранение делает клиентский api-слой). */
  takeDocument(sessionId: string): MissionDraft | null {
    const session = this.#liveSession(sessionId);
    if (session === null || session.document === null) return null;
    return session.document;
  }

  stateOf(sessionId: string): MissionChainSessionView {
    const session = this.#liveSession(sessionId);
    if (session === null) return unknownSession();
    return view(session);
  }

  #liveSession(sessionId: string): SessionRecord | null {
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 200) return null;
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return null;
    if (this.#nowMs() - session.updatedAtMs > this.#ttlMs) {
      this.#sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  #evictExpired(): void {
    const now = this.#nowMs();
    for (const [sessionId, session] of this.#sessions) {
      if (now - session.updatedAtMs > this.#ttlMs) this.#sessions.delete(sessionId);
    }
  }

  /**
   * Закрытие интервью по требованию автора. Возвращает текст отказа, если
   * собрать нельзя: сессия остаётся в interview, ответы автора не теряются.
   */
  async #closeInterview(session: SessionRecord): Promise<string | null> {
    if (session.agent.questionsAsked < MISSION_CHAIN_MIN_QUESTIONS) {
      return `Собирать пока рано: ответьте минимум на ${MISSION_CHAIN_MIN_QUESTIONS} вопроса помощника.`;
    }
    if (session.busy) return "Помощник ещё отвечает: подождите завершения хода.";
    session.busy = true;
    let turn: MissionChainTurnResult;
    try {
      turn = await session.agent.close(this.#nowMs() + CHAIN_ASSEMBLE_DEADLINE_MS);
    } finally {
      session.busy = false;
    }
    session.updatedAtMs = this.#nowMs();
    if (turn.kind === "chain_ready") {
      session.messages.push({ role: "assistant", text: chainReportText(turn.summary) });
      session.summary = turn.summary;
      session.stage = "chain_ready";
      session.error = null;
      return null;
    }
    if (turn.kind === "question") {
      // Режим «только цепочка» такой исход исключает — но не молчим, если он придёт.
      const message = "Помощник снова задал вопрос вместо сборки цепочки. Повторите сборку.";
      session.error = Object.freeze({ code: "invalid_response", message });
      return message;
    }
    session.error = Object.freeze({ code: mapTurnCode(turn.code), message: turn.message });
    return turn.message;
  }
}

/** Текст «собрана цепочка такая-то, нарратив такой-то» для автора. */
export function chainReportText(summary: MissionChainSummary): string {
  const scenes = summary.chain.scenes.map((scene) => scene.title).join(" → ");
  const endings = summary.chain.endings.map((ending) => ending.title).join(", ");
  const resources = summary.chain.resources.map((resource) => resource.title).join(", ");
  const parts = [
    `Собрана цепочка: ${scenes}.`,
    `Финалы: ${endings}.`,
    resources.length > 0 ? `Ресурсы: ${resources}.` : "",
    `Нарратив: ${summary.narrative}`
  ].filter((part) => part.length > 0);
  return parts.join("\n");
}

function view(session: SessionRecord, inlineError?: string): MissionChainSessionView {
  return Object.freeze({
    sessionId: session.sessionId,
    stage: session.stage,
    messages: Object.freeze(session.messages.map((message) => Object.freeze({ ...message }))),
    questionsAnswered: session.agent.questionsAsked,
    questionsMin: MISSION_CHAIN_MIN_QUESTIONS,
    questionsMax: MISSION_CHAIN_MAX_QUESTIONS,
    summary: session.summary,
    stats: session.stats,
    error: session.error ?? (inlineError === undefined ? null : Object.freeze({ code: "invalid_use", message: inlineError })),
    updatedAtMs: session.updatedAtMs
  });
}

function failedView(code: string, message: string): MissionChainSessionView {
  return Object.freeze({
    sessionId: "",
    stage: "failed" as const,
    messages: Object.freeze([]),
    questionsAnswered: 0,
    questionsMin: MISSION_CHAIN_MIN_QUESTIONS,
    questionsMax: MISSION_CHAIN_MAX_QUESTIONS,
    summary: null,
    stats: null,
    error: Object.freeze({ code, message }),
    updatedAtMs: 0
  });
}

function unknownSession(): MissionChainSessionView {
  return failedView("session_not_found", "Диалог не найден или завершён: опишите идею заново — введённый текст сохранился в поле.");
}

function mapTurnCode(code: string): string {
  if (code === "backend_failure") return "backend_failure";
  if (code === "invalid_use") return "invalid_use";
  return "invalid_response";
}

function writerFailureCode(kind: string): string {
  if (kind === "insufficient_plan") return "insufficient_plan";
  if (kind === "invalid_plan") return "invalid_plan";
  if (kind === "invalid_intent") return "invalid_intent";
  return "backend_failure";
}

type WriterFailureResult = { readonly message?: string };

/**
 * Техническая причина отказа писателя: код вида `plan.branches` или текст
 * провайдера. Автору показываем её рядом с человеческим объяснением — иначе
 * «не подошла структура» невозможно ни понять, ни сообщить о ней.
 */
function writerFailureDetail(result: { kind: string }): string {
  const value = result as {
    readonly message?: unknown;
    readonly missing?: unknown;
    readonly problems?: unknown;
  };
  const parts: string[] = [];
  if (typeof value.message === "string" && value.message.trim().length > 0) parts.push(value.message.trim());
  if (Array.isArray(value.missing) && value.missing.length > 0) parts.push(`не хватает: ${value.missing.map(String).join(", ")}`);
  if (Array.isArray(value.problems) && value.problems.length > 0) parts.push(`нарушено: ${value.problems.map(String).join(", ")}`);
  if (parts.length === 0) return "";
  return ` Причина: ${parts.join("; ").slice(0, 200)}.`;
}

function writerFailureMessage(result: Exclude<{ kind: string } & WriterFailureResult, never> | { kind: string }): string {
  const kind = result.kind;
  const detail = writerFailureDetail(result);
  if (kind === "insufficient_plan") {
    return `По цепочке не удалось собрать полную миссию: не хватает ветвей или финалов. Уточните финалы в ответах и соберите цепочку заново.${detail}`;
  }
  if (kind === "invalid_plan") {
    return `Миссия по цепочке не прошла проверку структуры. Попробуйте подтвердить цепочку ещё раз.${detail}`;
  }
  if (kind === "invalid_intent") {
    return `Собранная цепочка не подошла для генерации. Начните диалог заново с более подробной идеей.${detail}`;
  }
  const message = (result as { readonly message?: string }).message;
  return message ?? "Помощник не смог собрать миссию: проверьте подключение к ИИ и повторите.";
}
