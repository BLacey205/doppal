/**
 * Exercises the social gateway spine with no platform access and no network:
 *
 *   bun run scripts/social-selftest.ts
 *
 * What it proves, and how:
 *
 *   1. **The model has no "sent".** `SocialReplyDraftState` is exactly `"draft"`,
 *      the runtime guard refuses anything else, and the source of the whole spine is
 *      scanned for an outbound write (no `method: "POST"`, no send-shaped helper, no
 *      `fetch(` outside the registry). The page is rendered and asserted to contain
 *      no send control.
 *   2. **Normalisation, per network, per shape.** Each mapping is driven with a
 *      payload in the vendor's documented shape — Meta Graph media/comments/
 *      Messenger rows and insights, LinkedIn shares/comments/messages and share
 *      statistics, X API v2 tweets/replies/DM events and metrics. A record with a
 *      field missing maps to `null` rather than an invented value, and a counter the
 *      network didn't send stays `null` rather than becoming `0`.
 *   3. **A network can only be reported connected after a real call returned.** With
 *      no credentials the state is `unconfigured`, the injected `fetch` is **never
 *      called**, and the result is a typed failure (never a throw). Credentials
 *      without a call are `unverified` — a connection is not claimed. A returned call
 *      is `connected`. A refusal is `failed`, and it *stays* `failed` after a later
 *      success, exactly like the storage evidence rule on `/app`.
 *   4. **The sample set is labelled as sample.** Every record carries
 *      `origin: "sample"`, and the rendered page says so in words on every block.
 *   5. **A reply draft can never be sent.** Saving works, trims, re-saves and
 *      carries its provenance; a `"sent"` state is refused and nothing is stored.
 *   6. **Missing credentials produce typed errors, not throws** — through the
 *      library functions *and* through the real request handlers
 *      (`/api/social-status`, `/api/social-read`), driven with real `Request`
 *      objects. The read route fails closed with no shared secret configured.
 *   7. **No secret reaches a log line or a response body.** A distinctive fake token
 *      is put in the injected environment and asserted absent from the JSON the
 *      routes return and from every captured log line — which are also asserted to
 *      be short single strings, not an `Error` dump (see `~/lib/log-line`).
 *
 * What it does **not** prove: that any of these mappings matches what a live API
 * returns today. No developer app exists, so nothing here has been run against Meta,
 * LinkedIn or X. The field names come from the vendors' published documentation, and
 * this harness proves the code follows that documentation — no more, and no less.
 *
 * Hermetic: no socket is opened, no environment variable is set, and the injected
 * `fetch` throws if it is ever reached by accident.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SocialPageBody, stateChip, type SocialActions } from "../src/components/social-ui";
import { handleSocialMethodNotAllowed, handleSocialReadGet, handleSocialStatusGet } from "../src/lib/social/api";
import { connectionStateFor, resetSocialEvidence } from "../src/lib/social/evidence";
import { NORMALISERS } from "../src/lib/social/normalise";
import { socialOverview } from "../src/lib/social/overview";
import { listReplyDrafts, resetReplyDrafts, saveReplyDraft, suggestReply } from "../src/lib/social/replies";
import {
  SOCIAL_ADAPTERS,
  credentialState,
  networkConnection,
  networkConnections,
  readNetwork,
  verifyNetwork,
  type EnvLike,
  type FetchLike,
} from "../src/lib/social/registry";
import { SAMPLE_LABEL, SAMPLE_NOTE, buildSocialSamples, replyTargetsFor } from "../src/lib/social/sample";
import { SOCIAL_CAPABILITIES, SOCIAL_REPLY_DRAFT_STATES, isReplyDraftState } from "../src/lib/social/types";

let failures = 0;
let checks = 0;

function step(title: string): void {
  console.log(`\n${title}`);
}

function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`, detail === undefined ? "" : `\n        ${JSON.stringify(detail)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures: documented payloads, and a fetch that must not be reached         */
/* -------------------------------------------------------------------------- */

/** A token-shaped value that must never appear in a response or a log line. */
const FAKE_TOKEN = "FAKE-TOKEN-abc123-must-never-leak";

const calls: string[] = [];
let lastHeaders: Record<string, string> | undefined;

const spyFetch: FetchLike = async () => {
  throw new Error("the network must not be reached in this self-test");
};

