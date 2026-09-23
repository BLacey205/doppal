/**
 * The provider registry — one adapter per network, and the gate in front of every
 * call to one.
 *
 * The shape of a call, and why it is in this order:
 *
 *   1. **credentials** — the adapter declares the exact environment-variable
 *      *names* it needs. If any is missing the call stops here, with a typed
 *      `not_configured` result and the missing names as names. **No network call is
 *      made without credentials**, and no secret value is ever returned, logged or
 *      put in a URL that leaves this module (auth goes in a header).
 *   2. **availability** — a shape the platform does not expose to a normal app
 *      (LinkedIn's messaging API is partner-only) answers `not_available`, with the
 *      reason, before anything is attempted. Still no call.
 *   3. **the call** — only now, and only through an injectable `fetch` so the
 *      self-test can drive the whole path with a stub. A returned payload is mapped
 *      by `~/lib/social/normalise` and recorded as evidence
 *      (`noteNetworkCallConnected`); a refusal or a throw is recorded as a sticky
 *      failure (`noteNetworkCallFailed`) and returned as a typed result.
 *
 * Nothing here posts, replies or sends: every request is a `GET`, and the only
 * "write" in the gateway is a reply draft kept in memory (`~/lib/social/replies`).
 *
 * Server-only: reads `process.env` and uses `fetch`. Never import this from a
 * component — the page gets its view model from `~/lib/social/views`.
 */
import { failureLogLine } from "~/lib/log-line";
import {
  connectionStateFor,
  networkEvidence,
  noteNetworkCallConnected,
  noteNetworkCallFailed,
} from "~/lib/social/evidence";
import { NORMALISERS } from "~/lib/social/normalise";
import type {
  AnalyticsSnapshot,
  NetworkConnection,
  SocialAccount,
  SocialComment,
  SocialMessage,
  SocialNetwork,
  SocialPost,
} from "~/lib/social/types";
import { NETWORK_LABELS } from "~/lib/social/types";

/** The four things the gateway reads from a network. */
export type SocialReadShape = "posts" | "comments" | "messages" | "analytics";

export const SOCIAL_READ_SHAPES: readonly SocialReadShape[] = ["posts", "comments", "messages", "analytics"];

/** Environment, or anything shaped like it. Injectable so a test never sets one. */
export type EnvLike = Record<string, string | undefined>;

/** A `fetch` narrow enough to stub, wide enough to be the real one. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

export type SocialCallFailure = {
  ok: false;
  code:
    | "not_configured"
    | "not_available"
    | "unknown_network"
    | "unauthorized"
    | "forbidden"
    | "rate_limited"
    | "unreachable"
    | "bad_response";
  /** The app's own sentence. Never a vendor response body, status text or stack. */
  message: string;
  /** Missing credential names (names only), when the code is `not_configured`. */
  missing?: string[];
};

export type SocialCallResult<T> = { ok: true; value: T; note: string } | SocialCallFailure;

export type AdapterCredentials = {
  /** Names and roles, for the owner. Names only — never a value. */
  names: string[];
  /** Short description per name, shown on the card, e.g. "the app id from Meta". */
  roles: Record<string, string>;
};

export type SocialAdapter = {
  network: SocialNetwork;
  label: string;
  credentials: AdapterCredentials;
  docsUrl: string;
  /** What the platform requires beyond credentials (an approved app, a review). */
  approval: string;
  /** The permissions the app must hold, named as the platform names them. */
  permissions: string[];
  /** The one endpoint a verification call hits (documented; built from config). */
  identityUrl: (values: Record<string, string>) => string;
  /** How a returned identity payload names the account. */
  identityOf: (payload: unknown) => { handle: string; displayName: string | null } | null;
  /** The read endpoint per shape, built from configured values. */
  readUrls: (values: Record<string, string>) => Partial<Record<SocialReadShape, string>>;
  /** True when the platform exposes the shape to an ordinary approved app. */
  readAvailable: Partial<Record<SocialReadShape, boolean>>;
  /** Why a shape is unavailable, when it is. */
  readNotes: Partial<Record<SocialReadShape, string>>;
  /** Auth goes in headers, so no token can end up in a URL we log or return. */
  authHeaders: (values: Record<string, string>) => Record<string, string>;
  /**
   * The provider records inside a read envelope. Takes the shape because one
   * envelope can nest differently per shape (Meta returns conversations whose
   * messages live one level down).
   */
  items: (payload: unknown, shape: SocialReadShape) => unknown[];
};

