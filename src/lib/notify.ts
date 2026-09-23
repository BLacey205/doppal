/**
 * Owner alerting — the one place Doppel talks to a third-party service.
 *
 * Knock is **outbound only**. We POST to `POST https://api.knock.app/v1/workflows/{key}/trigger`
 * and Knock runs the owner's workflow. Nothing here receives mail, and the only
 * recipient we ever name is our own business inbox (`OWNER_ALERT_EMAIL`, default
 * `doppel-cae2e184@ctomail.io`). No reply, follow-up or proposal is ever sent from
 * here — Doppel stays drafts-only.
 *
 * Rules this module keeps, because the rest of the app depends on them:
 *   - **server-only.** `KNOCK_API_KEY` is read from `process.env` here and nowhere
 *     else. It is never logged, never returned in a result and never put in a payload.
 *   - **every failure is a typed result** (`AlertResult`), never a throw. A missing key,
 *     a refused key or a dead network can never turn an ingest into a 500.
 *   - **the network sits behind a `Transport` seam**, so the self-test exercises every
 *     branch (sent / not_configured / workflow_missing / unauthorized / unavailable)
 *     with a stub and without opening a socket.
 *
 * Endpoint and payload shape confirmed against Knock's docs on 2026-09-20:
 *   - trigger: `POST /v1/workflows/{key}/trigger`, body `{ recipients, data, settings? }`,
 *     response `{ workflow_run_id }`
 *     <https://docs.knock.app/api-reference/workflows/trigger.md>
 *   - idempotency: an `Idempotency-Key` header is supported on **this endpoint only**;
 *     a repeat within 24 h returns the original response instead of a second run
 *     <https://docs.knock.app/api-reference/overview/idempotent-requests.md>
 *   - inline recipients: pass `{ id, email, … }` and Knock identifies the recipient
 *     before running the workflow
 *     <https://docs.knock.app/send-notifications/triggering-workflows/api.md>
 *   - there is no public endpoint that lists or fetches workflows (`GET /v1/workflows`
 *     and `GET /v1/workflows/{key}` both 404 — that lives in the separate Management
 *     API), so the only way to learn whether a workflow exists is to trigger it. The
 *     reachability check below therefore uses `settings.sandbox_mode`, which generates
 *     the message without delivering it.
 */
import type { AlertStatus, StoredEmail } from "~/lib/inbox-types";

export const KNOCK_API_KEY_ENV = "KNOCK_API_KEY";
export const KNOCK_WORKFLOW_KEY_ENV = "KNOCK_WORKFLOW_KEY";
export const OWNER_ALERT_EMAIL_ENV = "OWNER_ALERT_EMAIL";
export const SITE_URL_ENV = "PUBLIC_SITE_URL";

export const KNOCK_API_BASE = "https://api.knock.app/v1";
export const DEFAULT_WORKFLOW_KEY = "doppel-important-mail";
export const DEFAULT_OWNER_ALERT_EMAIL = "doppel-cae2e184@ctomail.io";
/** Where `/app/email/<id>` resolves for the owner. Overridable with PUBLIC_SITE_URL. */
export const LIVE_SITE_URL = "https://c9d45af83bb416f22801da126358ff8d.ctonew.app";
/** Stable Knock user id for the owner — identified inline on each trigger. */
export const OWNER_RECIPIENT_ID = "doppel-owner";

/**
 * The bar for "this mail matters enough to interrupt the owner".
 *
 * `score >= 80`, **or** a message that explicitly needs a reply and scores `>= 70`:
 * a question addressed to the owner is worth surfacing a little earlier than the
 * plain bar, but not so early that every newsletter with a "?" in it rings the phone.
 */
export const IMPORTANCE_ALERT_THRESHOLD = 80;
export const NEEDS_REPLY_ALERT_THRESHOLD = 70;

