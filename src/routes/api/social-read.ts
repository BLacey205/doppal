/**
 * GET /api/social-read?network=<instagram|linkedin|x>&shape=<identity|posts|comments|messages|analytics>
 *
 * The machine seam of the social gateway. `shape=identity` verifies the credentials
 * with one documented call; the other shapes read a network and map the payload onto
 * the normalised model. Everything it can do is a read: **there is no POST here at
 * all**, because Doppel does not post, reply or send direct messages.
 *
 * Fail closed: unless a shared secret is configured (`SOCIAL_READ_TOKEN`) *and*
 * presented as a Bearer token or `?token=`, the route refuses every request —
 * including when the secret is simply missing. Failures are typed JSON
 * (`{ ok: false, error, message }`): 400 for a bad ask, 401 for the gate, 409 for a
 * network that isn't configured or doesn't expose the shape, 502 when the network
 * refused or returned something unreadable. Never a bare 500.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/social-read")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleSocialReadGet } = await import("~/lib/social/api");
        return handleSocialReadGet(request);
      },
      POST: async () => {
        const { handleSocialMethodNotAllowed } = await import("~/lib/social/api");
        return handleSocialMethodNotAllowed("POST");
      },
    },
  },
});