/* -------------------------------------------------------------------------- *
 * Credentials
 * -------------------------------------------------------------------------- */

export type CredentialState = {
  configured: boolean;
  /** Which names are set. Names only. */
  present: string[];
  /** Which names are absent. Names only. */
  missing: string[];
};

/**
 * Read the *names* that are set and the names that are missing. The values are
 * read into a local object and never returned to a caller, so nothing above this
 * function can log, render or forward a secret by accident.
 */
export function credentialState(adapter: SocialAdapter, env: EnvLike = process.env): CredentialState {
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of adapter.credentials.names) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) present.push(name);
    else missing.push(name);
  }
  return { configured: missing.length === 0, present, missing };
}

/** The configured values, for the duration of one call. Deliberately unexported. */
function credentialValues(adapter: SocialAdapter, env: EnvLike): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of adapter.credentials.names) {
    const value = env[name];
    if (typeof value === "string") values[name] = value;
  }
  return values;
}

/* -------------------------------------------------------------------------- *
 * Failure sentences
 * -------------------------------------------------------------------------- */

/** A refusal from the platform, in the app's own words. Never the vendor's. */
function refusalMessage(label: string, code: SocialCallFailure["code"]): string {
  switch (code) {
    case "unauthorized":
      return `${label} refused those credentials, so Doppel is not connected and nothing was read. A fresh token is the usual fix.`;
    case "forbidden":
      return `${label} refused that read — the app or the permission hasn't been approved for this account yet. Nothing was read.`;
    case "rate_limited":
      return `${label} is rate-limiting Doppel right now, so nothing was read. Nothing is wrong with the credentials.`;
    case "unreachable":
      return `Doppel couldn't reach ${label} just now, so nothing was read and no connection is claimed.`;
    case "not_available":
      return `${label} doesn't expose that to an ordinary app, so Doppel doesn't read it. Nothing was read.`;
    case "not_configured":
      return `${label} isn't configured, so nothing was read.`;
    case "unknown_network":
      return "That isn't one of the networks Doppel supports.";
    case "bad_response":
    default:
      return `${label} answered with something Doppel couldn't read, so it is not claiming a connection. Nothing was read.`;
  }
}

/** HTTP status → the typed code. Anything odd is `bad_response`, never silence. */
function codeForStatus(status: number): SocialCallFailure["code"] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  return "bad_response";
}

/** One place that logs a network failure: a short string, never an `Error`. */
function logNetworkFailure(message: string, engine: unknown): void {
  console.warn(failureLogLine(`[social] ${message}`, engine, "network"));
}

/* -------------------------------------------------------------------------- *
 * The adapters
 * -------------------------------------------------------------------------- */

const metaGraph = "https://graph.facebook.com/v21.0";

