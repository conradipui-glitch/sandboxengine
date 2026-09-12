import { cssEscape, escapeAttr, escapeHtml } from "./dom-escape.js";

/*
 * Библиотека материалов Studio (vanilla DOM, без фреймворков).
 *
 * Модуль самостоятельный: он не знает про Control, HTTP, app.ts и хранилище.
 * Список, загрузку и применение материала он получает через `host` —
 * оркестратор подставляет реальные вызовы API. Тест подставляет свой host,
 * поэтому сеть в проверках не участвует.
 *
 * Что делает панель:
 *   - загружает файл (с необязательным описанием для незрячих);
 *   - показывает список с миниатюрой для изображений и плеером для звука;
 *   - честно показывает длительность звука: пока браузер не сообщил метаданные,
 *     пишется «Длительность: неизвестна», выдуманных чисел нет;
 *   - даёт кнопку «Использовать в сцене» с выбором назначения;
 *   - помнит, что уже назначено, и заменяет только выбранное назначение,
 *     не затирая остальные;
 *   - на любой сбой отвечает по-русски и предлагает действие («Повторить»),
 *     технический код наружу не выносится.
 *
 * Разметка собирается строкой в `renderMaterialsPanelHtml`, поэтому её можно
 * проверить без браузера; монтирование добавляет обработчики и `dispose`.
 */

export type MaterialKind = "image" | "audio" | "other";

/** Все виды материалов — для перебора в тестах и в интеграции. */
export const MATERIAL_KINDS: readonly MaterialKind[] = Object.freeze(["image", "audio", "other"]);

export interface MaterialItem {
  assetId: string;
  filename: string;
  mimeType: string;
  kind: MaterialKind;
  byteLength: number;
  url: string;
  thumbnailUrl: string | null;
  altText: string | null;
}

/** Куда материал можно поставить: в экран сцены или в карточку проекта. */
export type MaterialTarget = "scene-background" | "scene-audio" | "character-portrait" | "project-cover";

export const MATERIAL_TARGETS: readonly MaterialTarget[] = Object.freeze([
  "project-cover",
  "scene-background",
  "scene-audio",
  "character-portrait"
]);

export interface MaterialsPanelHost {
  root: HTMLElement;
  projectId: string;
  questId: string;
  listMaterials(): Promise<MaterialItem[]>;
  uploadMaterial(file: File, meta: { altText?: string }): Promise<MaterialItem>;
  onUseMaterial(item: MaterialItem, target: MaterialTarget): void;
  onError(error: unknown): void;
}

/* ------------------------------------------------------------------ */
/* Подписи                                                             */
/* ------------------------------------------------------------------ */

export const MATERIAL_KIND_LABELS: Record<MaterialKind, string> = Object.freeze({
  image: "Изображение",
  audio: "Звук",
  other: "Другой файл"
});

export const MATERIAL_TARGET_LABELS: Record<MaterialTarget, string> = Object.freeze({
  "project-cover": "Обложка проекта",
  "scene-background": "Фон сцены",
  "scene-audio": "Звук сцены",
  "character-portrait": "Портрет персонажа"
});

export function materialKindLabel(kind: MaterialKind): string {
  return MATERIAL_KIND_LABELS[kind] ?? MATERIAL_KIND_LABELS.other;
}

export function targetLabel(target: MaterialTarget): string {
  return MATERIAL_TARGET_LABELS[target] ?? target;
}

/** Определение вида материала по MIME-типу — на случай, если сервер его не прислал. */
export function materialKindFromMime(mimeType: string | null | undefined): MaterialKind {
  if (typeof mimeType !== "string") return "other";
  const normalized = mimeType.trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  return "other";
}

/** Допустимые назначения для вида материала: другой файл в сцену не ставится. */
export function targetsForKind(kind: MaterialKind): readonly MaterialTarget[] {
  if (kind === "image") return Object.freeze(["project-cover", "scene-background", "character-portrait"]);
  if (kind === "audio") return Object.freeze(["scene-audio"]);
  return Object.freeze([]);
}

