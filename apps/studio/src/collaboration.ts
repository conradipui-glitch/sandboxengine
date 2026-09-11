import {
  ControlApiClient,
  ControlApiError,
  type CollaborationAnchorView,
  type CollaborationMessageView,
  type CollaborationNoteView,
  type CollaborationThreadView,
  type CollaborationView
} from "./api.js";
import { escapeAttr, escapeHtml } from "./dom-escape.js";

/*
 * FIN-12 (V07) — панель заметок и обсуждений в Studio.
 *
 * Заметки и треды — рабочий материал команды. Этот модуль только читает и
 * рендерит их: ничего из него не трогает draft/release/gameplay. Он разделён
 * на чистые функции (загрузка состояния, разбор ошибок, рендер HTML) и не
 * держит DOM-состояния, чтобы его можно было проверять через node:test, как
 * `author-assistant.ts` и `versions.ts`.
 *
 * Все записи идут через ControlApiClient: он сам добавляет CSRF proof и
 * idempotency-key. Панель никогда не повторяет запись автоматически и никогда
 * не переписывает сервер молча: 409 COLLABORATION_REVISION_CONFLICT
 * превращается в видимый конфликт с предложением перечитать данные.
 */

export type CollaborationPanelState =
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "ready"; readonly view: CollaborationView };

export interface CollaborationConflict {
  readonly code: string;
  readonly currentRevision: number | null;
  readonly message: string;
}

export type CollaborationEditTarget =
  | { readonly kind: "note"; readonly noteId: string }
  | { readonly kind: "message"; readonly threadId: string; readonly messageId: string };

export interface CollaborationRenderOptions {
  /** editor/owner + mutation proof: только тогда появляются write-контролы. */
  readonly canWrite: boolean;
  readonly currentUserId: string | null;
  readonly isOwner: boolean;
  readonly conflict: CollaborationConflict | null;
  readonly busy: boolean;
  /** Сохранённый ввод, который переживает перерисовку innerHTML. */
  readonly fields: Readonly<Record<string, string>>;
  readonly editing: CollaborationEditTarget | null;
  readonly notice: string | null;
}

export type CollaborationWriteFailure =
  | { readonly kind: "conflict"; readonly code: string; readonly currentRevision: number | null }
  | { readonly kind: "forbidden"; readonly code: string }
  | { readonly kind: "not_found"; readonly code: string }
  | { readonly kind: "idempotency_reused"; readonly code: string }
  | { readonly kind: "invalid"; readonly code: string }
  | { readonly kind: "error"; readonly code: string };

export async function loadCollaborationPanel(
  api: Pick<ControlApiClient, "getCollaboration">,
  projectId: string,
  questId: string
): Promise<CollaborationPanelState> {
  try {
    const view = await api.getCollaboration(projectId, questId);
    return Object.freeze({ kind: "ready", view });
  } catch (error) {
    return Object.freeze({ kind: "unavailable", reason: collaborationLoadMessage(error) });
  }
}

export function collaborationLoadMessage(error: unknown): string {
  if (error instanceof ControlApiError) {
    if (error.status === 404) return "Миссия не найдена или недоступна вашей роли (404). Панель ничего не изменила.";
    if (error.status === 401) return "Нужен вход в Studio: сессия истекла или отсутствует (401).";
    if (error.status === 501) return "Server-side хранилище заметок не подключено (501).";
    if (error.status === 0) return "Control недоступен. Проверьте соединение и обновите панель.";
    return `Заметки недоступны: HTTP ${error.status} ${error.code}.`;
  }
  return error instanceof Error ? `Заметки недоступны: ${error.message}` : "Заметки недоступны: неизвестная ошибка.";
}

export function collaborationWriteFailure(error: unknown): CollaborationWriteFailure {
  const status = error instanceof ControlApiError ? error.status : 0;
  const code = error instanceof ControlApiError ? error.code : "CONTROL_UNAVAILABLE";
  if (status === 409 && code === "COLLABORATION_REVISION_CONFLICT") {
    return Object.freeze({ kind: "conflict", code, currentRevision: collaborationCurrentRevision(error) });
  }
  if (status === 409 && code === "COLLABORATION_IDEMPOTENCY_KEY_REUSED") {
    return Object.freeze({ kind: "idempotency_reused", code });
  }
  if (status === 403 || code === "COLLABORATION_FORBIDDEN") return Object.freeze({ kind: "forbidden", code });
  if (status === 404) return Object.freeze({ kind: "not_found", code });
  if (status === 422 || status === 400) return Object.freeze({ kind: "invalid", code });
  return Object.freeze({ kind: "error", code });
}

