/**
 * The Connections framework — one adapter shape per channel, and the honest state
 * each channel is in.
 *
 * This is the card's whole source of truth, and it is deliberately built *on top of*
 * the things that already exist rather than beside them:
 *
 *   - the **email channel's** configuration and its own sentence come from the same
 *     `InboundProvider` registry the Resend webhook route uses
 *     (`~/lib/inbound-providers`), through the very same `connection()` call the
 *     `GET /api/inbound-email/resend` handler answers with. The card and the route
 *     cannot drift, because they read one function.
 *   - the **proof** that a channel actually works comes from
 *     `~/lib/channel-evidence`, recorded at the only moment that counts: a real
 *     forwarded message fetched through the provider and genuinely kept by a store.
 *
 * ## The adapter shape (what a second channel implements)
 *
 *   {
 *     id, label, purpose,
 *     envVars: [{ name, role }],     // exact env-var NAMES + what each is for — never a value
 *     ownerSteps: [...],             // the owner's exact steps, in order
 *     standingLine,                  // the sentence every unproven state repeats
 *     connection(),                  // → typed state + the exact sentence shown on screen
 *     runCheck(),                    // optional: the in-process check (facts, verbatim)
 *   }
 *
 * An SMS channel adds one object to `CHANNEL_ADAPTERS` and one provider-to-channel
 * row in `~/lib/channel-evidence`; the page maps over whatever the registry holds,
 * so nothing about `/app` is reshaped.
 *
 * ## The states, and what each may say
 *
 *   not_configured      — "Not connected": names the missing env vars by name.
 *   configured_unproven — secrets set, but nothing has proved mail flows. Says so.
 *   proven              — a real forwarded message was fetched and stored. The only
 *                         state whose chip says "Connected", with when and where.
 *   failed              — the provider refused our credentials, or a check found
 *                         something unacceptable. Stays failed until a later event.
 *
 * **Secrets never cross this module's boundary as values.** Env vars are read only
 * to test presence; every string handed to the card is a name, a sentence, a status
 * code or a timestamp.
 *
 * Server-only: reads `process.env` and calls the provider handlers. Never imported
 * by a component — the page gets its view model through `~/lib/channel-view`.
 */
import {
  type ChannelCheckFact,
  type ChannelCheckRecord,
  type ChannelId,
  channelEvidence,
  noteChannelCheck,
} from "~/lib/channel-evidence";
import { handleProviderWebhookGet, handleProviderWebhookPost, PROVIDERS, providerRouteMessage } from "~/lib/inbound-providers";

/* -------------------------------------------------------------------------- *
 * The adapter shape
 * -------------------------------------------------------------------------- */

export type ChannelEnvVar = {
  /** The exact environment-variable name. The name is safe to show; the value never is. */
  name: string;
  /** What it is for, in the owner's language. */
  role: string;
};

export type ChannelConnectionState = {
  state: "not_configured" | "configured_unproven";
  /** The env-var names that are absent right now. Names only. */
  missingEnvVars: string[];
  /** The exact sentence shown on the card — for email, the route's own answer. */
  message: string;
};

/**
 * One channel. `connection()` is the honest configuration state; the *evidence*
 * state (proven / failed) is layered on top from `~/lib/channel-evidence`, so an
 * adapter only ever has to describe itself and its check.
 */
export type ChannelAdapter = {
  id: ChannelId;
  label: string;
  /** What this channel is, in one sentence for the owner. */
  purpose: string;
  /** Every env-var name this channel needs, with its role. Names only, never values. */
  envVars: readonly ChannelEnvVar[];
  /** The owner's exact steps to connect it, in order, short, no invented UI paths. */
  ownerSteps: readonly string[];
  /** The sentence every state that is not `proven` repeats, so nothing overclaims. */
  standingLine: string;
  /**
   * The configuration state, derived from the same source the route uses. For the
   * email channel this *is* the Resend provider's own `connection()` — one call,
   * two surfaces, no drift.
   */
  connection: () => ChannelConnectionState;
  /**
   * The in-process check — the same facts `scripts/resend-live-check.ts`
   * establishes over the network: the route's honest state and its refusal of
   * unsigned mail. Optional: a channel without one says so instead of faking it.
   */
  runCheck?: (now: Date) => Promise<ChannelCheckRecord>;
};

