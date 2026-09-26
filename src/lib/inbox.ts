/**
 * The client-callable server functions behind /app.
 *
 * Same shape as the waitlist: `createServerFn({ method: "POST" })` for anything
 * that writes (so a gateway retry can't double-submit), `GET` for reads, and the
 * database/ingest modules imported *inside* the handler so no server-only code
 * is ever bundled for the browser.
 *
 * Every handler returns a plain, stringified view object and a human message —
 * never a throw — so a missing DATABASE_URL shows a sentence, not a 500.
 */
import { createServerFn } from "@tanstack/react-start";

import type { AiStatus, AlertStatus, CalendarEvent, StoredEmail, StorageStatus } from "~/lib/inbox-types";

export type InboxView = {
  ok: boolean;
  message?: string;
  emails: StoredEmail[];
  ai: AiStatus;
  storage: StorageStatus;
  /** Whether the owner gets told when important mail arrives (Knock alerting). */
  alerts: AlertStatus;
};

export type EmailView = {
  ok: boolean;
  message?: string;
  email: StoredEmail | null;
  ai: AiStatus;
  storage: StorageStatus;
  events: CalendarEvent[];
};

export type CalendarView = {
  ok: boolean;
  message?: string;
  events: CalendarEvent[];
  ai: AiStatus;
  storage: StorageStatus;
};

export type ActionResult = { ok: boolean; message: string; emailId?: string };

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/* --------------------------------- reads ---------------------------------- */

export const getInbox = createServerFn({ method: "GET" }).handler(async (): Promise<InboxView> => {
  const { listEmails, storageStatus } = await import("~/lib/inbox-server");
  const { aiStatus } = await import("~/lib/ai");
  // Server-only: reads KNOCK_API_KEY. Never imported by a component.
  const { alertStatus } = await import("~/lib/notify");
  const result = await listEmails();
  const alerts = await alertStatus();
  // Read the storage line *after* the query, never before: it is evidence-based, so
  // it has to reflect what this read just did, not what the environment claims.
  const storage = storageStatus();
  if (!result.ok) {
    return { ok: false, message: result.message, emails: [], ai: await aiStatus(), storage, alerts };
  }
  return { ok: true, emails: result.value, ai: await aiStatus(), storage, alerts };
});

export const getEmailView = createServerFn({ method: "GET" })
  .validator((data: unknown) => ({ id: asString((data as { id?: unknown })?.id) }))
  .handler(async ({ data }): Promise<EmailView> => {
    const { getEmail, listCalendarEvents, storageStatus } = await import("~/lib/inbox-server");
    const { aiStatus } = await import("~/lib/ai");
    const ai = await aiStatus();

    if (!/^\d+$/.test(data.id)) {
      return {
        ok: false,
        message: "That email link doesn't look right.",
        email: null,
        ai,
        storage: storageStatus(),
        events: [],
      };
    }
    const result = await getEmail(data.id);
    // Evidence-based: taken after the read so it reports what the read did.
    const storage = storageStatus();
    if (!result.ok) {
      return { ok: false, message: result.message, email: null, ai, storage, events: [] };
    }
    if (!result.value) {
      return {
        ok: false,
        message: "We couldn't find that email — it may have been removed.",
        email: null,
        ai,
        storage,
        events: [],
      };
    }
    const events = await listCalendarEvents();
    const forThis = events.ok ? events.value.filter((event) => event.emailId === data.id) : [];
    return { ok: true, email: result.value, ai, storage, events: forThis };
  });

export const getCalendar = createServerFn({ method: "GET" }).handler(async (): Promise<CalendarView> => {
  const { listCalendarEvents, storageStatus } = await import("~/lib/inbox-server");
  const { aiStatus } = await import("~/lib/ai");
  const result = await listCalendarEvents();
  // Evidence-based: taken after the read so it reports what the read did.
  const storage = storageStatus();
  if (!result.ok) return { ok: false, message: result.message, events: [], ai: await aiStatus(), storage };
  return { ok: true, events: result.value, ai: await aiStatus(), storage };
});

/* -------------------------------- ingestion -------------------------------- */