export function collaborationErrorMessage(failure: CollaborationWriteFailure): string {
  switch (failure.kind) {
    case "conflict":
      return `Конфликт ревизий: сервер уже на r${failure.currentRevision ?? "?"}. Ваша правка не применена и ничего не перезаписано — нажмите «Перечитать с сервера» и повторите.`;
    case "forbidden":
      return "Сервер запретил правку: изменить или удалить запись может только её автор либо владелец проекта. Текст остался без изменений.";
    case "not_found":
      return "Запись уже удалена или недоступна — обновите панель, локальная копия устарела.";
    case "idempotency_reused":
      return "Такой idempotency-key уже использован с другим содержимым. Скопируйте текст и отправьте его снова.";
    case "invalid":
      return `Сервер отклонил запрос (${failure.code}): проверьте текст и координаты.`;
    default:
      return "Control недоступен: запрос не дошёл до сервера. Проверьте соединение и нажмите «Обновить».";
  }
}

export function collaborationCurrentRevision(error: unknown): number | null {
  if (!(error instanceof ControlApiError)) return null;
  const payload = error.payload;
  if (payload === null || typeof payload !== "object") return null;
  const payloadError = (payload as { readonly error?: unknown }).error;
  if (payloadError === null || typeof payloadError !== "object") return null;
  const currentRevision = (payloadError as { readonly currentRevision?: unknown }).currentRevision;
  return typeof currentRevision === "number" && Number.isFinite(currentRevision) ? currentRevision : null;
}

/** Значение формы, сохранённое в состоянии: переживает полную перерисовку. */
export function collabField(fields: Readonly<Record<string, string>>, name: string, fallback = ""): string {
  const value = fields[name];
  return typeof value === "string" ? value : fallback;
}

export function collaborationAnchorLabel(anchor: CollaborationAnchorView): string {
  switch (anchor.kind) {
    case "board": return "Пин на доске";
    case "scene": return `Сцена ${anchor.targetId ?? ""}`.trim();
    case "layer": return `Слой ${anchor.targetId ?? ""}`.trim();
    case "field": return `Поле ${anchor.targetId ?? ""}`.trim();
  }
}

/**
 * Якорь для треда из полей формы. Board требует координаты, scene/layer/field —
 * id цели; иначе сервер вернёт 422, а панель покажет ошибку.
 */
export function collaborationAnchorFromForm(
  kind: string,
  targetId: string,
  x: number,
  y: number
): { readonly ok: true; readonly anchor: CollaborationAnchorView } | { readonly ok: false; readonly error: string } {
  if (kind === "board") {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "Координаты пина должны быть числами." };
    return { ok: true, anchor: { kind: "board", targetId: null, position: { x, y } } };
  }
  if (kind !== "scene" && kind !== "layer" && kind !== "field") {
    return { ok: false, error: "Выберите тип якоря: доска, сцена, слой или поле." };
  }
  const trimmed = targetId.trim();
  if (trimmed.length === 0) return { ok: false, error: `Для якоря «${kind}» нужен ID цели.` };
  return { ok: true, anchor: { kind, targetId: trimmed, position: null } };
}

function collaborationCounts(view: CollaborationView): { readonly open: number; readonly total: number } {
  return { open: view.unresolvedThreadCount, total: view.threads.length };
}

