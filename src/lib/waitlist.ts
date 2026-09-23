/**
 * The waitlist server function, called from the client-side form.
 *
 * `createServerFn({ method: "POST" })` keeps this out of GET/prefetch paths (it
 * writes data, and a gateway retry must not double-submit). The database module is
 * imported *inside* the handler so no server-only code is bundled for the browser.
 */
import { createServerFn } from "@tanstack/react-start";

export type WaitlistState =
  | { status: "joined" }
  | { status: "already" }
  | { status: "invalid"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

export const joinWaitlist = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const raw = (data ?? {}) as Record<string, unknown>;
    const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
    return {
      email: asString(raw.email) ?? "",
      name: asString(raw.name),
      businessType: asString(raw.businessType),
    };
  })
  .handler(async ({ data }): Promise<WaitlistState> => {
    const { addToWaitlist } = await import("~/lib/waitlist-server");
    return addToWaitlist(data);
  });