/* -------------------------------------------------------------------------- *
 * The email channel — the real thing that exists: Resend forwarding
 * -------------------------------------------------------------------------- */

/** The live webhook URL, exactly as the ratified plan states it. */
export const EMAIL_WEBHOOK_URL = "https://doppal.ctonew.app/api/inbound-email/resend";

export const EMAIL_CHANNEL_STANDING_LINE =
  "Nothing is claimed connected until a real forwarded message has been fetched and stored — this card and the route's own answer both say so.";

export const emailChannelAdapter: ChannelAdapter = {
  id: "email",
  label: "Email — forwarded mail via Resend",
  purpose: "Forward your mailbox to a Resend receiving address and every message arrives here, scored, with its dates and a drafted reply.",
  envVars: [
    { name: "RESEND_WEBHOOK_SECRET", role: "the webhook's signing secret, from Resend's Webhooks page" },
    { name: "RESEND_API_KEY", role: "a Full-access API key on the same Resend account — Doppel reads message bodies, and a sending-access key cannot" },
  ],
  ownerSteps: [
    "Create a Resend account at resend.com.",
    "In Resend, open Emails → Receiving and create a “Receiving address” — your <id>.resend.app address.",
    "Create an API key with Full access. Doppel reads the message body; a sending-access key cannot.",
    "In Resend, open Webhooks → Add Webhook. Point it at the webhook URL below, subscribe to the email.received event only, then copy the signing secret it shows.",
    "Save the two secrets in Doppel (Settings → Secrets): RESEND_WEBHOOK_SECRET from step 4, and RESEND_API_KEY from step 3.",
    "Add the forwarding rule on your own mailbox: forward your mail to the <id>.resend.app receiving address from step 2.",
  ],
  standingLine: EMAIL_CHANNEL_STANDING_LINE,

  connection() {
    const provider = PROVIDERS.resend;
    const result = provider.connection();
    if (result.connected) {
      return {
        state: "configured_unproven" as const,
        missingEnvVars: [] as string[],
        // The provider's armed-state sentence, composed by the same function the
        // GET route answers with.
        message: providerRouteMessage(provider, true),
      };
    }
    return {
      state: "not_configured" as const,
      missingEnvVars: provider.envVars.filter((name) => !configuredEnv(name)),
      // The provider's own sentence, verbatim, composed by the same function the
      // GET route answers with — what /app says and what the route says cannot drift.
      message: providerRouteMessage(provider, false, result.message),
    };
  },

  async runCheck(now: Date): Promise<ChannelCheckRecord> {
    return checkEmailRoute(now);
  },
};

