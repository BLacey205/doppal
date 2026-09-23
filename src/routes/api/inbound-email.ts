/**
 * POST /api/inbound-email
 *
 * The machine seam: a forwarding address, a Zapier step, a Gmail/Outlook OAuth sync
 * or the owner's own script can post here. Accepts
 *
 *   { "from": "…", "subject": "…", "text": "…", "receivedAt": "2026-09-20T09:00:00Z" }
 *
 * and runs the exact same `ingestEmail()` funnel as the paste box and the sample
 * inbox: rank → extract dates → draft → store.
 *
 * Guarded by the shared secret in `INBOUND_EMAIL_TOKEN` (Bearer header or `?token=`).
 * With no secret configured the route refuses every POST — it never accepts
 * unauthenticated mail just because the secret is missing. Requests are capped at
 * 256 KB and rate-limited per IP. All of that lives in `~/lib/inbound-guard`.
 *
 * Stores the message only. It never sends anything and never calls back out to a
 * mail account.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/inbound-email")({
  server: {
    handlers: {
      GET: async () => {
        const { handleInboundEmailGet } = await import("~/lib/inbound-request");
        return handleInboundEmailGet();
      },
      POST: async ({ request }) => {
        const { handleInboundEmailPost } = await import("~/lib/inbound-request");
        return handleInboundEmailPost(request);
      },
    },
  },
});
