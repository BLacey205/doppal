/**
 * /social — the social gateway's face.
 *
 * Reached from the inbox nav. Everything it shows comes from `getSocialOverview()`
 * (server-side, so the data path is real and not a client fetch), and the page is a
 * thin wrapper: the nav, the loader, and the two actions the product allows —
 * save-as-draft and check-connection. There is no send action here because there is
 * nothing behind one.
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";

import { AppNav } from "~/components/app-ui";
import { SocialPageBody, type SocialActions } from "~/components/social-ui";
import { checkSocialNetwork, getSocialOverview, saveSocialReplyDraft } from "~/lib/social/views";
import type { ReplyTarget } from "~/lib/social/types";

export const Route = createFileRoute("/social")({
  head: () => ({
    meta: [
      { title: "Social — Doppel" },
      {
        name: "description",
        content:
          "Posts, comments, messages and analytics for the networks you run — with a reply drafted for you to send yourself. Drafts only: Doppel never posts, replies or sends a DM.",
      },
    ],
  }),
  loader: async () => await getSocialOverview(),
  component: SocialPage,
});

function SocialPage() {
  const view = Route.useLoaderData();
  const router = useRouter();

  const actions: SocialActions = {
    saveDraft: async (target: ReplyTarget, body: string) => {
      try {
        const result = await saveSocialReplyDraft({
          data: {
            network: target.network,
            targetKind: target.kind,
            targetId: target.id,
            body,
          },
        });
        if (result.ok) await router.invalidate();
        return result;
      } catch {
        return { ok: false, message: "That didn't reach the server — nothing was saved. Please try again." };
      }
    },
    checkNetwork: async (network: string) => {
      try {
        const result = await checkSocialNetwork({ data: { network } });
        await router.invalidate();
        return result;
      } catch {
        return { ok: false, message: "That didn't reach the server, so no check was made." };
      }
    },
  };

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
      <AppNav current="social" />
      <SocialPageBody view={view} actions={actions} />
    </main>
  );
}