const REQUEST_TIMEOUT_MS = 4000;
const STATUS_TTL_MS = 5 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type AlertOutcome =
  | "sent"
  | "skipped"
  | "not_configured"
  | "workflow_missing"
  | "unauthorized"
  | "rejected"
  | "unavailable";

/** The outcome of one attempt. Never thrown, always returned. */
export type AlertResult = {
  /** `true` when nothing went wrong (sent, or deliberately skipped). */
  ok: boolean;
  outcome: AlertOutcome;
  /** The workflow key this attempt was aimed at. */
  workflowKey: string;
  /** One human sentence. Safe to show or log: it never contains the API key. */
  message: string;
  /** Short machine detail from Knock (`workflow_missing`, `api_key_invalid`, …). */
  detail?: string;
  /** Upstream HTTP status, when there was one. */
  status?: number;
  /** Set when Knock accepted the run. */
  workflowRunId?: string;
  /** The dedupe key we sent, so a retry can't double-notify. */
  idempotencyKey?: string;
};

export type TransportRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

export type TransportResponse = { status: number; body: string };

/** The seam the self-test replaces. May throw: the caller turns that into `unavailable`. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** The fields alerting needs off a stored email. */
export type NotifiableEmail = Pick<StoredEmail, "id" | "subject" | "fromLabel" | "source" | "importance">;

export type AlertConfig = {
  hasKey: boolean;
  workflowKey: string;
  ownerEmail: string;
  siteUrl: string;
};

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export function alertConfig(): AlertConfig {
  return {
    hasKey: Boolean(process.env[KNOCK_API_KEY_ENV]),
    workflowKey: (process.env[KNOCK_WORKFLOW_KEY_ENV] || DEFAULT_WORKFLOW_KEY).trim(),
    ownerEmail: (process.env[OWNER_ALERT_EMAIL_ENV] || DEFAULT_OWNER_ALERT_EMAIL).trim(),
    siteUrl: (process.env[SITE_URL_ENV] || LIVE_SITE_URL).trim().replace(/\/+$/, ""),
  };
}

/* -------------------------------------------------------------------------- */
/* The rule: which mail is worth an alert                                      */
/* -------------------------------------------------------------------------- */

export function shouldAlert(email: Pick<StoredEmail, "source" | "importance">): {
  alert: boolean;
  why: string;
} {
  // Only mail that actually arrived through the machine seam (`POST /api/inbound-email`,
  // the Resend forwarding webhook) alerts the owner. The sample inbox and the paste box
  // are a public demo: a visitor clicking a button must never be able to ring the owner.
  if (email.source !== "api") {
    return { alert: false, why: `source "${email.source}" is not arrived mail, so it cannot alert` };
  }
  const { score, needsReply } = email.importance;
  if (score >= IMPORTANCE_ALERT_THRESHOLD) {
    return { alert: true, why: `score ${score} is at or above the ${IMPORTANCE_ALERT_THRESHOLD} bar` };
  }
  if (needsReply && score >= NEEDS_REPLY_ALERT_THRESHOLD) {
    return {
      alert: true,
      why: `it needs a reply and scores ${score} (needs-reply bar ${NEEDS_REPLY_ALERT_THRESHOLD})`,
    };
  }
  return {
    alert: false,
    why: `score ${score} is below the ${IMPORTANCE_ALERT_THRESHOLD} bar${
      needsReply ? ` and below the ${NEEDS_REPLY_ALERT_THRESHOLD} needs-reply bar` : ""
    }`,
  };
}

