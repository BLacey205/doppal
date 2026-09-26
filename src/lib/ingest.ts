/**
 * The one funnel every message goes through.
 *
 * Paste box, `POST /api/inbound-email`, the sample inbox — they all call
 * `ingestEmail()`. That is the seam a forwarding address or a Gmail/Outlook OAuth
 * sync plugs into later: build the same input shape and the rest of the pipeline
 * (rank → extract → draft → store) is already done.
 *
 * Order matters: dates are found first so the importance score can count them.
 *
 * Nothing here sends anything. Drafts only.
 */
import type { AiStatus, StoredEmail, StorageStatus } from "~/lib/inbox-types";
import { aiStatus, draftReply, extractDates, rankImportance, type EmailForAi } from "~/lib/ai";
import { fromStructured, parseRawEmail, snippetOf } from "~/lib/email-parse";
import {
  insertCalendarEvent,
  insertEmail,
  saveDraft,
  storageStatus,
  type QueryExecutor,
} from "~/lib/inbox-server";

export type IngestSource = "paste" | "api" | "sample";

export type IngestInput = {
  source: IngestSource;
  /** Raw message text (headers optional). Used by the paste box and samples. */
  raw?: string;
  /** Structured fields — the shape a webhook or an OAuth sync would send. */
  from?: string;
  subject?: string;
  text?: string;
  receivedAt?: string;
  /**
   * Set by a provider that could read the envelope but not the body (an
   * attachment-only forward): the honest reason there is no readable text.
   * Never invents content — it only explains an absence.
   */
  bodyNote?: string;
};

export type IngestResult =
  | {
      ok: true;
      email: StoredEmail;
      storage: StorageStatus;
      ai: AiStatus;
      /**
       * Where the row actually landed — "database" only when a real insert came
       * back. Callers that must never claim or remember more than happened (the
       * provider webhook's duplicate suppression) read this, not `storage` alone:
       * a memory fallback while a database is configured reports a database-y
       * status but landed in memory all the same.
       */
      storedIn: "database" | "memory";
    }
  | {
      ok: false;
      /**
       * Why the funnel refused: "not_a_message" is the caller's payload (a 400
       * problem); "store_failed" is our store refusing or falling back (a 503
       * problem, retryable). The two used to share one answer, which let a
       * refused store be reported as if the payload were at fault.
       */
      reason: "not_a_message" | "store_failed";
      message: string;
      storage: StorageStatus;
    };

const EMPTY_MESSAGE =
  "That doesn't look like a message yet — paste the text of the email (the From and Subject lines help too) and try again.";

/**
 * The body stored for a real message (a sender or a subject answered for it)
 * that arrived with no readable text. Bracketed and labelled `Doppel note:` so
 * it can never be mistaken for words the sender wrote — in the inbox list, in
 * the message view, or in an alert that quotes it.
 */
function noReadableTextBody(note?: string): string {
  const detail = (note ?? "").trim();
  return detail
    ? `[Doppel note: this message had no readable text — ${detail}.]`
    : "[Doppel note: this message had no readable text.]";
}

