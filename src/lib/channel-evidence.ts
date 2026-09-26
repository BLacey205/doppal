/**
 * The evidence behind every claim on the /app Connections card.
 *
 * The rule, and the reason this module exists: **configuration is not evidence.**
 * `RESEND_WEBHOOK_SECRET` and `RESEND_API_KEY` being set says only that somebody
 * stored two strings. It says nothing about whether a real forwarded message has
 * ever been fetched and stored — which is the only thing "connected" is allowed to
 * mean here. So each channel's state follows recorded events, never the env:
 *
 *   - `not_configured`       — the env-var names the channel needs are not all set;
 *   - `configured_unproven`  — they are set, but no real forwarded message has been
 *                              fetched and stored in this process;
 *   - `proven`               — a real forwarded message was fetched through the
 *                              provider and genuinely kept by a store. The only
 *                              state allowed to say the channel is connected;
 *   - `failed`               — the provider refused our credentials, or a check
 *                              found something unacceptable. It stays failed until
 *                              a **later recorded event** (a stored message, or a
 *                              passing check) supersedes it — a failure is never
 *                              quietly dropped.
 *
 * Events carry an ISO timestamp and "the latest event wins" decides the state, so
 * recovery is possible but never silent: a card that said "failed" keeps saying so
 * until something actually happened that is stronger evidence.
 *
 * Kept on `globalThis` so it survives a dev-server module reload and is shared by
 * every route handler and server function in the process. Nothing here throws,
 * touches the network, or holds a secret: only names, typed codes and the app's own
 * sentences.
 */

/** A channel id. "email" today; an SMS channel would add its own later. */
export type ChannelId = string;

/** Which inbound provider (in `~/lib/inbound-providers`) feeds which channel. */
const PROVIDER_TO_CHANNEL: Record<string, ChannelId> = {
  resend: "email",
};

/** Where a proven message actually landed — the store's own word, not a guess. */
export type ProvenWhere = "database" | "preview";

export type ChannelEvent = {
  at: string; // ISO
};

export type MailStoredEvent = ChannelEvent & {
  kind: "mail_stored";
  where: ProvenWhere;
};

export type ChannelFailureEvent = ChannelEvent & {
  kind: "failure";
  /** Short typed token, e.g. "provider_rejected_key", "unsigned_accepted". */
  code: string;
  /** The app's own sentence. Never a vendor body, stack or secret. */
  message: string;
};

export type ChannelCheckFact = {
  label: string;
  /** The HTTP status the handler answered, verbatim. */
  status: number;
  /**
   * The typed JSON the handler answered, verbatim (codes and sentences only —
   * our own responses carry strings, numbers, booleans and null, nothing else,
   * which also keeps the whole record JSON-serializable for the browser).
   */
  body: Record<string, string | number | boolean | null>;
  /** Whether that answer is the one this check required. */
  expected: boolean;
};

export type ChannelCheckRecord =
  | {
      kind: "ok";
      ranAt: string;
      ranAtLabel: string;
      facts: ChannelCheckFact[];
      /** What the check established — and, just as firmly, what it did not. */
      summary: string;
    }
  | {
      kind: "failed";
      ranAt: string;
      ranAtLabel: string;
      facts: ChannelCheckFact[];
      /** Why the check failed, in one sentence. */
      reason: string;
    }
  | {
      kind: "error";
      ranAt: string;
      ranAtLabel: string;
      /** The check could not run at all — said plainly, claiming nothing. */
      message: string;
    };

type ChannelEvidenceEntry = {
  mailStored: MailStoredEvent | null;
  failure: ChannelFailureEvent | null;
  lastCheck: ChannelCheckRecord | null;
};

type EvidenceStore = { entries?: Record<ChannelId, ChannelEvidenceEntry | undefined> };

function evidenceStore(): EvidenceStore {
  const globalKey = "__doppelChannelEvidence" as const;
  const host = globalThis as unknown as Record<string, EvidenceStore | undefined>;
  if (!host[globalKey]) host[globalKey] = {};
  return host[globalKey]!;
}

function entryFor(channel: ChannelId): ChannelEvidenceEntry {
  const store = evidenceStore();
  if (!store.entries) store.entries = {};
  const existing = store.entries[channel];
  if (existing) return existing;
  const fresh: ChannelEvidenceEntry = { mailStored: null, failure: null, lastCheck: null };
  store.entries[channel] = fresh;
  return fresh;
}

/** Read one channel's evidence (read-only; safe from any server code). */
export function channelEvidence(channel: ChannelId): ChannelEvidenceEntry {
  return entryFor(channel);
}

/**
 * Record that a real message arrived through a provider webhook and was genuinely
 * kept by a store. Called from the provider webhook handler at the exact moment
 * the brief names — *after* the store said where the row landed, never before.
 * This is the only thing that can put a channel into `proven`.
 */
export function noteProviderMailStored(providerName: string, where: ProvenWhere, now: Date = new Date()): void {
  const channel = PROVIDER_TO_CHANNEL[providerName];
  if (!channel) return;
  const entry = entryFor(channel);
  entry.mailStored = { kind: "mail_stored", at: now.toISOString(), where };
}

/**
 * Record a channel failure: the provider refused our credentials
 * (`provider_rejected_key`) or a check found something unacceptable. The app's own
 * sentence rides along; nothing vendor-shaped is stored.
 */
export function noteProviderFailure(providerName: string, code: string, message: string, now: Date = new Date()): void {
  const channel = PROVIDER_TO_CHANNEL[providerName];
  if (!channel) return;
  const entry = entryFor(channel);
  entry.failure = { kind: "failure", at: now.toISOString(), code, message };
}

/** Record the outcome of one run of the channel's check. */
export function noteChannelCheck(channel: ChannelId, record: ChannelCheckRecord): void {
  const entry = entryFor(channel);
  entry.lastCheck = record;
  if (record.kind === "failed") {
    // A failed check is a failure event too — it competes by time with everything
    // else, so a later stored message can supersede it, and it can supersede an
    // earlier proven state if it happened after.
    entry.failure = { kind: "failure", at: record.ranAt, code: "check_failed", message: record.reason };
  }
}

/** Test helper: forget everything this process has learned. */
export function resetChannelEvidence(): void {
  const store = evidenceStore();
  store.entries = {};
}
