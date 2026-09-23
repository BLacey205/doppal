/**
 * The built-in social sample set: what `/social` shows while nothing is connected.
 *
 * Why this exists: with no platform credentials there is no audience data to read,
 * and a page of empty boxes teaches the owner nothing. So — exactly as `/app` does
 * with its five-message sample inbox — this module ships a small, realistic set and
 * the page labels every record as sample data, on the record and on the page.
 *
 * The set is built as **raw provider payloads** (the documented Meta Graph,
 * LinkedIn REST and X API v2 shapes) and pushed through the real mappings in
 * `~/lib/social/normalise` with `origin: "sample"`. Two things fall out of that:
 * the sample cannot drift from the shape the live read will produce, and every
 * value carries `origin: "sample"` so no view can render it without a label.
 *
 * Timestamps are relative to `now`, so the sample never goes stale. Nothing in here
 * is a real number, a real handle or a real person: the accounts are invented and
 * the people are invented, and no part of this set is ever presented as the owner's
 * audience. Nothing here talks to a network.
 */
import { NORMALISERS } from "~/lib/social/normalise";
import { suggestReply } from "~/lib/social/replies";
import type {
  NetworkSample,
  ReplySuggestion,
  ReplyTarget,
  SocialOrigin,
  SocialNetwork,
} from "~/lib/social/types";
import { NETWORK_LABELS, SOCIAL_NETWORKS } from "~/lib/social/types";

/** The one label the page and every record use for this data. */
export const SAMPLE_ORIGIN: SocialOrigin = "sample";
export const SAMPLE_LABEL = "Sample data";
export const SAMPLE_NOTE =
  "Nothing is connected yet, so everything below is Doppel's built-in sample set — written by us, not read from your accounts. None of these accounts, numbers or messages are yours.";

export type SocialSampleSet = {
  origin: SocialOrigin;
  label: string;
  note: string;
  networks: NetworkSample[];
};

