/**
 * Forwarding providers → our one funnel.
 *
 * A forwarding service (Resend today, Postmark tomorrow) POSTs a webhook at us; this
 * module verifies the caller, turns the payload into `{ from, subject, text, receivedAt }`
 * and hands it to the *same* `ingestEmail()` funnel as the paste box — rank → extract
 * dates → draft → store. Nothing here sends mail, and nothing here replies to a provider.
 *
 * ## Adding a second provider (Postmark inbound maps almost 1:1)
 *
 * Implement one object of `InboundProvider` and add it to `PROVIDERS`:
 *
 *   postmark = {
 *     name: "postmark",
 *     label: "Postmark",
 *     envVars: ["POSTMARK_INBOUND_TOKEN"],            // Basic-auth credentials on the hook URL
 *     connection() { … },
 *     async read(request, rawBody) {                  // From/Subject/TextBody/Date → our shape
 *       const event = JSON.parse(rawBody);
 *       return { ok: true, kind: "message", message: {
 *         from: event.From, subject: event.Subject, text: event.TextBody ?? "",
 *         receivedAt: event.Date, providerMessageId: event.MessageID ?? null } };
 *     },
 *   };
 *
 * The route file is then one line: `handleProviderWebhookPost("postmark", request)`.
 * No changes to the funnel, the guard or the UI.
 *
 * Server-only: reads `process.env`, uses node:crypto and outbound fetch.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  failureResponse,
  intakePreflight,
  jsonResponse,
  type GuardFailure,
} from "~/lib/inbound-guard";
import type { IngestOptions } from "~/lib/inbound-request";
import { failureLogLine } from "~/lib/log-line";

export const RESEND_WEBHOOK_SECRET_ENV = "RESEND_WEBHOOK_SECRET";
export const RESEND_API_KEY_ENV = "RESEND_API_KEY";

/** How old a signed webhook may be before we refuse it (Svix's own recommendation). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Where Resend's receiving API hands us the body of a message we were told about. */
export const RESEND_RECEIVED_EMAIL_URL = "https://api.resend.com/emails/receiving";

export type InboundMessage = {
  from: string;
  subject: string;
  text: string;
  receivedAt?: string;
  /** Provider-side id, so a retried webhook doesn't ingest the same mail twice. */
  providerMessageId: string | null;
};

export type ProviderRead =
  | { ok: true; kind: "message"; message: InboundMessage }
  | { ok: true; kind: "ignored"; reason: string }
  | { ok: false; status: number; code: string; message: string };

export type InboundProvider = {
  readonly name: string;
  readonly label: string;
  /** Every var this provider needs; if one is missing the provider is not connected. */
  readonly envVars: readonly string[];
  /** What the owner must do to connect it, in one sentence. */
  readonly configureHint: string;
  connection(): { connected: true } | { connected: false; message: string };
  read(request: Request, rawBody: string): Promise<ProviderRead>;
};

function env(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/* ------------------------------------------------------------------ *
 * Svix-style signature verification (what Resend signs with)
 * ------------------------------------------------------------------ */

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "stale" | "mismatch" };

/** Constant-time compare of two base64 signatures. */
function sameSignature(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/** The Svix signing key is the base64 part of the secret, i.e. everything after `whsec_`. */
function signingKey(secret: string): Buffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const decoded = Buffer.from(encoded, "base64");
  // A secret that isn't base64 (a hand-set value) still works, as UTF-8 bytes.
  return decoded.length > 0 ? decoded : Buffer.from(secret, "utf8");
}

/**
 * Verify one Resend webhook request the way their docs describe it
 * (<https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests> →
 * <https://docs.svix.com/receiving/verifying-payloads/how-manual>):
 *
 *   signed content = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   signature      = base64(HMAC-SHA256(signed content, base64(secret after "whsec_")))
 *   header         = space-delimited list of `v1,<signature>`
 *
 * The raw body must be passed byte-for-byte; re-serialising JSON breaks the signature.
 * A timestamp outside the tolerance is refused, so a captured request can't be replayed
 * later. Svix's white-label `webhook-*` header names are accepted as a fallback.
 */
