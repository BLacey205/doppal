/**
 * The machine seam of the social gateway: `GET /api/social-status` and
 * `GET /api/social-read`.
 *
 * Both are request handlers of `(Request) => Response` that live here rather than
 * in the route file, so the whole guarded path can be driven from a script with a
 * real `Request` — no server, no port, no network. The route files are four-line
 * wrappers.
 *
 * Rules these two routes hold to:
 *
 *   - **no secrets leave.** `social-status` is a public, read-only description of
 *     state: it names the environment variables each network waits for and never
 *     their values, and it carries no account identifier while nothing is connected.
 *   - **fail closed.** `social-read` refuses every request unless a shared secret is
 *     configured *and* presented (`~/lib/social/guard`). Both routes are `GET`:
 *     nothing here writes, replies or sends.
 *   - **every failure is typed JSON** (`{ ok: false, error, message }`) with a
 *     sensible status — 400 for a bad ask, 401 for the gate, 409 for a network that
 *     isn't configured or doesn't expose the shape, 502 for a network that refused
 *     or returned something we can't read. Never a bare 500, and never a vendor's
 *     response body.
 */
import { jsonResponse } from "~/lib/inbound-guard";
import { authorizeSocialRead, socialReadConfigured, type SocialGuardFailure } from "~/lib/social/guard";
import {
  SOCIAL_ADAPTERS,
  networkConnection,
  readNetwork,
  verifyNetwork,
  type EnvLike,
  type FetchLike,
  type SocialReadShape,
} from "~/lib/social/registry";
import { SAMPLE_LABEL, SAMPLE_NOTE } from "~/lib/social/sample";
import { SOCIAL_CAPABILITIES, SOCIAL_NETWORKS, isSocialNetwork } from "~/lib/social/types";

/** Everything `social-read` can be asked for. `identity` verifies the credentials. */
export const SOCIAL_READ_SHAPES_WITH_IDENTITY = [
  "identity",
  "posts",
  "comments",
  "messages",
  "analytics",
] as const;

export type SocialReadShapeWithIdentity = (typeof SOCIAL_READ_SHAPES_WITH_IDENTITY)[number];

export function isReadShapeWithIdentity(value: unknown): value is SocialReadShapeWithIdentity {
  return typeof value === "string" && (SOCIAL_READ_SHAPES_WITH_IDENTITY as readonly string[]).includes(value);
}

/** Typed code → HTTP status, so the two can never drift apart. */
function statusForCode(code: string): number {
  switch (code) {
    case "unauthorized":
      return 401;
    case "not_configured":
    case "not_available":
      return 409;
    case "unknown_network":
    case "unknown_shape":
      return 400;
    default:
      return 502;
  }
}

/**
 * `GET /api/social-status` — what Doppel can say about each network, and no more.
 *
 * Public and read-only. Every list in the response is a list of *names*: the
 * credential names each adapter wants, and the ones that are missing. A value for
 * any of them never reaches this function — `credentialState` reads values only to
 * decide whether a name is set.
 */
export function handleSocialStatusGet(request: Request): Response {
  const wanted = new URL(request.url).searchParams.get("network");
  if (wanted !== null && !isSocialNetwork(wanted)) {
    return jsonResponse(
      {
        ok: false,
        error: "unknown_network",
        message: `Doppel has no adapter for “${wanted}”. Known networks: ${SOCIAL_NETWORKS.join(", ")}.`,
      },
      400,
    );
  }

  const networks = (wanted ? [wanted] : [...SOCIAL_NETWORKS]).map((network) => {
    const adapter = SOCIAL_ADAPTERS[network];
    // The same evidence-based view model the page renders, so the API and the card
    // can never disagree about a state.
    const card = networkConnection(adapter);
    return {
      network,
      label: adapter.label,
      state: card.state,
      account: card.account ? { handle: card.account.handle } : null,
      credentialNames: adapter.credentials.names,
      missingCredentials: card.missingCredentials,
      approval: adapter.approval,
      permissions: adapter.permissions,
      docsUrl: adapter.docsUrl,
      reads: (["posts", "comments", "messages", "analytics"] as SocialReadShape[]).map((shape) => ({
        shape,
        available: adapter.readAvailable[shape] !== false,
        note: adapter.readNotes[shape] ?? null,
      })),
      note: card.summary,
    };
  });

  return jsonResponse({
    ok: true,
    // Spelled out for a machine reader: Doppel drafts, the owner sends.
    capabilities: SOCIAL_CAPABILITIES,
    sending: false,
    readTokenConfigured: socialReadConfigured(),
    networks,
    sample: { label: SAMPLE_LABEL, note: SAMPLE_NOTE },
    note: "Nothing is connected. These states come from configuration plus what this process has actually seen; no credential values, tokens or account ids are included in this response.",
  });
}

