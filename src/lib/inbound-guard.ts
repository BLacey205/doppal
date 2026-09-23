/**
 * The one gate in front of every route that can put mail into the owner's inbox.
 *
 * Two routes use it: `POST /api/inbound-email` (the plain JSON seam, guarded by a
 * shared token) and `POST /api/inbound-email/resend` (the Resend forwarding webhook,
 * guarded by a provider signature). Both need the same three things — a size cap, a
 * per-IP rate limit and a typed refusal — so they live here once.
 *
 * FAIL CLOSED is the whole point: if `INBOUND_EMAIL_TOKEN` is not set, the token
 * route accepts nothing at all. It never falls back to "no secret configured, so let
 * anyone in" — that would be worse than having no route.
 *
 * Server-only: reads `process.env` and uses node:crypto. Import it from a route
 * handler, never from a component.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Env var holding the shared secret a forwarder must present. */
export const INBOUND_TOKEN_ENV = "INBOUND_EMAIL_TOKEN";

/** Nothing bigger than this is read into memory. ~256 KB is far more than any email body we triage. */
export const MAX_INBOUND_BODY_BYTES = 256 * 1024;

/** Per-IP flood guard. A forwarding service sends a handful of messages a minute at most. */
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_REQUESTS = 30;

export type GuardFailure = {
  ok: false;
  status: number;
  /** Stable machine code — the typed part of the response. */
  code: string;
  /** A plain sentence a human can read. */
  message: string;
  headers?: Record<string, string>;
};

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

export const failureResponse = (failure: GuardFailure) =>
  jsonResponse(
    { ok: false, error: failure.code, message: failure.message },
    failure.status,
    failure.headers ?? {},
  );

/** Every failure below is a readable sentence, never a stack trace or a code. */
export const NOT_CONFIGURED: GuardFailure = {
  ok: false,
  status: 401,
  code: "intake_not_configured",
  message:
    "Intake isn't switched on yet. No shared secret is set for this endpoint, so Doppel is refusing every message rather than accepting mail it can't tell apart from junk. Nothing was stored.",
};

const NO_TOKEN: GuardFailure = {
  ok: false,
  status: 401,
  code: "unauthorized",
  message:
    "That request didn't carry a valid token, so nothing was stored. Send the shared secret as `Authorization: Bearer <token>` or as a `?token=` query parameter.",
};

const TOO_LARGE: GuardFailure = {
  ok: false,
  status: 413,
  code: "payload_too_large",
  message: `That message is bigger than Doppel will accept (limit ${Math.round(
    MAX_INBOUND_BODY_BYTES / 1024,
  )} KB of body). Nothing was stored.`,
};

const RATE_LIMITED: GuardFailure = {
  ok: false,
  status: 429,
  code: "rate_limited",
  message:
    "Too many messages arrived from this address in the last minute. Doppel paused intake for a moment — nothing was stored. Try again shortly.",
  headers: { "retry-after": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) },
};

/* ------------------------------------------------------------------ *
 * The shared secret
 * ------------------------------------------------------------------ */

export function configuredInboundToken(): string | null {
  const value = process.env[INBOUND_TOKEN_ENV];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function inboundIntakeConfigured(): boolean {
  return configuredInboundToken() !== null;
}

/** The token the caller presented: Bearer header first, `?token=` as the fallback. */
export function presentedToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (bearer) return bearer[1]!.trim();

  try {
    const query = new URL(request.url).searchParams.get("token");
    if (query && query.trim().length > 0) return query.trim();
  } catch {
    /* a request whose URL won't parse simply has no query token */
  }
  return null;
}

/** Hash both sides so the comparison leaks neither the length nor a prefix. */
function sameSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * Fail closed. No configured secret → refuse everything. Wrong or missing token →
 * refuse. Never a 500: a bad token is a client problem, and it is reported as one.
 */
export function authorizeInboundRequest(request: Request): { ok: true } | GuardFailure {
  const expected = configuredInboundToken();
  if (!expected) return NOT_CONFIGURED;

  const presented = presentedToken(request);
  if (!presented || !sameSecret(presented, expected)) return NO_TOKEN;

  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Size cap
 * ------------------------------------------------------------------ */

/** A message body arrives as text; bytes matter for the cap, so count bytes. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Read the body up to the cap, refusing anything larger as soon as it is known
 * to be larger — the declared length first, then the actual bytes as they stream.
 */
export async function readCappedBody(
  request: Request,
  max = MAX_INBOUND_BODY_BYTES,
): Promise<{ ok: true; text: string } | GuardFailure> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return TOO_LARGE;

  const stream = request.body;
  if (!stream) {
    const text = await request.text();
    return byteLength(text) > max ? TOO_LARGE : { ok: true, text };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } catch {
    // A truncated upload is a client problem, not ours.
    return { ok: false, status: 400, code: "unreadable_body", message: "That request body could not be read, so nothing was stored." };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(merged) };
}

/* ------------------------------------------------------------------ *
 * Per-IP rate limit (in-memory, per server process)
 * ------------------------------------------------------------------ */

type Bucket = { count: number; resetAt: number };

const RATE_LIMIT_STORE_KEY = "__doppelInboundRateLimits";

/** On globalThis so HMR and the route handlers share one map, and a restart clears it. */
function buckets(): Map<string, Bucket> {
  const store = globalThis as unknown as Record<string, Map<string, Bucket> | undefined>;
  if (!store[RATE_LIMIT_STORE_KEY]) store[RATE_LIMIT_STORE_KEY] = new Map();
  return store[RATE_LIMIT_STORE_KEY]!;
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

/** Count one hit for this caller. Over the limit → a 429 the provider will retry. */
export function checkRateLimit(
  key: string,
  now = Date.now(),
): { ok: true; remaining: number } | GuardFailure {
  const map = buckets();
  const existing = map.get(key);

  if (!existing || existing.resetAt <= now) {
    // Cheap pruning so a flood from many addresses can't grow the map forever.
    if (map.size > 1000) {
      for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
      if (map.size > 5000) map.clear();
    }
    map.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }

  if (existing.count >= RATE_LIMIT_MAX_REQUESTS) return RATE_LIMITED;
  existing.count += 1;
  return { ok: true, remaining: RATE_LIMIT_MAX_REQUESTS - existing.count };
}

/** Used by the self-test to start every scenario from a clean slate. */
export function resetRateLimits(): void {
  buckets().clear();
}

/**
 * The three checks every intake route runs before it looks at the payload:
 * cheap flood guard, then size, then whatever per-route authentication applies.
 */
export async function intakePreflight(
  request: Request,
  options: { maxBytes?: number } = {},
): Promise<{ ok: true; rawBody: string } | GuardFailure> {
  const limited = checkRateLimit(clientIp(request));
  if (!limited.ok) return limited;

  const body = await readCappedBody(request, options.maxBytes ?? MAX_INBOUND_BODY_BYTES);
  if (!body.ok) return body;

  return { ok: true, rawBody: body.text };
}