const instagram: SocialAdapter = {
  network: "instagram",
  label: NETWORK_LABELS.instagram,
  credentials: {
    names: ["META_APP_ID", "META_APP_SECRET", "META_ACCESS_TOKEN", "META_IG_USER_ID"],
    roles: {
      META_APP_ID: "the Meta app's id",
      META_APP_SECRET: "the Meta app's secret",
      META_ACCESS_TOKEN: "the long-lived token for the Instagram professional account",
      META_IG_USER_ID: "the Instagram professional account's id, as Meta numbers it",
    },
  },
  docsUrl: "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login",
  approval: "Meta must review the app and grant the Instagram permissions before any read works. Until then the graph API refuses the token — approval is a review, not a setting.",
  permissions: [
    "instagram_business_basic",
    "instagram_business_manage_comments",
    "instagram_business_manage_messages",
  ],
  identityUrl: (values) =>
    `${metaGraph}/${values.META_IG_USER_ID}?fields=id,username,name`,
  identityOf: (payload) => {
    const node = asRecord(payload);
    const handle = str(node?.username);
    if (!handle) return null;
    return { handle, displayName: str(node?.name) };
  },
  readUrls: (values) => ({
    posts: `${metaGraph}/${values.META_IG_USER_ID}/media?fields=id,caption,permalink,timestamp,like_count,comments_count&limit=10`,
    comments: `${metaGraph}/${values.META_IG_USER_ID}/comments?fields=id,text,username,timestamp,media{id}&limit=25`,
    messages: `${metaGraph}/${values.META_IG_USER_ID}/conversations?platform=instagram&fields=id,updated_time,messages{id,message,from,created_time}&limit=10`,
    analytics: `${metaGraph}/${values.META_IG_USER_ID}/insights?metric=reach,follower_count&period=day`,
  }),
  readAvailable: {},
  readNotes: {},
  authHeaders: (values) => ({ authorization: `Bearer ${values.META_ACCESS_TOKEN}` }),
  items: (payload, shape) => {
    const node = asRecord(payload);
    if (shape === "messages") {
      return asArray(node?.data).flatMap((conversation) =>
        asArray(asRecord(asRecord(conversation)?.messages)?.data),
      );
    }
    return asArray(node?.data);
  },
};

const linkedin: SocialAdapter = {
  network: "linkedin",
  label: NETWORK_LABELS.linkedin,
  credentials: {
    names: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_ACCESS_TOKEN", "LINKEDIN_ORGANIZATION_ID"],
    roles: {
      LINKEDIN_CLIENT_ID: "the LinkedIn app's client id",
      LINKEDIN_CLIENT_SECRET: "the LinkedIn app's client secret",
      LINKEDIN_ACCESS_TOKEN: "a token with the organisation page's admin scope",
      LINKEDIN_ORGANIZATION_ID: "the numeric id of the organisation page",
    },
  },
  docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview",
  approval: "LinkedIn requires an approved app with the Community Management API. Access is granted by LinkedIn's review against an organisation page — there is no self-serve switch.",
  permissions: ["r_organization_social", "rw_organization_admin", "w_organization_social"],
  identityUrl: () => "https://api.linkedin.com/v2/userinfo",
  identityOf: (payload) => {
    const node = asRecord(payload);
    const handle = str(node?.preferred_username) ?? str(node?.sub);
    if (!handle) return null;
    return { handle, displayName: str(node?.name) };
  },
  readUrls: (values) => ({
    posts: `https://api.linkedin.com/rest/posts?author=urn:li:organization:${values.LINKEDIN_ORGANIZATION_ID}&q=author&count=10`,
    comments: `https://api.linkedin.com/rest/socialActions/urn:li:organization:${values.LINKEDIN_ORGANIZATION_ID}/comments`,
    analytics: `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn:li:organization:${values.LINKEDIN_ORGANIZATION_ID}`,
  }),
  readAvailable: {
    messages: false,
  },
  readNotes: {
    messages:
      "LinkedIn's messaging API is partner-only, so Doppel does not read direct messages here at all. The sample message below shows the shape, nothing more.",
  },
  authHeaders: (values) => ({
    authorization: `Bearer ${values.LINKEDIN_ACCESS_TOKEN}`,
    "LinkedIn-Version": "202409",
    "X-Restli-Protocol-Version": "2.0.0",
  }),
  items: (payload) => {
    const node = asRecord(payload);
    return [...asArray(node?.elements), ...asArray(node?.data)];
  },
};

