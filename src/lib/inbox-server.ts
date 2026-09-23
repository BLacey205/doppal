/**
 * Server-only storage for the inbox wedge.
 *
 * Two backends, one API:
 *   - **Postgres** (`DATABASE_URL`, via `~/db`) when a database is connected.
 *   - **In-memory preview** when it isn't — so every screen and every button in
 *     /app still works before the owner connects a database, and the UI says
 *     plainly that nothing is being saved. The moment `DATABASE_URL` appears the
 *     same calls take the Postgres path; no code change, no migration (the tables
 *     are created with `CREATE TABLE IF NOT EXISTS` on first write).
 *
 * `storageStatus()` reports what a query has **actually done**, not what the
 * environment is configured with: a connection string alone is never evidence
 * that saving works. Every query that goes through this module is observed (see
 * `observed()`), so a success promotes the line to "saved", a failure demotes it
 * to "failing" and keeps it there for the rest of the process, and a fresh
 * process with a connection string but no query yet claims nothing at all. The
 * evidence lives in `~/lib/storage-evidence`, shared with the waitlist, which
 * writes to the same database.
 *
 * Every function returns a typed result instead of throwing, so no missing
 * database and no failed write can ever surface to a visitor as a 500.
 *
 * Timestamps are always handed back as ISO **strings** — React will not render a
 * JS `Date`.
 */
import { sql } from "~/db";
import type {
  CalendarEvent,
  DateCandidate,
  DraftRecord,
  Importance,
  StoredEmail,
  StorageStatus,
} from "~/lib/inbox-types";
import {
  storageEvidence,
  noteStorageQueryFailed,
  noteStorageQuerySucceeded,
  type QueryDirection,
} from "~/lib/storage-evidence";
import { formatWhen } from "~/lib/ai";
import { failureLogLine } from "~/lib/log-line";

export type Row = Record<string, unknown>;
export type QueryExecutor = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Row[]>;

export type StoreResult<T> =
  | {
      ok: true;
      value: T;
      storage: StorageStatus;
      /**
       * Where the row actually landed — set by the write paths that feed the
       * inbound funnel. "memory" can be honest preview (no database configured)
       * or a silent fallback after the real store refused; callers that decide
       * anything from durability (the provider webhook's duplicate suppression)
       * must look at this, not at `storage` alone, which cannot tell the two
       * memory cases apart.
       */
      storedIn?: "database" | "memory";
    }
  | { ok: false; message: string; storage: StorageStatus };

export const PREVIEW_NOTE =
  "No database is connected yet, so this inbox lives in memory for this session and nothing is saved. Everything else — ranking, date extraction and drafting — runs for real.";

/** The only label that claims saving works — and only a real query may trigger it. */
export const CONFIRMED_LABEL = "Saved to the connected database";

const UNVERIFIED_LABEL = "Database connected — saving not confirmed yet";
const FAILED_LABELS = {
  write: "Database connected — saving is failing",
  read: "Database connected — reading the inbox is failing",
} as const;

const UNVERIFIED_NOTE =
  "An address for a database is set, but nothing has been read from or written to it yet in this run — so this line makes no claim that saving works. It updates itself the moment something goes through.";

const CONFIRMED_NOTE =
  "A real read or write to it came back in this run. That, not the address being set, is what this line reports.";

/**
 * The acceptance rule for every claim on the storage card.
 *
 * Order matters: no connection string is preview whatever else happened; then a
 * recorded failure outranks a success (so a page can never keep claiming success
 * after a failure); only then does a confirmed query earn the "saved" wording.
 */
