/**
 * Live Resend arrival-path check — the one command for the moment the owner's two
 * secrets land.
 *
 *   bun scripts/resend-live-check.ts [base-url]      # default https://doppal.ctonew.app
 *
 * It talks to the REAL route (`POST /api/inbound-email/resend`) over the network and
 * prints every outcome verbatim — the exact status and the exact body the server
 * returned, never a paraphrase — then a PASS/FAIL summary. Exits non-zero on FAIL.
 *
 * What it proves, in order:
 *
 *   1. **Honest state.** GET the route and report what it says. Until the secrets
 *      exist the 405 + "not connected" body is the EXPECTED result, not a FAIL.
 *   2. **Unsigned refusal.** POST a plausible `email.received` body with no svix
 *      headers. Once connected this must be refused 401 `missing_signature` — forged
 *      mail must never be accepted. Before the secrets land the route answers
 *      503 `provider_not_connected`, which is also a pass (refused, honestly).
 *   3. **Tampered refusals** (only when `RESEND_WEBHOOK_SECRET` is set in this
 *      shell, so there is something to sign with): sign a body correctly, then send
 *      it once with one byte of the body altered and once with one character of the
 *      signature altered. Both must be refused 401 `bad_signature`. This is the
 *      check that proves the signature check is real rather than decorative.
 *   4. **Signed-and-ignored.** Sign a genuine webhook for an event type that is NOT
 *      `email.received` (`email.sent`). It must be accepted 2xx and reported as
 *      ignored, storing nothing.
 *
 * What this check deliberately cannot prove (and says so in its own output): that a
 * REAL forwarded message is fetched from Resend's receiving API and stored. That
 * needs real mail with a real `email_id`. This script therefore NEVER posts a
 * correctly-signed `email.received` event — the only fully-signed probe it sends is
 * an `email.sent`, which the route ignores before it ever looks for an id.
 *
 * Ground rules: nothing is stored by design (every `email.received` body it sends is
 * either unsigned or tampered, so the signature layer refuses it before anything is
 * fetched); the signing secret is never printed; failure paths log a short string,
 * never a raw Error object. The signer below mirrors `signingKey()` +
 * `verifyResendSignature()` in `src/lib/inbound-providers.ts` exactly — the server
 * is the spec, not this description.
 *
 * Server-only, run by hand: uses node:crypto and outbound fetch.
 */
import { createHmac, randomUUID } from "node:crypto";

const RULE = "─".repeat(72);

/** The signing secret the OWNER also saves in the deployment, for the tamper checks. */
const SECRET_ENV = "RESEND_WEBHOOK_SECRET";

type Verdict = "PASS" | "FAIL" | "SKIP";
type Outcome = { name: string; verdict: Verdict; why: string };

const outcomes: Outcome[] = [];

const record = (name: string, verdict: Verdict, why: string): void => {
  outcomes.push({ name, verdict, why });
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/* ------------------------------------------------------------------ *
 * Signing — a mirror of src/lib/inbound-providers.ts, nothing more
 * ------------------------------------------------------------------ */

/** The Svix signing key is the base64 part of the secret, i.e. everything after `whsec_`. */
function signingKey(secret: string): Buffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const decoded = Buffer.from(encoded, "base64");
  // A secret that isn't base64 (a hand-set value) still works, as UTF-8 bytes.
  return decoded.length > 0 ? decoded : Buffer.from(secret, "utf8");
}

/** `base64(HMAC-SHA256("${id}.${timestamp}.${rawBody}", key))` — what the server recomputes. */
function signPayload(secret: string, id: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", signingKey(secret))
    .update(`${id}.${timestamp}.${rawBody}`, "utf8")
    .digest("base64");
}

const svixHeaders = (id: string, timestamp: string, signature: string): Record<string, string> => ({
  "content-type": "application/json",
  "svix-id": id,
  "svix-timestamp": timestamp,
  "svix-signature": `v1,${signature}`,
});

/* ------------------------------------------------------------------ *
 * The probe bodies
 * ------------------------------------------------------------------ */

