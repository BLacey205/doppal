/**
 * Shared types for the Doppel inbox wedge. Pure types only — this module is
 * imported by both server-only code and React components, so it must never pull
 * in a database handle or a secret.
 *
 * Rule for everything below: timestamps cross the wire as **strings** (ISO or
 * pre-formatted), never as `Date` objects. React refuses to render a `Date`.
 */

/** Which producer made a piece of AI output. Never blur these two. */
export type AiMode = "model" | "heuristic";

/** How the AI layer is currently wired, for the UI strip. */
export type AiStatus = {
  mode: AiMode;
  /** e.g. "openai:gpt-4o-mini" or "heuristic" */
  provider: string;
  /** Human sentence, safe to show a non-technical owner. */
  label: string;
  /** Optional honesty note (e.g. the model call failed and we fell back). */
  note?: string;
};

/** A date/time we found inside an email. */
export type DateCandidate = {
  /** Stable within one email: `d1`, `d2`, … */
  id: string;
  /** The text we matched, e.g. "Friday 25 September at 10:00". */
  label: string;
  /** ISO string, always UTC. */
  startsAt: string;
  /** Pre-formatted for display, e.g. "Fri 25 Sep 2026, 10:00". */
  startsAtLabel: string;
  allDay: boolean;
  reminderAt: string;
  reminderLabel: string;
  reminderMinutes: number | null;
  /** Which producer found this date (model vs rules). */
  mode?: AiMode;
  provider?: string;
  /** `true` once a calendar event exists for it (DB or preview store). */
  added?: boolean;
};

/** Importance triage for one message. */
export type Importance = {
  /** 0–100, higher = more important. */
  score: number;
  /** One line explaining the score. */
  reason: string;
  needsReply: boolean;
};

export type DraftRecord = {
  body: string;
  mode: AiMode;
  provider: string;
  label: string;
  note?: string;
  updatedAt: string;
};

/** An email as the app knows it — everything already stringified/parsed. */
export type StoredEmail = {
  id: string;
  source: "paste" | "api" | "sample";
  fromName: string | null;
  fromEmail: string | null;
  fromLabel: string;
  subject: string;
  snippet: string;
  body: string;
  receivedAt: string;
  receivedAtLabel: string;
  importance: Importance;
  aiMode: AiMode;
  aiProvider: string;
  dates: DateCandidate[];
  draft: DraftRecord | null;
};

export type CalendarEvent = {
  id: string;
  emailId: string | null;
  title: string;
  startsAt: string;
  startsAtLabel: string;
  allDay: boolean;
  reminderAt: string | null;
  reminderLabel: string | null;
  sourceLabel: string;
  createdAt: string;
};

/**
 * Whether the owner gets told when important mail arrives (Knock alerting).
 * Produced by `~/lib/notify`; defined here because components render it.
 */
export type AlertState =
  | "on"
  | "not_configured"
  | "workflow_missing"
  | "unauthorized"
  | "rejected"
  | "unavailable"
  | "unknown";

export type AlertStatus = {
  state: AlertState;
  /** Plain words for the /app line, e.g. "Alerts: on". */
  label: string;
  /** Optional sentence saying how we know, and what changes it. */
  note?: string;
  /** The Knock workflow key this state is about. */
  workflowKey: string;
  /** ISO string of the last check, or null when nothing was checked. */
  checkedAt: string | null;
  /** How the state was learned. */
  source: "probe" | "trigger" | "none";
};

/**
 * Which backend is holding the data right now — and, separately, what we have
 * actually seen it do.
 *
 * `mode` is configuration (is a connection string set at all?); `state` is
 * evidence (has a query through that backend come back?). Only `"confirmed"`
 * allows the UI to say that saving works, because only `"confirmed"` follows a
 * query that really went through. See `~/lib/storage-evidence`.
 */
export type StorageState =
  /** No connection string: in-memory preview, nothing is saved. */
  | "preview"
  /** A connection string is set, but no query has gone through it yet. */
  | "unverified"
  /** A query went through it: saving is real. */
  | "confirmed"
  /** A query failed; nothing may claim success again in this process. */
  | "failed";

export type StorageStatus = {
  mode: "database" | "preview";
  /** What we can support with evidence, as opposed to what is configured. */
  state: StorageState;
  /** Which half of the failure this is — only set when `state` is "failed". */
  failedDirection?: "read" | "write";
  /** One human sentence for the banner. Never claims more than `state` allows. */
  label: string;
  /** Why the line reads the way it does. */
  note?: string;
};
