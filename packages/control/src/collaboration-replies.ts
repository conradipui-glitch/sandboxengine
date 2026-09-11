import type {
  AddMessageInput,
  CollaborationMessage,
  CollaborationStore,
  CollaborationWriteResult
} from "./types.js";

/**
 * FIN-12 reply policy (chosen deliberately, see the test file for the proof).
 *
 * POLICY: "flatten-to-root".
 *
 * A thread is a two-level structure: the opening message plus its direct
 * replies. Answering a reply is allowed, but the reply is re-anchored to the
 * THREAD ROOT — `replyToMessageId` always names a top-level message, never
 * another reply. The alternative (rejecting a reply-to-reply outright) was
 * discarded because it makes a busy discussion fragile: the author cannot know
 * whether the message they are looking at is already an answer, and a rejected
 * reply silently loses the intent. Flattening keeps every answer, keeps the
 * thread order stable and keeps the rendering trivial (one indent level).
 *
 * The root of a message is resolved by walking `replyToMessageId` up to the
 * message whose own parent is `null`, so legacy rows that were written while
 * the link was optional and still contain a nested chain are flattened on the
 * next reply instead of being dropped.
 */
export const COLLABORATION_REPLY_POLICY = "flatten-to-root" as const;

function findMessage(
  messages: readonly CollaborationMessage[],
  messageId: string
): CollaborationMessage | null {
  for (const message of messages) {
    if (message.messageId === messageId) return message;
  }
  return null;
}

/**
 * Walks the parent chain of `messageId` up to the top-level message and returns
 * its id. Returns `null` when the message is not part of the thread at all (the
 * caller must keep the original id then, so the store still rejects it with the
 * usual `invalid_request`). A broken or cyclic chain stops at the last
 * resolvable message instead of throwing.
 */
export function resolveThreadRoot(
  messages: readonly CollaborationMessage[],
  messageId: string
): string | null {
  let current = findMessage(messages, messageId);
  if (current === null) return null;
  const seen = new Set<string>([current.messageId]);
  while (current.replyToMessageId !== null) {
    const parent = findMessage(messages, current.replyToMessageId);
    if (parent === null) break;
    if (seen.has(parent.messageId)) break;
    seen.add(parent.messageId);
    current = parent;
  }
  return current.messageId;
}

/**
 * The parent id that must actually be stored for a reply. `undefined` in means
 * "top-level message" (unchanged); an unknown id is returned as-is so the
 * underlying store keeps ownership of the `invalid_request` verdict.
 */
export function flattenReplyTarget(
  messages: readonly CollaborationMessage[],
  replyToMessageId: string | undefined
): string | undefined {
  if (replyToMessageId === undefined) return undefined;
  const root = resolveThreadRoot(messages, replyToMessageId);
  return root === null ? replyToMessageId : root;
}

function requireBaseRevision(): CollaborationWriteResult {
  return Object.freeze({ kind: "invalid_request" as const, errors: Object.freeze(["expectedRevision"]) });
}

async function flattenForStore(
  store: CollaborationStore,
  projectId: string,
  questId: string,
  input: AddMessageInput
): Promise<string | undefined> {
  if (input.replyToMessageId === undefined) return undefined;
  const view = await store.getCollaboration(projectId, questId);
  const thread = view?.threads.find((entry) => entry.threadId === input.threadId);
  // An unknown project/quest/thread keeps the original id: the wrapped store
  // answers with project_not_found/quest_not_found/not_found, not with a
  // fabricated parent verdict.
  if (!thread) return input.replyToMessageId;
  return flattenReplyTarget(thread.messages, input.replyToMessageId);
}

/**
 * Wraps any `CollaborationStore` with the two FIN-12 server rules that the
 * pre-existing store keeps optional for backwards compatibility:
 *
 *  1. a reply MUST carry a thread base revision (`expectedRevision`), otherwise
 *     it is an `invalid_request` and nothing is written. The wrapped store still
 *     performs the authoritative CAS, so a stale base is its
 *     `revision_conflict` with the live `currentRevision` and no reply is lost;
 *  2. a reply-to-reply is flattened to the thread root before it reaches the
 *     store, so `replyToMessageId` always names a top-level message.
 *
 * Every other method is delegated unchanged: notes, edits, deletes, the status
 * CAS state machine (including its honest no-op) and idempotent replay keep
 * their exact semantics.
 */
export function withReplyPolicy(store: CollaborationStore): CollaborationStore {
  return Object.freeze({
    getCollaboration: (projectId: string, questId: string) => store.getCollaboration(projectId, questId),
    createNote: (projectId: string, questId: string, input: Parameters<CollaborationStore["createNote"]>[2]) => store.createNote(projectId, questId, input),
    changeNote: (projectId: string, questId: string, input: Parameters<CollaborationStore["changeNote"]>[2]) => store.changeNote(projectId, questId, input),
    deleteNote: (projectId: string, questId: string, input: Parameters<CollaborationStore["deleteNote"]>[2]) => store.deleteNote(projectId, questId, input),
    createThread: (projectId: string, questId: string, input: Parameters<CollaborationStore["createThread"]>[2]) => store.createThread(projectId, questId, input),
    changeMessage: (projectId: string, questId: string, input: Parameters<CollaborationStore["changeMessage"]>[2]) => store.changeMessage(projectId, questId, input),
    deleteMessage: (projectId: string, questId: string, input: Parameters<CollaborationStore["deleteMessage"]>[2]) => store.deleteMessage(projectId, questId, input),
    setThreadStatus: (projectId: string, questId: string, input: Parameters<CollaborationStore["setThreadStatus"]>[2]) => store.setThreadStatus(projectId, questId, input),
    addMessage: async (
      projectId: string,
      questId: string,
      input: Parameters<CollaborationStore["addMessage"]>[2]
    ): Promise<CollaborationWriteResult> => {
      if (input.expectedRevision === undefined) return requireBaseRevision();
      const target = await flattenForStore(store, projectId, questId, input);
      const next: AddMessageInput = target === undefined ? { ...input } : { ...input, replyToMessageId: target };
      return store.addMessage(projectId, questId, next);
    }
  });
}