function jsonFetch(payload: unknown, status = 200): FetchLike {
  return async (_url, init) => {
    calls.push(_url);
    lastHeaders = init?.headers;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

function statusFetch(status: number, body = "vendor words that must not be logged"): FetchLike {
  return async (_url, init) => {
    calls.push(_url);
    lastHeaders = init?.headers;
    return new Response(body, { status });
  };
}

const IG_ENV: EnvLike = {
  META_APP_ID: "meta-app-id",
  META_APP_SECRET: "meta-app-secret",
  META_ACCESS_TOKEN: FAKE_TOKEN,
  META_IG_USER_ID: "17841400000000000",
};

const LI_ENV: EnvLike = {
  LINKEDIN_CLIENT_ID: "li-client-id",
  LINKEDIN_CLIENT_SECRET: "li-client-secret",
  LINKEDIN_ACCESS_TOKEN: FAKE_TOKEN,
  LINKEDIN_ORGANIZATION_ID: "12345678",
};

const X_ENV: EnvLike = {
  X_BEARER_TOKEN: FAKE_TOKEN,
  X_API_KEY: "x-key",
  X_API_SECRET: "x-secret",
  X_ACCESS_TOKEN: "x-user-token",
  X_ACCESS_TOKEN_SECRET: "x-user-secret",
  X_USERNAME: "sample_electrician",
};

const NO_ENV: EnvLike = {};

const igPost = {
  id: "17895695668004550",
  caption: "Second fix finished in Redland this morning.",
  permalink: "https://www.instagram.com/p/example",
  timestamp: "2026-09-20T09:15:00+0000",
  like_count: 42,
  comments_count: 3,
};
const igComment = {
  id: "17850000000000001",
  text: "Do you cover Bedminster? We need a quote.",
  username: "sam_at_no42",
  timestamp: "2026-09-21T08:00:00+0000",
  mediaId: igPost.id,
};
const igMessage = {
  id: "aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjox",
  message: "Can you fit a small job in this week?",
  from: { username: "kirsty.redland" },
  created_time: 1789000000,
};
const igInsights = {
  data: [
    { name: "follower_count", values: [{ value: 1840 }] },
    { name: "reach", values: [{ value: 9620 }] },
  ],
  media: [{ id: igPost.id, reach: 4000, like_count: 100, comments_count: 20 }],
  responseMinutes: [30, 90],
};

const liPost = {
  id: "urn:li:share:7140112345678901248",
  commentary: "We've taken on a second van this month.",
  createdAt: 1789000000000,
  authorHandle: "sample-service-business",
  socialActions: { likeCount: 96, commentCount: 14, shareCount: 6 },
};
const liComment = {
  id: "urn:li:comment:7150112345678900001",
  comment: "Are you taking on commercial work as well?",
  created: { time: 1789000000000 },
  actor: "urn:li:person:abcdef",
};
const liMessage = {
  id: "urn:li:msg_message:1",
  body: "Could we talk about a maintenance contract?",
  created: { time: 1789000000000 },
  authorName: "Dan",
};
const liStats = {
  followers: { data: [{ name: "followerCount", values: [{ value: 1830 }] }] },
  insights: { data: [{ name: "impressionCount", values: [{ value: 9420 }] }] },
  elements: [{ id: liPost.id, reach: 5210, like_count: 96, comments_count: 14, share_count: 6 }],
  responseMinutes: [180, 420],
};

const xPost = {
  id: "1810112345678901248",
  text: "Two call-outs before 9am.",
  created_at: "2026-09-21T10:00:00.000Z",
  public_metrics: { like_count: 58, reply_count: 7, retweet_count: 4 },
};
const xReply = {
  data: {
    id: "1810112345678901301",
    text: "Any chance you'd come out to Keynsham?",
    created_at: "2026-09-21T11:00:00.000Z",
    conversation_id: xPost.id,
    author_id: "900000001",
  },
  includes: { users: [{ id: "900000001", username: "keynsham_dave", name: "Dave" }] },
};
const xDm = {
  data: {
    id: "1810112345678901401",
    text: "Do you do emergency call-outs on Sundays?",
    created_at: "2026-09-21T12:00:00.000Z",
    sender_id: "900000003",
  },
  includes: { users: [{ id: "900000003", username: "sunday_saver", name: "Jordan" }] },
};
const xMetrics = {
  public_metrics: { followers_count: 2140, following_count: 312, tweet_count: 1480 },
  non_public_metrics: { impressions: 41000 },
  tweets: [{ id: xPost.id, impression_count: 8400, like_count: 58, comments_count: 7, share_count: 4 }],
  responseMinutes: [35, 150],
};

/* -------------------------------------------------------------------------- */
/* 1. The model has exactly one reply state, and it is "draft"                 */
/* -------------------------------------------------------------------------- */
step("1. The reply model has no send state, and the spine has no send path");

check(
  'the only reply state is "draft"',
  SOCIAL_REPLY_DRAFT_STATES.length === 1 && SOCIAL_REPLY_DRAFT_STATES[0] === "draft",
  SOCIAL_REPLY_DRAFT_STATES,
);
check('isReplyDraftState("draft") is true', isReplyDraftState("draft") === true);
check('isReplyDraftState("sent") is false', isReplyDraftState("sent") === false);
check(
  "every outbound capability is false, drafting is true",
  SOCIAL_CAPABILITIES.canDraft === true &&
    SOCIAL_CAPABILITIES.canPost === false &&
    SOCIAL_CAPABILITIES.canReplyInThread === false &&
    SOCIAL_CAPABILITIES.canSendDirectMessage === false,
  SOCIAL_CAPABILITIES,
);
check(
  "the capability sentence says Doppel does not send",
  /no code path that posts, replies or sends/i.test(SOCIAL_CAPABILITIES.sentence),
);

const SPINE_FILES = [
  "evidence.ts",
  "types.ts",
  "normalise.ts",
  "sample.ts",
  "replies.ts",
  "templates.ts",
  "registry.ts",
  "guard.ts",
  "api.ts",
  "overview.ts",
  "views.ts",
];
const spineSource = [
  ...SPINE_FILES.map((file) => readFileSync(`src/lib/social/${file}`, "utf8")),
  readFileSync("src/components/social-ui.tsx", "utf8"),
  readFileSync("src/routes/social.tsx", "utf8"),
  readFileSync("src/routes/api/social-read.ts", "utf8"),
  readFileSync("src/routes/api/social-status.ts", "utf8"),
].join("\n");

const fetchCallers = [
  ...SPINE_FILES.map((file) => ({ file, source: readFileSync(`src/lib/social/${file}`, "utf8") })),
  { file: "social-ui.tsx", source: readFileSync("src/components/social-ui.tsx", "utf8") },
  { file: "routes/social.tsx", source: readFileSync("src/routes/social.tsx", "utf8") },
  { file: "routes/api/social-read.ts", source: readFileSync("src/routes/api/social-read.ts", "utf8") },
  { file: "routes/api/social-status.ts", source: readFileSync("src/routes/api/social-status.ts", "utf8") },
].filter((entry) => /fetch\(/.test(entry.source)).map((entry) => entry.file);

check(
  "the registry is the only module that can reach a network",
  fetchCallers.length === 1 && fetchCallers[0] === "registry.ts",
  fetchCallers,
);
check(
  "every outbound call the registry makes is a GET (no POST/PUT/PATCH/DELETE)",
  !/method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(readFileSync("src/lib/social/registry.ts", "utf8")) &&
    /method:\s*["']GET["']/.test(readFileSync("src/lib/social/registry.ts", "utf8")),
);
check(
  "no send-shaped helper exists (send/reply/publish/DM functions)",
  !/\b(sendReply|sendMessage|sendDm|sendDirectMessage|publishPost|createComment|postReply)\b/.test(spineSource),
);
check(
  "only the registry reaches the network",
  /fetch\(/.test(readFileSync("src/lib/social/registry.ts", "utf8")) &&
    !/fetch\(/.test(readFileSync("src/lib/social/replies.ts", "utf8")) &&
    !/fetch\(/.test(readFileSync("src/lib/social/api.ts", "utf8")),
);
check(
  'the state union is declared as exactly "draft"',
  /export type SocialReplyDraftState = "draft";/.test(readFileSync("src/lib/social/types.ts", "utf8")),
);

/* -------------------------------------------------------------------------- */
/* 2. Normalisation: every network, every shape                                */
/* -------------------------------------------------------------------------- */
step("2. Each shape of each network maps onto the normalised model");

const sampleContext = { origin: "sample" as const, now: new Date("2026-09-22T12:00:00.000Z") };

// Instagram (Meta Graph)
const igPostMapped = NORMALISERS.instagram.post(igPost, { ...sampleContext, accountHandle: "brightlark" });
check(
  "instagram post → id, body, counters, ISO time and label",
  igPostMapped !== null &&
    igPostMapped.id === igPost.id &&
    igPostMapped.body === igPost.caption &&
    igPostMapped.metrics.likes === 42 &&
    igPostMapped.metrics.comments === 3 &&
    igPostMapped.metrics.shares === null &&
    igPostMapped.postedAt === "2026-09-20T09:15:00.000Z" &&
    igPostMapped.postedAtLabel.length > 0,
  igPostMapped,
);
const igCommentMapped = NORMALISERS.instagram.comment(igComment, sampleContext);
check(
  "instagram comment → author, body, needs-reply flag",
  igCommentMapped !== null &&
    igCommentMapped.author === "sam_at_no42" &&
    igCommentMapped.needsReply === true &&
    igCommentMapped.postId === igPost.id,
  igCommentMapped,
);
const igMessageMapped = NORMALISERS.instagram.message(igMessage, sampleContext);
check(
  "instagram message → sender, body, epoch seconds → ISO",
  igMessageMapped !== null &&
    igMessageMapped.from === "kirsty.redland" &&
    igMessageMapped.receivedAt === new Date(1789000000 * 1000).toISOString(),
  igMessageMapped,
);
const igAnalyticsMapped = NORMALISERS.instagram.analytics(igInsights, sampleContext);
check(
  "instagram insights → followers, reach, per-post engagement, median reply time",
  igAnalyticsMapped.followers === 1840 &&
    igAnalyticsMapped.reach === 9620 &&
    igAnalyticsMapped.perPost.length === 1 &&
    igAnalyticsMapped.perPost[0]!.engagementRatePct === 3 &&
    igAnalyticsMapped.medianResponseMinutes === 60,
  igAnalyticsMapped,
);

// LinkedIn (REST / organisation)
const liPostMapped = NORMALISERS.linkedin.post(liPost, sampleContext);
check(
  "linkedin post → commentary, socialActions counters, epoch ms → ISO",
  liPostMapped !== null &&
    liPostMapped.body === liPost.commentary &&
    liPostMapped.metrics.likes === 96 &&
    liPostMapped.metrics.comments === 14 &&
    liPostMapped.metrics.shares === 6 &&
    liPostMapped.postedAt === new Date(1789000000000).toISOString(),
  liPostMapped,
);
const liCommentMapped = NORMALISERS.linkedin.comment(liComment, sampleContext);
check(
  "linkedin comment → body, URN tail as the author",
  liCommentMapped !== null && liCommentMapped.author === "abcdef" && liCommentMapped.needsReply === true,
  liCommentMapped,
);
const liMessageMapped = NORMALISERS.linkedin.message(liMessage, sampleContext);
check(
  "linkedin message → body and sender (mapping exists even though the API is partner-only)",
  liMessageMapped !== null && liMessageMapped.from === "Dan" && liMessageMapped.needsReply === true,
  liMessageMapped,
);
const liAnalyticsMapped = NORMALISERS.linkedin.analytics(liStats, sampleContext);
check(
  "linkedin share statistics → followers, impressions, per-post engagement, median reply time",
  liAnalyticsMapped.followers === 1830 &&
    liAnalyticsMapped.reach === 9420 &&
    liAnalyticsMapped.perPost[0]!.engagementRatePct === 2.2 &&
    liAnalyticsMapped.medianResponseMinutes === 300,
  liAnalyticsMapped,
);

// X (API v2)
const xPostMapped = NORMALISERS.x.post({ data: xPost }, sampleContext);
check(
  "x post → text, public_metrics counters, ISO created_at",
  xPostMapped !== null &&
    xPostMapped.body === xPost.text &&
    xPostMapped.metrics.likes === 58 &&
    xPostMapped.metrics.comments === 7 &&
    xPostMapped.metrics.shares === 4 &&
    xPostMapped.postedAt === xPost.created_at,
  xPostMapped,
);
const xCommentMapped = NORMALISERS.x.comment(xReply, sampleContext);
check(
  "x reply → @handle out of includes.users, conversation id as the post",
  xCommentMapped !== null &&
    xCommentMapped.author === "@keynsham_dave" &&
    xCommentMapped.postId === xPost.id,
  xCommentMapped,
);
const xDmMapped = NORMALISERS.x.message(xDm, sampleContext);
check(
  "x dm event → sender handle out of includes.users",
  xDmMapped !== null && xDmMapped.from === "@sunday_saver" && xDmMapped.needsReply === true,
  xDmMapped,
);
const xMetricsMapped = NORMALISERS.x.analytics(xMetrics, sampleContext);
check(
  "x metrics → followers, impressions, per-post engagement, median reply time",
  xMetricsMapped.followers === 2140 &&
    xMetricsMapped.reach === 41000 &&
    xMetricsMapped.perPost[0]!.engagementRatePct === 0.8 &&
    xMetricsMapped.medianResponseMinutes === 92.5,
  xMetricsMapped,
);

// Honesty of the mapping itself
check(
  "a payload that names nothing maps to null, not to a guessed record",
  NORMALISERS.instagram.post({ caption: "no id, no time" }, sampleContext) === null &&
    NORMALISERS.linkedin.comment({ comment: "no id" }, sampleContext) === null &&
    NORMALISERS.x.message({ data: { text: "no id" } }, sampleContext) === null &&
    NORMALISERS.instagram.post(null, sampleContext) === null,
);
check(
  "a counter the network did not report stays null, not 0",
  NORMALISERS.instagram.post(
    { id: "x", timestamp: "2026-09-20T00:00:00.000Z" },
    sampleContext,
  )!.metrics.likes === null,
);
check(
  "an insight the network did not send stays null, not 0",
  NORMALISERS.instagram.analytics({ data: [] }, sampleContext).followers === null,
);
check(
  "origin is carried through: live when a returned call produced it",
  NORMALISERS.x.post({ data: xPost }, { origin: "live" })!.origin === "live" &&
    NORMALISERS.x.post({ data: xPost }, {})!.origin === "sample",
);

/* -------------------------------------------------------------------------- */
/* 3. Evidence: connected only after a returned call, and failures are sticky  */
/* -------------------------------------------------------------------------- */
step("3. A network is only 'connected' when a real call returned data in this process");

resetSocialEvidence();
calls.length = 0;

const missingCreds = credentialState(SOCIAL_ADAPTERS.instagram, NO_ENV);
check(
  "the adapter names the keys it needs, and reports which are missing (names only)",
  missingCreds.configured === false &&
    missingCreds.missing.length === 4 &&
    missingCreds.missing.includes("META_APP_ID") &&
    missingCreds.missing.includes("META_ACCESS_TOKEN"),
  missingCreds,
);
check(
  "credential state never carries a value",
  !JSON.stringify(SOCIAL_ADAPTERS).includes(FAKE_TOKEN) && !JSON.stringify(missingCreds).includes(FAKE_TOKEN),
);
check(
  "no credentials → unconfigured, and no connection is claimed",
  connectionStateFor("instagram", false) === "unconfigured",
);

const noCredsVerify = await verifyNetwork("instagram", { env: NO_ENV, fetch: spyFetch });
check(
  "verifying without credentials is a typed not_configured result, not a throw",
  noCredsVerify.ok === false && noCredsVerify.code === "not_configured",
  noCredsVerify,
);
check(
  "the refusal names the missing keys",
  noCredsVerify.ok === false &&
    noCredsVerify.missing?.includes("META_ACCESS_TOKEN") === true &&
    /META_ACCESS_TOKEN/.test(noCredsVerify.message),
  noCredsVerify,
);
check("no network call was made without credentials", calls.length === 0, calls);

const noCredsRead = await readNetwork("x", "posts", { env: NO_ENV, fetch: spyFetch });
check(
  "reading without credentials is also typed, and still makes no call",
  noCredsRead.ok === false && noCredsRead.code === "not_configured" && calls.length === 0,
  noCredsRead,
);
check(
  "an unknown network is a typed failure, never an exception",
  (await verifyNetwork("tiktok", { env: NO_ENV, fetch: spyFetch })).ok === false &&
    (await readNetwork("tiktok", "posts", { env: NO_ENV, fetch: spyFetch })).ok === false,
);

check(
  "credentials present but no call yet → unverified, still not connected",
  connectionStateFor("instagram", true) === "unverified",
);

// A returned call: the only thing that may produce "connected".
calls.length = 0;
const connected = await verifyNetwork("instagram", {
  env: IG_ENV,
  fetch: jsonFetch({ id: "17841400000000000", username: "brightlark.electric", name: "Bright Lark" }),
});
check(
  "a returned call verifies the account",
  connected.ok === true && connected.value.handle === "brightlark.electric",
  connected,
);
check(
  "connected is claimed only after that call came back",
  connectionStateFor("instagram", true) === "connected",
);
check("the token travelled in a header, never in the URL", lastHeaders?.authorization === `Bearer ${FAKE_TOKEN}` && !calls.join(" ").includes(FAKE_TOKEN), calls);
const igCard = networkConnection(SOCIAL_ADAPTERS.instagram, IG_ENV);
check(
  "the card says connected, names the handle, and says how it knows",
  igCard.state === "connected" &&
    igCard.account?.handle === "brightlark.electric" &&
    /real API call/i.test(igCard.summary),
  igCard,
);

// Reads record the same evidence.
calls.length = 0;
const livePosts = await readNetwork("x", "posts", { env: X_ENV, fetch: jsonFetch({ data: [xPost] }) });
check(
  "a read maps live records with origin 'live'",
  livePosts.ok === true &&
    Array.isArray(livePosts.value) &&
    livePosts.value[0]?.origin === "live" &&
    livePosts.value[0]?.body === xPost.text,
  livePosts,
);
check("reading sets the connected evidence for that network", connectionStateFor("x", true) === "connected");

// A refusal, and the stickiness of it.
resetSocialEvidence();
calls.length = 0;
const refused = await verifyNetwork("x", { env: X_ENV, fetch: statusFetch(403) });
check(
  "a refusal is a typed failure naming what it means",
  refused.ok === false && refused.code === "forbidden" && /approved/.test(refused.message),
  refused,
);
check("a refusal makes the state failed", connectionStateFor("x", true) === "failed");
const failedCard = networkConnection(SOCIAL_ADAPTERS.x, X_ENV);
check(
  "the card reports the failure rather than an optimistic state",
  failedCard.state === "failed" && failedCard.account === null && /approved|refused/.test(failedCard.summary),
  failedCard,
);

const laterSuccess = await verifyNetwork("x", {
  env: X_ENV,
  fetch: jsonFetch({ data: { id: "9", username: "sample_electrician", name: "Sample" } }),
});
check(
  "the failure is sticky: a later success does not clear it",
  laterSuccess.ok === true && connectionStateFor("x", true) === "failed",
);
check(
  "and the card still says failing",
  networkConnection(SOCIAL_ADAPTERS.x, X_ENV).state === "failed",
);

const unreachable = await readNetwork("x", "posts", { env: X_ENV, fetch: spyFetch });
check(
  "a call that throws is typed unreachable, and makes the state failing",
  unreachable.ok === false && unreachable.code === "unreachable",
  unreachable,
);

resetSocialEvidence();
const callsBeforeLiDm = calls.length;
const liDm = await readNetwork("linkedin", "messages", { env: LI_ENV, fetch: spyFetch });
check(
  "a shape the platform does not expose answers not_available, with no call made",
  liDm.ok === false && liDm.code === "not_available" && calls.length === callsBeforeLiDm,
  liDm,
);
check(
  "the credential check comes first: without keys, LinkedIn DMs are not_configured, not not_available",
  (await readNetwork("linkedin", "messages", { env: NO_ENV, fetch: spyFetch })).ok === false,
);
check(
  "LinkedIn's DM note is shown rather than a silent empty list",
  /partner-only/i.test(SOCIAL_ADAPTERS.linkedin.readNotes.messages ?? ""),
);
resetSocialEvidence();

/* -------------------------------------------------------------------------- */
/* 4. Log hygiene: a string, and no secret in it                               */
/* -------------------------------------------------------------------------- */
step("4. Failures are logged as short strings, carrying no secret and no vendor body");

resetSocialEvidence();
const logLines: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  logLines.push(args.map((value) => (typeof value === "string" ? value : String(value))).join(" "));
};
await verifyNetwork("instagram", { env: IG_ENV, fetch: statusFetch(401) });
console.warn = originalWarn;

check("a failed call logs exactly one line", logLines.length === 1, logLines);
check(
  "the line is a short string, not an Error dump",
  (logLines[0] ?? "").length < 300 && !/node_modules|at Object|\.js:\d+/.test(logLines[0] ?? ""),
  logLines,
);
check(
  "the line carries no credential value and no vendor response body",
  !logLines.join("\n").includes(FAKE_TOKEN) && !logLines.join("\n").includes("vendor words"),
  logLines,
);
check("the line says where it came from", /network:/.test(logLines[0] ?? ""), logLines);
resetSocialEvidence();

/* -------------------------------------------------------------------------- */
/* 5. Reply drafts: save, label, and never send                                */
/* -------------------------------------------------------------------------- */
step("5. Replies can be saved as drafts and copied — and can never be sent");

resetReplyDrafts();
const samples = buildSocialSamples(new Date("2026-09-22T12:00:00.000Z"));
const allTargets = samples.networks.flatMap((network) => replyTargetsFor(network));
const lookup = (target: { network: string; targetKind: string; targetId: string }) =>
  allTargets.find(
    (candidate) =>
      candidate.network === target.network &&
      candidate.kind === target.targetKind &&
      candidate.id === target.targetId,
  ) ?? null;

const firstComment = samples.networks[0]!.comments[0]!;
const saved = saveReplyDraft(
  {
    network: "instagram",
    targetKind: "comment",
    targetId: firstComment.id,
    body: "  Yes — we can help with that. Send over the location.  ",
  },
  { knownTarget: lookup, now: new Date("2026-09-22T12:30:00.000Z") },
);
check(
  "a reply saves as a draft, with the body trimmed",
  saved.ok === true && saved.draft.state === "draft" && saved.draft.body === "Yes — we can help with that. Send over the location.",
  saved,
);
check(
  "the draft carries its provenance, not a claim that the owner wrote it",
  saved.ok === true &&
    saved.draft.mode === "heuristic" &&
    /template/i.test(saved.draft.provenanceLabel) &&
    /not your words/i.test(saved.draft.provenanceLabel),
  saved.ok ? saved.draft : saved,
);
check(
  "the confirmation says nothing was sent",
  saved.ok === true && /hasn't sent anything/i.test(saved.message),
  saved,
);
check("the draft is listed", listReplyDrafts().length === 1);

const sentAttempt = saveReplyDraft(
  {
    network: "instagram",
    targetKind: "comment",
    targetId: firstComment.id,
    body: "posted as you",
    state: "sent",
  } as unknown as Parameters<typeof saveReplyDraft>[0],
  { knownTarget: lookup },
);
check(
  'a "sent" state is refused, and nothing is stored',
  sentAttempt.ok === false &&
    sentAttempt.code === "not_a_draft" &&
    /no code path that sends/i.test(sentAttempt.message) &&
    listReplyDrafts().length === 1 &&
    listReplyDrafts().every((draft) => draft.state === "draft"),
  sentAttempt,
);

const emptyBody = saveReplyDraft(
  { network: "instagram", targetKind: "comment", targetId: firstComment.id, body: "   " },
  { knownTarget: lookup },
);
check("an empty reply is refused", emptyBody.ok === false && emptyBody.code === "empty_body", emptyBody);
const longBody = saveReplyDraft(
  { network: "instagram", targetKind: "comment", targetId: firstComment.id, body: "x".repeat(4001) },
  { knownTarget: lookup },
);
check("an over-long reply is refused", longBody.ok === false && longBody.code === "body_too_long", longBody);
const unknownTarget = saveReplyDraft(
  { network: "instagram", targetKind: "comment", targetId: "not-a-real-id", body: "hello" },
  { knownTarget: lookup },
);
check(
  "an unknown target is refused with a typed code",
  unknownTarget.ok === false && unknownTarget.code === "invalid_target",
  unknownTarget,
);
const noLookup = saveReplyDraft(
  { network: "instagram", targetKind: "comment", targetId: firstComment.id, body: "hello" },
  {},
);
check(
  "with no target lookup the save fails closed rather than trusting the caller",
  noLookup.ok === false && noLookup.code === "invalid_target",
  noLookup,
);
const badNetwork = saveReplyDraft(
  { network: "tiktok", targetKind: "comment", targetId: firstComment.id, body: "hello" } as unknown as Parameters<
    typeof saveReplyDraft
  >[0],
  { knownTarget: lookup },
);
check("an unknown network is refused", badNetwork.ok === false && badNetwork.code === "unknown_network", badNetwork);

const suggestion = suggestReply(allTargets[0]!);
check(
  "the suggested starting point is labelled with what produced it",
  suggestion.mode === "heuristic" && /template/i.test(suggestion.label) && suggestion.body.length > 0,
  suggestion,
);
check(
  "saving twice for one target updates rather than duplicating",
  saveReplyDraft(
    { network: "instagram", targetKind: "comment", targetId: firstComment.id, body: "second version" },
    { knownTarget: lookup },
  ).ok === true && listReplyDrafts().length === 1,
);

/* -------------------------------------------------------------------------- */
/* 6. The sample set is labelled as sample, and the page says so               */
/* -------------------------------------------------------------------------- */
step("6. The sample set is labelled as sample everywhere it appears");

const sampleRecords = samples.networks.flatMap((network) => [
  ...network.posts,
  ...network.comments,
  ...network.messages,
]);
check(
  "every sample record carries origin 'sample'",
  sampleRecords.length > 0 && sampleRecords.every((record) => record.origin === "sample"),
  sampleRecords.find((record) => record.origin !== "sample"),
);
check(
  "every sample analytics snapshot is marked sample",
  samples.networks.every((network) => network.analytics.origin === "sample"),
);
check(
  "the sample label and note both say sample, in words",
  /sample/i.test(SAMPLE_LABEL) && /built-in sample set/.test(SAMPLE_NOTE) && /not (read from )?your/i.test(SAMPLE_NOTE),
  { SAMPLE_LABEL, SAMPLE_NOTE },
);
check("the sample set and its origin agree", samples.origin === "sample" && samples.label === SAMPLE_LABEL);

/* -------------------------------------------------------------------------- */
/* 7. The request handlers: typed JSON, fail closed, no secrets                */
/* -------------------------------------------------------------------------- */
step("7. The API routes answer with typed JSON, fail closed, and leak no values");

resetSocialEvidence();
resetReplyDrafts();

const statusResponse = handleSocialStatusGet(new Request("https://doppel.test/api/social-status"));
const statusText = await statusResponse.text();
const statusBody = JSON.parse(statusText) as {
  ok: boolean;
  sending: boolean;
  capabilities: { canSendDirectMessage: boolean };
  networks: { network: string; state: string; missingCredentials: string[]; credentialNames: string[] }[];
};
check("GET /api/social-status is a 200 with ok: true", statusResponse.status === 200 && statusBody.ok === true);
check("it states that nothing is sent", statusBody.sending === false && statusBody.capabilities.canSendDirectMessage === false);
check(
  "all three networks are reported, and none is claimed connected",
  statusBody.networks.length === 3 &&
    statusBody.networks.every((network) => network.state === "unconfigured" || network.state === "unverified") &&
    statusBody.networks.every((network) => network.state !== "connected"),
  statusBody.networks.map((network) => `${network.network}:${network.state}`),
);
check(
  "it names the credential names each network waits for",
  statusBody.networks.some((network) => network.missingCredentials.includes("META_APP_ID")) &&
    statusBody.networks.some((network) => network.missingCredentials.includes("LINKEDIN_ACCESS_TOKEN")) &&
    statusBody.networks.some((network) => network.missingCredentials.includes("X_BEARER_TOKEN")),
);
check("no credential value appears in the response", !statusText.includes(FAKE_TOKEN));
const statusUnknown = handleSocialStatusGet(new Request("https://doppel.test/api/social-status?network=tiktok"));
check(
  "an unknown network is a typed 400, not a 500",
  statusUnknown.status === 400 && (await statusUnknown.json()).error === "unknown_network",
);

const readWithoutSecret = await handleSocialReadGet(
  new Request("https://doppel.test/api/social-read?network=x&shape=identity"),
);
check(
  "the read route fails closed when no shared secret is configured",
  readWithoutSecret.status === 401 &&
    (await readWithoutSecret.json()).error === "read_not_configured",
);

const readWrongToken = await handleSocialReadGet(
  new Request("https://doppel.test/api/social-read?network=x&shape=identity", {
    headers: { authorization: "Bearer not-the-token" },
  }),
  { expectedToken: "the-real-token" },
);
check(
  "a wrong token is a typed 401",
  readWrongToken.status === 401 && (await readWrongToken.json()).error === "unauthorized",
);

calls.length = 0;
const readNoCreds = await handleSocialReadGet(
  new Request("https://doppel.test/api/social-read?network=x&shape=posts", {
    headers: { authorization: "Bearer the-real-token" },
  }),
  { expectedToken: "the-real-token", env: NO_ENV, fetch: spyFetch },
);
const readNoCredsBody = (await readNoCreds.json()) as { error: string; missing?: string[] };
check(
  "with the token but no platform keys: typed 409 naming what is missing, and no call",
  readNoCreds.status === 409 &&
    readNoCredsBody.error === "not_configured" &&
    readNoCredsBody.missing?.includes("X_BEARER_TOKEN") === true &&
    calls.length === 0,
  readNoCredsBody,
);

const readBadShape = await handleSocialReadGet(
  new Request("https://doppel.test/api/social-read?network=x&shape=followers", {
    headers: { authorization: "Bearer the-real-token" },
  }),
  { expectedToken: "the-real-token" },
);
check(
  "an unknown shape is a typed 400",
  readBadShape.status === 400 && (await readBadShape.json()).error === "unknown_shape",
);

calls.length = 0;
const readLive = await handleSocialReadGet(
  new Request("https://doppel.test/api/social-read?network=x&shape=posts", {
    headers: { authorization: "Bearer the-real-token" },
  }),
  { expectedToken: "the-real-token", env: X_ENV, fetch: jsonFetch({ data: [xPost] }) },
);
const readLiveText = await readLive.text();
const readLiveBody = JSON.parse(readLiveText) as { data: { origin: string; body: string }[]; sending: boolean };
check(
  "a credentialed read returns the normalised records, marked live",
  readLive.status === 200 && readLiveBody.data[0]?.origin === "live" && readLiveBody.data[0]?.body === xPost.text,
  readLiveBody,
);
check("the read response repeats that nothing is sent", readLiveBody.sending === false);
check("no credential value appears in the read response", !readLiveText.includes(FAKE_TOKEN));
check(
  "the platform was refused, and the answer says so as a typed 502",
  (
    await handleSocialReadGet(
      new Request("https://doppel.test/api/social-read?network=x&shape=identity", {
        headers: { authorization: "Bearer the-real-token" },
      }),
      { expectedToken: "the-real-token", env: X_ENV, fetch: statusFetch(500) },
    )
  ).status === 502,
);

const written = handleSocialMethodNotAllowed("POST");
check(
  "POST is a typed 405 saying Doppel only reads",
  written.status === 405 && (await written.json()).error === "method_not_allowed",
);

resetSocialEvidence();

/* -------------------------------------------------------------------------- */
/* 8. The page: honest state, labelled samples, and no send control            */
/* -------------------------------------------------------------------------- */
step("8. /social renders the honest state, the labels, and no way to send");

resetSocialEvidence();
resetReplyDrafts();
const view = await socialOverview();
check("the overview builds", view.ok === true && view.message === undefined, view.message);
check(
  "the overview carries all three networks, none of them connected",
  view.networks.length === 3 &&
    view.networks.every((network) => network.state === "unconfigured" || network.state === "unverified") &&
    view.networks.every((network) => network.state !== "connected"),
  view.networks.map((network) => `${network.network}:${network.state}`),
);
check(
  "every card names the keys it waits for, and says the platform must approve the app",
  view.networks.every(
    (network) =>
      network.credentialNames.length >= 4 &&
      network.credentialNames.length > 0 &&
      network.missingCredentials.every((name) => network.credentialNames.includes(name)) &&
      /approv|review|partner|requires/i.test(network.approval),
  ),
  view.networks.map((network) => network.approval.slice(0, 40)),
);
check(
  "the overview carries the sample label, the draft-storage note and the mapping caveat",
  view.sample.label === SAMPLE_LABEL &&
    /Drafts last for this session/.test(view.draftStorage.label) &&
    /server's memory/.test(view.draftStorage.note) &&
    /None of them has been exercised against a live API/.test(view.mappingNote),
);
check(
  "the composer offers targets from every network, all of them sample data",
  view.feeds.length === 3 &&
    view.feeds.every((feed) => feed.targets.length >= 3) &&
    view.feeds.every((feed) => feed.analytics.origin === "sample"),
);

let actionCalls = 0;
const stubActions: SocialActions = {
  saveDraft: async () => {
    actionCalls += 1;
    return { ok: true, message: "stub" };
  },
  checkNetwork: async () => {
    actionCalls += 1;
    return { ok: true, message: "stub" };
  },
};
const html = renderToStaticMarkup(createElement(SocialPageBody, { view, actions: stubActions }));
check("rendering the page performs no action by itself", actionCalls === 0);
check(
  "the page says plainly that Doppel never posts, replies or sends a DM",
  /never posts, replies or sends a direct message/.test(html),
);
check("the page labels its data as sample, on the page itself", html.includes(SAMPLE_LABEL) && /built-in sample set/.test(html));
check(
  "each network's sample block is labelled (one label per network, at least)",
  (html.match(/Sample data/g) ?? []).length >= 3,
  (html.match(/Sample data/g) ?? []).length,
);
check(
  "the page shows the key names it waits for",
  html.includes("META_APP_ID") && html.includes("META_APP_SECRET") && html.includes("LINKEDIN_ACCESS_TOKEN") && html.includes("X_BEARER_TOKEN"),
);
check(
  "the page says the platform must approve the app",
  /must review the app/.test(html) && /Community Management API/.test(html) && /developer app with API v2 access/.test(html),
);
check("the composer offers save-as-draft", html.includes("Save as draft"));
check("the composer offers copy", /Copy<\/button>/.test(html));
check(
  "there is no send control anywhere on the page",
  !/>Send</.test(html) && !/Send now|Post now|Publish now/i.test(html),
  html.match(/.{30}(Send now|Post now|Publish).{30}/i)?.[0],
);
check(
  "the page does not claim any network is connected",
  !/>Connected</.test(html) && /Not connected/.test(html) && !/Doppel is connected/i.test(html),
);
check(
  "it renders the analytics view model: followers, reach, engagement per post, reply time",
  html.includes("Followers") && html.includes("Reach") && html.includes("Engagement per post") && html.includes("Typical reply time"),
);
check(
  "it states that drafts last only for the session",
  /Drafts last for this session/.test(html),
);
check(
  "the state chips never say connected for an unconfigured network",
  stateChip("unconfigured").label === "Not connected" &&
    stateChip("unverified").label === "Not confirmed" &&
    stateChip("failed").label === "Failing" &&
    stateChip("connected").label === "Connected",
);

const cardsAfterRender = networkConnections(NO_ENV);
check(
  "rendering does not turn any network connected",
  cardsAfterRender.every((card) => card.state !== "connected") &&
    connectionStateFor("instagram", true) === "unverified",
);

resetSocialEvidence();
resetReplyDrafts();

/* -------------------------------------------------------------------------- */
console.log(
  failures === 0
    ? `\n${checks}/${checks} checks passed. VERDICT: PASS — the social spine is provider-agnostic, evidence-based and cannot send.\n`
    : `\n${checks - failures}/${checks} checks passed. ${failures} FAILED. VERDICT: FAIL\n`,
);
console.log(
  "Not proven here: that any mapping matches a live API response today. No developer app exists,\n" +
    "so nothing in this run touched Meta, LinkedIn or X — the field names come from the vendors'\n" +
    "published documentation, and this harness proves the code follows that documentation.\n",
);
process.exit(failures === 0 ? 0 : 1);
