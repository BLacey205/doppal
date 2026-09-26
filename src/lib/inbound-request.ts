/**
 * The request half of the inbound seam — the part that is testable without a server.
 *
 * `handleInboundEmailPost()` is the whole of `POST /api/inbound-email`: gate the
 * caller, read a capped body, hand the payload to the same `ingestEmail()` funnel as
 * the paste box, and answer with typed JSON. `src/routes/api/inbound-email.ts` is a
 * thin wrapper around it, and the provider webhook reuses `ingestToOutcome()`
 * so its duplicate suppression can act on what actually happened.
 *
 * Order of checks, and why:
 *   1. rate limit  — cheapest flood guard, applies even to unauthenticated callers
 *   2. token auth  — fail closed; no configured token means nobody gets in
 *   3. size cap    — 256 KB, refused before the body is buffered
 *   4. JSON parse  — a clear 400, never a 500
 *
 * Nothing here sends mail. Drafts only.
 */
import type { StoredEmail, StorageStatus } from "~/lib/inbox-types";
import type { QueryExecutor } from "~/lib/inbox-server";
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
  /** Honest reason there is no readable body (provider path only). */
  bodyNote?: string;
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
  /**
   * Inject a query executor (tests). Production passes nothing and the funnel
   * uses its real store; the option exists only so the route logic can be
   * exercised hermetically, including a store that refuses.
   */
  exec?: QueryExecutor;
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

/**
 * What one ingest actually did, made explicit for callers that must act on the
 * outcome. `ingestToResponse()` used to be the whole seam: it returned only a
 * Response, so a caller could not tell a real store from a refused one or from
 * the in-memory preview fallback without parsing its own JSON — and the provider
 * webhook's duplicate suppression had to guess, which is how a message id came
 * to be remembered before (and regardless of whether) the message was stored.
 */
export type IngestOutcome = {
  /** The answer for the caller, worded exactly as `ingestToResponse` words it. */
  response: Response;
  /** True only when the funnel's store step succeeded and a message exists. */
  ingested: boolean;
  /**
   * Where the row landed: "database" only when a real insert came back;
   * "memory" for honest preview or for a fallback after the store refused;
   * null when nothing was stored at all. The fact `storage.state` cannot
   * carry — a memory fallback while a database is configured reports a
   * database-y status — lives here instead.
   */
  storedIn: "database" | "memory" | null;
  /** What the storage line said at the moment of the store. */
  storageState: StorageStatus["state"] | null;
};

/** Run one message through the funnel and return both the answer and the facts. */
export async function ingestToOutcome(
  input: InboundFields,
  options: IngestOptions = {},
): Promise<IngestOutcome> {
  const text = (value: unknown) => (typeof value === "string" ? value : "");

  try {
    const { ingestEmail } = await import("~/lib/ingest");
    const result = await ingestEmail(
      {
        source: "api",
        from: text(input.from),
        subject: text(input.subject),
        text: text(input.text),
        receivedAt: text(input.receivedAt) || undefined,
        bodyNote: text(input.bodyNote) || undefined,
      },
      options.exec,
    );

    if (!result.ok) {
      // Two refusals that are not the same thing, answered differently on
      // purpose: a payload that isn't a message is the caller's problem (400);
      // a store that refused or fell back is ours (503), and the honest answer
      // is the non-2xx a provider will retry. Neither stored anything, so
      // neither reports stored — and neither may be treated as ingested.
      const response =
        result.reason === "store_failed"
          ? jsonResponse(
              { ok: false, error: "store_failed", stored: false, message: result.message },
              503,
            )
          : jsonResponse({ ok: false, error: "not_a_message", message: result.message }, 400);
      return { response, ingested: false, storedIn: null, storageState: result.storage.state };
    }

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

    return {
      response: jsonResponse(body, options.status ?? 201),
      ingested: true,
      storedIn: result.storedIn,
      storageState: storage.state,
    };
  } catch (err) {
    console.error(failureLogLine(INGEST_FAILED_MESSAGE, err, "ingest"));
    return {
      response: jsonResponse(
        {
          ok: false,
          error: "ingest_failed",
          message: INGEST_FAILED_MESSAGE,
        },
        503,
      ),
      ingested: false,
      storedIn: null,
      storageState: null,
    };
  }
}

/** The response-only view of `ingestToOutcome` — what the plain JSON route needs. */
export async function ingestToResponse(
  input: InboundFields,
  options: IngestOptions = {},
): Promise<Response> {
  return (await ingestToOutcome(input, options)).response;
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