const hoursAgo = (now: Date, hours: number): string => new Date(now.getTime() - hours * 3_600_000).toISOString();
const daysAgo = (now: Date, days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString();
const epochMs = (iso: string): number => new Date(iso).getTime();
const epochSeconds = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

function instagramSample(now: Date): NetworkSample {
  const rawPosts = [
    {
      id: "ig-media-17940112345678901",
      caption:
        "Second fix finished in Redland this morning — new consumer unit, three circuits tidied up, certificate issued before we left.",
      permalink: "https://www.instagram.com/p/example-1",
      timestamp: daysAgo(now, 2),
      like_count: 128,
      comments_count: 9,
    },
    {
      id: "ig-media-17940112345678902",
      caption: "Van's got a new stock run for the winter call-outs. Same number, same two-hour response.",
      permalink: "https://www.instagram.com/p/example-2",
      timestamp: daysAgo(now, 6),
      like_count: 74,
      comments_count: 4,
    },
  ];

  const rawComments = [
    {
      id: "ig-comment-1",
      text: "Do you cover Bedminster? We need a quote for a rewire next month.",
      username: "sam_at_no42",
      timestamp: hoursAgo(now, 5),
      mediaId: rawPosts[0]!.id,
    },
    {
      id: "ig-comment-2",
      text: "Looks tidy. What's the waiting list like at the moment?",
      username: "hannahb_plumbing",
      timestamp: hoursAgo(now, 30),
      mediaId: rawPosts[1]!.id,
    },
  ];

  const rawMessages = [
    {
      id: "ig-message-1",
      message: "Hi — can you fit a small job in this week? Kitchen sockets tripping.",
      from: { username: "kirsty.redland" },
      created_time: epochSeconds(hoursAgo(now, 9)),
    },
  ];

  const rawAnalytics = {
    data: [
      { name: "follower_count", values: [{ value: 1840 }] },
      { name: "reach", values: [{ value: 9620 }] },
    ],
    media: [
      { id: rawPosts[0]!.id, reach: 4120, like_count: 128, comments_count: 9 },
      { id: rawPosts[1]!.id, reach: 2380, like_count: 74, comments_count: 4 },
    ],
    // Minutes between a first message and an answer, per thread, for the window.
    responseMinutes: [48, 96, 27],
  };

  const posts = rawPosts
    .map((raw) => NORMALISERS.instagram.post(raw, { origin: SAMPLE_ORIGIN, accountHandle: "sample.electrician" }))
    .filter((post): post is NonNullable<typeof post> => post !== null);

  return {
    network: "instagram",
    label: `${NETWORK_LABELS.instagram} — sample posts, comments, messages and insights`,
    posts,
    comments: rawComments
      .map((raw) => NORMALISERS.instagram.comment(raw, { origin: SAMPLE_ORIGIN }))
      .filter((row): row is NonNullable<typeof row> => row !== null),
    messages: rawMessages
      .map((raw) => NORMALISERS.instagram.message(raw, { origin: SAMPLE_ORIGIN }))
      .filter((row): row is NonNullable<typeof row> => row !== null),
    analytics: NORMALISERS.instagram.analytics(rawAnalytics, { origin: SAMPLE_ORIGIN, now }),
    suggestions: [],
  };
}

function linkedinSample(now: Date): NetworkSample {
  const rawPosts = [
    {
      id: "urn:li:share:7140112345678901248",
      commentary:
        "We've taken on a second van and an apprentice this month. Two call-outs a week became six, so it was that or start saying no.",
      createdAt: epochMs(daysAgo(now, 3)),
      authorHandle: "sample-service-business",
      socialActions: { likeCount: 96, commentCount: 14, shareCount: 6 },
    },
    {
      id: "urn:li:share:7140112345678901249",
      commentary: "A short note on why we now photograph every consumer unit before and after a job.",
      createdAt: epochMs(daysAgo(now, 11)),
      authorHandle: "sample-service-business",
      socialActions: { likeCount: 41, commentCount: 3, shareCount: 2 },
    },
  ];

  const rawComments = [
    {
      id: "urn:li:comment:7150112345678900001",
      comment: "Well done. Are you taking on commercial maintenance contracts as well?",
      created: { time: epochMs(hoursAgo(now, 8)) },
      actor: "urn:li:person:sample0001",
      authorName: "Priya (sample)",
      postId: rawPosts[0]!.id,
    },
    {
      id: "urn:li:comment:7150112345678900002",
      comment: "Would you share the checklist you use? We're trying to get ours consistent.",
      created: { time: epochMs(hoursAgo(now, 26)) },
      actor: "urn:li:person:sample0002",
      authorName: "Marcus (sample)",
      postId: rawPosts[1]!.id,
    },
  ];

  // LinkedIn's messaging API is partner-only, so a live DM read is declared
  // unavailable (see the adapter's `dmAccess`). The sample still shows the shape.
  const rawMessages = [
    {
      id: "urn:li:msg_message:sample0001",
      body: "Saw your post about the apprentice — we're looking for someone to take on our maintenance across two sites. Could we talk?",
      created: { time: epochMs(hoursAgo(now, 14)) },
      authorName: "Dan (sample)",
    },
  ];

  const rawAnalytics = {
    followers: { data: [{ name: "followerCount", values: [{ value: 1830 }] }] },
    insights: { data: [{ name: "impressionCount", values: [{ value: 9420 }] }] },
    elements: [
      { id: rawPosts[0]!.id, reach: 5210, like_count: 96, comments_count: 14, share_count: 6 },
      { id: rawPosts[1]!.id, reach: 2140, like_count: 41, comments_count: 3, share_count: 2 },
    ],
    responseMinutes: [180, 420, 95],
  };

  return {
    network: "linkedin",
    label: `${NETWORK_LABELS.linkedin} — sample organisation posts, comments, messages and insights`,
    posts: rawPosts
      .map((raw) => NORMALISERS.linkedin.post(raw, { origin: SAMPLE_ORIGIN }))
      .filter((post): post is NonNullable<typeof post> => post !== null),
    comments: rawComments
      .map((raw) => NORMALISERS.linkedin.comment(raw, { origin: SAMPLE_ORIGIN }))
      .filter((row): row is NonNullable<typeof row> => row !== null),
    messages: rawMessages
      .map((raw) => NORMALISERS.linkedin.message(raw, { origin: SAMPLE_ORIGIN }))
      .filter((row): row is NonNullable<typeof row> => row !== null),
    analytics: NORMALISERS.linkedin.analytics(rawAnalytics, { origin: SAMPLE_ORIGIN, now }),
    suggestions: [],
  };
}

function xSample(now: Date): NetworkSample {
  const rawPosts = [
    {
      id: "1810112345678901248",
      text: "Two call-outs before 9am. The kettle in the van is earning its keep this week.",
      created_at: daysAgo(now, 1),
      public_metrics: { like_count: 58, reply_count: 7, retweet_count: 4 },
    },
    {
      id: "1810112345678901249",
      text: "Reminder: if your RCD trips twice in a week, that's the house telling you something. Get it looked at.",
      created_at: daysAgo(now, 5),
      public_metrics: { like_count: 133, reply_count: 11, retweet_count: 22 },
    },
  ];

  const rawComments = [
    {
      data: {
        id: "1810112345678901301",
        text: "Any chance you'd come out to Keynsham? Same problem here.",
        created_at: hoursAgo(now, 4),
        conversation_id: rawPosts[0]!.id,
        author_id: "900000001",
        public_metrics: { like_count: 2, reply_count: 0, retweet_count: 0 },
      },
      includes: { users: [{ id: "900000001", username: "keynsham_dave", name: "Dave (sample)" }] },
    },
    {
      data: {
        id: "1810112345678901302",
        text: "What do you charge for a certificate these days?",
        created_at: hoursAgo(now, 22),
        conversation_id: rawPosts[1]!.id,
        author_id: "900000002",
      },
      includes: { users: [{ id: "900000002", username: "loft_conversion_kat", name: "Kat (sample)" }] },
    },
  ];

  const rawMessages = [
    {
      data: {
        id: "1810112345678901401",
        text: "Sent you a DM because the phone line was busy — do you do emergency call-outs on Sundays?",
        created_at: hoursAgo(now, 6),
        sender_id: "900000003",
      },
      includes: { users: [{ id: "900000003", username: "sunday_saver", name: "Jordan (sample)" }] },
    },
  ];

  const rawAnalytics = {
    public_metrics: { followers_count: 2140, following_count: 312, tweet_count: 1480 },
    non_public_metrics: { impressions: 41000 },
    tweets: [
      { id: rawPosts[0]!.id, impression_count: 8400, like_count: 58, comments_count: 7, share_count: 4 },
      { id: rawPosts[1]!.id, impression_count: 19200, like_count: 133, comments_count: 11, share_count: 22 },
    ],
    responseMinutes: [35, 150, 62],
  };

  return {
    network: "x",
    label: `${NETWORK_LABELS.x} — sample posts, replies, messages and insights`,
    posts: rawPosts
      .map((raw) => NORMALISERS.x.post(raw, { origin: SAMPLE_ORIGIN, accountHandle: "sample_electrician" }))
      .filter((post): post is NonNullable<typeof post> => post !== null),
    comments: rawComments
      .map((raw) => NORMALISERS.x.comment(raw, { origin: SAMPLE_ORIGIN }))
      .filter((row): row is NonNullable<typeof row> => row !== null),
    messages: rawMessages
      .map((raw) => NORMALISERS.x.message(raw, { origin: SAMPLE_ORIGIN }))
      .filter((row): row is NonNullable<typeof row> => row !== null),
    analytics: NORMALISERS.x.analytics(rawAnalytics, { origin: SAMPLE_ORIGIN, now }),
    suggestions: [],
  };
}

/**
 * Every post, comment and message the composer can be aimed at, with the text a
 * starting point. Built from the sample set, so the composer works before anything
 * is connected and never offers a target Doppel cannot see.
 */
export function replyTargetsFor(sample: NetworkSample): ReplyTarget[] {
  const excerpt = (body: string) => (body.length > 140 ? `${body.slice(0, 137)}…` : body);
  return [
    ...sample.posts.map((post) => ({
      kind: "post" as const,
      id: post.id,
      network: sample.network,
      label: `Post · ${post.postedAtLabel}`,
      excerpt: excerpt(post.body),
    })),
    ...sample.comments.map((comment) => ({
      kind: "comment" as const,
      id: comment.id,
      network: sample.network,
      label: `Comment from ${comment.author}`,
      excerpt: excerpt(comment.body),
    })),
    ...sample.messages.map((message) => ({
      kind: "dm" as const,
      id: message.id,
      network: sample.network,
      label: `Message from ${message.from}`,
      excerpt: excerpt(message.body),
    })),
  ];
}

/** The whole set, newest-relative-to-`now`, one entry per network. */
export function buildSocialSamples(now: Date = new Date()): SocialSampleSet {
  const builders: Record<SocialNetwork, (at: Date) => NetworkSample> = {
    instagram: instagramSample,
    linkedin: linkedinSample,
    x: xSample,
  };

  const networks = SOCIAL_NETWORKS.map((network) => {
    const sample = builders[network](now);
    const suggestions: ReplySuggestion[] = replyTargetsFor(sample).map(suggestReply);
    return { ...sample, suggestions };
  });

  return { origin: SAMPLE_ORIGIN, label: SAMPLE_LABEL, note: SAMPLE_NOTE, networks };
}
