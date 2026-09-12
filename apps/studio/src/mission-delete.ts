/**
 * DELETE-01: UI-путь удаления миссии и проекта.
 *
 * Модуль держит всю разметку и состояние подтверждения, чтобы общий `app.ts`
 * остался тонким: там только обработчики действий и вызовы API. Правила,
 * которые здесь закодированы:
 *
 *  * удаление — необратимое действие, поэтому его нельзя выполнить одним
 *    кликом: сначала отдельный экран подтверждения с текстом последствий;
 *  * подтверждение явное: кнопка отправляется только с отмеченным чекбоксом
 *    «Я понимаю последствия» (`required`), иначе браузер не отправит форму;
 *  * в подтверждении видны точные revision, на которые опирается сервер, —
 *    если за это время миссию или проект изменили, сервер откажет, и автор
 *    увидит причину, а не «ничего не произошло»;
 *  * опубликованное действие fail-closed: текст прямо говорит, что сначала
 *    нужно снять миссию с публикации, а не обещает успех;
 *  * никаких `text-overflow: ellipsis` и `line-clamp`: последствия читаются
 *    целиком, потому что именно они решают, нажимать ли кнопку.
 */
import { escapeAttr, escapeHtml } from "./dom-escape.js";
import { destructiveIcon } from "./icons.js";

/** Квест, который автор подтверждает удалить. */
export interface QuestDeleteIntent {
  readonly projectId: string;
  readonly questId: string;
  readonly title: string;
  /** Draft revision, которую автор видел перед подтверждением. */
  readonly draftRevision: number;
  /** Content revision документа миссии; `null` — документа ещё нет. */
  readonly missionRevision: number | null;
  /**
   * Ключ идемпотентности, выданный один раз при открытии подтверждения.
   * Повторная отправка той же формы переиспользует его, поэтому сетевой
   * повтор не удаляет дважды и не превращается в «миссия не найдена».
   */
  readonly idempotencyKey: string;
  /**
   * Сколько версий черновика показано автору и есть ли ещё более старые.
   * Текст последствий не имеет права обещать «все версии», если список
   * постраничный: число берётся из того, что автор реально видит.
   */
  readonly historyRevisions: number;
  readonly historyHasMore: boolean;
  /** Есть ли у миссии сохранённый документ истории. */
  readonly hasMission: boolean;
}

export interface ProjectDeleteQuestEntry {
  readonly questId: string;
  readonly draftRevision: number;
  readonly title: string;
}

/** Проект, который автор подтверждает удалить вместе со всеми миссиями. */
export interface ProjectDeleteIntent {
  readonly projectId: string;
  readonly title: string;
  /** Cover revision проекта — CAS-основание запроса. */
  readonly baseRevision: number;
  readonly quests: readonly ProjectDeleteQuestEntry[];
  readonly idempotencyKey: string;
}

/** Кнопки «опасной зоны» в настройках проекта. */
export interface DeleteZoneInput {
  readonly canDeleteQuest: boolean;
  readonly canDeleteProject: boolean;
  readonly questTitle: string | null;
}

export function renderDeleteZone(input: DeleteZoneInput): string {
  const questButton = input.canDeleteQuest
    ? `<button class="danger delete-zone-action" type="button" data-action="prepare-delete-quest"
        ${input.questTitle === null ? "" : `aria-label="Удалить миссию «${escapeAttr(input.questTitle)}»"`}>
        ${destructiveIcon("trash", 40)}
        <span>Удалить миссию…</span>
      </button>`
    : "";
  const projectButton = input.canDeleteProject
    ? `<button class="danger delete-zone-action" type="button" data-action="prepare-delete-project">
        ${destructiveIcon("trash", 40)}
        <span>Удалить проект…</span>
      </button>`
    : "";
  return `<section class="danger-zone" aria-label="Опасная зона">
    <h3>Опасная зона</h3>
    <p>Удаление необратимо. Сервер сверит версию, которую вы видите сейчас, и откажет, если её уже изменили.</p>
    ${questButton}
    ${projectButton}
    ${input.canDeleteQuest || input.canDeleteProject ? "" : `<p class="form-hint">Удаление недоступно: нужна роль владельца (проект) или владельца/редактора (миссия).</p>`}
  </section>`;
}

