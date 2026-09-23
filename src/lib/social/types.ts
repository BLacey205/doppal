/**
 * The normalised social model — one shape per thing every network has, so nothing
 * above this layer has to know Instagram's JSON from X's.
 *
 * Three rules hold everywhere in this module:
 *
 *   1. **Timestamps cross as strings.** ISO plus a pre-formatted label, never a
 *      `Date` — React refuses to render a `Date`, and the app's other pages
 *      (see `~/lib/inbox-types`) already follow this.
 *   2. **Every record carries where it came from** (`origin`): `"sample"` for the
 *      built-in set we ship, `"live"` only for data a real API call returned in
 *      this process. There is no third option, so a number can never be shown
 *      without saying which it is.
 *   3. **There is no "sent" state.** `SocialReplyDraftState` is exactly `"draft"`.
 *      Adding a `"sent"` variant would create the only code path that could post
 *      as the owner, and this product deliberately has none.
 *
 * Pure types and constants only: this file is imported by React components, so it
 * must never read `process.env`, open a socket or pull in a database handle.
 */
import type { AiMode } from "~/lib/inbox-types";

/** The networks the gateway is written for. */
export type SocialNetwork = "instagram" | "linkedin" | "x";

export const SOCIAL_NETWORKS: readonly SocialNetwork[] = ["instagram", "linkedin", "x"];

/** Display names — kept here (not in the registry) because components render them. */
export const NETWORK_LABELS: Record<SocialNetwork, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  x: "X",
};

export function isSocialNetwork(value: unknown): value is SocialNetwork {
  return typeof value === "string" && (SOCIAL_NETWORKS as readonly string[]).includes(value);
}

/**
 * Where a piece of data came from. `"sample"` is the built-in set in
 * `~/lib/social/sample`; `"live"` means a network call returned it in this process.
 */
export type SocialOrigin = "sample" | "live";

/**
 * What we know about a network's connection — configuration *and* evidence, kept
 * apart, exactly like the storage line on `/app` (see `~/lib/storage-evidence`):
 *
 *   - `unconfigured` — the credentials this network needs are not all present;
 *     nothing is read from it and nothing may claim otherwise;
 *   - `unverified`   — the credentials are present, but no call has come back in
 *     this process, so a connection is **not** claimed;
 *   - `connected`    — a real API call returned data in this process. The only
 *     state allowed to say the network is connected;
 *   - `failed`       — a call was refused or threw; this sticks for the life of the
 *     process, and later successes do not clear it.
 */
export type ConnectionState = "unconfigured" | "unverified" | "connected" | "failed";

/** A network account as this app knows it. */
export type SocialAccount = {
  network: SocialNetwork;
  /** The handle a returned API call reported. Never guessed from configuration. */
  handle: string;
  displayName: string | null;
  state: ConnectionState;
  /** ISO string of the call that proved it, or null while unproven. */
  verifiedAt: string | null;
};

/**
 * The public counters on a post. Each is `number | null`: `null` means the network
 * did not report it (or the mapping could not read it), and it is shown as "not
 * reported" rather than as a zero we made up.
 */