const x: SocialAdapter = {
  network: "x",
  label: NETWORK_LABELS.x,
  credentials: {
    names: [
      "X_BEARER_TOKEN",
      "X_API_KEY",
      "X_API_SECRET",
      "X_ACCESS_TOKEN",
      "X_ACCESS_TOKEN_SECRET",
      "X_USERNAME",
    ],
    roles: {
      X_BEARER_TOKEN: "the app-only bearer token (reads)",
      X_API_KEY: "the developer app's API key",
      X_API_SECRET: "the developer app's API secret",
      X_ACCESS_TOKEN: "the account's user-context access token (direct messages need this)",
      X_ACCESS_TOKEN_SECRET: "the user-context access token secret",
      X_USERNAME: "the account's @handle, as X spells it",
    },
  },
  docsUrl: "https://docs.x.com/x-api/introduction",
  approval: "X requires a developer app with API v2 access at a paid tier for reads, and direct-message history is granted separately on top of that. Rate limits apply per app.",
  permissions: ["tweet.read", "users.read", "dm.read"],
  identityUrl: () => "https://api.x.com/2/users/me?user.fields=username,name",
  identityOf: (payload) => {
    const node = asRecord(asRecord(payload)?.data) ?? asRecord(payload);
    const raw = str(node?.username);
    if (!raw) return null;
    return { handle: raw.startsWith("@") ? raw : `@${raw}`, displayName: str(node?.name) };
  },
  readUrls: (values) => ({
    posts: `https://api.x.com/2/users/${encodeURIComponent(values.X_USERNAME ?? "")}/tweets?max_results=10&tweet.fields=created_at,public_metrics`,
    comments: `https://api.x.com/2/users/${encodeURIComponent(values.X_USERNAME ?? "")}/mentions?max_results=25&tweet.fields=created_at,public_metrics,conversation_id`,
    messages: "https://api.x.com/2/dm_events?max_results=25&dm_event.fields=created_at,sender_id,text&expansions=sender_id&user.fields=username,name",
    analytics: "https://api.x.com/2/users/me?user.fields=public_metrics",
  }),
  readAvailable: {
    messages: true,
  },
  readNotes: {
    messages:
      "Reading direct messages needs user-context access (X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET on top of the bearer token), which X grants separately from ordinary reads.",
  },
  authHeaders: (values) => ({ authorization: `Bearer ${values.X_BEARER_TOKEN}` }),
  items: (payload) => asArray(asRecord(payload)?.data),
};

/** The registry. Adding a network is one entry here plus its normalisers. */
export const SOCIAL_ADAPTERS: Record<SocialNetwork, SocialAdapter> = {
  instagram,
  linkedin,
  x,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/* -------------------------------------------------------------------------- *
 * Calls
 * -------------------------------------------------------------------------- */

export type CallOptions = {
  env?: EnvLike;
  fetch?: FetchLike;
  now?: Date;
};

/** The gate every call runs through. Returns the typed refusal, or the values. */
function gate(
  adapter: SocialAdapter,
  shape: SocialReadShape | "identity",
  env: EnvLike,
): SocialCallFailure | { ok: true; values: Record<string, string> } {
  const credentials = credentialState(adapter, env);
  if (!credentials.configured) {
    return {
      ok: false,
      code: "not_configured",
      message: `${adapter.label} isn't configured yet — Doppel is waiting for ${credentials.missing.join(
        ", ",
      )}. Nothing was read, and nothing is claimed.`,
      missing: credentials.missing,
    };
  }

  if (shape !== "identity" && adapter.readAvailable[shape] === false) {
    return {
      ok: false,
      code: "not_available",
      message:
        adapter.readNotes[shape] ?? refusalMessage(adapter.label, "not_available"),
    };
  }

  return { ok: true, values: credentialValues(adapter, env) };
}

/** GET one documented endpoint and decode JSON, all failures typed. */
async function getJson(
  adapter: SocialAdapter,
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<{ ok: true; payload: unknown } | SocialCallFailure> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers });
  } catch (err) {
    const message = refusalMessage(adapter.label, "unreachable");
    logNetworkFailure(message, err);
    return { ok: false, code: "unreachable", message };
  }

  if (!response.ok) {
    const code = codeForStatus(response.status);
    const message = refusalMessage(adapter.label, code);
    // The status only: a provider's body can carry account detail, so it is never
    // logged or returned. `~/lib/log-line` reduces this to one short string.
    logNetworkFailure(message, `HTTP ${response.status}`);
    noteNetworkCallFailed(adapter.network, code, message);
    return { ok: false, code, message };
  }

  try {
    return { ok: true, payload: await response.json() };
  } catch (err) {
    const message = refusalMessage(adapter.label, "bad_response");
    logNetworkFailure(message, err);
    noteNetworkCallFailed(adapter.network, "bad_response", message);
    return { ok: false, code: "bad_response", message };
  }
}