export const ingestPastedEmail = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({ raw: asString((data as { raw?: unknown })?.raw) }))
  .handler(async ({ data }): Promise<ActionResult> => {
    const { ingestEmail } = await import("~/lib/ingest");
    const result = await ingestEmail({ source: "paste", raw: data.raw });
    if (!result.ok) return { ok: false, message: result.message };
    return {
      ok: true,
      message: `Added “${result.email.subject}” — ranked ${result.email.importance.score}/100.`,
      emailId: result.email.id,
    };
  });

export const loadSampleInbox = createServerFn({ method: "POST" }).handler(
  async (): Promise<ActionResult> => {
    const { ingestEmail } = await import("~/lib/ingest");
    const { listEmails } = await import("~/lib/inbox-server");
    const { buildSampleInbox } = await import("~/lib/sample-inbox");

    const existing = await listEmails();
    const have = new Set(existing.ok ? existing.value.map((email) => email.subject) : []);

    let added = 0;
    let skipped = 0;
    for (const sample of buildSampleInbox()) {
      if (have.has(sample.subject)) {
        skipped += 1;
        continue;
      }
      const result = await ingestEmail({ source: "sample", raw: sample.raw });
      if (result.ok) added += 1;
      else return { ok: false, message: result.message };
    }

    if (added === 0) {
      return { ok: true, message: `The sample inbox is already here — ${skipped} messages, nothing new added.` };
    }
    return {
      ok: true,
      message:
        skipped > 0
          ? `Added ${added} sample message${added === 1 ? "" : "s"} (${skipped} already in the inbox).`
          : `Added ${added} sample messages — ranked, dates extracted and drafted.`,
    };
  },
);

/* --------------------------------- actions --------------------------------- */

export const addToCalendar = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const raw = (data ?? {}) as Record<string, unknown>;
    return { emailId: asString(raw.emailId), candidateId: asString(raw.candidateId) };
  })
  .handler(async ({ data }): Promise<ActionResult> => {
    const { getEmail } = await import("~/lib/inbox-server");
    const { addDateToCalendar } = await import("~/lib/ingest");

    const found = await getEmail(data.emailId);
    if (!found.ok) return { ok: false, message: found.message };
    if (!found.value) return { ok: false, message: "We couldn't find that email any more." };

    const result = await addDateToCalendar(found.value, data.candidateId);
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true, message: `On the calendar: “${result.title}” — reminder ${result.reminder}.` };
  });

export const removeCalendarEvent = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({ id: asString((data as { id?: unknown })?.id) }))
  .handler(async ({ data }): Promise<ActionResult> => {
    const { deleteCalendarEvent } = await import("~/lib/inbox-server");
    if (!/^\d+$/.test(data.id)) return { ok: false, message: "That event can't be removed — bad link." };
    const result = await deleteCalendarEvent(data.id);
    if (!result.ok) return { ok: false, message: result.message };
    return {
      ok: true,
      message: result.value ? "Removed from the calendar." : "That event was already gone.",
    };
  });

export const updateDraft = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const raw = (data ?? {}) as Record<string, unknown>;
    return { emailId: asString(raw.emailId), body: asString(raw.body) };
  })
  .handler(async ({ data }): Promise<ActionResult> => {
    const { getEmail, saveDraft } = await import("~/lib/inbox-server");
    if (!data.body.trim()) return { ok: false, message: "A draft can't be empty — nothing was saved." };
    if (data.body.length > 8000) return { ok: false, message: "That draft is too long to save (8000 characters)." };

    const found = await getEmail(data.emailId);
    if (!found.ok) return { ok: false, message: found.message };
    if (!found.value) return { ok: false, message: "We couldn't find that email any more." };

    const result = await saveDraft({
      emailId: data.emailId,
      body: data.body,
      mode: found.value.draft?.mode ?? "heuristic",
      provider: found.value.draft?.provider ?? "heuristic",
      label: found.value.draft ? `${found.value.draft.label} (edited by you)` : "Edited by you",
      note: found.value.draft?.note,
    });
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true, message: "Your edit is saved." };
  });
