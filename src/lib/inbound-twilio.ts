/**
 * The Twilio text-message provider → our one funnel.
 *
 * Twilio POSTs every message that arrives on the owner's number here as an
 * `application/x-www-form-urlencoded` webhook
 * (<https://www.twilio.com/docs/messaging/guides/webhook-request>), and this module
 * verifies the caller, turns the form fields into the same `InboundMessage` shape the
 * Resend provider produces, and hands it to the *same* `ingestEmail()` funnel as the
 * paste box. Nothing here sends a text, and nothing here replies to Twilio.
 *
 * ## Signature (from Twilio's security docs, quoted in
 * /home/team/shared/sms-provider-evidence.md §1.2)
 *
 *   signed content = the FULL PUBLIC URL the owner configures in the Console
 *                    (protocol through query string), then every POST field sorted
 *                    case-sensitively ("Unix-style") by name, each appended as
 *                    name + value with no delimiter;
 *   signature      = base64(HMAC-SHA1(signed content, key = the Auth Token));
 *   header         = `X-Twilio-Signature`.
 *
 * There is NO separate webhook-signing secret (unlike Resend's
 * `RESEND_WEBHOOK_SECRET`): the Auth Token is both the API credential and the
 * signature key.
 *
 * ## The URL the validator uses — never a proxy reconstruction
 *
 * The signature covers the URL the OWNER CONFIGURED, which our origin only sees
 * through a proxy that may rewrite scheme, host or port. Rebuilding the URL from
 * request internals therefore breaks verification by construction. The validator is
 * handed one fixed, server-side string instead: `TWILIO_WEBHOOK_BASE_URL` when set,
 * otherwise the live origin — plus the route path. Nothing from the request's
 * headers or URL ever enters the signature check.
 *
 * ## Mapping (decided, per the brief)
 *
 *   MessageSid → provider id (dedupe, remembered only after a real store)
 *   From       → the sender (fromLabel)
 *   To         → our number (stored in the row's `to_address`, shown on screen)
 *   Body       → the message text
 *   subject    → `Text message to {To}` — the row says plainly what arrived;
 *   source     → "sms" — the /app screens label such rows "Text message".
 *
 * A Body that is empty or missing is NOT lost: with a sender named, the funnel
 * stores the message with its bracketed "no readable text" note (the same rule the
 * Resend path uses), so a truncated form body cannot silently drop a real text.
 *
 * Server-only: reads `process.env` and uses node:crypto.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { noteProviderFailure } from "~/lib/channel-evidence";
import type { InboundMessage, InboundProvider, ProviderRead } from "~/lib/inbound-providers";

export const TWILIO_AUTH_TOKEN_ENV = "TWILIO_AUTH_TOKEN";
export const TWILIO_ACCOUNT_SID_ENV = "TWILIO_ACCOUNT_SID";
/** Optional exact public URL prefix to validate against; defaults to the live origin. */
export const TWILIO_WEBHOOK_BASE_URL_ENV = "TWILIO_WEBHOOK_BASE_URL";

/** The route path Twilio's webhook is pointed at. */
export const TWILIO_WEBHOOK_PATH = "/api/inbound-sms/twilio";

/**
 * The live origin, used when `TWILIO_WEBHOOK_BASE_URL` is not set. A fixed
 * server-side constant — never derived from proxy headers, which is what would let
 * a proxy-reconstructed URL into the validator.
 */
export const DEFAULT_PUBLIC_ORIGIN = "https://doppal.ctonew.app";

function env(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The exact URL the owner was told to configure, byte-for-byte — the string the
 * signature check validates against. `TWILIO_WEBHOOK_BASE_URL` overrides the
 * origin (so a staging deployment can be armed too); the path is always ours.
 */
export function twilioWebhookUrl(): string {
  const base = (env(TWILIO_WEBHOOK_BASE_URL_ENV) ?? DEFAULT_PUBLIC_ORIGIN).replace(/\/+$/, "");
  return `${base}${TWILIO_WEBHOOK_PATH}`;
}

/**
 * Parse an `application/x-www-form-urlencoded` body into a plain record.
 * `URLSearchParams` decodes `+` and `%xx` exactly as a form server would — the
 * decoded name/value pairs are what Twilio's signature is computed over.
 */
export function parseTwilioParams(rawBody: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawBody)) {
    params[key] = value;
  }
  return params;
}

/**
 * What Twilio's signer computes, written out independently of any SDK:
 * `base64(HMAC-SHA1(url + sortedConcat(name+value), Auth Token))`.
 *
 * The sort is Twilio's "Unix-style case-sensitive" byte order. Every Twilio
 * parameter name is ASCII, where JavaScript's `.sort()` (UTF-16 code-unit order)
 * is exactly byte order — the documented requirement holds without a custom
 * comparator.
 */
export function twilioExpectedSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedConcat = Object.keys(params)
    .sort()
    .reduce((acc, name) => `${acc}${name}${params[name]}`, "");
  return createHmac("sha1", authToken).update(`${url}${sortedConcat}`, "utf8").digest("base64");
}

export type TwilioSignatureCheck =
  | { ok: true }
  | { ok: false; reason: "missing_token" | "missing_signature" | "mismatch" };