/* ------------------------------------------------------------------ */
/* Форматирование значений                                             */
/* ------------------------------------------------------------------ */

const BYTE_UNITS: readonly string[] = Object.freeze(["Б", "КБ", "МБ", "ГБ", "ТБ"]);

/** Округление до одного знака; целые показываются без дробной части. */
function roundUnit(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded < 10 ? String(rounded).replace(".", ",") : String(Math.round(value));
}

/** Размер файла по-русски: «512 Б», «12 КБ», «1,5 МБ». */
export function formatByteSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "размер неизвестен";
  let value = Math.round(bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value = value / 1024;
    unit += 1;
  }
  const unitLabel = BYTE_UNITS[unit] ?? BYTE_UNITS[0];
  return unit === 0 ? `${value} ${unitLabel}` : `${roundUnit(value)} ${unitLabel}`;
}

/** Длительность в виде «1:05» или «1:00:00»; null — если значение не настоящее. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** Честная подпись длительности: выдуманного числа здесь появиться не может. */
export function durationLabel(seconds: number | null | undefined): string {
  const formatted = formatDuration(seconds);
  return formatted === null ? "Длительность: неизвестна" : `Длительность: ${formatted}`;
}

/** Строка «вид · MIME · размер». */
export function materialTypeLine(item: MaterialItem): string {
  const mime = item.mimeType.length > 0 ? item.mimeType : "тип неизвестен";
  return `${materialKindLabel(item.kind)} · ${mime} · ${formatByteSize(item.byteLength)}`;
}

/* ------------------------------------------------------------------ */
/* Нормализация ответа сервера                                         */
/* ------------------------------------------------------------------ */

/**
 * Приводит запись материала к контракту. Вид берётся из ответа, но если он
 * неизвестен — выводится из MIME-типа. Запись без идентификатора или адреса
 * отбрасывается: показывать нечего.
 */
export function normalizeMaterialItem(input: unknown): MaterialItem | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const assetId = typeof raw.assetId === "string" ? raw.assetId : "";
  const url = typeof raw.url === "string" ? raw.url : "";
  if (assetId.length === 0 || url.length === 0) return null;
  const mimeType = typeof raw.mimeType === "string" ? raw.mimeType : "";
  const kind = MATERIAL_KINDS.includes(raw.kind as MaterialKind)
    ? (raw.kind as MaterialKind)
    : materialKindFromMime(mimeType);
  return {
    assetId,
    filename: typeof raw.filename === "string" && raw.filename.length > 0 ? raw.filename : assetId,
    mimeType,
    kind,
    byteLength: typeof raw.byteLength === "number" && Number.isFinite(raw.byteLength) ? raw.byteLength : 0,
    url,
    thumbnailUrl: typeof raw.thumbnailUrl === "string" && raw.thumbnailUrl.length > 0 ? raw.thumbnailUrl : null,
    altText: typeof raw.altText === "string" && raw.altText.length > 0 ? raw.altText : null
  };
}

/* ------------------------------------------------------------------ */
/* Ошибки по-русски с действием                                        */
/* ------------------------------------------------------------------ */

export type MaterialErrorScope = "list" | "upload";

export interface MaterialErrorText {
  readonly message: string;
  readonly action: string;
  readonly retryable: boolean;
}

/** Служебные метки своих же ошибок — наружу они не выносятся. */
export const MATERIAL_ERROR_SENTINELS = Object.freeze({
  noFile: "material_no_file",
  listInvalid: "material_list_invalid",
  assetMissing: "material_asset_missing"
});

const LIST_FALLBACK: MaterialErrorText = Object.freeze({
  message: "Не удалось получить список материалов. Проверьте соединение и повторите.",
  action: "Повторить",
  retryable: true
});