export function renderCollaborationPanel(
  state: CollaborationPanelState,
  options: CollaborationRenderOptions
): string {
  if (state.kind === "unavailable") {
    return `<section class="collab-panel" data-collab-panel aria-label="Заметки и обсуждения">
      <div class="collab-head">
        <h2>Заметки и обсуждения</h2>
        <p>Рабочие материалы команды. Черновик, выпуски и игра не меняются.</p>
      </div>
      <div class="collab-unavailable" role="alert">
        <p>${escapeHtml(state.reason)}</p>
        <button class="button-secondary" data-action="collab-reload">Обновить</button>
      </div>
    </section>`;
  }

  const view = state.view;
  const counts = collaborationCounts(view);
  const writable = options.canWrite && !options.busy;

  return `<section class="collab-panel" data-collab-panel aria-label="Заметки и обсуждения">
    <div class="collab-head">
      <h2>Заметки и обсуждения</h2>
      <p>Рабочие материалы команды. Записи живут на сервере и не меняют черновик, выпуски и опубликованные игры.</p>
      <div class="collab-meta">
        <span>Проект <code>${escapeHtml(view.projectId)}</code></span>
        <span>Миссия <code>${escapeHtml(view.questId)}</code></span>
        <span>Коллекция r${view.revision}</span>
        <span>Заметок <strong>${view.notes.length}</strong></span>
        <span>Открытых <strong>${counts.open}</strong> из <strong>${counts.total}</strong></span>
        <button class="button-secondary" data-action="collab-reload">Обновить</button>
      </div>
    </div>

    <details class="collab-help" data-collab-help ${options.conflict === null ? "open" : ""}>
      <summary>Как это работает · пример</summary>
      <p>Пример: заметка «Проверить свет в мастерской» с координатами X 120, Y 80 — это пин для художника.
      Тред к сцене <code>workshop</code> («Нужен другой фон») собирает ответы: коллега отвечает в том же треде,
      автор или владелец правит свой текст, после правки тред закрывают кнопкой «Закрыть», а если обсуждение
      вспыхнуло снова — «Переоткрыть». Каждая запись несёт свою ревизию: сервер принимает правку только от
      той версии, которую вы видели, поэтому чужая работа не теряется.</p>
    </details>

    ${options.conflict === null ? "" : `<div class="collab-conflict" data-collab-conflict role="alert">
      <strong>Конфликт ревизий</strong>
      <p>${escapeHtml(options.conflict.message)}</p>
      <button class="primary" data-action="collab-reload">Перечитать с сервера</button>
      <small>Ваш текст остаётся в поле ниже: ничего не отправлено и не перезаписано автоматически.</small>
    </div>`}

    ${options.notice === null ? "" : `<p class="collab-notice" role="status">${escapeHtml(options.notice)}</p>`}

    <section class="collab-section" data-collab-notes aria-label="Заметки">
      <div class="collab-section-head">
        <h3>Заметки</h3>
        <span class="collab-count">${view.notes.length}</span>
      </div>
      <ul class="collab-list">
        ${view.notes.map((note) => renderNote(note, options, writable)).join("") || `<li class="collab-empty">Заметок пока нет. Первая заметка — ниже.</li>`}
      </ul>
      ${writable ? `<form class="collab-form" data-form="collab-note-create">
        <label>Текст заметки
          <textarea name="text" maxlength="2000" rows="2" data-collab-field="note.text" data-focus-key="collab-note-text">${escapeHtml(collabField(options.fields, "note.text"))}</textarea>
        </label>
        <div class="collab-form-row">
          <label>X <input name="x" type="number" step="1" data-collab-field="note.x" value="${escapeAttr(collabField(options.fields, "note.x", "0"))}"></label>
          <label>Y <input name="y" type="number" step="1" data-collab-field="note.y" value="${escapeAttr(collabField(options.fields, "note.y", "0"))}"></label>
          <button class="primary" type="submit">Добавить заметку</button>
        </div>
        <p class="collab-hint">Координаты — место пина на доске; они не меняют раскладку миссии.</p>
      </form>` : readOnlyNote(options)}
    </section>

    <section class="collab-section" data-collab-threads aria-label="Обсуждения">
      <div class="collab-section-head">
        <h3>Обсуждения</h3>
        <span class="collab-count">открыто ${counts.open} · всего ${counts.total}</span>
      </div>
      <div class="collab-list">
        ${view.threads.map((thread) => renderThread(thread, options, writable)).join("") || `<p class="collab-empty">Обсуждений пока нет. Первый тред — ниже.</p>`}
      </div>
      ${writable ? `<form class="collab-form" data-form="collab-thread-create">
        <label>Новое обсуждение
          <textarea name="text" maxlength="2000" rows="2" data-collab-field="thread.text">${escapeHtml(collabField(options.fields, "thread.text"))}</textarea>
        </label>
        <div class="collab-form-row">
          <label>Якорь
            <select name="anchorKind" data-collab-field="thread.kind">
              ${anchorOption("scene", options)}${anchorOption("board", options)}${anchorOption("layer", options)}${anchorOption("field", options)}
            </select>
          </label>
          <label>ID цели <input name="targetId" data-collab-field="thread.targetId" value="${escapeAttr(collabField(options.fields, "thread.targetId"))}"></label>
          <label>X <input name="x" type="number" step="1" data-collab-field="thread.x" value="${escapeAttr(collabField(options.fields, "thread.x", "0"))}"></label>
          <label>Y <input name="y" type="number" step="1" data-collab-field="thread.y" value="${escapeAttr(collabField(options.fields, "thread.y", "0"))}"></label>
          <button class="primary" type="submit">Открыть обсуждение</button>
        </div>
      </form>` : readOnlyNote(options)}
    </section>
  </section>`;
}

