/**
 * Shared SQLite adapter error types and error normalization.
 *
 * These live in a dependency-free leaf module so that row-mapping helpers
 * (`session-rows.ts`) and the guards (`json-guards.ts`) can raise the same
 * errors without importing a storage adapter — that would create an import
 * cycle (adapter -> rows -> adapter).
 *
 * `sqlite-storage.ts` re-exports these names, so the package public API is
 * unchanged. Before this module the busy/corruption classes and
 * `normalizeSQLiteError` were duplicated verbatim between `sqlite-storage.ts`
 * and `sqlite-guest-session-access.ts`.
 */
export class SQLiteStorageBusyError extends Error {
  readonly code = "SQLITE_BUSY";

  constructor(message = "SQLite storage remained busy past the bounded wait") {
    super(message);
    this.name = "SQLiteStorageBusyError";
  }
}

export class SQLiteStorageCorruptionError extends Error {
  readonly code = "SQLITE_CORRUPT_STATE";

  constructor(message: string) {
    super(message);
    this.name = "SQLiteStorageCorruptionError";
  }
}

export function normalizeSQLiteError(error: unknown): unknown {
  if (error instanceof SQLiteStorageBusyError || error instanceof SQLiteStorageCorruptionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(message)) return new SQLiteStorageBusyError(message);
  return error;
}