const UPLOAD_FALLBACK: MaterialErrorText = Object.freeze({
  message: "Не удалось загрузить файл. Проверьте файл и соединение, затем повторите.",
  action: "Повторить",
  retryable: true
});

const SERVER_ERROR: MaterialErrorText = Object.freeze({
  message: "Сервер материалов временно недоступен. Подождите немного и повторите.",
  action: "Повторить",
  retryable: true
});

const STATUS_ERRORS: Record<string, MaterialErrorText> = Object.freeze({
  "401": Object.freeze({
    message: "Сервер отклонил доступ к материалам. Войдите в проект заново и повторите.",
    action: "Повторить",
    retryable: true
  }),
  "403": Object.freeze({
    message: "Сервер отклонил доступ к материалам. Войдите в проект заново и повторите.",
    action: "Повторить",
    retryable: true
  }),
  "404": Object.freeze({
    message: "Файл не найден на сервере: возможно, его удалили или загрузка не завершилась. Повторите загрузку.",
    action: "Повторить",
    retryable: true
  }),
  "409": Object.freeze({
    message: "Материал уже изменился в другом месте. Обновите список и повторите.",
    action: "Обновить список",
    retryable: true
  }),
  "413": Object.freeze({
    message: "Файл слишком большой для сервера. Выберите файл меньшего размера и повторите.",
    action: "Повторить",
    retryable: true
  }),
  "415": Object.freeze({
    message: "Сервер не поддерживает этот тип файла. Выберите изображение или звук и повторите.",
    action: "Повторить",
    retryable: true
  }),
  "429": Object.freeze({
    message: "Сервер ограничил частоту запросов. Подождите немного и повторите.",
    action: "Повторить",
    retryable: true
  })
});

const CODE_ERRORS: Record<string, MaterialErrorText> = Object.freeze({
  network: Object.freeze({
    message: "Не удалось связаться с сервером материалов. Проверьте соединение и повторите.",
    action: "Повторить",
    retryable: true
  }),
  offline: Object.freeze({
    message: "Не удалось связаться с сервером материалов. Проверьте соединение и повторите.",
    action: "Повторить",
    retryable: true
  }),
  timeout: Object.freeze({
    message: "Сервер материалов не ответил вовремя. Повторите загрузку.",
    action: "Повторить",
    retryable: true
  }),
  aborted: Object.freeze({
    message: "Загрузка прервана. Выберите файл снова и повторите.",
    action: "Повторить",
    retryable: true
  })
});