export type SocialReadOptions = {
  /** Injected so a test never sets an environment variable or opens a socket. */
  env?: EnvLike;
  fetch?: FetchLike;
  now?: Date;
  /** Injected so a test can drive the gate without configuring a real secret. */
  expectedToken?: string | null;
};

/**
 * `GET /api/social-read?network=<n>&shape=<s>` — the guarded read.
 *
 * `shape=identity` verifies the credentials with one documented call and is the
 * only way a network becomes `connected`. Every other shape reads and maps through
 * `~/lib/social/normalise`. With credentials absent the network is never called at
 * all: the answer is a typed `not_configured` that names what is missing.
 */
export async function handleSocialReadGet(
  request: Request,
  options: SocialReadOptions = {},
): Promise<Response> {
  const authorised = authorizeSocialRead(request, options.expectedToken ?? undefined);
  if (!authorised.ok) {
    const failure = authorised as SocialGuardFailure;
    return jsonResponse({ ok: false, error: failure.code, message: failure.message }, failure.status);
  }

  const url = new URL(request.url);
  const network = url.searchParams.get("network");
  const shape = url.searchParams.get("shape") ?? "identity";

  if (network === null || !isSocialNetwork(network)) {
    return jsonResponse(
      {
        ok: false,
        error: "unknown_network",
        message:
          network === null
            ? `Name a network: ${SOCIAL_NETWORKS.join(", ")}.`
            : `Doppel has no adapter for “${network}”. Known networks: ${SOCIAL_NETWORKS.join(", ")}.`,
      },
      400,
    );
  }
  if (!isReadShapeWithIdentity(shape)) {
    return jsonResponse(
      {
        ok: false,
        error: "unknown_shape",
        message: `Doppel can read ${SOCIAL_READ_SHAPES_WITH_IDENTITY.join(", ")}. Nothing was read.`,
      },
      400,
    );
  }

  const callOptions = { env: options.env, fetch: options.fetch, now: options.now };

  if (shape === "identity") {
    const verified = await verifyNetwork(network, callOptions);
    if (!verified.ok) {
      return jsonResponse(
        { ok: false, error: verified.code, message: verified.message, missing: verified.missing },
        statusForCode(verified.code),
      );
    }
    return jsonResponse({
      ok: true,
      network,
      shape,
      account: { handle: verified.value.handle, displayName: verified.value.displayName },
      note: verified.note,
      sending: false,
    });
  }

  const result = await readNetwork(network, shape as SocialReadShape, callOptions);
  if (!result.ok) {
    return jsonResponse(
      { ok: false, error: result.code, message: result.message, missing: result.missing },
      statusForCode(result.code),
    );
  }
  return jsonResponse({
    ok: true,
    network,
    shape,
    origin: "live",
    data: result.value,
    note: result.note,
    sending: false,
  });
}

/** Any method but GET: a typed 405, never a silent success. */
export function handleSocialMethodNotAllowed(method: string): Response {
  return jsonResponse(
    {
      ok: false,
      error: "method_not_allowed",
      message: `${method} isn't supported here. Doppel reads social data with GET only — it never posts, replies or sends a direct message.`,
    },
    405,
  );
}