export type PostMetrics = {
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

export type SocialPost = {
  id: string;
  network: SocialNetwork;
  accountHandle: string;
  body: string;
  /** Human label for where it lives, e.g. "instagram.com/p/…". Never a token. */
  permalinkLabel: string;
  postedAt: string;
  postedAtLabel: string;
  metrics: PostMetrics;
  origin: SocialOrigin;
};

export type SocialComment = {
  id: string;
  network: SocialNetwork;
  postId: string;
  author: string;
  body: string;
  receivedAt: string;
  receivedAtLabel: string;
  /** True when the message reads like something a person is waiting on an answer to. */
  needsReply: boolean;
  origin: SocialOrigin;
};

/** A direct message. Read-only in this build: Doppel never replies into a DM thread. */
export type SocialMessage = {
  id: string;
  network: SocialNetwork;
  /** The person who wrote in. */
  from: string;
  body: string;
  receivedAt: string;
  receivedAtLabel: string;
  needsReply: boolean;
  origin: SocialOrigin;
};

/** One post's share of an analytics snapshot. */
export type PostAnalytics = {
  postId: string;
  reach: number;
  /** Interactions as a percentage of reach, one decimal place. */
  engagementRatePct: number;
};

/**
 * A normalised analytics view model: the few numbers this product actually talks
 * about, per network, with the shape every network's insights endpoint is mapped
 * onto.
 *
 * `null` is a real answer and is shown as "not reported": a metric the network did
 * not return (or that our mapping cannot derive) must never be filled with a guess.
 */
export type AnalyticsSnapshot = {
  network: SocialNetwork;
  origin: SocialOrigin;
  /** ISO plus label: when this snapshot describes. */
  capturedAt: string;
  capturedAtLabel: string;
  followers: number | null;
  /** Accounts reached in the window. */
  reach: number | null;
  /** Interactions (likes + comments + shares) per post, worst-to-best as returned. */
  perPost: PostAnalytics[];
  /** Mean engagement rate across the posts in this snapshot, or null. */
  engagementRatePct: number | null;
  /** Typical time to answer a DM or comment, in minutes. Null when unmeasurable. */
  medianResponseMinutes: number | null;
};

/** Where a reply is aimed. */
export type SocialReplyTargetKind = "post" | "comment" | "dm";

export const SOCIAL_REPLY_TARGET_KINDS: readonly SocialReplyTargetKind[] = [
  "post",
  "comment",
  "dm",
];

export function isReplyTargetKind(value: unknown): value is SocialReplyTargetKind {
  return typeof value === "string" && (SOCIAL_REPLY_TARGET_KINDS as readonly string[]).includes(value);
}

/**
 * The only state a reply can be in. There is deliberately **no** `"sent"`, and the
 * constant below is what the runtime validates against — so a stored value that is
 * not a draft is rejected rather than rendered.
 */
export type SocialReplyDraftState = "draft";

export const SOCIAL_REPLY_DRAFT_STATES: readonly SocialReplyDraftState[] = ["draft"];

export function isReplyDraftState(value: unknown): value is SocialReplyDraftState {
  return value === "draft";
}

/**
 * A reply Doppel has written for the owner to review. It is labelled with what
 * produced it (model or built-in rules) — the same provenance rule the inbox
 * drafts follow — and it is never presented as the owner's own words.
 */
export type SocialReplyDraft = {
  id: string;
  network: SocialNetwork;
  targetKind: SocialReplyTargetKind;
  targetId: string;
  /** What the reply is answering, for the draft list. */
  targetLabel: string;
  body: string;
  state: SocialReplyDraftState;
  /** Who produced the text: a model, or the built-in rules. */
  mode: AiMode;
  provider: string;
  /** Human label, e.g. "Built-in rules (reply suggestion)". */
  provenanceLabel: string;
  updatedAt: string;
  updatedAtLabel: string;
};

/**
 * What this build can do with a network. Frozen to `false` for every outbound
 * action on purpose: there is no code path that posts, replies or DMs, so the page
 * cannot advertise one by accident.
 */
export type SocialCapabilities = {
  canDraft: true;
  canCopy: true;
  canPost: false;
  canReplyInThread: false;
  canSendDirectMessage: false;
  /** One sentence, safe to show the owner. */
  sentence: string;
};

export const SOCIAL_CAPABILITIES: SocialCapabilities = {
  canDraft: true,
  canCopy: true,
  canPost: false,
  canReplyInThread: false,
  canSendDirectMessage: false,
  sentence:
    "Doppel writes the reply and you send it. There is no send button here and no code path that posts, replies or sends a direct message as you.",
};

/**
 * One network's card on `/social`: what it needs, what state it is in, and why.
 *
 * `credentialNames` and `missingCredentials` are **environment-variable names only**.
 * No secret value, token, ID or account handle produced by configuration is ever
 * put in this object — a card can say `META_ACCESS_TOKEN` is missing without
 * anything about that token existing outside the process that read it.
 */
export type NetworkConnection = {
  network: SocialNetwork;
  label: string;
  state: ConnectionState;
  /** The account, only when a returned call proved it. Null otherwise. */
  account: SocialAccount | null;
  /** Every env-var name this network needs, whether or not it is set. */
  credentialNames: string[];
  /** What each of those names is for, in the owner's language. Names and roles only. */
  credentialRoles: Record<string, string>;
  /** The subset that is absent right now. Names only. */
  missingCredentials: string[];
  /** The shape each read is available in, and the reason when it isn't. */
  reads: { shape: "posts" | "comments" | "messages" | "analytics"; available: boolean; note: string | null }[];
  /** One plain sentence saying exactly what this state means. */
  summary: string;
  /** What the platform itself requires before connecting (approval, permissions). */
  approval: string;
  /** The permissions an approved app would hold, named as the platform names them. */
  permissions: string[];
  /** Where the mapping and the permission list come from. */
  docsUrl: string;
  /** ISO string of the last state change this process observed, or null. */
  checkedAt: string | null;
};

/**
 * A suggestion for one reply target. `mode`/`provider` are the provenance of the
 * text; the UI shows them next to the box so nothing reads as the owner's words.
 */
export type ReplySuggestion = {
  network: SocialNetwork;
  targetKind: SocialReplyTargetKind;
  targetId: string;
  body: string;
  mode: AiMode;
  provider: string;
  label: string;
};

/** One labelled bundle of built-in sample data for a network. */
export type NetworkSample = {
  network: SocialNetwork;
  label: string;
  posts: SocialPost[];
  comments: SocialComment[];
  messages: SocialMessage[];
  analytics: AnalyticsSnapshot;
  suggestions: ReplySuggestion[];
};

/**
 * One reply target the composer can be aimed at: a sample post, comment or DM.
 * Built on the server so the page never has to know where the list came from.
 */
export type ReplyTarget = {
  kind: SocialReplyTargetKind;
  id: string;
  network: SocialNetwork;
  label: string;
  /** The text being answered, so the composer shows the context. */
  excerpt: string;
};