/**
 * A plausible `email.received` event, in the shape Resend's docs publish. The id is
 * the nil UUID on purpose: it is clearly not a real message, and even in the
 * impossible case that an unsigned or tampered copy was accepted, a fetch of that id
 * would 404 at Resend and nothing would be stored.
 */
function plausibleReceivedBody(): string {
  const now = new Date().toISOString();
  return JSON.stringify({
    type: "email.received",
    created_at: now,
    data: {
      email_id: "00000000-0000-0000-0000-000000000000",
      created_at: now,
      from: "live-check@example.com",
      to: ["owner@example.com"],
      message_id: "<live-check@example.com>",
      subject: "Doppel live check — this is not a real message",
    },
  });
}

/** A genuine non-`email.received` webhook: accepted, then ignored, storing nothing. */
function emailSentBody(): string {
  return JSON.stringify({
    type: "email.sent",
    created_at: new Date().toISOString(),
    data: { email_id: "00000000-0000-0000-0000-000000000000" },
  });
}

/** Flip the case of the last character of the subject value — same length, one byte. */
function tamperOneBodyByte(body: string): string {
  // JSON.stringify emits no space after the colon — match exactly what it wrote.
  const marker = '"subject":"Doppel live check — this is not a real message';
  const at = body.indexOf(marker);
  if (at < 0) throw new Error("could not find the subject to tamper with");
  const last = at + marker.length - 1;
  const char = body[last]!;
  return body.slice(0, last) + (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()) + body.slice(last + 1);
}

/** Flip the first character of the base64 signature — still plausible, now wrong. */
function tamperSignature(signature: string): string {
  const first = signature[0]!;
  return (first === "A" ? "B" : "A") + signature.slice(1);
}

/* ------------------------------------------------------------------ *
 * The network
 * ------------------------------------------------------------------ */

type Probe =
  | { ok: true; status: number; raw: string }
  | { ok: false; message: string };

async function probe(
  method: "GET" | "POST",
  url: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<Probe> {
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: true, status: response.status, raw: await response.text() };
  } catch (err) {
    return { ok: false, message: errorText(err) };
  }
}

/** Print what the server actually returned — exact status, exact body, no paraphrase. */
function reportVerbatim(p: Probe): void {
  if (!p.ok) {
    console.log(`   → the request never got an answer: ${p.message}`);
    return;
  }
  console.log(`   → HTTP ${p.status}`);
  console.log(p.raw);
}

