/**
 * The gate in front of the social read endpoint.
 *
 * `/api/social-read` can, once the owner's developer apps are approved, pull the
 * owner's own posts, comments, messages and analytics out of a network — so it does
 * not answer an unauthenticated caller at all. It follows the same rule as the mail
 * intake route (`~/lib/inbound-guard`): **fail closed**. With no shared secret
 * configured, the endpoint refuses every request rather than becoming public the
 * moment somebody forgets a variable. The two sides are hashed and compared with
 * `timingSafeEqual`, so neither a length nor a prefix leaks.
 *
 * The secret is a name of its own (`SOCIAL_READ_TOKEN`) rather than the mail token,
 * because the two endpoints expose different things and should be revocable
 * separately. Names only, as everywhere in this gateway: no value is logged,
 * returned or put in a message.
 *
 * Server-only: reads `process.env`, uses node:crypto.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Env var holding the shared secret a caller must present to read. */
export const SOCIAL_READ_TOKEN_ENV = "SOCIAL_READ_TOKEN";

export type SocialGuardFailure = {
  ok: false;
  status: number;
  /** The typed, machine-readable part of the response. */
  code: string;
  message: string;
};

export const SOCIAL_NOT_CONFIGURED: SocialGuardFailure = {
  ok: false,
  status: 401,
  code: "read_not_configured",
  message:
    "The social read endpoint isn't switched on. No shared secret is set for it, so Doppel is refusing every request rather than exposing an account to anyone who asks. Nothing was read.",
};

const NO_TOKEN: SocialGuardFailure = {
  ok: false,
  status: 401,
  code: "unauthorized",
  message:
    "That request didn't carry a valid token, so nothing was read. Send the shared secret as `Authorization: Bearer <token>` or as a `?token=` query parameter.",
};

function configuredToken(): string | null {
  const value = process.env[SOCIAL_READ_TOKEN_ENV];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function socialReadConfigured(): boolean {
  return configuredToken() !== null;
}

/** The token the caller presented: Bearer header first, `?token=` as the fallback. */
export function presentedSocialToken(request: Request): string | null {
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

function sameSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/** Fail closed: no configured secret refuses everything; a wrong token refuses too. */
export function authorizeSocialRead(
  request: Request,
  expected = configuredToken(),
): { ok: true } | SocialGuardFailure {
  if (!expected) return SOCIAL_NOT_CONFIGURED;
  const presented = presentedSocialToken(request);
  if (!presented || !sameSecret(presented, expected)) return NO_TOKEN;
  return { ok: true };
}