/** Экран подтверждения удаления миссии. `null`, когда подтверждать нечего. */
export function renderQuestDeleteConfirm(intent: QuestDeleteIntent | null, currentRevision: number): string {
  if (!intent) return "";
  const stale = currentRevision !== intent.draftRevision;
  const missionLine = intent.hasMission
    ? `документ истории ревизии r${intent.missionRevision ?? 0}`
    : "отсутствующий документ истории (его у миссии ещё нет)";
  const consequences = [
    `черновик и его версии (${intent.historyRevisions}${intent.historyHasMore ? "+" : ""} revision, включая текущую r${intent.draftRevision})`,
    missionLine,
    "раскладка доски и заметки, обсуждения и их привязки",
    "проверки, сохранённые прогоны и все выпуски этой миссии"
  ];
  const staleNote = stale
    ? `<p class="deletion-blocked">Черновик уже изменился: подтверждение опиралось на r${intent.draftRevision}, сейчас r${currentRevision}. Ничего не удалено — откройте подтверждение заново.</p>`
    : "";
  const actions = stale
    ? `<button class="button-secondary" type="button" data-action="cancel-quest-delete">Закрыть</button>`
    : `<button class="button-secondary" type="button" data-action="cancel-quest-delete">Отмена</button>
       <button class="danger" type="submit">Удалить миссию навсегда</button>`;
  const confirmField = stale
    ? ""
    : `<label class="checkbox delete-confirm-check">
        <input type="checkbox" name="confirm" value="yes" required>
        <span>Я понимаю, что вернуть миссию «${escapeHtml(intent.title)}» будет нельзя.</span>
      </label>`;
  return `<div class="modal-backdrop" data-modal="quest-delete">
    <form class="modal delete-modal" data-form="quest-delete" role="dialog" aria-modal="true" aria-label="Удаление миссии">
      <div class="delete-modal-header">
        ${destructiveIcon("trash", 48)}
        <h2>Удалить миссию «${escapeHtml(intent.title)}»?</h2>
      </div>
      ${staleNote}
      <p>Вместе с миссией <code>${escapeHtml(intent.questId)}</code> будут удалены:</p>
      <ul class="delete-consequences">${consequences.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      <p>Если миссия опубликована, сервер откажет: сначала снимите её с публикации в панели «Публикация», потом удаляйте.</p>
      ${confirmField}
      <div class="modal-actions">${actions}</div>
    </form>
  </div>`;
}

/** Экран подтверждения удаления проекта. `null`, когда подтверждать нечего. */
export function renderProjectDeleteConfirm(
  intent: ProjectDeleteIntent | null,
  current: { readonly baseRevision: number; readonly questIds: readonly string[] } | null
): string {
  if (!intent) return "";
  const currentIds = current === null ? intent.quests.map((quest) => quest.questId) : [...current.questIds].sort();
  const intentIds = intent.quests.map((quest) => quest.questId).sort();
  const staleCover = current !== null && current.baseRevision !== intent.baseRevision;
  const movedSet = currentIds.length !== intentIds.length || currentIds.some((id, index) => id !== intentIds[index]);
  const stale = staleCover || movedSet;
  const staleReason = staleCover
    ? `обложка проекта изменилась (было r${intent.baseRevision}, стало r${current?.baseRevision ?? intent.baseRevision})`
    : "состав миссий проекта изменился";
  const questLines = intent.quests.length === 0
    ? `<li>В проекте нет миссий — будет удалён только он сам, его материалы и доступы.</li>`
    : intent.quests.map((quest) => `<li>миссия «${escapeHtml(quest.title)}» (<code>${escapeHtml(quest.questId)}</code>, r${quest.draftRevision}) — вместе со всей её историей и выпусками</li>`).join("");
  const actions = stale
    ? `<button class="button-secondary" type="button" data-action="cancel-project-delete">Закрыть</button>`
    : `<button class="button-secondary" type="button" data-action="cancel-project-delete">Отмена</button>
       <button class="danger" type="submit">Удалить проект навсегда</button>`;
  const confirmField = stale
    ? ""
    : `<label class="checkbox delete-confirm-check">
        <input type="checkbox" name="confirm" value="yes" required>
        <span>Я понимаю, что вернуть проект «${escapeHtml(intent.title)}» и его миссии будет нельзя.</span>
      </label>`;
  return `<div class="modal-backdrop" data-modal="project-delete">
    <form class="modal delete-modal" data-form="project-delete" role="dialog" aria-modal="true" aria-label="Удаление проекта">
      <div class="delete-modal-header">
        ${destructiveIcon("trash", 48)}
        <h2>Удалить проект «${escapeHtml(intent.title)}»?</h2>
      </div>
      ${stale ? `<p class="deletion-blocked">Подтверждение устарело: ${escapeHtml(staleReason)}. Ничего не удалено — откройте подтверждение заново.</p>` : ""}
      <p>Проект <code>${escapeHtml(intent.projectId)}</code> будет удалён вместе с:</p>
      <ul class="delete-consequences">
        ${questLines}
        <li>материалами проекта и назначенной обложкой</li>
        <li>доступом участников — все роли в этом проекте исчезнут</li>
      </ul>
      <p>Если хотя бы одна миссия проекта опубликована, сервер откажет: сначала снимите её с публикации.</p>
      ${confirmField}
      <div class="modal-actions">${actions}</div>
    </form>
  </div>`;
}

/** Значение чекбокса подтверждения: ровно это значение считает app.ts согласием. */
export const DELETE_CONFIRM_VALUE = "yes";

export function isDeleteConfirmed(value: unknown): boolean {
  return value === DELETE_CONFIRM_VALUE;
}