export function storageStatus(): StorageStatus {
  if (!process.env.DATABASE_URL) {
    return { mode: "preview", state: "preview", label: "Preview mode — nothing is being saved", note: PREVIEW_NOTE };
  }

  const evidence = storageEvidence();

  if (evidence.failure) {
    const { direction, message } = evidence.failure;
    return {
      mode: "database",
      state: "failed",
      failedDirection: direction,
      label: FAILED_LABELS[direction],
      // The app's own typed sentence, then why it stays — no error code, no vendor.
      note: `${message} This line keeps saying that for the rest of this run, so it can never slip back to claiming that saving works.`,
    };
  }

  if (evidence.confirmed) {
    return { mode: "database", state: "confirmed", label: CONFIRMED_LABEL, note: CONFIRMED_NOTE };
  }

  return { mode: "database", state: "unverified", label: UNVERIFIED_LABEL, note: UNVERIFIED_NOTE };
}

const FAILED_WRITE =
  "We couldn't save that to the database just now, so nothing was recorded. Please try again in a minute.";
const FAILED_READ =
  "We couldn't read the inbox just now. Nothing has been lost — please try again in a minute.";

/* -------------------------------------------------------------------------- */
/* In-memory backend (preview)                                                 */
/* -------------------------------------------------------------------------- */

type MemoryEmail = Omit<StoredEmail, "draft">;

/** In preview mode the link back to the date is kept on the event itself. */
type MemoryEvent = CalendarEvent & { candidateId: string | null };

type MemoryBackend = {
  emails: MemoryEmail[];
  drafts: Map<string, DraftRecord>;
  events: MemoryEvent[];
  seq: number;
  eventSeq: number;
};

/** In preview mode, which of an email's dates already have an event. */
function withAddedFlags(
  dates: DateCandidate[],
  store: MemoryBackend,
  emailId: string,
): DateCandidate[] {
  const added = store.events
    .filter((event) => event.emailId === emailId && event.candidateId)
    .map((event) => event.candidateId as string);
  return dates.map((date) => ({ ...date, added: added.includes(date.id) }));
}

const memoryStore = (): MemoryBackend => {
  const globalKey = "__doppelPreviewInbox" as const;
  const host = globalThis as unknown as Record<string, MemoryBackend | undefined>;
  if (!host[globalKey]) {
    host[globalKey] = { emails: [], drafts: new Map(), events: [], seq: 0, eventSeq: 0 };
  }
  return host[globalKey];
};

/** Row shape we insert — everything already computed and stringified. */
export type NewEmailRow = {
  source: string;
  fromName: string | null;
  fromEmail: string | null;
  fromLabel: string;
  subject: string;
  snippet: string;
  body: string;
  raw: string;
  receivedAt: string;
  score: number;
  reason: string;
  needsReply: boolean;
  aiMode: string;
  aiProvider: string;
  datesJson: string;
};

export type NewEventRow = {
  emailId: string | null;
  candidateId: string | null;
  title: string;
  startsAt: string;
  allDay: boolean;
  reminderAt: string | null;
  reminderLabel: string | null;
  reminderMinutes: number | null;
  sourceLabel: string;
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const iso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  const text = String(value ?? "");
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? text : new Date(parsed).toISOString();
};

const str = (value: unknown, fallback = ""): string =>
  value === null || value === undefined ? fallback : String(value);

const bool = (value: unknown): boolean => value === true || value === "t" || value === "true";