function readOnlyNote(options: CollaborationRenderOptions): string {
  return `<p class="collab-readonly"><strong>Только чтение.</strong> Заметки и обсуждения видны, но записи требуют роли editor или owner${options.currentUserId === null ? "" : ` (ваша учётная запись: ${escapeHtml(options.currentUserId)})`}. Ничего не будет отправлено.</p>`;
}

function anchorOption(kind: string, options: CollaborationRenderOptions): string {
  const selected = collabField(options.fields, "thread.kind", "scene") === kind ? " selected" : "";
  const label = kind === "board" ? "Пин на доске" : kind === "scene" ? "Сцена" : kind === "layer" ? "Слой" : "Поле";
  return `<option value="${kind}"${selected}>${label}</option>`;
}

function renderNote(
  note: CollaborationNoteView,
  options: CollaborationRenderOptions,
  writable: boolean
): string {
  const editable = writable && canTouch(options, note.authorUserId);
  const editing = options.editing !== null && options.editing.kind === "note" && options.editing.noteId === note.noteId;
  return `<li class="collab-note" data-note-id="${escapeAttr(note.noteId)}">
    <div class="collab-row-head">
      <strong>${escapeHtml(note.authorUserId)}</strong>
      <span>r${note.revision}</span>
      <span>x ${note.position.x} · y ${note.position.y}</span>
    </div>
    <p class="collab-text">${escapeHtml(note.text)}</p>
    ${editing ? `<form class="collab-form inline" data-form="collab-note-change">
      <input type="hidden" name="noteId" value="${escapeAttr(note.noteId)}">
      <input type="hidden" name="expectedRevision" value="${note.revision}">
      <textarea name="text" maxlength="2000" rows="2" data-collab-field="note.${escapeAttr(note.noteId)}.text">${escapeHtml(collabField(options.fields, `note.${note.noteId}.text`, note.text))}</textarea>
      <div class="collab-form-row">
        <label>X <input name="x" type="number" step="1" data-collab-field="note.${escapeAttr(note.noteId)}.x" value="${escapeAttr(collabField(options.fields, `note.${note.noteId}.x`, String(note.position.x)))}"></label>
        <label>Y <input name="y" type="number" step="1" data-collab-field="note.${escapeAttr(note.noteId)}.y" value="${escapeAttr(collabField(options.fields, `note.${note.noteId}.y`, String(note.position.y)))}"></label>
        <button class="primary" type="submit">Сохранить</button>
        <button class="button-secondary" type="button" data-action="collab-cancel-edit">Отмена</button>
      </div>
    </form>` : ""}
    ${editable ? `<div class="collab-row-actions">
      ${editing ? "" : `<button class="button-secondary" data-action="collab-note-edit" data-note-id="${escapeAttr(note.noteId)}">Изменить</button>`}
      <button class="danger" data-action="collab-note-delete" data-note-id="${escapeAttr(note.noteId)}">Удалить</button>
    </div>` : ""}
  </li>`;
}

