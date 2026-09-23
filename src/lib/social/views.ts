/**
 * The server functions behind `/social`.
 *
 * Same shape as the inbox's (`~/lib/inbox`): `createServerFn({ method: "GET" })`
 * for the read, `{ method: "POST" }` for anything that changes state, and the
 * server-only modules imported *inside* the handler so no environment read or
 * socket-capable code is ever bundled for the browser. The view model itself lives
 * in `~/lib/social/overview` so the self-test can build the very same object the
 * page renders.
 *
 * Three functions, and deliberately no fourth:
 *
 *   - `getSocialOverview()` — the whole page view model: per-network cards, the
 *     labelled sample feeds, the reply targets and the drafts.
 *   - `saveSocialReplyDraft()` — saves a reply as a draft. There is no send
 *     function, no publish function and no "reply" function, because the product
 *     does not do those things.
 *   - `checkSocialNetwork()` — runs the verification call for one network and
 *     reports the resulting evidence-based state. With no credentials it returns the
 *     typed `not_configured` answer naming what is missing, and no network is
 *     contacted.
 *
 * Every handler returns a plain, stringified object and a human message — never a
 * throw — so a missing key shows a sentence, not a 500.
 */
import { createServerFn } from "@tanstack/react-start";

export type { SocialFeed, SocialOverview } from "~/lib/social/overview";

export type SocialActionResult = { ok: boolean; message: string; state?: string };

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

export const getSocialOverview = createServerFn({ method: "GET" }).handler(async () => {
  const { socialOverview } = await import("~/lib/social/overview");
  return await socialOverview();
});

export const saveSocialReplyDraft = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const raw = (data ?? {}) as Record<string, unknown>;
    return {
      network: asString(raw.network),
      targetKind: asString(raw.targetKind),
      targetId: asString(raw.targetId),
      body: asString(raw.body),
    };
  })
  .handler(async ({ data }): Promise<SocialActionResult> => {
    const { saveReplyDraft } = await import("~/lib/social/replies");
    const { buildSocialSamples, replyTargetsFor } = await import("~/lib/social/sample");
    const { isSocialNetwork, isReplyTargetKind } = await import("~/lib/social/types");

    if (!isSocialNetwork(data.network) || !isReplyTargetKind(data.targetKind)) {
      return { ok: false, message: "That isn't a post, comment or message Doppel can see — nothing was saved." };
    }

    // The only targets on offer are the ones on the page, so the lookup is built
    // from the same sample set the page rendered. Fail closed when it isn't found.
    const knownTargets = buildSocialSamples().networks.flatMap((network) => replyTargetsFor(network));
    const result = saveReplyDraft(
      {
        network: data.network,
        targetKind: data.targetKind,
        targetId: data.targetId,
        body: data.body,
      },
      {
        knownTarget: (target) =>
          knownTargets.find(
            (candidate) =>
              candidate.network === target.network &&
              candidate.kind === target.targetKind &&
              candidate.id === target.targetId,
          ) ?? null,
      },
    );

    return result.ok ? { ok: true, message: result.message } : { ok: false, message: result.message };
  });

export const checkSocialNetwork = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({ network: asString((data as { network?: unknown })?.network) }))
  .handler(async ({ data }): Promise<SocialActionResult> => {
    // Server-only: this is the one path that can make a real network call, and only
    // when the credentials it needs are actually present.
    const { SOCIAL_ADAPTERS, networkConnection, verifyNetwork } = await import("~/lib/social/registry");
    const { isSocialNetwork } = await import("~/lib/social/types");

    if (!isSocialNetwork(data.network)) {
      return { ok: false, message: "That isn't one of the networks Doppel supports." };
    }

    const result = await verifyNetwork(data.network);
    const card = networkConnection(SOCIAL_ADAPTERS[data.network]);
    return result.ok
      ? { ok: true, message: `${result.note} ${card.summary}`, state: card.state }
      : { ok: false, message: result.message, state: card.state };
  });
