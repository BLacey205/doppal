/**
 * The client-callable server functions behind the Model connection card.
 *
 * Same shape as `~/lib/channel-fns`: `GET` for reads, `POST` for the actions
 * that change state (so a gateway retry cannot surprise us), and the
 * server-only modules imported *inside* the handler so no env-reading code is
 * ever bundled for the browser. All three return wrapped, plain, string-only
 * view objects — the provider, the model, a MASK and timestamps. No key value
 * ever crosses this boundary in either direction: the browser sends the key
 * once (over HTTPS, in the request body) and never receives anything but its
 * mask back.
 */
import { createServerFn } from "@tanstack/react-start";

import type { ModelCredentialCard } from "~/lib/model-credentials";

/** What the Model connection card shows, straight from the stored row and the last recorded refusal. */
export const getModelCredentialCard = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ card: ModelCredentialCard }> => {
    const { credentialCard } = await import("~/lib/model-credentials");
    return { card: await credentialCard() };
  },
);

/**
 * Save (or replace): validate the entered key with a real authenticated call
 * to the provider, and only then encrypt and store it. On any refusal nothing
 * is stored, the card records why, and the built-in rules keep running.
 */
export const saveModelCredentialKey = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({
    provider: ((data as { provider?: unknown })?.provider === "anthropic" ? "anthropic" : "openai") as "openai" | "anthropic",
    key: typeof (data as { key?: unknown })?.key === "string" ? (data as { key: string }).key : "",
  }))
  .handler(async ({ data }) => {
    const { saveModelCredential } = await import("~/lib/model-credentials");
    return saveModelCredential(data.provider, data.key);
  });

/** Remove: a genuine delete of the stored credential — not a flag. */
export const removeModelCredentialKey = createServerFn({ method: "POST" }).handler(async () => {
  const { removeModelCredential } = await import("~/lib/model-credentials");
  return removeModelCredential();
});
