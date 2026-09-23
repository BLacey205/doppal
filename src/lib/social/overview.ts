/**
 * The `/social` view model, built without a server function.
 *
 * `~/lib/social/views` wraps `socialOverview()` in `createServerFn` for the page;
 * the self-test calls this function directly, so the object the test asserts on is
 * the same object the page renders — not a hand-made lookalike.
 *
 * Server-only by construction: it reads credential *names* (through the registry)
 * and never a value, and it makes no network call at all. The only way anything here
 * becomes `connected` is evidence the process recorded earlier — see
 * `~/lib/social/evidence`.
 */
import type {
  AnalyticsSnapshot,
  NetworkConnection,
  ReplyTarget,
  SocialCapabilities,
  SocialComment,
  SocialMessage,
  SocialNetwork,
  SocialPost,
  SocialReplyDraft,
} from "~/lib/social/types";
import { SOCIAL_CAPABILITIES } from "~/lib/social/types";

/** One network's labelled sample feed, plus every target the composer can aim at. */
export type SocialFeed = {
  network: SocialNetwork;
  label: string;
  posts: SocialPost[];
  comments: SocialComment[];
  messages: SocialMessage[];
  analytics: AnalyticsSnapshot;
  targets: ReplyTarget[];
};

export type SocialOverview = {
  ok: boolean;
  message?: string;
  capabilities: SocialCapabilities;
  networks: NetworkConnection[];
  feeds: SocialFeed[];
  drafts: SocialReplyDraft[];
  /** Exactly what the sample data on the page is, in words the page shows. */
  sample: { label: string; note: string };
  /** Whether drafts outlive this server process, and why. */
  draftStorage: { label: string; note: string };
  /** Where the provider field mappings come from — and what has not been proven. */
  mappingNote: string;
  /** Whether the machine read endpoint is armed. Name only, never a value. */
  readTokenConfigured: boolean;
};

/** Drafts are in-memory for now; the page says so rather than implying storage. */
export const DRAFT_STORAGE = {
  label: "Drafts last for this session",
  note: "A saved draft is held in the server's memory and disappears when it restarts — no database is holding it yet. Nothing is ever sent from here: you copy the text out and send it yourself.",
};

export const MAPPING_NOTE =
  "Each network's fields are mapped from that platform's published documentation, and the self-test drives every mapping with a documented payload. None of them has been exercised against a live API, because no developer app has been approved yet.";

export const OVERVIEW_FAILED_MESSAGE =
  "Doppel couldn't put the social view together just now. Nothing was read from any network.";

export async function socialOverview(): Promise<SocialOverview> {
  // Server-only: reads process.env for credential *names*, and outbound fetch.
  const { networkConnections } = await import("~/lib/social/registry");
  const { buildSocialSamples, replyTargetsFor, SAMPLE_LABEL, SAMPLE_NOTE } = await import(
    "~/lib/social/sample"
  );
  const { listReplyDrafts } = await import("~/lib/social/replies");
  const { socialReadConfigured } = await import("~/lib/social/guard");

  const base = {
    capabilities: SOCIAL_CAPABILITIES,
    sample: { label: SAMPLE_LABEL, note: SAMPLE_NOTE },
    draftStorage: DRAFT_STORAGE,
    mappingNote: MAPPING_NOTE,
  };

  try {
    const samples = buildSocialSamples();
    const feeds: SocialFeed[] = samples.networks.map((network) => ({
      network: network.network,
      label: network.label,
      posts: network.posts,
      comments: network.comments,
      messages: network.messages,
      analytics: network.analytics,
      targets: replyTargetsFor(network),
    }));

    return {
      ok: true,
      ...base,
      networks: networkConnections(),
      feeds,
      drafts: listReplyDrafts(),
      readTokenConfigured: socialReadConfigured(),
    };
  } catch {
    return {
      ok: false,
      message: OVERVIEW_FAILED_MESSAGE,
      ...base,
      networks: [],
      feeds: [],
      drafts: [],
      readTokenConfigured: false,
    };
  }
}