/** The short, useful payload the owner's workflow renders. */
export function alertData(
  email: NotifiableEmail,
  config: AlertConfig,
): { url: string; data: Record<string, unknown> } {
  const url = `${config.siteUrl}/app/email/${encodeURIComponent(email.id)}`;
  return {
    url,
    data: {
      email_id: email.id,
      subject: email.subject,
      from: email.fromLabel,
      score: email.importance.score,
      reason: email.importance.reason,
      needs_reply: email.importance.needsReply,
      url,
      summary: `${email.fromLabel} — “${email.subject}” scored ${email.importance.score}/100: ${email.importance.reason}`,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

/** The real transport: one `fetch`, bounded by a timeout, response as text. */
export const fetchTransport: Transport = async ({ url, method, headers, body, timeoutMs }) => {
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: await response.text() };
};

/* -------------------------------------------------------------------------- */
/* One Knock call                                                              */
/* -------------------------------------------------------------------------- */

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const clip = (value: string, max = 200): string =>
  value.length > max ? `${value.slice(0, max)}…` : value.replace(/\s+/g, " ").trim();

/** Belt and braces: nothing Knock says should ever echo our key, but if it does, strip it. */
function redact(text: string | undefined, apiKey: string): string | undefined {
  if (!text) return undefined;
  const safe = apiKey && text.includes(apiKey) ? text.split(apiKey).join("[redacted]") : text;
  return clip(safe);
}

type CallInput = {
  transport: Transport;
  path: string;
  apiKey: string;
  workflowKey: string;
  idempotencyKey: string;
  body: string;
  /** Phrase for the success sentence, e.g. "the alert" or "the alerting check". */
  subject: string;
};

async function callKnock(call: CallInput): Promise<AlertResult> {
  const base = {
    workflowKey: call.workflowKey,
    idempotencyKey: call.idempotencyKey,
  } as const;

  try {
    const response = await call.transport({
      url: `${KNOCK_API_BASE}${call.path}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${call.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        // Knock supports this header on the trigger endpoint only; a retry with the
        // same key inside 24 h returns the original response instead of a second run.
        "Idempotency-Key": call.idempotencyKey,
      },
      body: call.body,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    const parsed = parseJson(response.body);
    const code = str(parsed?.code);
    const upstream = redact(str(parsed?.message) ?? response.body, call.apiKey);
    const runId = str(parsed?.workflow_run_id);

    if (response.status >= 200 && response.status < 300) {
      return {
        ...base,
        ok: true,
        outcome: "sent",
        status: response.status,
        detail: code,
        workflowRunId: runId,
        message: `Knock accepted ${call.subject} for workflow '${call.workflowKey}'.`,
      };
    }

    if (response.status === 404 && code === "workflow_missing") {
      return {
        ...base,
        ok: false,
        outcome: "workflow_missing",
        status: response.status,
        detail: code,
        message: `Knock has no workflow called '${call.workflowKey}' in this environment yet, so ${call.subject} was not sent.`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ...base,
        ok: false,
        outcome: "unauthorized",
        status: response.status,
        detail: code,
        message: `Knock refused the API key (${response.status}${code ? ` ${code}` : ""}), so ${call.subject} was not sent.`,
      };
    }

    if (response.status >= 400 && response.status < 500) {
      return {
        ...base,
        ok: false,
        outcome: "rejected",
        status: response.status,
        detail: code ?? upstream,
        message: `Knock rejected ${call.subject} (${response.status}${code ? ` ${code}` : ""}), so nothing was sent.`,
      };
    }

    return {
      ...base,
      ok: false,
      outcome: "unavailable",
      status: response.status,
      detail: code ?? upstream,
      message: `Knock answered ${response.status}, so ${call.subject} was not sent.`,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      outcome: "unavailable",
      detail: redact(err instanceof Error ? err.message : "network failure", call.apiKey),
      message: `Knock could not be reached just now, so ${call.subject} was not sent.`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* The alert                                                                   */
/* -------------------------------------------------------------------------- */

export type NotifyOptions = { transport?: Transport };

/**
 * Fire the owner's alert for one ingested message.
 *
 * Never throws: the outcome is always a typed `AlertResult`, and a caller that can't
 * wait should use `notifyImportantEmailInBackground()`.
 */
export async function notifyImportantEmail(
  email: NotifiableEmail,
  options: NotifyOptions = {},
): Promise<AlertResult> {
  const config = alertConfig();
  const transport = options.transport ?? fetchTransport;

  const bar = shouldAlert(email);
  if (!bar.alert) {
    return {
      ok: true,
      outcome: "skipped",
      workflowKey: config.workflowKey,
      detail: bar.why,
      message: `No alert for “${email.subject}” — ${bar.why}.`,
    };
  }

  if (!config.hasKey) {
    const result: AlertResult = {
      ok: false,
      outcome: "not_configured",
      workflowKey: config.workflowKey,
      message: `Alerts are not set up yet: no Knock key (${KNOCK_API_KEY_ENV}) is configured, so the owner was not told about “${email.subject}”.`,
    };
    remember(result, "trigger");
    return result;
  }

  const { data } = alertData(email, config);
  const result = await callKnock({
    transport,
    path: `/workflows/${encodeURIComponent(config.workflowKey)}/trigger`,
    apiKey: process.env[KNOCK_API_KEY_ENV] ?? "",
    workflowKey: config.workflowKey,
    // Derived from the message, so a retry of the same ingest cannot double-notify.
    idempotencyKey: `${config.workflowKey}:email:${email.id}`,
    subject: "the alert",
    body: JSON.stringify({
      recipients: [{ id: OWNER_RECIPIENT_ID, email: config.ownerEmail, name: "Doppel owner" }],
      data,
    }),
  });

  remember(result, "trigger");
  if (!result.ok && result.outcome !== "not_configured") {
    // One line, no secrets, no stack: the ingest already answered the caller.
    console.warn(`[notify] ${result.outcome}: ${result.message}`);
  }
  return result;
}

/** Fire-and-forget: for a caller that must not wait and must not fail. */
export function notifyImportantEmailInBackground(email: NotifiableEmail, options: NotifyOptions = {}): void {
  void notifyImportantEmail(email, options).catch(() => {
    // notifyImportantEmail never throws; this is here so nothing can escape a `void`.
  });
}

/* -------------------------------------------------------------------------- */
/* The state on /app                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The reachability check. Knock has no public "does this workflow exist?" endpoint, so
 * the check triggers the workflow in **sandbox mode**: the run is accepted (which is
 * exactly what we want to know) and nothing is delivered to anyone.
 *
 * The idempotency key is per day, so a probe that succeeds is replayed rather than
 * creating a fresh run every time /app is opened.
 */
export async function probeAlerting(options: { transport?: Transport } = {}): Promise<AlertStatus> {
  const config = alertConfig();
  const transport = options.transport ?? fetchTransport;

  if (!config.hasKey) return missingKeyStatus(config);

  const { data } = alertData(
    {
      id: "alerting-check",
      subject: "Doppel alerting check",
      fromLabel: "Doppel",
      source: "api",
      importance: { score: 100, reason: "Sandbox check — nothing is delivered by it.", needsReply: false },
    },
    config,
  );

  const today = new Date().toISOString().slice(0, 10);
  const result = await callKnock({
    transport,
    path: `/workflows/${encodeURIComponent(config.workflowKey)}/trigger`,
    apiKey: process.env[KNOCK_API_KEY_ENV] ?? "",
    workflowKey: config.workflowKey,
    idempotencyKey: `${config.workflowKey}:sandbox-check:${today}`,
    subject: "the alerting check",
    body: JSON.stringify({
      recipients: [{ id: OWNER_RECIPIENT_ID, email: config.ownerEmail, name: "Doppel owner" }],
      data,
      // Generates the message, delivers nothing.
      settings: { sandbox_mode: true, skip_delay: true },
    }),
  });

  const status = statusFrom(result, "probe");
  rememberStatus(status);
  return status;
}

export type AlertStatusOptions = { transport?: Transport; force?: boolean };

/**
 * The line `/app` shows. Cached for five minutes per process so a page view doesn't
 * hit Knock every time; never throws (a failure is a status, not an exception).
 */
export async function alertStatus(options: AlertStatusOptions = {}): Promise<AlertStatus> {
  const config = alertConfig();
  try {
    if (!config.hasKey) return missingKeyStatus(config);

    const cached = statusStore().record;
    if (
      !options.force &&
      cached &&
      cached.status.workflowKey === config.workflowKey &&
      Date.now() - cached.at < STATUS_TTL_MS
    ) {
      return cached.status;
    }

    return await probeAlerting({ transport: options.transport });
  } catch (err) {
    // A page renders on this: it must never throw, whatever happens.
    return {
      state: "unavailable",
      label: "Alerts: not confirmed (the check failed)",
      note: err instanceof Error ? err.message : "The alerting check could not run.",
      workflowKey: config.workflowKey,
      checkedAt: null,
      source: "probe",
    };
  }
}

function missingKeyStatus(config: AlertConfig): AlertStatus {
  return {
    state: "not_configured",
    label: "Alerts: not set up yet (no Knock key)",
    note: `Nothing is being sent to the owner. Set ${KNOCK_API_KEY_ENV} to switch alerting on.`,
    workflowKey: config.workflowKey,
    checkedAt: null,
    source: "none",
  };
}

function statusFrom(result: AlertResult, source: "probe" | "trigger"): AlertStatus {
  const checkedAt = new Date().toISOString();
  const base = { workflowKey: result.workflowKey, checkedAt, source } as const;

  switch (result.outcome) {
    case "sent":
      return {
        ...base,
        state: "on",
        label: "Alerts: on",
        note:
          source === "probe"
            ? "Checked just now with a Knock sandbox trigger — the run was accepted and nothing was delivered by that check."
            : "Knock accepted the last alert for the owner.",
      };
    case "workflow_missing":
      return {
        ...base,
        state: "workflow_missing",
        label: `Alerts: waiting for the workflow '${result.workflowKey}' in Knock`,
        note: "Create that workflow in Knock and this line switches to “Alerts: on” by itself.",
      };
    case "unauthorized":
      return {
        ...base,
        state: "unauthorized",
        label: "Alerts: not set up yet (the Knock key was refused)",
        note: "Knock answered 401 — the key in Settings → Secrets isn't a valid API key for this account.",
      };
    case "rejected":
      return {
        ...base,
        state: "rejected",
        label: "Alerts: not set up yet (Knock rejected the check)",
        note: result.message,
      };
    case "unavailable":
      return {
        ...base,
        state: "unavailable",
        label: "Alerts: not confirmed (Knock couldn't be reached just now)",
        note: "The last check didn't get an answer; it will try again on the next page view.",
      };
    default:
      return {
        ...base,
        state: "unknown",
        label: "Alerts: not checked yet",
        workflowKey: result.workflowKey,
        checkedAt: null,
        source,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Process-local cache (so /app doesn't probe Knock on every view)              */
/* -------------------------------------------------------------------------- */

type StatusRecord = { at: number; status: AlertStatus };
type StatusStore = { record?: StatusRecord };

function statusStore(): StatusStore {
  const globalKey = "__doppelAlertStatus" as const;
  const host = globalThis as unknown as Record<string, StatusStore | undefined>;
  if (!host[globalKey]) host[globalKey] = {};
  return host[globalKey];
}

function rememberStatus(status: AlertStatus, at = Date.now()): void {
  statusStore().record = { at, status };
}

/** Fold a real trigger outcome into the state `/app` shows. */
function remember(result: AlertResult, source: "probe" | "trigger"): void {
  if (result.outcome === "skipped") return;
  rememberStatus(statusFrom(result, source));
}

/** Test helper: forget what we last learned. */
export function resetAlertStatusCache(): void {
  statusStore().record = undefined;
}