export type NetworkIdentity = { handle: string; displayName: string | null };

/**
 * Verify one network: the only way a network can become `connected`.
 *
 * With credentials missing this returns `not_configured` **without touching the
 * network** — the self-test asserts the injected `fetch` was never called. With
 * credentials present it performs one real, documented identity read and records
 * the evidence. A refusal, a throw or a response that doesn't name an account all
 * end as a sticky failure: under-claiming, never over-claiming.
 */
export async function verifyNetwork(
  network: string,
  options: CallOptions = {},
): Promise<SocialCallResult<NetworkIdentity>> {
  if (!Object.hasOwn(SOCIAL_ADAPTERS, network)) {
    return { ok: false, code: "unknown_network", message: refusalMessage("", "unknown_network") };
  }
  const adapter = SOCIAL_ADAPTERS[network as SocialNetwork];
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? new Date();

  const allowed = gate(adapter, "identity", env);
  if (!allowed.ok) return allowed;

  const result = await getJson(adapter, adapter.identityUrl(allowed.values), adapter.authHeaders(allowed.values), fetchImpl);
  if (!result.ok) return result;

  const identity = adapter.identityOf(result.payload);
  if (!identity) {
    const message = refusalMessage(adapter.label, "bad_response");
    noteNetworkCallFailed(adapter.network, "bad_response", message, now);
    return { ok: false, code: "bad_response", message };
  }

  noteNetworkCallConnected(
    adapter.network,
    { handle: identity.handle, displayName: identity.displayName, verifiedAt: now.toISOString() },
    now,
  );
  return {
    ok: true,
    value: identity,
    note: `${adapter.label} answered — connected as ${identity.handle}.`,
  };
}

export type ReadValue = SocialPost[] | SocialComment[] | SocialMessage[] | AnalyticsSnapshot;

/**
 * Read one shape from one network. Same gate, same evidence rule: no credentials →
 * no call; a real returned payload → the evidence that the network is connected.
 *
 * Individual records that don't map are dropped rather than guessed at; a payload
 * that maps to nothing at all is `bad_response` (and a sticky failure), because
 * "connected, zero posts" and "the shape changed under us" must not look alike.
 */