export function verifyResendSignature(input: {
  rawBody: string;
  id?: string | null;
  timestamp?: string | null;
  signature?: string | null;
  secret?: string | null;
  now?: number;
  toleranceSeconds?: number;
}): SignatureCheck {
  const { rawBody, secret } = input;
  if (!secret) return { ok: false, reason: "missing_headers" };
  if (!input.id || !input.timestamp || !input.signature) return { ok: false, reason: "missing_headers" };

  const sent = Number(input.timestamp);
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (!Number.isFinite(sent) || Math.abs(now - sent) > tolerance) return { ok: false, reason: "stale" };

  const expected = createHmac("sha256", signingKey(secret))
    .update(`${input.id}.${input.timestamp}.${rawBody}`, "utf8")
    .digest("base64");

  const candidates = input.signature
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (/^v\d+,/.test(entry) ? entry.slice(entry.indexOf(",") + 1) : entry));

  return candidates.some((candidate) => sameSignature(candidate, expected))
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

/** Pull the three signing headers, accepting Svix's `webhook-*` white-label names too. */
export function signatureHeaders(headers: Headers) {
  return {
    id: headers.get("svix-id") ?? headers.get("webhook-id"),
    timestamp: headers.get("svix-timestamp") ?? headers.get("webhook-timestamp"),
    signature: headers.get("svix-signature") ?? headers.get("webhook-signature"),
  };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/** Enough HTML → text for triage: no dependencies, no decoration, keeps the words. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------------ *
 * Duplicate suppression (a webhook the provider retries)
 * ------------------------------------------------------------------ */

const SEEN_KEY = "__doppelInboundSeenProviderMessages";

function seen(): Map<string, number> {
  const store = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  if (!store[SEEN_KEY]) store[SEEN_KEY] = new Map();
  return store[SEEN_KEY]!;
}

function alreadyIngested(id: string): boolean {
  const map = seen();
  if (map.size > 2000) map.clear();
  return map.has(id);
}

function rememberIngested(id: string): void {
  const map = seen();
  if (map.size > 2000) map.clear();
  map.set(id, Date.now());
}

/** Test helper: forget every remembered provider message id (cf. resetRateLimits). */
export function resetIngestedProviderMessages(): void {
  seen().clear();
}

/* ------------------------------------------------------------------ *
 * Resend
 * ------------------------------------------------------------------ */

/**
 * Read the message body from Resend's receiving API. The webhook only carries
 * metadata, so this one extra call is required
 * (<https://resend.com/docs/dashboard/receiving/get-email-content>).
 */
async function fetchResendMessage(
  emailId: string,
  apiKey: string,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; code: string; message: string }> {
  let response: Response;
  try {
    response = await fetch(`${RESEND_RECEIVED_EMAIL_URL}/${encodeURIComponent(emailId)}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return {
      ok: false,
      status: 502,
      code: "provider_unreachable",
      message:
        "We couldn't reach Resend to read that message just now, so nothing was stored. Resend will try the webhook again.",
    };
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: 503,
        code: "provider_rejected_key",
        message:
          "Resend didn't accept the API key we hold, so that message couldn't be read. Nothing was stored — replace RESEND_API_KEY and Resend will send it again.",
      };
    }
    return {
      ok: false,
      status: 502,
      code: "provider_error",
      message: `Resend couldn't hand us that message (it answered ${response.status}). Nothing was stored — Resend will try the webhook again.`,
    };
  }

  try {
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      status: 502,
      code: "provider_bad_payload",
      message:
        "Resend's reply wasn't something we could read, so nothing was stored. Resend will try the webhook again.",
    };
  }
}

