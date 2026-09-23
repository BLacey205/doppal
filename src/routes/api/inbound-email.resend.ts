/**
 * POST /api/inbound-email/resend
 *
 * The forwarding webhook: the owner sets a forwarding rule to their own
 * `<id>.resend.app` receiving address, Resend sends every forwarded message here as an
 * `email.received` event, and we turn it into an inbox entry through the same
 * `ingestEmail()` funnel as everything else. No OAuth, no domain, no mailbox
 * credential — and Doppel still never sends mail.
 *
 * This route holds no logic of its own: it is one call into `~/lib/inbound-providers`,
 * where Resend lives behind the same small interface a second provider (Postmark) will
 * implement. Guard: 256 KB body cap, per-IP rate limit, svix-style signature check with
 * a 5-minute freshness window, and a typed JSON answer for every outcome — including
 * "provider not connected" when the secrets are missing. It never 500s on bad input.
 *
 * Secrets (server-only, read in the provider module): RESEND_WEBHOOK_SECRET, RESEND_API_KEY.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/inbound-email/resend")({
  server: {
    handlers: {
      GET: async () => {
        const { handleProviderWebhookGet } = await import("~/lib/inbound-providers");
        return handleProviderWebhookGet("resend");
      },
      POST: async ({ request }) => {
        const { handleProviderWebhookPost } = await import("~/lib/inbound-providers");
        return handleProviderWebhookPost("resend", request);
      },
    },
  },
});
