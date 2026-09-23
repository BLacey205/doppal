/**
 * The request half of the inbound seam — the part that is testable without a server.
 *
 * `handleInboundEmailPost()` is the whole of `POST /api/inbound-email`: gate the
 * caller, read a capped body, hand the payload to the same `ingestEmail()` funnel as
 * the paste box, and answer with typed JSON. `src/routes/api/inbound-email.ts` is a
 * thin wrapper around it, and the provider webhook reuses `ingestToResponse()`.
 *
 * Order of checks, and why:
 *   1. rate limit  — cheapest flood guard, applies even to unauthenticated callers
 *   2. token auth  — fail closed; no configured token means nobody gets in
 *   3. size cap    — 256 KB, refused before the body is buffered
 *   4. JSON parse  — a clear 400, never a 500
 *
 * Nothing here sends mail. Drafts only.
 */
import type { StoredEmail } from "~/lib/inbox-types";
import {
  authorizeInboundRequest,
  failureResponse,
  inboundIntakeConfigured,
  intakePreflight,
  jsonResponse,
  type GuardFailure,
} from "~/lib/inbound-guard";
import { failureLogLine } from "~/lib/log-line";

type InboundFields = {
  from?: string;
  subject?: string;
  text?: string;
  receivedAt?: string;
  /** Set when the message came from a provider webhook, so the answer says which. */
  provider?: string;
};

/** A fire-and-forget notifier. Injectable so the self-test never needs a socket. */
export type AlertNotifier = (email: StoredEmail) => unknown;

export type IngestOptions = {
  status?: number;
  extra?: Record<string, unknown>;
  /** Override the owner alert (tests). Defaults to `~/lib/notify`. */
  notify?: AlertNotifier;
};

const defaultNotifier: AlertNotifier = (email) =>
  import("~/lib/notify").then((module) => module.notifyImportantEmailInBackground(email));

/**
 * Tell the owner, if this message crossed the bar — **after** the caller's answer is
 * settled, and without ever letting alerting affect it. Errors are swallowed on
 * purpose: a dead Knock or a missing key must not change an ingest result or a status.
 */
function queueAlert(email: StoredEmail, injected?: AlertNotifier): void {
  try {
    void Promise.resolve((injected ?? defaultNotifier)(email)).catch(() => {});
  } catch (err) {
    console.warn("[notify] alerting failed, ignored:", err instanceof Error ? err.message : "unknown");
  }
}

/**
 * The words the caller gets when the funnel itself failed — the same sentence is
 * logged (under `~/lib/log-line`, as a string, never the error object) and returned,
 * so the log line and the response can never drift apart.
 */
const INGEST_FAILED_MESSAGE =
  "We couldn't process that message just now. Nothing was stored — please try again.";

/** Run one message through the funnel and turn the outcome into the route's JSON. */
export async function ingestToResponse(
  input: InboundFields,
  options: IngestOptions = {},
): Promise<Response> {
  const text = (value: unknown) => (typeof value === "string" ? value : "");

  try {
    const { ingestEmail } = await import("~/lib/ingest");
    const result = await ingestEmail({
      source: "api",
      from: text(input.from),
      subject: text(input.subject),
      text: text(input.text),
      receivedAt: text(input.receivedAt) || undefined,
    });

    if (!result.ok) return jsonResponse({ ok: false, error: "not_a_message", message: result.message }, 400);

    const { email, storage } = result;
    // `confirmed` is the only state that follows a query which really came back, so it
    // is the only one that may say this message was stored. A connection string being
    // set is not evidence — see `~/lib/storage-evidence`.
    const stored = storage.state === "confirmed";
    const body = {
      ok: true,
      provider: input.provider ?? "api",
      storage: storage.mode,
      stored,
      email: {
        id: email.id,
        from: email.fromLabel,
        subject: email.subject,
        receivedAt: email.receivedAt,
        importance: email.importance,
        aiMode: email.aiMode,
        aiProvider: email.aiProvider,
        dates: email.dates.map((date) => ({
          label: date.label,
          startsAt: date.startsAt,
          allDay: date.allDay,
          reminderAt: date.reminderAt,
          reminderLabel: date.reminderLabel,
        })),
        draft: email.draft
          ? { mode: email.draft.mode, provider: email.draft.provider, body: email.draft.body }
          : null,
      },
      note: stored
        ? "Stored. The draft is waiting in the app — Doppel does not send anything."
        : storage.state === "preview"
          ? "Analysed, but not persisted: no database is connected, so this message lives in memory for this session."
          : "Analysed, but persistence is not confirmed on this deployment, so treat this message as living in memory for this session only.",
      ...(options.extra ?? {}),
    };

    // The owner alert is fired only once the answer is settled. It is not awaited, so
    // it can never slow this response down, and every failure of it is contained.
    queueAlert(email, options.notify);

    return jsonResponse(body, options.status ?? 201);
  } catch (err) {
    console.error(failureLogLine(INGEST_FAILED_MESSAGE, err, "ingest"));
    return jsonResponse(
      {
        ok: false,
        error: "ingest_failed",
        message: INGEST_FAILED_MESSAGE,
      },
      503,
    );
  }
}

/** `POST /api/inbound-email` — the plain JSON seam, guarded by the shared token. */
export async function handleInboundEmailPost(
  request: Request,
  options: IngestOptions = {},
): Promise<Response> {
  const preflight = await intakePreflight(request);
  if (!preflight.ok) return failureResponse(preflight);

  const authorised = authorizeInboundRequest(request);
  if (!authorised.ok) return failureResponse(authorised as GuardFailure);

  let payload: unknown;
  try {
    payload = JSON.parse(preflight.rawBody);
  } catch {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_json",
        message: "Send JSON: { from, subject, text, receivedAt }.",
      },
      400,
    );
  }

  const raw = (payload ?? {}) as Record<string, unknown>;
  return ingestToResponse(
    {
      from: typeof raw.from === "string" ? raw.from : "",
      subject: typeof raw.subject === "string" ? raw.subject : "",
      text: typeof raw.text === "string" ? raw.text : "",
      receivedAt: typeof raw.receivedAt === "string" ? raw.receivedAt : undefined,
    },
    options,
  );
}

/** `GET /api/inbound-email` — a read-only explanation, always a 405. Says whether intake is armed. */
export function handleInboundEmailGet(): Response {
  return jsonResponse(
    {
      ok: false,
      error: "method_not_allowed",
      intakeConfigured: inboundIntakeConfigured(),
      message:
        "Post to this route to add a message. Body: { from, subject, text, receivedAt }. Nothing is ever sent from here.",
    },
    405,
  );
}
