import { ControlApiError } from "./api.js";

/**
 * Человеческое объяснение отказа Control API.
 *
 * Правило: сообщение об ошибке обязано быть действием автора, а не кодом.
 * `Control API: <CODE>` заставлял владельца гадать, что делать; здесь коды
 * переводятся в причину и следующий шаг, а неизвестный код остаётся видимым
 * (и код, и detailCode), чтобы отказ не превращался в молчание.
 */
const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  // Публикация и выпуски.
  RELEASE_FREEZE_FAILED: "Выпуск нельзя собрать из этой проверки.",
  MISSION_REVISION_UNAVAILABLE:
    "У миссии нет сохранённой истории: сохраните сюжет миссии и проверьте снова — из пустой миссии выпуск не собирается.",
  ASSET_MISSING: "Не хватает материалов, на которые ссылается миссия: добавьте их в материалы проекта и проверьте снова.",
  ASSET_CHANGED: "Материал изменился после сборки выпуска: соберите выпуск заново.",
  LEGACY_PIN_UNPROVABLE: "Этот выпуск собран вне мастерской, его содержимое недоказуемо — откат к нему невозможен.",
  PUBLICATION_COMMIT_FAILED: "Публикация не завершилась: указатель версии не сдвинут, текущая версия сайта не изменилась. Повторите публикацию.",
  PUBLICATION_ALREADY_PENDING: "Другая публикация уже идёт: дождитесь её завершения.",
  PUBLICATION_OPERATION_NOT_PENDING: "Эта операция публикации больше не ожидает подтверждения: повторите публикацию заново.",

  // Проверка и правила.
  PLUGIN_PREFLIGHT_FAILED: "Миссии не хватает правил (плагинов), которые требует движок.",
  PLUGIN_REQUIREMENTS_UNMET: "Правила (плагины) не установлены или устарели: обновите набор правил движка.",
  INVALID_VALIDATION_REQUEST: "Проверка отклонена: неверный номер ревизии черновика.",
  INVALID_RELEASE_BUILD_REQUEST: "Сборка отклонена: неверные параметры выпуска.",
  VALIDATION_NOT_FOUND: "Проверка не найдена: прогоните проверку заново.",

  // Совместная работа.
  REVISION_CONFLICT: "Черновик изменился после вашего последнего сохранения: обновите страницу и повторите.",
  COLLABORATION_REVISION_CONFLICT: "Кто-то сохранил изменения раньше вас: обновите и повторите.",
  COLLABORATION_FORBIDDEN: "Недостаточно прав: изменения в обсуждении доступны автору проекта и его владельцу.",
  EDITING_LOCK_HELD: "Объект сейчас редактирует другой участник: подождите или выберите другой объект.",
  EDITING_LOCK_NOT_HOLDER: "Объект редактируете не вы: обновление аренды отклонено.",
  EDITING_LOCK_REVISION_CONFLICT: "Объект изменился, пока вы его редактировали: обновите и повторите.",
  EDITING_LOCK_EXPIRED: "Аренда объекта истекла: возьмите её заново.",

  // Доступ и сессия.
  CONTROL_FORBIDDEN: "Недостаточно прав для этого действия в проекте.",
  CONTROL_ORIGIN_DENIED: "Запрос пришёл с неизвестного адреса: обновите страницу и войдите заново.",
  CONTROL_CSRF_REQUIRED: "Сессия устарела: обновите страницу и войдите заново.",
  CONTROL_UNAUTHENTICATED: "Нужно войти в мастерскую.",
  CONTROL_SESSION_EXPIRED: "Сессия истекла: войдите заново.",
  CONTROL_LOGIN_THROTTLED: "Слишком много попыток входа: подождите минуту и повторите.",

  // Данные проекта.
  PROJECT_NOT_FOUND: "Проект не найден: он мог быть удалён или переименован.",
  QUEST_NOT_FOUND: "Миссия не найдена: обновите список миссий.",
  INVALID_QUEST: "Миссию не удалось создать: проверьте название и стартовую локацию.",
  QUEST_EXISTS: "Миссия с таким идентификатором уже есть в проекте.",
  INVALID_MISSION_DOCUMENT: "Документ истории отклонён: проверьте ревизию, от которой сохраняете.",
  DRAFT_REVISION_CONFLICT: "Черновик уже изменили: обновите и повторите.",
  INVALID_IDEMPOTENCY_KEY: "Повторная отправка того же действия отклонена: повторите действие."
});

function detailOf(error: ControlApiError): string | null {
  const payload = error.payload;
  if (!payload || typeof payload !== "object") return null;
  const inner = (payload as { error?: unknown }).error;
  if (!inner || typeof inner !== "object") return null;
  const detail = (inner as { detailCode?: unknown }).detailCode;
  return typeof detail === "string" && detail.length > 0 ? detail : null;
}

export function explainControlCode(code: string | null | undefined): string | null {
  return code ? MESSAGES[code] ?? null : null;
}

export interface ReleaseReadinessLike {
  readonly status?: string;
  readonly code?: string | null;
  readonly missionRevision?: number;
}

/**
 * Почему «выпуск нельзя собрать», сказанное до самой попытки сборки.
 * Возвращает `null`, когда блокировки нет: тогда автору нечего читать.
 */
export function describeReleaseReadiness(readiness: ReleaseReadinessLike | null | undefined): string | null {
  if (!readiness || readiness.status !== "blocked") return null;
  const reason = explainControlCode(readiness.code ?? null);
  if (reason) return reason;
  return `Выпуск собрать нельзя: код ${readiness.code ?? "неизвестен"}.`;
}

export function describeControlError(error: unknown): string {
  if (error instanceof ControlApiError) {
    if (error.status === 0) return "Control API недоступен: проверьте, что локальный сервер мастерской запущен.";
    const detail = detailOf(error);
    const explained = (detail ? MESSAGES[detail] : undefined) ?? MESSAGES[error.code];
    if (explained) return explained;
    const codes = detail && detail !== error.code ? `${error.code} / ${detail}` : error.code;
    return `Действие отклонено: ${codes}.`;
  }
  return error instanceof Error ? error.message : "Неизвестная ошибка Studio.";
}
