// DELETE-01: fail-closed проверка публикации перед удалением.
//
// ControlStore ничего не знает о каталоге опубликованных миссий, поэтому вопрос
// «можно ли это удалить, не оставив висячую ссылку» решается здесь, на HTTP-
// границе, ДО вызова стора. Правило простое и намеренно строгое:
//
//   * опубликованный квест удалить нельзя — сначала его снимают с публикации
//     (панель «Публикация» → «Снять с публикации»), затем удаляют;
//   * проект с хотя бы одним опубликованным квестом удалить нельзя: каскад
//     оставил бы каталог указывающим на релиз, которого больше нет.
//
// Если публикационный стор не сконфигурирован вовсе, публиковать в этом
// процессе нечем — доказывать нечего, и запрет был бы выдумкой. Это осознанно:
// локальный режим без релизов не должен терять возможность удаления.
import type { ControlPublicationStore } from "@living-history/control";

export type DeletePublicationGuard =
  | { readonly kind: "clear" }
  | { readonly kind: "published"; readonly questIds: readonly string[] };

/**
 * Список квестов проекта, у которых есть ЖИВАЯ публикация (`status: published`).
 * Запись со статусом `unlisted` живой ссылкой не является: публичный каталог её
 * не отдаёт, поэтому она не блокирует удаление — но и не удаляется здесь, чтобы
 * не трогать чужой стор.
 */
export async function publishedQuestIds(
  publicationStore: ControlPublicationStore | null | undefined,
  projectId: string,
  questIds: readonly string[]
): Promise<readonly string[]> {
  if (!publicationStore) return Object.freeze([]);
  const published: string[] = [];
  for (const questId of questIds) {
    const record = await publicationStore.getPublicationForQuest(projectId, questId);
    if (record !== null && record.status === "published") published.push(questId);
  }
  return Object.freeze(published);
}

export async function questDeletePublicationGuard(
  publicationStore: ControlPublicationStore | null | undefined,
  projectId: string,
  questId: string
): Promise<DeletePublicationGuard> {
  const published = await publishedQuestIds(publicationStore, projectId, [questId]);
  return published.length === 0 ? { kind: "clear" } : { kind: "published", questIds: published };
}

export async function projectDeletePublicationGuard(
  publicationStore: ControlPublicationStore | null | undefined,
  projectId: string,
  questIds: readonly string[]
): Promise<DeletePublicationGuard> {
  const published = await publishedQuestIds(publicationStore, projectId, questIds);
  return published.length === 0 ? { kind: "clear" } : { kind: "published", questIds: published };
}