export async function ingestEmail(
  input: IngestInput,
  exec?: QueryExecutor,
): Promise<IngestResult> {
  const status = storageStatus();
  const ai = await aiStatus();

  const parsed = input.raw
    ? parseRawEmail(input.raw, input.receivedAt)
    : fromStructured({
        from: input.from,
        subject: input.subject,
        text: input.text,
        receivedAt: input.receivedAt,
      });

  // Refuse only a payload that is nothing at all: no body, no subject, no
  // sender. A forwarded message that names a sender or a subject is real mail
  // even when its body couldn't be read (Resend's documented response can
  // carry `"text": null` with no HTML either) — refusing it would answer the
  // provider's webhook with a failure code for mail that has nowhere else to
  // go, so it is stored with the absence said plainly instead.
  const emptyBody = !parsed.body.trim();
  const hasSender = Boolean(parsed.fromEmail || parsed.fromName);
  if (emptyBody && (!parsed.subject || parsed.subject === "(no subject)") && !hasSender) {
    return { ok: false, reason: "not_a_message", message: EMPTY_MESSAGE, storage: status };
  }

  // What the owner sees for a body-less message is the honest note, not an
  // empty section and not invented text.
  const bodyForStore = emptyBody ? noReadableTextBody(input.bodyNote) : parsed.body;

  const forAi: EmailForAi = {
    fromLabel: parsed.fromLabel,
    fromEmail: parsed.fromEmail,
    subject: parsed.subject,
    // Triage reads the truth — no sender words exist — and the draft learns
    // about the absence through bodyNote.
    body: emptyBody ? "" : parsed.body,
    receivedAt: parsed.receivedAt,
    bodyNote: emptyBody ? (input.bodyNote ?? "no readable text arrived with it") : undefined,
  };

  // 1. dates (so the score can count them)  2. importance  3. draft
  const dates = await extractDates(forAi);
  const importance = await rankImportance(forAi, dates.value.length);
  const draft = await draftReply(forAi, {
    needsReply: importance.value.needsReply,
    dates: dates.value,
  });

  const storedDates = dates.value.map((candidate) => ({
    ...candidate,
    mode: dates.mode,
    provider: dates.provider,
  }));

  const inserted = await insertEmail(
    {
      source: input.source,
      fromName: parsed.fromName,
      fromEmail: parsed.fromEmail,
      fromLabel: parsed.fromLabel,
      subject: parsed.subject,
      snippet: snippetOf(bodyForStore),
      body: bodyForStore,
      raw: input.raw ?? JSON.stringify({ from: input.from, subject: input.subject }),
      receivedAt: parsed.receivedAt,
      score: importance.value.score,
      reason: importance.value.reason,
      needsReply: importance.value.needsReply,
      aiMode: importance.mode,
      aiProvider: importance.provider,
      datesJson: JSON.stringify(storedDates),
    },
    exec,
  );

  if (!inserted.ok) {
    return { ok: false, reason: "store_failed", message: inserted.message, storage: inserted.storage };
  }

  const savedDraft = await saveDraft(
    {
      emailId: inserted.value.id,
      body: draft.value.body,
      mode: draft.mode,
      provider: draft.provider,
      label: draft.label,
      note: draft.note,
    },
    exec,
  );
  if (!savedDraft.ok) console.error("[ingest] draft could not be stored:", savedDraft.message);

  const email: StoredEmail = {
    id: inserted.value.id,
    source: input.source,
    fromName: parsed.fromName,
    fromEmail: parsed.fromEmail,
    fromLabel: parsed.fromLabel,
    subject: parsed.subject,
    snippet: snippetOf(bodyForStore),
    body: bodyForStore,
    receivedAt: parsed.receivedAt,
    receivedAtLabel: formatReceived(parsed.receivedAt),
    importance: importance.value,
    aiMode: importance.mode,
    aiProvider: importance.provider,
    dates: storedDates,
    draft: savedDraft.ok ? savedDraft.value : null,
  };

  return {
    ok: true,
    email,
    storage: inserted.storage,
    ai,
    // A store that ever forgets to say where it landed is treated as memory —
    // the mail-safe direction: never suppress a retry that might be needed.
    storedIn: inserted.storedIn ?? "memory",
  };
}

/**
 * Put one of the dates we found into the calendar, with its reminder.
 * Idempotent per (email, date) so a double click doesn't duplicate the event.
 */
export async function addDateToCalendar(
  email: StoredEmail,
  candidateId: string,
  exec?: QueryExecutor,
): Promise<{ ok: true; title: string; reminder: string } | { ok: false; message: string }> {
  const candidate = email.dates.find((date) => date.id === candidateId);
  if (!candidate) return { ok: false, message: "We couldn't find that date any more — reload the email." };
  if (candidate.added) return { ok: true, title: candidate.label, reminder: candidate.reminderLabel };

  const title = `${email.subject === "(no subject)" ? "Email" : email.subject} — ${candidate.label}`;
  const result = await insertCalendarEvent(
    {
      emailId: email.id,
      candidateId: candidate.id,
      title: title.slice(0, 200),
      startsAt: candidate.startsAt,
      allDay: candidate.allDay,
      reminderAt: candidate.reminderAt,
      reminderLabel: candidate.reminderLabel,
      reminderMinutes: candidate.reminderMinutes,
      sourceLabel: `${email.fromLabel} · ${email.subject}`.slice(0, 200),
    },
    exec,
  );

  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, title, reminder: candidate.reminderLabel };
}

function formatReceived(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "Unknown";
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(ms))} UTC`;
}
