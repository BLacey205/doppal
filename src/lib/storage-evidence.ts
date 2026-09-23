/**
 * The evidence behind the storage line on /app.
 *
 * The rule this module exists to enforce: **a connection string is not evidence
 * that saving works.** `DATABASE_URL` being set says only that some address was
 * configured — it says nothing about whether a write to that address succeeds. So
 * the line under "Where the data lives" is decided by what actually happened:
 *
 *   - no `DATABASE_URL`        → preview: nothing is being saved, as before;
 *   - a string, no query yet   → configured and unconfirmed: we claim nothing;
 *   - a query went through     → saving is confirmed, and the line may say so;
 *   - a query failed           → failing, and it stays that way.
 *
 * A failure is deliberately **sticky for the life of the process**: after one
 * failed read or write, no later page view may go back to claiming saves are
 * landing, even if another query happens to succeed. That under-claims rather than
 * over-claims, which is the direction this product errs in. Restarting the app
 * (or fixing the connection) clears it.
 *
 * Kept on `globalThis` for two reasons: it survives a dev-server module reload, and
 * the inbox and the waitlist write to the same database, so they share one answer.
 *
 * Nothing here throws, touches the network, or keeps an error object: only the
 * typed, human sentence the app already shows is stored.
 */

export type QueryDirection = "read" | "write";

export type StorageEvidence = {
  /** A real query through the configured database came back in this process. */
  confirmed: boolean;
  /** The first failure in this process, and the typed copy that describes it. */
  failure: { direction: QueryDirection; message: string } | null;
};

type EvidenceStore = { evidence?: StorageEvidence };

function evidenceStore(): EvidenceStore {
  const globalKey = "__doppelStorageEvidence" as const;
  const host = globalThis as unknown as Record<string, EvidenceStore | undefined>;
  if (!host[globalKey]) host[globalKey] = {};
  return host[globalKey];
}

export function storageEvidence(): StorageEvidence {
  const store = evidenceStore();
  if (!store.evidence) store.evidence = { confirmed: false, failure: null };
  return store.evidence;
}

/** Call after a query through the configured database came back. Cheap and sync. */
export function noteStorageQuerySucceeded(): void {
  storageEvidence().confirmed = true;
}

/**
 * Call when a query through the configured database threw.
 *
 * `message` must be the typed sentence the app already returns to a visitor
 * (see `FAILED_READ` / `FAILED_WRITE` in `~/lib/inbox-server`) — never a driver
 * error, an error code or a stack. The first failure wins: later ones cannot
 * downgrade it to a milder sentence.
 */
export function noteStorageQueryFailed(direction: QueryDirection, message: string): void {
  const evidence = storageEvidence();
  if (!evidence.failure) evidence.failure = { direction, message };
}

/** Test helper: forget everything this process has learned. */
export function resetStorageEvidence(): void {
  evidenceStore().evidence = { confirmed: false, failure: null };
}
