/**
 * POST /api/inbound-sms/twilio
 *
 * The text-message webhook: the owner points their Twilio number's "A message
 * comes in" webhook (HTTP POST) here, Twilio sends every text that arrives on the
 * number as an `application/x-www-form-urlencoded` request, and we turn it into an
 * inbox entry through the same `ingestEmail()` funnel as everything else — one
 * pipeline, one store, one dedupe rule. Doppel never sends a text back.
 *
 * This route holds no logic of its own: it is one call into `~/lib/inbound-providers`,
 * where the Twilio provider (`~/lib/inbound-twilio`) lives behind the same interface
 * the Resend forwarding webhook implements. Guard: 256 KB body cap and the same
 * per-IP rate limit as every intake route, then the `X-Twilio-Signature` check over
 * the fixed server-side public URL (`TWILIO_WEBHOOK_BASE_URL` or the live origin —
 * never a proxy-reconstructed URL) — typed 401 refusals, nothing stored on refusal.
 *
 * The answer on success is the shared funnel's typed 2xx JSON. Twilio "expects to
 * receive TwiML in response"; a TwiML-neutral 2xx with no TwiML verbs answers a
 * receive-only number — its exact empty-response semantics are untested until a real
 * text arrives, and nothing here claims otherwise.
 *
 * Secrets (server-only, read in the provider module): TWILIO_AUTH_TOKEN (also the
 * signature secret — there is no separate webhook secret, unlike Resend) and
 * TWILIO_ACCOUNT_SID.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/inbound-sms/twilio")({
  server: {
    handlers: {
      GET: async () => {
        const { handleProviderWebhookGet } = await import("~/lib/inbound-providers");
        return handleProviderWebhookGet("twilio");
      },
      POST: async ({ request }) => {
        const { handleProviderWebhookPost } = await import("~/lib/inbound-providers");
        return handleProviderWebhookPost("twilio", request);
      },
    },
  },
});