/** Which env-var names are set (presence only — the value is never kept or returned). */
function configuredEnv(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/* -------------------------------------------------------------------------- *
 * The registry — a second channel plugs in here, and nowhere else
 * -------------------------------------------------------------------------- */

/** Registration order is display order. SMS will join here in its own session. */
export const CHANNEL_ADAPTERS: readonly ChannelAdapter[] = [emailChannelAdapter];

/* -------------------------------------------------------------------------- *
 * Status derivation — configuration from the adapter, evidence from the store
 * -------------------------------------------------------------------------- */

export type ChannelStatus = {
  id: ChannelId;
  label: string;
  purpose: string;
  state: "not_configured" | "configured_unproven" | "proven" | "failed";
  /** Every env-var name this channel needs, with roles. Names only. */
  envVars: ChannelEnvVar[];
  /** The subset that is absent right now. Names only. */
  missingEnvVars: string[];
  /**
   * The channel's own sentence for its current state — for the email channel, the
   * very string `GET /api/inbound-email/resend` answers with.
   */
  message: string;
  /**
   * Present in every state except `proven`: the plain sentence saying what is NOT
   * happening. Never present when the channel is proven connected.
   */
  honesty: string | null;
  /** When a real forwarded message was last fetched and stored, and where it landed. */
  provenAt: string | null;
  provenWhere: string | null;
  /** The latest failure, when the latest recorded event is a failure. */
  failure: { code: string; message: string; at: string } | null;
  /** The most recent check, verbatim, labelled with when it ran. */
  lastCheck: ChannelCheckRecord | null;
  /** Whether this channel has a check at all. */
  canCheck: boolean;
  /** The address a provider webhook is pointed at, when the channel has one. */
  webhookUrl: string | null;
  ownerSteps: string[];
  standingLine: string;
};

const PROVEN_WHERE_LABELS: Record<"database" | "preview", string> = {
  database: "the connected database",
  preview: "the in-memory preview (nothing is persisted)",
};

export function channelStatus(adapter: ChannelAdapter): ChannelStatus {
  const connection = adapter.connection();
  const evidence = channelEvidence(adapter.id);
  const configured = connection.state === "configured_unproven";

  // Latest recorded event wins — a failure is never dropped, and a later stored
  // message supersedes it. Nothing here can be talked into `proven` by
  // configuration: only `noteProviderMailStored` (a real kept message) sets it.
  const storedAt = evidence.mailStored?.at ?? null;
  const failedAt = evidence.failure?.at ?? null;
  const failureIsLatest = evidence.failure !== null && (storedAt === null || (failedAt !== null && failedAt >= storedAt));

  const state: ChannelStatus["state"] = failureIsLatest
    ? "failed"
    : evidence.mailStored !== null
      ? "proven"
      : configured
        ? "configured_unproven"
        : "not_configured";

  const honesty =
    state === "proven"
      ? null
      : state === "failed"
        ? "This channel is reported as failed — mail may not be arriving. It stays failed until a real forwarded message is fetched and stored again, or a later check supersedes this."
        : state === "configured_unproven"
          ? "The secrets are set, but no forwarded message has been fetched and stored yet, so this is not claimed as connected."
          : "No mail is flowing into Doppel: until the secrets exist and a real forwarded message is fetched and stored, this channel is not connected.";

  return {
    id: adapter.id,
    label: adapter.label,
    purpose: adapter.purpose,
    state,
    missingEnvVars: connection.missingEnvVars,
    message: connection.message,
    honesty,
    provenAt: evidence.mailStored?.at ?? null,
    provenWhere: evidence.mailStored ? PROVEN_WHERE_LABELS[evidence.mailStored.where] : null,
    failure: failureIsLatest && evidence.failure ? { code: evidence.failure.code, message: evidence.failure.message, at: evidence.failure.at } : null,
    lastCheck: evidence.lastCheck,
    canCheck: typeof adapter.runCheck === "function",
    webhookUrl: adapter.id === "email" ? EMAIL_WEBHOOK_URL : null,
    // Mutable copies: this object crosses to the browser as JSON, and TanStack's
    // serializable constraint wants plain mutable arrays.
    envVars: adapter.envVars.map((envVar) => ({ name: envVar.name, role: envVar.role })),
    ownerSteps: [...adapter.ownerSteps],
    standingLine: adapter.standingLine,
  };
}

/** Every channel's status, in registry order. The card renders exactly this. */
export function channelStatuses(): ChannelStatus[] {
  return CHANNEL_ADAPTERS.map(channelStatus);
}

/* -------------------------------------------------------------------------- *
 * The check — the same facts scripts/resend-live-check.ts establishes
 * -------------------------------------------------------------------------- */

const CHECK_ERROR_MESSAGE =
  "The check could not run just now, so it established nothing — nothing is claimed either way. Try again in a moment.";

/** The route path the email channel's webhook lives at. */
const EMAIL_ROUTE_PATH = "/api/inbound-email/resend";

/**
 * Parse a typed handler answer into the check-fact body shape. Our own responses
 * carry only strings, numbers, booleans and null; anything else (never produced
 * by these handlers) is dropped to null rather than carried forward.
 */
function parseCheckBody(raw: string): Record<string, string | number | boolean | null> {
  const body: Record<string, string | number | boolean | null> = {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
          body[key] = value;
        }
      }
    }
  } catch {
    // A body that is not JSON is recorded as an empty fact body; the status
    // still tells the story.
  }
  return body;
}

/**
 * A plausible `email.received` probe with **no signature headers** — the same shape
 * the live check sends. It must be refused. Even in the impossible case it were
 * accepted, the nil UUID would 404 at Resend and nothing would be stored; as
 * written, the signature layer refuses it before any fetch, and unconfigured
 * channels refuse it before the signature layer. It never stores anything.
 */