function fieldOf(error: unknown, names: readonly string[]): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function numberOf(error: unknown, names: readonly string[]): number | null {
  const value = fieldOf(error, names);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOf(error: unknown, names: readonly string[]): string | null {
  const value = fieldOf(error, names);
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : null;
}

/**
 * Перевод любого сбоя в понятный русский текст с действием. Сообщение и имя
 * исключения наружу не выносятся: пользователь видит только объяснение.
 */
export function describeMaterialError(error: unknown, scope: MaterialErrorScope): MaterialErrorText {
  const code = stringOf(error, ["code", "errorCode"]);
  const status = numberOf(error, ["status", "statusCode"]);

  if (code === MATERIAL_ERROR_SENTINELS.noFile) {
    return Object.freeze({
      message: "Файл не выбран. Выберите файл и повторите загрузку.",
      action: "Выбрать файл",
      retryable: false
    });
  }
  if (code === MATERIAL_ERROR_SENTINELS.listInvalid) {
    return Object.freeze({
      message: "Сервер вернул неожиданный список материалов. Обновите список и повторите.",
      action: "Обновить список",
      retryable: true
    });
  }
  if (code === MATERIAL_ERROR_SENTINELS.assetMissing) {
    return STATUS_ERRORS["404"] ?? UPLOAD_FALLBACK;
  }

  if (status !== null) {
    const known = STATUS_ERRORS[String(status)];
    if (known !== undefined) return known;
    if (status >= 500) return SERVER_ERROR;
    if (status >= 400) {
      return Object.freeze({
        message: "Сервер отклонил запрос с этим файлом. Проверьте файл и повторите.",
        action: "Повторить",
        retryable: true
      });
    }
  }

  if (code !== null) {
    const known = CODE_ERRORS[code];
    if (known !== undefined) return known;
  }

  return scope === "list" ? LIST_FALLBACK : UPLOAD_FALLBACK;
}

/* ------------------------------------------------------------------ */
/* Состояние панели                                                    */
/* ------------------------------------------------------------------ */

export type MaterialsStatus = "loading" | "ready" | "error";

export interface MaterialNotice {
  readonly scope: MaterialErrorScope;
  readonly message: string;
  readonly action: string;
  readonly retryable: boolean;
}

export interface MaterialAssignment {
  readonly assetId: string;
  readonly filename: string;
}

export interface MaterialsPanelState {
  readonly status: MaterialsStatus;
  readonly items: readonly MaterialItem[];
  readonly notice: MaterialNotice | null;
  /** Что уже назначено в сцене — по одному значению на назначение. */
  readonly assigned: Readonly<Partial<Record<MaterialTarget, MaterialAssignment>>>;
  readonly busy: boolean;
  readonly altText: string;
}

export function emptyMaterialsPanelState(overrides: Partial<MaterialsPanelState> = {}): MaterialsPanelState {
  return Object.freeze({
    status: "loading",
    items: Object.freeze([]),
    notice: null,
    assigned: Object.freeze({}),
    busy: false,
    altText: "",
    ...overrides
  });
}

/** Назначение, в котором уже стоит этот материал (если стоит). */
export function assignmentOf(
  assigned: Readonly<Partial<Record<MaterialTarget, MaterialAssignment>>>,
  assetId: string
): MaterialTarget | null {
  for (const target of MATERIAL_TARGETS) {
    if (assigned[target]?.assetId === assetId) return target;
  }
  return null;
}

/** Замена одного назначения не трогает остальные. */
export function withAssignment(
  assigned: Readonly<Partial<Record<MaterialTarget, MaterialAssignment>>>,
  target: MaterialTarget,
  assignment: MaterialAssignment
): Readonly<Partial<Record<MaterialTarget, MaterialAssignment>>> {
  return Object.freeze({ ...assigned, [target]: Object.freeze({ ...assignment }) });
}

/* ------------------------------------------------------------------ */
/* Разметка                                                            */
/* ------------------------------------------------------------------ */

const WRAP_STYLE = "overflow-wrap:anywhere;word-break:break-word;white-space:normal";

function statusText(state: MaterialsPanelState): string {
  if (state.status === "loading") return "Загрузка списка материалов.";
  if (state.status === "error") return "Список материалов не загружен.";
  return state.items.length === 0 ? "Материалов нет." : `Материалов: ${state.items.length}.`;
}

function renderStatus(state: MaterialsPanelState): string {
  return [
    `<p class="mat-status" data-materials-status="${escapeAttr(state.status)}" role="status"`,
    ` aria-label="Состояние библиотеки материалов" style="${WRAP_STYLE}">`,
    escapeHtml(statusText(state)),
    `</p>`
  ].join("");
}

function renderNotice(notice: MaterialNotice | null): string {
  if (notice === null) return "";
  const button = notice.retryable
    ? `<button type="button" class="mat-retry" data-material-action="retry" data-error-scope="${escapeAttr(notice.scope)}"`
      + ` aria-label="${escapeAttr(`Повторить: ${notice.action}`)}">${escapeHtml(notice.action)}</button>`
    : `<button type="button" class="mat-retry" data-material-action="pick-file" data-error-scope="${escapeAttr(notice.scope)}"`
      + ` aria-label="${escapeAttr(`Повторить: ${notice.action}`)}">${escapeHtml(notice.action)}</button>`;
  return [
    `<div class="mat-error" data-material-error data-error-scope="${escapeAttr(notice.scope)}" role="alert">`,
    `<p class="mat-error-label" style="${WRAP_STYLE}">Не получилось.</p>`,
    `<p class="mat-error-text" data-material-error-text style="${WRAP_STYLE}">${escapeHtml(notice.message)}</p>`,
    button,
    `</div>`
  ].join("");
}

function renderUploadForm(state: MaterialsPanelState): string {
  const disabled = state.busy ? " disabled" : "";
  return [
    `<form class="mat-upload" data-material-upload>`,
    `<label class="mat-field-label">Файл материала`,
    `<input type="file" name="file" data-material-file class="mat-file" aria-label="Файл материала"${disabled}>`,
    `</label>`,
    `<label class="mat-field-label">Описание для незрячих (необязательно)`,
    `<input type="text" name="altText" data-material-alt class="mat-alt" maxlength="500"`
      + ` value="${escapeAttr(state.altText)}" aria-label="Описание материала для незрячих"${disabled}>`,
    `</label>`,
    `<button type="submit" class="mat-upload-submit" data-material-action="upload"`
      + ` aria-label="Загрузить выбранный файл в библиотеку материалов"${disabled}>Загрузить материал</button>`,
    `</form>`
  ].join("");
}

function renderAssigned(state: MaterialsPanelState): string {
  const rows = MATERIAL_TARGETS.map((target) => {
    const assignment = state.assigned[target] ?? null;
    const value = assignment === null
      ? "не назначено"
      : `${assignment.filename} (материал ${assignment.assetId})`;
    return [
      `<li class="mat-assigned-item" data-assigned-target="${escapeAttr(target)}"`
        + ` data-assigned-state="${assignment === null ? "empty" : "set"}">`,
      `<span class="mat-assigned-label">${escapeHtml(targetLabel(target))}: </span>`,
      `<span class="mat-assigned-value" data-assigned-value style="${WRAP_STYLE}">${escapeHtml(value)}</span>`,
      `</li>`
    ].join("");
  }).join("");
  return [
    `<section class="mat-assigned" data-material-assigned aria-label="Назначенные материалы">`,
    `<h4>Назначенные материалы</h4>`,
    `<ul class="mat-assigned-list">${rows}</ul>`,
    `<p class="mat-assigned-hint" style="${WRAP_STYLE}">Замена одного назначения не меняет остальные.</p>`,
    `</section>`
  ].join("");
}

function renderCard(item: MaterialItem, state: MaterialsPanelState): string {
  const filename = item.filename;
  const targets = targetsForKind(item.kind);
  const currentTarget = assignmentOf(state.assigned, item.assetId);
  const preview = item.kind === "image"
    ? [
      `<img class="mat-thumb" data-material-thumb src="${escapeAttr(item.thumbnailUrl ?? item.url)}"`,
      ` alt="${escapeAttr(item.altText ?? filename)}" width="96" height="72" loading="lazy">`
    ].join("")
    : item.kind === "audio"
      ? [
        `<audio class="mat-audio" data-material-audio src="${escapeAttr(item.url)}" preload="metadata" controls`,
        ` aria-label="${escapeAttr(`Плеер материала ${filename}`)}"></audio>`
      ].join("")
      : `<p class="mat-no-preview" data-material-no-preview style="${WRAP_STYLE}">Предпросмотр для этого типа файла недоступен.</p>`;

  const altLine = item.altText === null
    ? ""
    : `<p class="mat-alt-text" data-material-alt-text style="${WRAP_STYLE}">Описание для незрячих: ${escapeHtml(item.altText)}</p>`;

  const durationLine = item.kind === "audio"
    ? `<span class="mat-duration" data-material-duration style="${WRAP_STYLE}">${escapeHtml(durationLabel(null))}</span>`
    : "";

  const playButton = item.kind === "audio"
    ? `<button type="button" class="mat-play" data-material-action="play-audio" data-asset-id="${escapeAttr(item.assetId)}"`
      + ` aria-label="${escapeAttr(`Прослушать файл ${filename}`)}">Прослушать</button>`
    : "";

  const actions = targets.length === 0
    ? `<p class="mat-unusable" data-material-unusable style="${WRAP_STYLE}">Этот тип файла нельзя назначить в сцене: подходят изображения и звуки.</p>`
    : [
      `<label class="mat-target-label">Назначение`,
      `<select class="mat-target" data-material-target data-asset-id="${escapeAttr(item.assetId)}"`,
      ` aria-label="${escapeAttr(`Назначение материала ${filename}`)}">`,
      targets.map((target) => `<option value="${escapeAttr(target)}"${target === currentTarget ? " selected" : ""}>${escapeHtml(targetLabel(target))}</option>`).join(""),
      `</select>`,
      `</label>`,
      `<button type="button" class="mat-use" data-material-action="use" data-asset-id="${escapeAttr(item.assetId)}"`
      + ` aria-label="${escapeAttr(`Применить назначение материала: ${filename}`)}">Применить назначение</button>`
    ].join("");

  return [
    `<li class="mat-card" data-material-card data-asset-id="${escapeAttr(item.assetId)}" data-material-kind="${escapeAttr(item.kind)}">`,
    `<div class="mat-preview">${preview}</div>`,
    `<div class="mat-meta">`,
    `<p class="mat-name" data-material-name style="${WRAP_STYLE}">${escapeHtml(filename)}</p>`,
    `<p class="mat-type" data-material-type style="${WRAP_STYLE}">${escapeHtml(materialTypeLine(item))}</p>`,
    altLine,
    durationLine,
    `</div>`,
    `<div class="mat-actions">${playButton}${actions}</div>`,
    `</li>`
  ].join("");
}

function renderList(state: MaterialsPanelState): string {
  const empty = `<p class="mat-empty" data-material-empty style="${WRAP_STYLE}"${state.items.length === 0 ? "" : " hidden"}>`
    + `Материалов пока нет. Загрузите первый файл — он появится в списке.</p>`;
  const cards = state.items.map((item) => renderCard(item, state)).join("");
  return [
    `<ul class="mat-list" data-material-list${state.items.length === 0 ? " hidden" : ""}>${cards}</ul>`,
    empty
  ].join("");
}

/** Чистый рендер панели в строку разметки. Ничего не читает и не пишет наружу. */
export function renderMaterialsPanelHtml(state: MaterialsPanelState): string {
  return [
    `<section class="materials-panel" data-materials-panel role="region" aria-label="Библиотека материалов">`,
    renderStatus(state),
    renderUploadForm(state),
    renderNotice(state.notice),
    renderAssigned(state),
    renderList(state),
    `</section>`
  ].join("");
}

/* ------------------------------------------------------------------ */
/* Монтирование и обработчики                                          */
/* ------------------------------------------------------------------ */

function closestWithAction(node: EventTarget | null): HTMLElement | null {
  let current = node as HTMLElement | null;
  while (current !== null && current !== undefined) {
    if (typeof current.hasAttribute === "function" && current.hasAttribute("data-material-action")) return current;
    current = (current.parentElement ?? (current.parentNode as HTMLElement | null)) ?? null;
  }
  return null;
}

function datasetOf(element: Element | null, key: string): string {
  if (element === null) return "";
  const holder = element as HTMLElement;
  const dataset = holder.dataset as Record<string, string | undefined> | undefined;
  const value = dataset?.[key];
  return typeof value === "string" ? value : "";
}

export function renderMaterialsPanel(host: MaterialsPanelHost): () => void {
  const root = host.root;
  let disposed = false;
  let busy = false;
  let status: MaterialsStatus = "loading";
  let items: readonly MaterialItem[] = Object.freeze([]);
  let notice: MaterialNotice | null = null;
  let assigned: Readonly<Partial<Record<MaterialTarget, MaterialAssignment>>> = Object.freeze({});
  let altText = "";
  let pendingFile: File | null = null;
  let focusAssetId: string | null = null;

  const snapshot = (): MaterialsPanelState => emptyMaterialsPanelState({
    status, items, notice, assigned, busy, altText
  });

  const paint = (): void => {
    if (disposed) return;
    root.innerHTML = renderMaterialsPanelHtml(snapshot());
    if (focusAssetId !== null) {
      const card = root.querySelector(`[data-material-card][data-asset-id="${cssEscape(focusAssetId)}"]`);
      const button = (card === null ? null : card.querySelector("[data-material-action]")) as HTMLElement | null;
      focusAssetId = null;
      if (button !== null && typeof button.focus === "function") button.focus();
    }
  };

  const writeAltText = (): void => {
    const input = root.querySelector("[data-material-alt]") as HTMLInputElement | null;
    altText = typeof input?.value === "string" ? input.value : altText;
  };

  const load = (): void => {
    // Пока попытка идёт, второй запуск не начинается: «Повторить» — ровно одна
    // контролируемая попытка, а не лавина запросов при быстрых нажатиях.
    if (disposed || busy) return;
    busy = true;
    status = "loading";
    notice = null;
    paint();
    host.listMaterials()
      .then((listed) => {
        if (disposed) return;
        busy = false;
        if (!Array.isArray(listed)) {
          const invalid = new Error(MATERIAL_ERROR_SENTINELS.listInvalid);
          (invalid as unknown as { code: string }).code = MATERIAL_ERROR_SENTINELS.listInvalid;
          throw invalid;
        }
        const normalized: MaterialItem[] = [];
        for (const entry of listed) {
          const item = normalizeMaterialItem(entry);
          if (item !== null) normalized.push(item);
        }
        items = Object.freeze(normalized);
        status = "ready";
        paint();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        busy = false;
        status = "error";
        notice = { scope: "list", ...describeMaterialError(error, "list") };
        host.onError(error);
        paint();
      });
  };

  const startUpload = (file: File | null): void => {
    if (disposed || busy) return;
    if (file === null) {
      const noFile = new Error(MATERIAL_ERROR_SENTINELS.noFile);
      (noFile as unknown as { code: string }).code = MATERIAL_ERROR_SENTINELS.noFile;
      busy = false;
      notice = { scope: "upload", ...describeMaterialError(noFile, "upload") };
      paint();
      return;
    }
    pendingFile = file;
    busy = true;
    notice = null;
    paint();
    const meta = altText.length > 0 ? { altText } : {};
    host.uploadMaterial(file, meta)
      .then((item) => {
        if (disposed) return;
        busy = false;
        const normalized = normalizeMaterialItem(item);
        if (normalized !== null) {
          items = Object.freeze([normalized, ...items]);
          focusAssetId = normalized.assetId;
        }
        pendingFile = null;
        status = "ready";
        paint();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        busy = false;
        // Выбранный файл сохраняется: кнопка «Повторить» повторит ту же загрузку.
        notice = { scope: "upload", ...describeMaterialError(error, "upload") };
        host.onError(error);
        paint();
      });
  };

  const applyItem = (assetId: string, target: MaterialTarget): void => {
    const item = items.find((entry) => entry.assetId === assetId) ?? null;
    if (item === null) return;
    host.onUseMaterial(item, target);
    assigned = withAssignment(assigned, target, { assetId: item.assetId, filename: item.filename });
    notice = null;
    paint();
  };

  const toggleAudio = (assetId: string, button: HTMLElement): void => {
    const card = root.querySelector(`[data-material-card][data-asset-id="${cssEscape(assetId)}"]`);
    const audio = (card?.querySelector("[data-material-audio]") ?? null) as HTMLAudioElement | null;
    const filename = items.find((entry) => entry.assetId === assetId)?.filename ?? assetId;
    const playing = audio !== null && typeof audio.paused === "boolean" && audio.paused === false;
    if (playing) {
      if (typeof audio?.pause === "function") audio.pause();
      button.textContent = "Прослушать";
      button.setAttribute("aria-label", `Прослушать файл ${filename}`);
      return;
    }
    if (audio !== null && typeof audio.play === "function") {
      const result = audio.play() as unknown;
      if (result !== undefined && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => undefined);
      }
      button.textContent = "Пауза";
      button.setAttribute("aria-label", `Остановить прослушивание файла ${filename}`);
    }
  };

  const onClick = (event: Event): void => {
    if (disposed) return;
    const action = closestWithAction(event.target);
    if (action === null) return;
    const kind = datasetOf(action, "materialAction");
    if (kind === "use" || kind === "play-audio") event.preventDefault?.();
    const assetId = datasetOf(action, "assetId");
    if (kind === "use") {
      const card = root.querySelector(`[data-material-card][data-asset-id="${cssEscape(assetId)}"]`);
      const select = (card?.querySelector("[data-material-target]") ?? null) as HTMLSelectElement | null;
      const target = (typeof select?.value === "string" ? select.value : "") as MaterialTarget;
      if (!MATERIAL_TARGETS.includes(target)) return;
      applyItem(assetId, target);
      return;
    }
    if (kind === "play-audio") {
      toggleAudio(assetId, action);
      return;
    }
    if (kind === "retry") {
      if (notice?.scope === "upload") startUpload(pendingFile);
      else load();
      return;
    }
    if (kind === "pick-file") {
      const input = root.querySelector("[data-material-file]") as HTMLInputElement | null;
      if (input !== null && typeof input.click === "function") input.click();
    }
  };

  const onSubmit = (event: Event): void => {
    if (disposed) return;
    event.preventDefault?.();
    if (busy) return;
    writeAltText();
    const input = root.querySelector("[data-material-file]") as HTMLInputElement | null;
    const files = input?.files as FileList | null | undefined;
    const chosen = files !== null && files !== undefined && files.length > 0 ? files[0]! : pendingFile;
    startUpload(chosen ?? null);
  };

  const onChange = (event: Event): void => {
    if (disposed) return;
    const target = event.target as HTMLInputElement | null;
    if (target !== null && target !== undefined && target.hasAttribute?.("data-material-file")) {
      const files = target.files as FileList | null | undefined;
      if (files !== null && files !== undefined && files.length > 0) {
        pendingFile = files[0]!;
      }
    }
  };

  const onLoadedMetadata = (event: Event): void => {
    if (disposed) return;
    const audio = event.target as HTMLAudioElement | null;
    if (audio === null || audio === undefined) return;
    const duration = (audio as unknown as { duration?: number }).duration;
    const card = (typeof audio.closest === "function" ? audio.closest("[data-material-card]") : null)
      ?? (audio.parentElement ?? null);
    const label = card === null ? null : (card.querySelector("[data-material-duration]") ?? null);
    if (label !== null) label.textContent = durationLabel(typeof duration === "number" ? duration : null);
  };

  root.addEventListener("click", onClick as EventListener);
  root.addEventListener("submit", onSubmit as EventListener);
  root.addEventListener("change", onChange as EventListener);
  root.addEventListener("loadedmetadata", onLoadedMetadata as EventListener, true);

  paint();
  load();

  return function dispose(): void {
    if (disposed) return;
    disposed = true;
    root.removeEventListener("click", onClick as EventListener);
    root.removeEventListener("submit", onSubmit as EventListener);
    root.removeEventListener("change", onChange as EventListener);
    root.removeEventListener("loadedmetadata", onLoadedMetadata as EventListener, true);
    root.innerHTML = "";
  };
}