const asJson = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const base = (process.argv[2] ?? "https://doppal.ctonew.app").replace(/\/+$/, "");
  const secret = process.env[SECRET_ENV]?.trim() || null;

  console.log(RULE);
  console.log("Live Resend arrival-path check");
  console.log(RULE);
  console.log(`base url            : ${base}`);
  console.log(`route               : POST ${base}/api/inbound-email/resend`);
  console.log(
    `${SECRET_ENV} (this shell) : ${
      secret ? "present — the tamper and ignore checks will run" : "MISSING — checks 3 and 4 will be skipped"
    }`,
  );
  if (!secret) {
    console.log(
      `   (export ${SECRET_ENV}="<the webhook's signing secret>" to prove the tamper refusals\n    and the signed-ignore path against the live server. Its value is never printed.)`,
    );
  }

  /* ---------------- 1. honest state (GET) ---------------- */

  console.log(`\n1. Honest state — GET the route and report exactly what it says`);
  const got = await probe("GET", `${base}/api/inbound-email/resend`);
  reportVerbatim(got);

  let serverConnected: boolean | null = null;
  if (!got.ok) {
    record("1. honest state (GET)", "FAIL", `the route never answered: ${got.message}`);
  } else {
    const body = asJson(got.raw);
    if (got.status !== 405 || body === null || body.provider !== "resend") {
      record(
        "1. honest state (GET)",
        "FAIL",
        `expected the typed 405 from the provider route, got HTTP ${got.status}${
          body === null ? " with a body that is not JSON" : ""
        }`,
      );
    } else {
      serverConnected = body.connected === true;
      record(
        "1. honest state (GET)",
        "PASS",
        serverConnected
          ? "the route answers its typed 405 and reports itself armed and ready"
          : "the route answers its typed 405 and honestly says it is NOT connected yet — expected until the owner's secrets land, not a FAIL",
      );
    }
  }

  /* ---------------- 2. unsigned refusal ---------------- */

  console.log(`\n2. Unsigned refusal — a plausible email.received body with no svix headers`);
  const receivedBody = plausibleReceivedBody();
  const unsigned = await probe("POST", `${base}/api/inbound-email/resend`, receivedBody, {
    "content-type": "application/json",
  });
  reportVerbatim(unsigned);

  if (!unsigned.ok) {
    record("2. unsigned refusal", "FAIL", `the route never answered: ${unsigned.message}`);
  } else {
    const body = asJson(unsigned.raw);
    if (unsigned.status < 400) {
      record("2. unsigned refusal", "FAIL", `UNSIGNED MAIL WAS ACCEPTED (HTTP ${unsigned.status}) — the signature gate is not holding`);
    } else if (body === null) {
      record("2. unsigned refusal", "FAIL", `refused, but the body is not the typed JSON error (HTTP ${unsigned.status})`);
    } else if (body.error === "missing_signature") {
      record(
        "2. unsigned refusal",
        "PASS",
        "refused 401 missing_signature — forged mail is turned away at the signature layer",
      );
      if (serverConnected === false) {
        console.log("   (note: the GET said not connected but the POST says the secrets are live — they appear to have landed mid-run; re-run to see the whole connected path)");
        serverConnected = true;
      }
    } else if (body.error === "provider_not_connected") {
      record(
        "2. unsigned refusal",
        "PASS",
        "refused 503 provider_not_connected — the route is not armed yet, so nothing is accepted; this is the expected state until the secrets land, not a FAIL",
      );
    } else {
      record("2. unsigned refusal", "FAIL", `refused, but with an unexpected error code "${String(body.error)}" (HTTP ${unsigned.status})`);
    }
  }

  /* ---------------- 3. tampered refusals + 4. signed-and-ignored ---------------- */

  const connected = serverConnected === true;

  if (!secret) {
    console.log(
      `\n3+4. Tampered refusals and the signed-ignore path — SKIPPED: ${SECRET_ENV} is not set in this\n` +
        `     shell, so there is nothing to sign with. Export it (the webhook's signing secret from\n` +
        `     Resend → Webhooks) and re-run to prove the server's signature check for real.`,
    );
    record("3. tampered refusals (body and signature)", "SKIP", `${SECRET_ENV} is not set in this shell — nothing to sign with`);
    record("4. signed-and-ignored (email.sent)", "SKIP", `${SECRET_ENV} is not set in this shell — nothing to sign with`);
  } else {
    const id = `msg_${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signPayload(secret, id, timestamp, receivedBody);

    console.log(`\n3. Tampered refusals — a correctly-signed body, altered after signing`);

    // 3a. The signature is genuine; the body is not the one that was signed.
    console.log(`   3a. one byte of the body altered (signature intact):`);
    const tamperedBody = await probe("POST", `${base}/api/inbound-email/resend`, tamperOneBodyByte(receivedBody), svixHeaders(id, timestamp, signature));
    reportVerbatim(tamperedBody);

    // 3b. The body is the one that was signed; the signature is not.
    console.log(`   3b. one character of the signature altered (body intact):`);
    const tamperedSignature = await probe("POST", `${base}/api/inbound-email/resend`, receivedBody, svixHeaders(id, timestamp, tamperSignature(signature)));
    reportVerbatim(tamperedSignature);

    const judgeTamper = (label: string, p: Probe): void => {
      if (!p.ok) {
        record(label, "FAIL", `the route never answered: ${p.message}`);
        return;
      }
      const body = asJson(p.raw);
      if (!connected && body !== null && body.error === "provider_not_connected") {
        record(
          label,
          "SKIP",
          "the server is not connected yet — it refuses before the signature layer, so the tamper check cannot be evaluated until the owner's secrets land (not a FAIL)",
        );
        return;
      }
      if (p.status === 401 && body !== null && body.error === "bad_signature") {
        record(label, "PASS", "refused 401 bad_signature — the signature check is real, not decorative");
        return;
      }
      record(
        label,
        "FAIL",
        p.status < 400
          ? `TAMPERED INPUT WAS ACCEPTED (HTTP ${p.status}) — the signature check is not holding`
          : `expected 401 bad_signature, got HTTP ${p.status}${body?.error ? ` with error "${String(body.error)}"` : ""}`,
      );
    };
    judgeTamper("3a. tampered body refused", tamperedBody);
    judgeTamper("3b. tampered signature refused", tamperedSignature);

    console.log(`\n4. Signed-and-ignored — a genuine webhook for an event this route does not take`);
    const sentId = `msg_${randomUUID()}`;
    const sentTimestamp = String(Math.floor(Date.now() / 1000));
    const sentBody = emailSentBody();
    const sentSignature = signPayload(secret, sentId, sentTimestamp, sentBody);
    const ignored = await probe("POST", `${base}/api/inbound-email/resend`, sentBody, svixHeaders(sentId, sentTimestamp, sentSignature));
    reportVerbatim(ignored);

    if (!ignored.ok) {
      record("4. signed-and-ignored (email.sent)", "FAIL", `the route never answered: ${ignored.message}`);
    } else {
      const body = asJson(ignored.raw);
      if (!connected && body !== null && body.error === "provider_not_connected") {
        record(
          "4. signed-and-ignored (email.sent)",
          "SKIP",
          "the server is not connected yet — it refuses before the signature layer, so this cannot be evaluated until the owner's secrets land (not a FAIL)",
        );
      } else if (ignored.status >= 200 && ignored.status < 300 && body !== null && body.ignored === true) {
        record(
          "4. signed-and-ignored (email.sent)",
          "PASS",
          "accepted 2xx and reported ignored:true — the route only takes received mail, and this event stored nothing",
        );
      } else {
        record(
          "4. signed-and-ignored (email.sent)",
          "FAIL",
          `expected 2xx with ignored:true, got HTTP ${ignored.status}${body?.ignored === undefined ? " without an ignored flag" : ""}`,
        );
      }
    }
  }

  /* ---------------- what this check cannot prove ---------------- */

  console.log(`\n${RULE}`);
  console.log("What this check CANNOT prove:");
  console.log(
    "  - That a REAL forwarded message is fetched from Resend's receiving API and stored.\n" +
      "    That needs real mail with a real `email_id` — which only exists after the owner\n" +
      "    forwards an actual message. This script never posts a correctly-signed\n" +
      "    `email.received` event, because a fabricated one with an invented id would call\n" +
      "    Resend's API, fail, and leave a false story in the live inbox or logs.",
  );
  console.log(
    "  - Store contents. An `ignored:true` answer is the server's own word that nothing was\n" +
      "    kept; no outside caller can read the inbox to double-check it.",
  );
  console.log(
    "  - Retry behaviour. Resend's retries (immediate, 5s, 5m, 30m, 2h, 5h, 10h) and the\n" +
      "    duplicate-suppression map can only be observed with real deliveries.",
  );

  /* ---------------- summary ---------------- */

  console.log(RULE);
  console.log("Summary");
  console.log(RULE);
  let failed = 0;
  for (const outcome of outcomes) {
    console.log(`  ${outcome.verdict.padEnd(4)}  ${outcome.name}`);
    console.log(`        ${outcome.why}`);
    if (outcome.verdict === "FAIL") failed += 1;
  }
  const skipped = outcomes.filter((o) => o.verdict === "SKIP").length;
  if (failed > 0) {
    console.log(`\nRESULT: FAIL — ${failed} of ${outcomes.length} checks failed. Do not trust the arrival path until this passes.`);
    process.exit(1);
  }
  console.log(
    `\nRESULT: PASS — no check failed${
      skipped > 0 ? ` (${skipped} skipped — see above for exactly what was skipped and why)` : ""
    }.`,
  );
  if (!secret || serverConnected === false) {
    console.log(
      "The route is not fully exercised yet: the owner's secrets have not landed (or this\n" +
        "shell holds no signing secret), so the tamper and signed-ignore checks are outstanding.\n" +
        "Re-run with RESEND_WEBHOOK_SECRET set once the Resend webhook exists.",
    );
  }
  process.exit(0);
}

await main();