function parseDates(datesJson: unknown): DateCandidate[] {
  try {
    const raw = typeof datesJson === "string" ? JSON.parse(datesJson) : datesJson;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is DateCandidate => Boolean(item && typeof item === "object"));
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Failure logging                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The line the server logs when a query fails: the app's own typed sentence for
 * that direction — the same words the visitor is shown — followed by the engine's
 * message in short.
 *
 * It is a **string, never an `Error`**. Printing an error object makes the runtime
 * serialize its stack, the source line it was thrown from and every property on it
 * (error code, statement, parameters); that, not the message, is what turned one
 * failed query into a bundle dump. Nothing on this line is user-facing copy.
 *
 * The sanitizing itself lives in `~/lib/log-line`, shared with every other failure
 * path in the app, so there is one implementation rather than a copy per module.
 */
function failedQueryLine(direction: QueryDirection, err: unknown): string {
  const sentence = direction === "read" ? FAILED_READ : FAILED_WRITE;
  return failureLogLine(sentence, err, "query engine");
}

/**
 * Wrap an executor so every query through it becomes evidence — the only place
 * the storage line learns anything.
 *
 * A failure is recorded with the app's own typed sentence for that direction
 * before the error is re-thrown, so the caller's existing `catch` still decides
 * what the visitor is told and the status can never disagree with it. Nothing here
 * swallows an error, adds a query, or opens a connection of its own.
 *
 * Logging stays with the caller, which names the operation that failed; what it
 * logs is `failedQueryLine(...)` above — a short string, so no error object, stack
 * or module source can reach the server log.
 */
function observed(exec: QueryExecutor, direction: QueryDirection): QueryExecutor {
  return async (strings, ...values) => {
    try {
      const rows = await exec(strings, ...values);
      noteStorageQuerySucceeded();
      return rows;
    } catch (err) {
      noteStorageQueryFailed(direction, direction === "read" ? FAILED_READ : FAILED_WRITE);
      throw err;
    }
  };
}

function backendFor(
  exec?: QueryExecutor,
  direction: QueryDirection = "write",
): { kind: "sql"; db: QueryExecutor } | { kind: "memory" } {
  if (exec) return { kind: "sql", db: observed(exec, direction) };
  if (process.env.DATABASE_URL) {
    try {
      return { kind: "sql", db: observed(sql() as unknown as QueryExecutor, direction) };
    } catch (err) {
      // No usable handle for that address: every call below runs against memory, so
      // nothing is saved. Record it as a failure rather than letting the line sit on
      // "configured" while the app quietly stores nothing.
      console.error("[inbox] could not open the database handle:", failedQueryLine(direction, err));
      noteStorageQueryFailed(direction, direction === "read" ? FAILED_READ : FAILED_WRITE);
    }
  }
  return { kind: "memory" };
}

const ok = <T>(value: T): StoreResult<T> => ({ ok: true, value, storage: storageStatus() });
const fail = <T>(message: string): StoreResult<T> => ({ ok: false, message, storage: storageStatus() });

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

let schemaReady = false;

export async function ensureSchema(db: QueryExecutor): Promise<void> {
  if (schemaReady) return;
  await db`
    create table if not exists emails (
      id bigserial primary key,
      source text not null default 'paste',
      from_name text,
      from_email text,
      from_label text not null default '',
      subject text not null default '(no subject)',
      snippet text not null default '',
      body text not null default '',
      raw text,
      received_at timestamptz not null default now(),
      importance_score integer not null default 0,
      importance_reason text not null default '',
      needs_reply boolean not null default false,
      ai_mode text not null default 'heuristic',
      ai_provider text not null default 'heuristic',
      dates_json text not null default '[]',
      created_at timestamptz not null default now()
    )
  `;
  await db`
    create table if not exists drafts (
      id bigserial primary key,
      email_id bigint not null references emails(id) on delete cascade,
      body text not null default '',
      mode text not null default 'heuristic',
      provider text not null default 'heuristic',
      label text not null default '',
      note text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await db`
    create table if not exists calendar_events (
      id bigserial primary key,
      email_id bigint references emails(id) on delete set null,
      candidate_id text,
      title text not null,
      starts_at timestamptz not null,
      all_day boolean not null default false,
      reminder_at timestamptz,
      reminder_label text,
      reminder_minutes integer,
      source_label text not null default '',
      created_at timestamptz not null default now()
    )
  `;
  schemaReady = true;
}

/* -------------------------------------------------------------------------- */
/* Emails                                                                      */
/* -------------------------------------------------------------------------- */

function rowToEmail(row: Row, addedIds: Set<string>): StoredEmail {
  const dates = parseDates(row.dates_json).map((d) => ({
    ...d,
    added: addedIds.has(d.id),
  }));
  const draftBody = row.draft_body === null || row.draft_body === undefined ? null : str(row.draft_body);
  const draft: DraftRecord | null = draftBody
    ? {
        body: draftBody,
        mode: str(row.draft_mode, "heuristic") === "model" ? "model" : "heuristic",
        provider: str(row.draft_provider, "heuristic"),
        label: str(row.draft_label, ""),
        note: row.draft_note ? str(row.draft_note) : undefined,
        updatedAt: iso(row.draft_updated_at ?? row.created_at),
      }
    : null;

  const receivedAt = iso(row.received_at);
  return {
    id: str(row.id),
    source: (str(row.source, "paste") as StoredEmail["source"]) ?? "paste",
    fromName: row.from_name ? str(row.from_name) : null,
    fromEmail: row.from_email ? str(row.from_email) : null,
    fromLabel: str(row.from_label, "Unknown sender"),
    subject: str(row.subject, "(no subject)"),
    snippet: str(row.snippet),
    body: str(row.body),
    receivedAt,
    receivedAtLabel: formatWhen(receivedAt, false),
    importance: {
      score: Number(row.importance_score ?? 0),
      reason: str(row.importance_reason),
      needsReply: bool(row.needs_reply),
    } satisfies Importance,
    aiMode: str(row.ai_mode, "heuristic") === "model" ? "model" : "heuristic",
    aiProvider: str(row.ai_provider, "heuristic"),
    dates,
    draft,
  };
}

async function addedCandidateIds(db: QueryExecutor, emailId: string): Promise<Set<string>> {
  try {
    const rows = await db`
      select candidate_id from calendar_events
      where email_id = ${Number(emailId)} and candidate_id is not null
    `;
    return new Set(rows.map((r) => str(r.candidate_id)).filter(Boolean));
  } catch (err) {
    console.error("[inbox] could not read event links:", failedQueryLine("read", err));
    return new Set();
  }
}

export async function insertEmail(
  row: NewEmailRow,
  exec?: QueryExecutor,
): Promise<StoreResult<{ id: string }>> {
  const backend = backendFor(exec, "write");
  if (backend.kind === "memory") {
    const store = memoryStore();
    store.seq += 1;
    const id = String(store.seq);
    store.emails.push({
      id,
      source: row.source as StoredEmail["source"],
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      fromLabel: row.fromLabel,
      subject: row.subject,
      snippet: row.snippet,
      body: row.body,
      receivedAt: row.receivedAt,
      receivedAtLabel: formatWhen(row.receivedAt, false),
      importance: { score: row.score, reason: row.reason, needsReply: row.needsReply },
      aiMode: row.aiMode === "model" ? "model" : "heuristic",
      aiProvider: row.aiProvider,
      dates: parseDates(row.datesJson),
    });
    return { ...ok({ id }), storedIn: "memory" as const };
  }

  try {
    await ensureSchema(backend.db);
    const inserted = await backend.db`
      insert into emails (
        source, from_name, from_email, from_label, subject, snippet, body, raw,
        received_at, importance_score, importance_reason, needs_reply, ai_mode,
        ai_provider, dates_json
      ) values (
        ${row.source}, ${row.fromName}, ${row.fromEmail}, ${row.fromLabel}, ${row.subject},
        ${row.snippet}, ${row.body}, ${row.raw}, ${row.receivedAt}::timestamptz, ${row.score},
        ${row.reason}, ${row.needsReply}, ${row.aiMode}, ${row.aiProvider}, ${row.datesJson}
      )
      returning id
    `;
    if (inserted.length === 0) return fail(FAILED_WRITE);
    return { ...ok({ id: str(inserted[0].id) }), storedIn: "database" as const };
  } catch (err) {
    console.error("[inbox] insertEmail failed:", failedQueryLine("write", err));
    return fail(FAILED_WRITE);
  }
}

export async function listEmails(exec?: QueryExecutor): Promise<StoreResult<StoredEmail[]>> {
  const backend = backendFor(exec, "read");
  if (backend.kind === "memory") {
    const store = memoryStore();
    const emails = [...store.emails]
      .sort((a, b) => b.importance.score - a.importance.score || b.receivedAt.localeCompare(a.receivedAt))
      .map((email) => ({
        ...email,
        dates: withAddedFlags(email.dates, store, email.id),
        draft: store.drafts.get(email.id) ?? null,
      }));
    return ok(emails);
  }

  try {
    await ensureSchema(backend.db);
    const rows = await backend.db`
      select e.*, d.body as draft_body, d.mode as draft_mode, d.provider as draft_provider,
             d.label as draft_label, d.note as draft_note, d.updated_at as draft_updated_at
      from emails e
      left join lateral (
        select * from drafts dd where dd.email_id = e.id order by dd.id desc limit 1
      ) d on true
      order by e.importance_score desc, e.received_at desc
      limit 200
    `;
    const links = await backend.db`
      select email_id, candidate_id from calendar_events where candidate_id is not null
    `;
    const byEmail = new Map<string, Set<string>>();
    for (const link of links) {
      const key = str(link.email_id);
      const set = byEmail.get(key) ?? new Set<string>();
      set.add(str(link.candidate_id));
      byEmail.set(key, set);
    }
    return ok(rows.map((row) => rowToEmail(row, byEmail.get(str(row.id)) ?? new Set())));
  } catch (err) {
    console.error("[inbox] listEmails failed:", failedQueryLine("read", err));
    return fail(FAILED_READ);
  }
}

export async function getEmail(id: string, exec?: QueryExecutor): Promise<StoreResult<StoredEmail | null>> {
  const backend = backendFor(exec, "read");
  if (backend.kind === "memory") {
    const store = memoryStore();
    const found = store.emails.find((email) => email.id === id);
    if (!found) return ok(null);
    return ok({
      ...found,
      dates: withAddedFlags(found.dates, store, found.id),
      draft: store.drafts.get(id) ?? null,
    });
  }

  try {
    await ensureSchema(backend.db);
    const rows = await backend.db`
      select e.*, d.body as draft_body, d.mode as draft_mode, d.provider as draft_provider,
             d.label as draft_label, d.note as draft_note, d.updated_at as draft_updated_at
      from emails e
      left join lateral (
        select * from drafts dd where dd.email_id = e.id order by dd.id desc limit 1
      ) d on true
      where e.id = ${Number(id)}
      limit 1
    `;
    if (rows.length === 0) return ok(null);
    return ok(rowToEmail(rows[0], await addedCandidateIds(backend.db, id)));
  } catch (err) {
    console.error("[inbox] getEmail failed:", failedQueryLine("read", err));
    return fail(FAILED_READ);
  }
}

/* -------------------------------------------------------------------------- */
/* Drafts                                                                      */
/* -------------------------------------------------------------------------- */

export async function saveDraft(
  input: { emailId: string; body: string; mode: string; provider: string; label: string; note?: string },
  exec?: QueryExecutor,
): Promise<StoreResult<DraftRecord>> {
  const backend = backendFor(exec, "write");
  const record: DraftRecord = {
    body: input.body,
    mode: input.mode === "model" ? "model" : "heuristic",
    provider: input.provider,
    label: input.label,
    note: input.note,
    updatedAt: new Date().toISOString(),
  };

  if (backend.kind === "memory") {
    const store = memoryStore();
    if (!store.emails.some((email) => email.id === input.emailId)) return fail("That email isn't here any more.");
    store.drafts.set(input.emailId, record);
    return ok(record);
  }

  try {
    await ensureSchema(backend.db);
    const existing = await backend.db`
      select id from drafts where email_id = ${Number(input.emailId)} order by id desc limit 1
    `;
    if (existing.length > 0) {
      await backend.db`
        update drafts
        set body = ${input.body}, mode = ${input.mode}, provider = ${input.provider},
            label = ${input.label}, note = ${input.note ?? null}, updated_at = now()
        where id = ${Number(existing[0].id)}
      `;
    } else {
      await backend.db`
        insert into drafts (email_id, body, mode, provider, label, note)
        values (${Number(input.emailId)}, ${input.body}, ${input.mode}, ${input.provider}, ${input.label}, ${input.note ?? null})
      `;
    }
    return ok(record);
  } catch (err) {
    console.error("[inbox] saveDraft failed:", failedQueryLine("write", err));
    return fail(FAILED_WRITE);
  }
}

/* -------------------------------------------------------------------------- */
/* Calendar events                                                             */
/* -------------------------------------------------------------------------- */

function rowToEvent(row: Row): CalendarEvent {
  const startsAt = iso(row.starts_at);
  return {
    id: str(row.id),
    emailId: row.email_id === null || row.email_id === undefined ? null : str(row.email_id),
    title: str(row.title, "Untitled"),
    startsAt,
    startsAtLabel: formatWhen(startsAt, bool(row.all_day)),
    allDay: bool(row.all_day),
    reminderAt: row.reminder_at ? iso(row.reminder_at) : null,
    reminderLabel: row.reminder_label ? str(row.reminder_label) : null,
    sourceLabel: str(row.source_label, "Added by hand"),
    createdAt: iso(row.created_at),
  };
}

export async function insertCalendarEvent(
  row: NewEventRow,
  exec?: QueryExecutor,
): Promise<StoreResult<CalendarEvent>> {
  const backend = backendFor(exec, "write");
  if (backend.kind === "memory") {
    const store = memoryStore();
    store.eventSeq += 1;
    const event: MemoryEvent = {
      id: String(store.eventSeq),
      emailId: row.emailId,
      title: row.title,
      startsAt: row.startsAt,
      startsAtLabel: formatWhen(row.startsAt, row.allDay),
      allDay: row.allDay,
      reminderAt: row.reminderAt,
      reminderLabel: row.reminderLabel,
      sourceLabel: row.sourceLabel,
      createdAt: new Date().toISOString(),
      candidateId: row.candidateId,
    };
    store.events.push(event);
    return ok(event);
  }

  try {
    await ensureSchema(backend.db);
    const inserted = await backend.db`
      insert into calendar_events (
        email_id, candidate_id, title, starts_at, all_day, reminder_at, reminder_label,
        reminder_minutes, source_label
      ) values (
        ${row.emailId === null ? null : Number(row.emailId)}, ${row.candidateId}, ${row.title},
        ${row.startsAt}::timestamptz, ${row.allDay},
        ${row.reminderAt}::timestamptz, ${row.reminderLabel}, ${row.reminderMinutes}, ${row.sourceLabel}
      )
      returning *
    `;
    if (inserted.length === 0) return fail(FAILED_WRITE);
    return ok(rowToEvent(inserted[0]));
  } catch (err) {
    console.error("[inbox] insertCalendarEvent failed:", failedQueryLine("write", err));
    return fail(FAILED_WRITE);
  }
}

export async function listCalendarEvents(exec?: QueryExecutor): Promise<StoreResult<CalendarEvent[]>> {
  const backend = backendFor(exec, "read");
  if (backend.kind === "memory") {
    const store = memoryStore();
    const events = [...store.events]
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map(({ candidateId: _candidateId, ...event }) => event);
    return ok(events);
  }

  try {
    await ensureSchema(backend.db);
    const rows = await backend.db`
      select * from calendar_events order by starts_at asc limit 200
    `;
    return ok(rows.map(rowToEvent));
  } catch (err) {
    console.error("[inbox] listCalendarEvents failed:", failedQueryLine("read", err));
    return fail(FAILED_READ);
  }
}

export async function deleteCalendarEvent(id: string, exec?: QueryExecutor): Promise<StoreResult<boolean>> {
  const backend = backendFor(exec, "write");
  if (backend.kind === "memory") {
    const store = memoryStore();
    const before = store.events.length;
    store.events = store.events.filter((event) => event.id !== id);
    return ok(store.events.length < before);
  }

  try {
    await ensureSchema(backend.db);
    const deleted = await backend.db`
      delete from calendar_events where id = ${Number(id)} returning id
    `;
    return ok(deleted.length > 0);
  } catch (err) {
    console.error("[inbox] deleteCalendarEvent failed:", failedQueryLine("write", err));
    return fail(FAILED_WRITE);
  }
}

// touch: preview store resets when this module graph reloads
