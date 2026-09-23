/**
 * Provider payload → the normalised model. One mapping per network, per shape.
 *
 * This is the half of the spine that can be built and tested without a platform
 * account: every function here takes the JSON a network's documented endpoint
 * returns and produces a `SocialPost` / `SocialComment` / `SocialMessage` /
 * `AnalyticsSnapshot`, or **`null`** when the payload is not recognisable. It never
 * invents a value: a missing field stays `null`, an unparsable timestamp makes the
 * whole record unrecognisable, and a metric the network did not send is not
 * reported rather than zero.
 *
 * Two honest caveats, both repeated on the page that renders this data:
 *
 *   - the field names come from the vendors' published documentation (Meta Graph,
 *     LinkedIn REST, X API v2). **Nothing here has been run against a live API**,
 *     because no platform credentials exist yet. The self-test drives each mapping
 *     with a documented payload, which proves the mapping is faithful to the
 *     documented shape — not that the shape is still current.
 *   - `origin` is carried through from the caller. Live reads pass `"live"`; the
 *     built-in sample set is mapped through these same functions with
 *     `origin: "sample"`, so the sample cannot drift from the real pipeline's
 *     shape.
 *
 * Pure functions: no `process.env`, no socket, no clock beyond what is passed in.
 */
import type {
  AnalyticsSnapshot,
  PostAnalytics,
  SocialComment,
  SocialMessage,
  SocialNetwork,
  SocialOrigin,
  SocialPost,
} from "~/lib/social/types";

/** Everything a mapping may need beyond the payload itself. */
export type NormaliseContext = {
  /** The handle the read ran as, when the network did not echo it per record. */
  accountHandle?: string;
  origin?: SocialOrigin;
  /** Injected so a test is deterministic. */
  now?: Date;
};

