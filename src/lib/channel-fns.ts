/**
 * The client-callable server functions behind the /app Connections card.
 *
 * Same shape as `~/lib/inbox`: `GET` for reads, `POST` for the check (so a gateway
 * retry cannot surprise us), and the server-only modules imported *inside* the
 * handler so no env-reading code is ever bundled for the browser. Both return a
 * wrapped object — the framework's server-fn contract wants an object payload.
 *
 * Both handlers return plain, string-only view objects — env var NAMES, typed
 * codes, sentences and timestamps. No secret value ever crosses this boundary.
 */
import { createServerFn } from "@tanstack/react-start";

import type { ChannelStatus } from "~/lib/channels";

/** What the Connections card shows, straight from the adapters and the evidence. */
export const getChannels = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ channels: ChannelStatus[] }> => {
    const { channelStatuses } = await import("~/lib/channels");
    return { channels: channelStatuses() };
  },
);

/**
 * "Check now": run every channel's check through the same handlers the real routes
 * call, record the outcomes as evidence, and return the fresh statuses. The check
 * proves the route's honesty and its refusal of unsigned mail — never a connection.
 */
export const runChannelsCheck = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ channels: ChannelStatus[] }> => {
    const { runChannelChecks } = await import("~/lib/channels");
    return { channels: await runChannelChecks() };
  },
);