function renderThread(
  thread: CollaborationThreadView,
  options: CollaborationRenderOptions,
  writable: boolean
): string {
  const resolved = thread.status === "resolved";
  return `<article class="collab-thread" data-thread-id="${escapeAttr(thread.threadId)}">
    <div class="collab-row-head">
      <strong>${escapeHtml(collaborationAnchorLabel(thread.anchor))}</strong>
      <span class="collab-status ${resolved ? "closed" : "open"}">${resolved ? "закрыт" : "открыт"}</span>
      <span>r${thread.revision}</span>
    </div>
    ${thread.anchorDeleted ? `<p class="collab-anchor-deleted">Элемент удалён — обсуждение сохранено, чтобы не потерять договорённости.</p>` : ""}
    <ol class="collab-messages">
      ${thread.messages.map((message) => renderMessage(thread, message, options, writable)).join("")}
    </ol>
    ${writable ? `<form class="collab-form inline" data-form="collab-thread-reply">
      <input type="hidden" name="threadId" value="${escapeAttr(thread.threadId)}">
      <textarea name="text" maxlength="2000" rows="2" data-collab-field="reply.${escapeAttr(thread.threadId)}" aria-label="Ответ в тред">${escapeHtml(collabField(options.fields, `reply.${thread.threadId}`))}</textarea>
      <div class="collab-form-row">
        <button class="primary" type="submit">Ответить</button>
        <button class="button-secondary" type="button" data-action="${resolved ? "collab-thread-reopen" : "collab-thread-resolve"}" data-thread-id="${escapeAttr(thread.threadId)}">${resolved ? "Переоткрыть" : "Закрыть"}</button>
      </div>
    </form>` : ""}
  </article>`;
}

function renderMessage(
  thread: CollaborationThreadView,
  message: CollaborationMessageView,
  options: CollaborationRenderOptions,
  writable: boolean
): string {
  if (message.deleted) {
    return `<li class="collab-message deleted" data-message-id="${escapeAttr(message.messageId)}">
      <span class="collab-message-author">${escapeHtml(message.authorUserId)}</span>
      <p class="collab-text">Сообщение удалено — место в треде сохранено.</p>
    </li>`;
  }
  const editable = writable && canTouch(options, message.authorUserId);
  const editing = options.editing !== null
    && options.editing.kind === "message"
    && options.editing.threadId === thread.threadId
    && options.editing.messageId === message.messageId;
  const fieldName = `msg.${thread.threadId}.${message.messageId}`;
  return `<li class="collab-message" data-message-id="${escapeAttr(message.messageId)}">
    <span class="collab-message-author">${escapeHtml(message.authorUserId)} <small>r${message.revision}</small></span>
    <p class="collab-text">${escapeHtml(message.text)}</p>
    ${editing ? `<form class="collab-form inline" data-form="collab-message-change">
      <input type="hidden" name="threadId" value="${escapeAttr(thread.threadId)}">
      <input type="hidden" name="messageId" value="${escapeAttr(message.messageId)}">
      <input type="hidden" name="expectedRevision" value="${message.revision}">
      <textarea name="text" maxlength="2000" rows="2" data-collab-field="${escapeAttr(fieldName)}">${escapeHtml(collabField(options.fields, fieldName, message.text))}</textarea>
      <div class="collab-form-row">
        <button class="primary" type="submit">Сохранить</button>
        <button class="button-secondary" type="button" data-action="collab-cancel-edit">Отмена</button>
      </div>
    </form>` : ""}
    ${editable && !editing ? `<div class="collab-row-actions">
      <button class="button-secondary" data-action="collab-message-edit" data-thread-id="${escapeAttr(thread.threadId)}" data-message-id="${escapeAttr(message.messageId)}">Изменить</button>
      <button class="danger" data-action="collab-message-delete" data-thread-id="${escapeAttr(thread.threadId)}" data-message-id="${escapeAttr(message.messageId)}">Удалить</button>
    </div>` : ""}
  </li>`;
}

function canTouch(options: CollaborationRenderOptions, authorUserId: string): boolean {
  return options.isOwner || (options.currentUserId !== null && options.currentUserId === authorUserId);
}
