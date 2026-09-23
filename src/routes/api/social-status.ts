/**
 * GET /api/social-status
 *
 * A public, read-only description of where each network connection stands: the
 * evidence-based state, the environment-variable *names* it waits for, what the
 * platform still has to approve, and which reads exist at all. It never includes a
 * credential value, a token or an account id, and it never writes anything.
 *
 * `?network=instagram` narrows it to one network; an unknown name is a typed 400.
 * POST and the rest are a typed 405 — no method here can change anything.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/social-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleSocialStatusGet } = await import("~/lib/social/api");
        return handleSocialStatusGet(request);
      },
      POST: async () => {
        const { handleSocialMethodNotAllowed } = await import("~/lib/social/api");
        return handleSocialMethodNotAllowed("POST");
      },
    },
  },
});