export const resendProvider: InboundProvider = {
  name: "resend",
  label: "Resend (forwarded mail)",
  envVars: [RESEND_WEBHOOK_SECRET_ENV, RESEND_API_KEY_ENV],
  configureHint:
    "Set RESEND_WEBHOOK_SECRET (the webhook's signing secret) and RESEND_API_KEY (an API key on the same Resend account), then point an email.received webhook at this route.",

  connection() {
    const missing = this.envVars.filter((name) => !env(name));
    if (missing.length === 0) return { connected: true };
    return {
      connected: false,
      message: `Forwarded mail isn't connected to Resend yet: ${missing.join(
        " and ",
      )} ${missing.length > 1 ? "are" : "is"} not set, so we won't accept ${missing.length > 1 ? "their" : "its"} webhooks. ${this.configureHint}`,
    };
  },

  async read(request, rawBody): Promise<ProviderRead> {
    const secret = env(RESEND_WEBHOOK_SECRET_ENV);
    const headers = signatureHeaders(request.headers);

    const signature = verifyResendSignature({
      rawBody,
      id: headers.id,
      timestamp: headers.timestamp,
      signature: headers.signature,
      secret,
    });

    if (!signature.ok) {
      if (signature.reason === "missing_headers") {
        return {
          ok: false,
          status: 401,
          code: "missing_signature",
          message:
            "This request didn't come with Resend's signature headers, so nothing was stored. Only signed webhooks are accepted.",
        };
      }
      if (signature.reason === "stale") {
        return {
          ok: false,
          status: 401,
          code: "stale_signature",
          message:
            "That webhook was signed too long ago to trust, so nothing was stored. Resend will send a fresh one.",
        };
      }
      return {
        ok: false,
        status: 401,
        code: "bad_signature",
        message:
          "The signature on that webhook didn't match, so nothing was stored. Check that RESEND_WEBHOOK_SECRET is the signing secret of this exact endpoint.",
      };
    }

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      event = parsed as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        status: 400,
        code: "invalid_json",
        message: "The webhook body wasn't JSON we could read, so nothing was stored.",
      };
    }

    const type = asText(event.type);
    if (type !== "email.received") {
      return { ok: true, kind: "ignored", reason: `Ignored a \`${type || "unknown"}\` event — this route only takes received mail.` };
    }

    const data = (event.data ?? {}) as Record<string, unknown>;
    const emailId = asText(data.email_id) || asText(data.id);
    if (!emailId) {
      return {
        ok: false,
        status: 400,
        code: "missing_email_id",
        message: "That webhook didn't name a message we could fetch, so nothing was stored.",
      };
    }

    const apiKey = env(RESEND_API_KEY_ENV);
    if (!apiKey) {
      return {
        ok: false,
        status: 503,
        code: "provider_not_connected",
        message: `We were told about a message but can't read it: ${RESEND_API_KEY_ENV} is not set. Nothing was stored. ${this.configureHint}`,
      };
    }

    const fetched = await fetchResendMessage(emailId, apiKey);
    if (!fetched.ok) return fetched;

    const body = fetched.body;
    const bodyHeaders = (body.headers ?? {}) as Record<string, unknown>;
    const from = asText(bodyHeaders.from) || asText(body.from) || asText(data.from);
    const text = asText(body.text) || htmlToText(asText(body.html));

    return {
      ok: true,
      kind: "message",
      message: {
        from,
        subject: asText(body.subject) || asText(data.subject),
        text,
        receivedAt: asText(data.created_at) || asText(body.created_at) || undefined,
        providerMessageId: emailId,
      },
    };
  },
};

export const PROVIDERS: Record<string, InboundProvider> = {
  [resendProvider.name]: resendProvider,
};

/* ------------------------------------------------------------------ *
 * The route logic (testable without a server)
 * ------------------------------------------------------------------ */

const UNKNOWN_PROVIDER: GuardFailure = {
  ok: false,
  status: 404,
  code: "unknown_provider",
  message: "There's no forwarding provider at this address. Nothing was stored.",
};

/**
 * The words the provider gets when our funnel failed — the same sentence is logged
 * (under `~/lib/log-line`, as a string, never the error object) and returned, so the
 * log line and the response can never drift apart. The sentence names no provider.
 */
const WEBHOOK_FAILED_MESSAGE =
  "We couldn't process that webhook just now. Nothing was stored — the provider will send it again.";

/**
 * The words the provider gets when the funnel ran but the message could not be
 * kept — the store refused, or it silently fell back to memory while a database
 * was configured. Non-2xx on purpose: Resend retries non-2xx answers, and the
 * whole point is that the next attempt must be free to store the message for
 * real instead of being told it is already here.
 */
const PROVIDER_STORE_FAILED_MESSAGE =
  "We read the message but couldn't save it just now, so nothing was kept — the provider will send it again.";