export async function readNetwork(
  network: string,
  shape: string,
  options: CallOptions = {},
): Promise<SocialCallResult<ReadValue>> {
  if (!Object.hasOwn(SOCIAL_ADAPTERS, network)) {
    return { ok: false, code: "unknown_network", message: refusalMessage("", "unknown_network") };
  }
  if (!(SOCIAL_READ_SHAPES as readonly string[]).includes(shape)) {
    return {
      ok: false,
      code: "bad_response",
      message: "That isn't one of the things Doppel reads from a network.",
    };
  }
  const adapter = SOCIAL_ADAPTERS[network as SocialNetwork];
  const readShape = shape as SocialReadShape;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? new Date();

  const allowed = gate(adapter, readShape, env);
  if (!allowed.ok) return allowed;

  const url = adapter.readUrls(allowed.values)[readShape];
  if (!url) {
    return { ok: false, code: "not_available", message: refusalMessage(adapter.label, "not_available") };
  }

  const result = await getJson(adapter, url, adapter.authHeaders(allowed.values), fetchImpl);
  if (!result.ok) return result;

  const normalise = NORMALISERS[adapter.network];
  const context = {
    origin: "live" as const,
    now,
    // What the last proven call told us about the account, when it named one.
    accountHandle: networkEvidence(adapter.network, now).account?.handle,
  };

  if (readShape === "analytics") {
    const snapshot = normalise.analytics(result.payload, context);
    noteNetworkCallConnected(adapter.network, null, now);
    return { ok: true, value: snapshot, note: `${adapter.label} insights came back.` };
  }

  const mapper =
    readShape === "posts" ? normalise.post : readShape === "comments" ? normalise.comment : normalise.message;
  const raw = adapter.items(result.payload, readShape);
  const records = raw
    .map((item) => mapper(item, context))
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (records.length === 0 && raw.length > 0) {
    const message = refusalMessage(adapter.label, "bad_response");
    noteNetworkCallFailed(adapter.network, "bad_response", message, now);
    return { ok: false, code: "bad_response", message };
  }

  noteNetworkCallConnected(adapter.network, null, now);
  return {
    ok: true,
    value: records as ReadValue,
    note: `${adapter.label} returned ${records.length} item${records.length === 1 ? "" : "s"}.`,
  };
}

/* -------------------------------------------------------------------------- *
 * The card view model
 * -------------------------------------------------------------------------- */

/**
 * What `/social` may say about one network.
 *
 * The state comes from `connectionStateFor`, which is evidence-based: credentials
 * present but no call returned means `unverified` — a connection is **not** claimed
 * — and a refused call means `failed`, which sticks. The sentence under the chip is
 * chosen from the state, so the two can never disagree.
 */
export function networkConnection(
  adapter: SocialAdapter,
  env: EnvLike = process.env,
  now: Date = new Date(),
): NetworkConnection {
  const credentials = credentialState(adapter, env);
  const state = connectionStateFor(adapter.network, credentials.configured);
  const evidence = networkEvidence(adapter.network, now);

  const account: SocialAccount | null =
    state === "connected" && evidence.account
      ? evidence.account
      : state === "connected"
        ? { network: adapter.network, handle: "handle not reported", displayName: null, state: "connected", verifiedAt: evidence.checkedAt }
        : null;

  const summary =
    state === "connected"
      ? `${adapter.label} answered a real API call in this run${account && account.handle !== "handle not reported" ? ` as ${account.handle}` : ""}. Reads are live.`
      : state === "unverified"
        ? `The ${adapter.label} credentials are set, but no call has come back in this run — so Doppel is not claiming a connection. Verifying needs the app to be approved first.`
        : state === "failed"
          ? evidence.failure?.message ??
            `${adapter.label} refused a call, so Doppel is not connected and will not claim otherwise in this run.`
          : `Not connected. Doppel is waiting for ${credentials.missing.join(
              ", ",
            )} — names only, and nothing is read from ${adapter.label} until they exist.`;

  return {
    network: adapter.network,
    label: adapter.label,
    state,
    account,
    credentialNames: adapter.credentials.names,
    credentialRoles: adapter.credentials.roles,
    missingCredentials: credentials.missing,
    reads: (["posts", "comments", "messages", "analytics"] as SocialReadShape[]).map((shape) => ({
      shape,
      available: adapter.readAvailable[shape] !== false,
      note: adapter.readNotes[shape] ?? null,
    })),
    summary,
    approval: adapter.approval,
    permissions: adapter.permissions,
    docsUrl: adapter.docsUrl,
    checkedAt: evidence.checkedAt,
  };
}

/** Every adapter's card, in registry order. */
export function networkConnections(env: EnvLike = process.env, now: Date = new Date()): NetworkConnection[] {
  return (Object.keys(SOCIAL_ADAPTERS) as SocialNetwork[]).map((network) =>
    networkConnection(SOCIAL_ADAPTERS[network], env, now),
  );
}