function unsignedProbeBody(now: Date): string {
  const iso = now.toISOString();
  return JSON.stringify({
    type: "email.received",
    created_at: iso,
    data: {
      email_id: "00000000-0000-0000-0000-000000000000",
      created_at: iso,
      from: "connection-check@example.com",
      to: ["owner@example.com"],
      message_id: "<connection-check@example.com>",
      subject: "Doppel connection check — this is not a real message",
    },
  });
}

/** `2026-09-24 at 14:03 UTC` — the label the check result is stamped with. */
export function utcLabel(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

/**
 * The email channel's check, run in-process through the same handlers the real
 * routes call — so it proves the server's actual behaviour, not a description of
 * it. Two facts, the same two the live check script establishes from outside:
 *
 *   1. **The route's honest state** — the typed 405 answer with its `connected`
 *      flag and message, verbatim.
 *   2. **The unsigned refusal** — a plausible `email.received` body with no svix
 *      headers must be refused (401 when connected, 503 provider_not_connected
 *      when not). An acceptance is the one thing this check treats as a failure.
 *
 * What this check deliberately cannot prove — and says so in its summary — is that
 * a real forwarded message is fetched and stored. Only real mail proves that, and
 * only the `proven` event records it. A passing check never moves the channel's
 * state: it proves the route is honest, not that mail flows.
 */
export async function checkEmailRoute(now: Date = new Date()): Promise<ChannelCheckRecord> {
  try {
    const facts: ChannelCheckFact[] = [];

    // Fact 1: the route's own answer — the same handler GET /api/inbound-email/resend calls.
    const getResponse = handleProviderWebhookGet("resend");
    const getBody = parseCheckBody(await getResponse.text());
    const getOk =
      getResponse.status === 405 &&
      getBody.provider === "resend" &&
      getBody.error === "method_not_allowed" &&
      typeof getBody.connected === "boolean";
    facts.push({
      label: `The route's own answer (GET ${EMAIL_ROUTE_PATH})`,
      status: getResponse.status,
      body: getBody,
      expected: getOk,
    });

    // Fact 2: an unsigned probe must be refused — forged mail must never be accepted.
    const probe = new Request(`http://connection-check.local${EMAIL_ROUTE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: unsignedProbeBody(now),
    });
    const postResponse = await handleProviderWebhookPost("resend", probe);
    const postBody = parseCheckBody(await postResponse.text());
    const postOk = postResponse.status >= 400 && typeof postBody.error === "string";
    facts.push({
      label: "An unsigned email.received probe (no signature headers) — must be refused",
      status: postResponse.status,
      body: postBody,
      expected: postOk,
    });

    const ranAt = now.toISOString();
    const ranAtLabel = utcLabel(now);

    if (!getOk || !postOk) {
      const reason = !postOk
        ? "An unsigned webhook was accepted — that must never happen: forged mail could be stored. This channel is reported as failed."
        : "The route's answer is not the typed shape this channel should answer with, so the check cannot vouch for it.";
      return { kind: "failed", ranAt, ranAtLabel, facts, reason };
    }

    const connected = getBody.connected === true;
    return {
      kind: "ok",
      ranAt,
      ranAtLabel,
      facts,
      summary: connected
        ? "The route answered and refused the unsigned probe. The secrets are set — but mail is not proven flowing until a real forwarded message is fetched and stored."
        : "The route answered and refused everything honestly: forwarded mail is not connected yet. This check proved the route's honesty, not a connection.",
    };
  } catch {
    // Degrade honestly: a check that cannot run establishes nothing, claims
    // nothing, and changes no state.
    return { kind: "error", ranAt: now.toISOString(), ranAtLabel: utcLabel(now), message: CHECK_ERROR_MESSAGE };
  }
}

/**
 * Run every channel that has a check, record the outcomes, and return the fresh
 * statuses — what the "Check now" button calls. A channel without a check is left
 * untouched and still says so.
 */
export async function runChannelChecks(now: Date = new Date()): Promise<ChannelStatus[]> {
  for (const adapter of CHANNEL_ADAPTERS) {
    if (!adapter.runCheck) continue;
    const record = await adapter.runCheck(now);
    noteChannelCheck(adapter.id, record);
  }
  return channelStatuses();
}