/**
 * `POST /api/inbound-email/<provider>` — a provider webhook. Never 500s on bad input.
 *
 * Duplicate suppression remembers an id **only after** the message is genuinely
 * kept — never before, and never on a maybe:
 *
 *   - `storedIn: "database"` — a real insert came back. Durable; remember it.
 *   - `storageState: "preview"` — no database is configured, memory IS the store,
 *     and the map lives exactly as long as that store does; the existing good
 *     case (an accidental repeat answered `duplicate`, stored once) is preserved.
 *   - anything else — the store refused the write, or the message fell back to
 *     memory while a database was configured: nothing is remembered, and a 2xx
 *     from the funnel is replaced with an honest 503 so the provider retries.
 *
 * The order is the fix: the id used to be remembered *before* the ingest ran, so
 * any store failure marked the mail ingested that was never stored — the retry
 * was answered `duplicate` with a 200 and the owner's message was gone for good.
 * When in doubt we do not suppress: one extra copy can be deleted, lost mail
 * cannot be recovered.
 */
export async function handleProviderWebhookPost(
  name: string,
  request: Request,
  options: IngestOptions = {},
): Promise<Response> {
  const provider = PROVIDERS[name];
  if (!provider) return failureResponse(UNKNOWN_PROVIDER);

  try {
    // Flood guard and size cap first: they're cheap and must apply even when the
    // provider isn't connected yet.
    const preflight = await intakePreflight(request);
    if (!preflight.ok) return failureResponse(preflight);

    const connection = provider.connection();
    if (!connection.connected) {
      return jsonResponse(
        {
          ok: false,
          provider: name,
          connected: false,
          error: "provider_not_connected",
          message: connection.message,
        },
        503,
      );
    }

    const read = await provider.read(request, preflight.rawBody);

    if (!read.ok) {
      return jsonResponse(
        { ok: false, provider: name, connected: true, error: read.code, message: read.message },
        read.status,
      );
    }

    if (read.kind === "ignored") {
      return jsonResponse({ ok: true, provider: name, ignored: true, message: read.reason }, 200);
    }

    const { providerMessageId } = read.message;
    if (providerMessageId && alreadyIngested(providerMessageId)) {
      return jsonResponse(
        {
          ok: true,
          provider: name,
          duplicate: true,
          message: "Already in the inbox — this webhook arrived twice, so nothing was added again.",
        },
        200,
      );
    }

    const { ingestToOutcome } = await import("~/lib/inbound-request");
    const outcome = await ingestToOutcome({ ...read.message, provider: name }, options);

    // Remember only what is genuinely kept — AFTER the store, never before (see
    // the doc comment above for the full rule and why the order is the fix).
    const kept =
      outcome.ingested && (outcome.storedIn === "database" || outcome.storageState === "preview");
    if (kept && providerMessageId) rememberIngested(providerMessageId);

    if (!kept && outcome.response.status < 400) {
      // The funnel answered 2xx but the message is not genuinely kept (a memory
      // fallback while a database is configured). Say so honestly, non-2xx, so
      // the provider retries into a store that can actually keep the message.
      return jsonResponse(
        {
          ok: false,
          provider: name,
          error: "store_failed",
          stored: false,
          message: PROVIDER_STORE_FAILED_MESSAGE,
        },
        503,
      );
    }
    return outcome.response;
  } catch (err) {
    console.error(failureLogLine(WEBHOOK_FAILED_MESSAGE, err, "provider webhook"));
    return jsonResponse(
      {
        ok: false,
        provider: name,
        error: "webhook_failed",
        message: WEBHOOK_FAILED_MESSAGE,
      },
      503,
    );
  }
}

/** `GET /api/inbound-email/<provider>` — tells the owner whether the channel is armed. */
export function handleProviderWebhookGet(name: string): Response {
  const provider = PROVIDERS[name];
  if (!provider) return failureResponse(UNKNOWN_PROVIDER);

  const connection = provider.connection();
  return jsonResponse(
    {
      ok: false,
      provider: name,
      connected: connection.connected,
      error: "method_not_allowed",
      message: `${provider.label} posts here. ${
        connection.connected ? "This route is armed and ready." : connection.message
      } Nothing is ever sent from Doppel.`,
    },
    405,
  );
}