/* --------------------------------- helpers -------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return asArray(value)
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null);
}

/** A non-empty string, trimmed. Anything else (including numbers) is null. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A finite number from a number or a numeric string. Never coerces junk to NaN. */
function count(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Seconds or milliseconds since the epoch → ISO, or null. */
function isoFromEpoch(value: unknown): string | null {
  const seconds = count(value);
  if (seconds === null) return null;
  const ms = seconds > 1e11 ? seconds : seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** An ISO 8601 string → ISO, or null. Anything else makes the record unusable. */
function isoFromString(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The one time format the product shows, UTC, matching the inbox pages. */
export function whenLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** A public counter: a number, or null when the network did not report it. */
function metric(value: unknown): number | null {
  return count(value);
}

function origin(context: NormaliseContext): SocialOrigin {
  return context.origin ?? "sample";
}

/** True when a body reads like something a person is waiting on an answer to. */
export function looksLikeItNeedsReply(body: string): boolean {
  return /\?|can you|could you|any chance|still waiting|when will|how much|quote|price|book|available|help/i.test(
    body,
  );
}

/* ------------------------------ Instagram -------------------------------- */

/** A Graph media node: `{ id, caption, permalink, timestamp, like_count, comments_count }`. */
function instagramPost(raw: unknown, context: NormaliseContext): SocialPost | null {
  const node = asRecord(raw);
  if (!node) return null;
  const id = text(node.id);
  const postedAt = isoFromString(node.timestamp) ?? isoFromEpoch(node.timestamp);
  if (!id || !postedAt) return null;
  return {
    id,
    network: "instagram",
    accountHandle: text(node.username) ?? context.accountHandle ?? "",
    body: text(node.caption) ?? "",
    permalinkLabel: text(node.permalink) ? "permalink on Instagram" : "not reported",
    postedAt,
    postedAtLabel: whenLabel(postedAt),
    metrics: {
      likes: metric(node.like_count),
      comments: metric(node.comments_count),
      shares: null,
    },
    origin: origin(context),
  };
}

/** A Graph comment node: `{ id, text, username, timestamp }`. */
function instagramComment(raw: unknown, context: NormaliseContext): SocialComment | null {
  const node = asRecord(raw);
  if (!node) return null;
  const id = text(node.id);
  const receivedAt = isoFromString(node.timestamp) ?? isoFromEpoch(node.timestamp);
  const body = text(node.text);
  if (!id || !receivedAt || !body) return null;
  return {
    id,
    network: "instagram",
    postId: text(node.mediaId) ?? text(node.media_id) ?? "",
    author: text(node.username) ?? "unknown account",
    body,
    receivedAt,
    receivedAtLabel: whenLabel(receivedAt),
    needsReply: looksLikeItNeedsReply(body),
    origin: origin(context),
  };
}

/** A Messenger message row: `{ id, message, from: { username }, created_time }`. */
function instagramMessage(raw: unknown, context: NormaliseContext): SocialMessage | null {
  const node = asRecord(raw);
  if (!node) return null;
  const id = text(node.id);
  const receivedAt = isoFromEpoch(node.created_time) ?? isoFromString(node.created_time);
  const body = text(node.message) ?? text(node.text);
  if (!id || !receivedAt || !body) return null;
  const from = asRecord(node.from);
  return {
    id,
    network: "instagram",
    from: text(from?.username) ?? text(from?.name) ?? text(node.from) ?? "unknown account",
    body,
    receivedAt,
    receivedAtLabel: whenLabel(receivedAt),
    needsReply: looksLikeItNeedsReply(body),
    origin: origin(context),
  };
}

/* ------------------------------- LinkedIn -------------------------------- */

/** An organisation share: `{ id, commentary, createdAt, author }` (+ its socialActions). */
function linkedinPost(raw: unknown, context: NormaliseContext): SocialPost | null {
  const node = asRecord(raw);
  if (!node) return null;
  const id = text(node.id);
  const postedAt = isoFromEpoch(node.createdAt) ?? isoFromEpoch(node.created) ?? isoFromString(node.createdAt);
  if (!id || !postedAt) return null;
  const actions = asRecord(node.socialActions) ?? asRecord(node.metrics);
  return {
    id,
    network: "linkedin",
    accountHandle: text(node.authorHandle) ?? context.accountHandle ?? "",
    body: text(node.commentary) ?? text(node.text) ?? "",
    permalinkLabel: text(node.permalink) ? "permalink on LinkedIn" : "not reported",
    postedAt,
    postedAtLabel: whenLabel(postedAt),
    metrics: {
      likes: metric(actions?.likeCount),
      comments: metric(actions?.commentCount),
      shares: metric(actions?.shareCount),
    },
    origin: origin(context),
  };
}

/** A comment: `{ id, comment, created: { time }, actor }`. */
function linkedinComment(raw: unknown, context: NormaliseContext): SocialComment | null {
  const node = asRecord(raw);
  if (!node) return null;
  const id = text(node.id);
  const created = asRecord(node.created);
  const receivedAt = isoFromEpoch(created?.time) ?? isoFromEpoch(node.createdAt);
  const body = text(node.comment) ?? text(node.message);
  if (!id || !receivedAt || !body) return null;
  const actor = text(node.authorName) ?? urnTail(text(node.actor)) ?? "unknown account";
  return {
    id,
    network: "linkedin",
    postId: text(node.postId) ?? "",
    author: actor,
    body,
    receivedAt,
    receivedAtLabel: whenLabel(receivedAt),
    needsReply: looksLikeItNeedsReply(body),
    origin: origin(context),
  };
}

/**
 * A LinkedIn message. Kept for shape-completeness: LinkedIn's messaging API is
 * partner-only, so the adapter declares DM reading unavailable rather than
 * pretending a read exists (see `~/lib/social/registry`).
 */
function linkedinMessage(raw: unknown, context: NormaliseContext): SocialMessage | null {
  const node = asRecord(raw);
  if (!node) return null;
  const id = text(node.id);
  const created = asRecord(node.created);
  const receivedAt = isoFromEpoch(created?.time) ?? isoFromEpoch(node.createdAt);
  const body = text(node.body) ?? text(node.message);
  if (!id || !receivedAt || !body) return null;
  return {
    id,
    network: "linkedin",
    from: text(node.authorName) ?? urnTail(text(node.from)) ?? "unknown account",
    body,
    receivedAt,
    receivedAtLabel: whenLabel(receivedAt),
    needsReply: looksLikeItNeedsReply(body),
    origin: origin(context),
  };
}

/* ----------------------------------- X ----------------------------------- */

/** A v2 tweet: `{ data: { id, text, created_at, public_metrics } }` or the tweet itself. */
function xPost(raw: unknown, context: NormaliseContext): SocialPost | null {
  const envelope = asRecord(raw);
  const node = asRecord(envelope?.data) ?? envelope;
  if (!node) return null;
  const id = text(node.id);
  const postedAt = isoFromString(node.created_at);
  if (!id || !postedAt) return null;
  const metrics = asRecord(node.public_metrics);
  return {
    id,
    network: "x",
    accountHandle: text(node.authorHandle) ?? context.accountHandle ?? "",
    body: text(node.text) ?? "",
    permalinkLabel: id ? "permalink on X" : "not reported",
    postedAt,
    postedAtLabel: whenLabel(postedAt),
    metrics: {
      likes: metric(metrics?.like_count),
      comments: metric(metrics?.reply_count),
      shares: metric(metrics?.retweet_count),
    },
    origin: origin(context),
  };
}

/** A v2 reply: a tweet node plus `includes.users` for the handle. */
function xComment(raw: unknown, context: NormaliseContext): SocialComment | null {
  const envelope = asRecord(raw);
  const node = asRecord(envelope?.data) ?? envelope;
  if (!node) return null;
  const id = text(node.id);
  const receivedAt = isoFromString(node.created_at);
  const body = text(node.text);
  if (!id || !receivedAt || !body) return null;
  const authorId = text(node.author_id);
  return {
    id,
    network: "x",
    postId: text(node.conversation_id) ?? "",
    author: handleFromIncludes(envelope?.includes, authorId) ?? authorId ?? "unknown account",
    body,
    receivedAt,
    receivedAtLabel: whenLabel(receivedAt),
    needsReply: looksLikeItNeedsReply(body),
    origin: origin(context),
  };
}

/** A v2 DM event: `{ data: { id, text, created_at, sender_id } }` + `includes.users`. */
function xMessage(raw: unknown, context: NormaliseContext): SocialMessage | null {
  const envelope = asRecord(raw);
  const node = asRecord(envelope?.data) ?? envelope;
  if (!node) return null;
  const id = text(node.id);
  const receivedAt = isoFromString(node.created_at);
  const body = text(node.text);
  if (!id || !receivedAt || !body) return null;
  const senderId = text(node.sender_id);
  return {
    id,
    network: "x",
    from: handleFromIncludes(envelope?.includes, senderId) ?? senderId ?? "unknown account",
    body,
    receivedAt,
    receivedAtLabel: whenLabel(receivedAt),
    needsReply: looksLikeItNeedsReply(body),
    origin: origin(context),
  };
}

/** The `@handle` for a user id out of an X `includes.users` expansion. */
function handleFromIncludes(includes: unknown, userId: string | null): string | null {
  if (!userId) return null;
  for (const user of asRecordArray(asRecord(includes)?.users)) {
    if (text(user.id) === userId) {
      const username = text(user.username);
      if (username) return username.startsWith("@") ? username : `@${username}`;
      return text(user.name);
    }
  }
  return null;
}

/** The last segment of a LinkedIn URN (`urn:li:person:abc` → `abc`). */
function urnTail(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split(":");
  return parts[parts.length - 1] ?? null;
}

/* ------------------------------- analytics -------------------------------- */

/**
 * One number out of an insights envelope. Handles both documented shapes:
 * `{ data: [ { name, values: [ { value } ] } ] }` (Meta) and `{ name: value }`
 * (X's `public_metrics`, or a pre-flattened object). Absent → null.
 */
function insightNumber(payload: unknown, name: string): number | null {
  const node = asRecord(payload);
  if (!node) return null;
  const direct = count(node[name]);
  if (direct !== null) return direct;

  for (const row of asRecordArray(node.data)) {
    if (text(row.name) !== name) continue;
    const values = asRecordArray(row.values);
    const fromValues = values.length > 0 ? count(values[values.length - 1]?.value) : null;
    return fromValues ?? count(row.value);
  }
  return null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function perPost(raw: unknown): PostAnalytics[] {
  const rows: PostAnalytics[] = [];
  for (const item of asRecordArray(raw)) {
    const postId = text(item.id) ?? text(item.postId);
    const reach = count(item.reach) ?? count(item.impression_count) ?? count(item.impressions);
    if (!postId || reach === null || reach <= 0) continue;
    const interactions =
      (count(item.like_count) ?? count(item.likes) ?? 0) +
      (count(item.comments_count) ?? count(item.comments) ?? 0) +
      (count(item.share_count) ?? count(item.shares) ?? 0);
    rows.push({ postId, reach, engagementRatePct: round((interactions / reach) * 100, 1) });
  }
  return rows;
}

/**
 * The three analytics shapes, mapped onto one view model. Each takes the vendor's
 * documented envelope plus (for a live read) the account's own counters. `reach`
 * and `followers` stay null when the payload does not carry them.
 *
 * `responseMinutes` is passed in by the caller: it is the only metric that cannot
 * be read out of a single insights response (it is derived from thread timestamps),
 * and the built-in sample supplies its own value.
 */
function buildSnapshot(
  network: SocialNetwork,
  context: NormaliseContext,
  parts: {
    followers: number | null;
    reach: number | null;
    posts: unknown;
    responseMinutes?: number | null;
  },
): AnalyticsSnapshot {
  const capturedAt = (context.now ?? new Date()).toISOString();
  const posts = perPost(parts.posts);
  const weighted = posts.length > 0
    ? round(posts.reduce((sum, row) => sum + row.engagementRatePct, 0) / posts.length, 1)
    : null;
  return {
    network,
    origin: origin(context),
    capturedAt,
    capturedAtLabel: whenLabel(capturedAt),
    followers: parts.followers,
    reach: parts.reach,
    perPost: posts,
    engagementRatePct: weighted,
    medianResponseMinutes: parts.responseMinutes ?? null,
  };
}

function instagramAnalytics(raw: unknown, context: NormaliseContext): AnalyticsSnapshot {
  const node = asRecord(raw);
  return buildSnapshot("instagram", context, {
    followers: insightNumber(node?.insights ?? node, "follower_count"),
    reach: insightNumber(node?.insights ?? node, "reach"),
    posts: node?.media,
    responseMinutes: median(
      asArray(node?.responseMinutes).map((value) => count(value)).filter((v): v is number => v !== null),
    ),
  });
}

function linkedinAnalytics(raw: unknown, context: NormaliseContext): AnalyticsSnapshot {
  const node = asRecord(raw);
  return buildSnapshot("linkedin", context, {
    followers: insightNumber(node?.followers ?? node, "followerCount"),
    reach: insightNumber(node?.insights ?? node, "impressionCount"),
    posts: node?.elements ?? node?.posts,
    responseMinutes: median(
      asArray(node?.responseMinutes).map((value) => count(value)).filter((v): v is number => v !== null),
    ),
  });
}

function xAnalytics(raw: unknown, context: NormaliseContext): AnalyticsSnapshot {
  const node = asRecord(raw);
  const metrics = asRecord(node?.public_metrics) ?? node;
  return buildSnapshot("x", context, {
    followers: insightNumber(metrics, "followers_count"),
    reach: insightNumber(node?.non_public_metrics ?? node?.insights ?? node, "impressions"),
    posts: node?.tweets ?? node?.data,
    responseMinutes: median(
      asArray(node?.responseMinutes).map((value) => count(value)).filter((v): v is number => v !== null),
    ),
  });
}

/* -------------------------------- registry -------------------------------- */

export type Normalisers = {
  post: (raw: unknown, context: NormaliseContext) => SocialPost | null;
  comment: (raw: unknown, context: NormaliseContext) => SocialComment | null;
  message: (raw: unknown, context: NormaliseContext) => SocialMessage | null;
  analytics: (raw: unknown, context: NormaliseContext) => AnalyticsSnapshot;
};

/**
 * One mapping per network, per shape. A provider is added by implementing one of
 * these and registering it — nothing above this layer changes.
 */
export const NORMALISERS: Record<SocialNetwork, Normalisers> = {
  instagram: {
    post: instagramPost,
    comment: instagramComment,
    message: instagramMessage,
    analytics: instagramAnalytics,
  },
  linkedin: {
    post: linkedinPost,
    comment: linkedinComment,
    message: linkedinMessage,
    analytics: linkedinAnalytics,
  },
  x: {
    post: xPost,
    comment: xComment,
    message: xMessage,
    analytics: xAnalytics,
  },
};