/** Constant-time compare of two base64 HMAC outputs (hashed first, so equal work). */
function sameSignature(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/** Verify one `X-Twilio-Signature` against the fixed public URL and the Auth Token. */
export function verifyTwilioSignature(input: {
  signature?: string | null;
  url: string;
  params: Record<string, string>;
  authToken?: string | null;
}): TwilioSignatureCheck {
  if (!input.authToken) return { ok: false, reason: "missing_token" };
  if (!input.signature) return { ok: false, reason: "missing_signature" };
  const expected = twilioExpectedSignature(input.authToken, input.url, input.params);
  return sameSignature(input.signature, expected)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

/* ------------------------------------------------------------------ *
 * The provider
 * ------------------------------------------------------------------ */

/** The refusal for a request that passed nothing: a typed 401, nothing stored. */
const UNSIGNED_MESSAGE =
  "This request didn't come with Twilio's X-Twilio-Signature header, so nothing was stored. Only signed webhooks are accepted.";

const BAD_SIGNATURE_MESSAGE =
  "The signature on that request didn't match, so nothing was stored. Check that TWILIO_AUTH_TOKEN is exactly the Console Auth Token, and that the webhook URL in the Console matches the one this route validates against.";

const MISSING_SID_MESSAGE =
  "That request didn't name a message (no MessageSid), so nothing was stored.";

export const twilioProvider: InboundProvider = {
  name: "twilio",
  label: "Twilio (text messages)",
  envVars: [TWILIO_AUTH_TOKEN_ENV, TWILIO_ACCOUNT_SID_ENV],
  configureHint:
    "Set TWILIO_AUTH_TOKEN (the Console Auth Token — it is also the webhook's signature secret) and TWILIO_ACCOUNT_SID, then point your Twilio number's “A message comes in” webhook (HTTP POST) at this route.",

  connection() {
    const missing = this.envVars.filter((name) => !env(name));
    if (missing.length === 0) return { connected: true };
    return {
      connected: false,
      message: `Text messages aren't connected to Twilio yet: ${missing.join(" and ")} ${
        missing.length > 1 ? "are" : "is"
      } not set, so we won't accept ${
        missing.length > 1 ? "their" : "its"
      } webhooks. ${this.configureHint}`,
    };
  },

  async read(request, rawBody): Promise<ProviderRead> {
    const authToken = env(TWILIO_AUTH_TOKEN_ENV);
    const signature = request.headers.get("x-twilio-signature");
    const params = parseTwilioParams(rawBody);
    const url = twilioWebhookUrl();

    // Signature FIRST — a request that doesn't verify never reaches the funnel,
    // and nothing is read out of it that could become a message.
    const check = verifyTwilioSignature({ signature, url, params, authToken });
    if (!check.ok) {
      if (check.reason === "missing_token") {
        // Unreachable through the route (connection() gates first) but typed anyway.
        return {
          ok: false,
          status: 503,
          code: "provider_not_connected",
          message: `Text messages aren't connected: ${TWILIO_AUTH_TOKEN_ENV} is not set. Nothing was stored. ${this.configureHint}`,
        };
      }
      if (check.reason === "missing_signature") {
        return { ok: false, status: 401, code: "missing_signature", message: UNSIGNED_MESSAGE };
      }
      // A signed-looking request that failed verification is the one signature
      // refusal that means something is genuinely wrong (a rotated or mis-copied
      // Auth Token) — recorded so the Connections card says so, per the evidence
      // file's failing state. Unsigned noise records nothing.
      noteProviderFailure(
        this.name,
        "bad_signature",
        "A text message from Twilio was refused — the signature didn't match. Check that TWILIO_AUTH_TOKEN is exactly the Console Auth Token.",
      );
      return { ok: false, status: 401, code: "bad_signature", message: BAD_SIGNATURE_MESSAGE };
    }

    const messageSid = params.MessageSid ?? "";
    if (!messageSid.trim()) {
      return { ok: false, status: 400, code: "missing_message_sid", message: MISSING_SID_MESSAGE };
    }

    const from = params.From ?? "";
    const to = params.To ?? "";
    const body = params.Body ?? "";

    // A message that is nothing at all — no sender, no text — is refused by the
    // funnel, not here: one refusal lives in ingestEmail() for every provider.
    // An empty or missing Body with a sender named is kept, with the absence said
    // plainly (the funnel's bracketed note), so a truncated form body cannot lose
    // a real text.
    let bodyNote: string | undefined;
    if (!body.trim()) {
      const media = Number(params.NumMedia ?? "0");
      const mediaCount = Number.isFinite(media) && media > 0 ? Math.floor(media) : 0;
      bodyNote =
        "no text body came with it" +
        (mediaCount > 0
          ? ` — its ${mediaCount} media item${mediaCount === 1 ? " was" : "s were"} not downloaded`
          : "");
    }

    const message: InboundMessage = {
      from,
      // The stored row must say plainly what arrived and to which number — the
      // /app screens read this subject and the `source: "sms"` flag.
      subject: to.trim() ? `Text message to ${to.trim()}` : "Text message",
      text: body,
      bodyNote,
      toAddress: to.trim() || undefined,
      source: "sms",
      providerMessageId: messageSid,
    };
    return { ok: true, kind: "message", message };
  },

  /**
   * A real text that no store kept is a channel failure — the owner's message
   * bounced off our store, and the card must say so (recorded only when the sms
   * channel exists in the evidence map; harmless no-op before that).
   */
  onStoreFailed(): void {
    noteProviderFailure(
      twilioProvider.name,
      "store_failed",
      "A text message arrived but couldn't be saved just now, so nothing was kept. Twilio will send it again.",
    );
  },
};
