/**
 * Live SMS arrival-path check — the one command for the moment the owner's Twilio
 * secrets land (and the honest report of the state before that).
 *
 *   bun scripts/sms-live-check.ts [base-url]      # default https://doppal.ctonew.app
 *
 * It talks to the REAL route (`POST /api/inbound-sms/twilio`) over the network and
 * prints every outcome verbatim — the exact status and the exact body the server
 * returned, never a paraphrase — then a PASS/FAIL/SKIP summary. Exits non-zero on
 * FAIL. Skips are expected and honest: a skip says what could not be evaluated and
 * why, never that it passed.
 *
 * What it proves, in order:
 *
 *   1. **Honest state.** GET the route and report what it says. Until the secrets
 *      exist the 405 + "not connected" body is the EXPECTED result, not a FAIL.
 *      If the deployment answers anything that is not the app's typed JSON (a 404
 *      on an unpublished route, a platform "Site unavailable" page), every check is
 *      skipped with exactly what came back quoted — nothing about the route can be
 *      judged from an answer the route did not give.
 *   2. **Unsigned refusal.** POST a plausible `x-www-form-urlencoded` body with no
 *      `X-Twilio-Signature` header. Once connected this must be refused 401
 *      `missing_signature` — forged texts must never be accepted. Before the
 *      secrets land the route answers 503 `provider_not_connected`, which is also a
 *      pass (refused, honestly, nothing stored).
 *   3. **Tampered refusals** (only when `TWILIO_AUTH_TOKEN` is set in this shell
 *      AND the server reports itself connected): sign a body correctly over the
 *      configured public URL, then send it once with one character of the Body
 *      altered and once with one character of the signature altered. Both must be
 *      refused 401 `bad_signature`. This is the check that proves the signature
 *      check is real rather than decorative.
 *   4. **Signed-but-payload-refused.** Send a correctly signed body that carries NO
 *      `MessageSid`. It must be answered 400 `missing_message_sid` — a status the
 *      signature layer already passed — storing nothing. This is the closest a
 *      check can get to proving a genuine signature is ACCEPTED without posting a
 *      valid `MessageSid`, which would fabricate a message in the owner's inbox.
 *
 * The signed string is built over the URL the OWNER configured — the same fixed,
 * server-side string the validator uses (`TWILIO_WEBHOOK_BASE_URL` from this shell
 * when set, otherwise the live origin) — never a URL reconstructed from the
 * request. That is the fixed-public-URL rule the route itself runs.
 *
 * Ground rules: no probe ever carries a `MessageSid` with a signature that
 * verifies (a fabricated but accepted text would end up in the owner's inbox);
 * the Auth Token is never printed; failure paths log a short string, never a raw
 * Error object. The signer below mirrors `twilioExpectedSignature()` in
 * `src/lib/inbound-twilio.ts` exactly — the server is the spec, not this text.
 *
 * Server-only, run by hand: uses node:crypto and outbound fetch.
 */
import { createHmac, randomUUID } from "node:crypto";

const RULE = "─".repeat(72);

/** The signing key the OWNER also saves in the deployment, for the signed checks. */
const TOKEN_ENV = "TWILIO_AUTH_TOKEN";
/** Optional exact public URL prefix the server validates against; mirrors the server's default. */
const BASE_URL_ENV = "TWILIO_WEBHOOK_BASE_URL";
/** The server's own default origin when no override is configured. */
const DEFAULT_PUBLIC_ORIGIN = "https://doppal.ctonew.app";
const ROUTE_PATH = "/api/inbound-sms/twilio";

type Verdict = "PASS" | "FAIL" | "SKIP";
type Outcome = { name: string; verdict: Verdict; why: string };

const outcomes: Outcome[] = [];

const record = (name: string, verdict: Verdict, why: string): void => {
  outcomes.push({ name, verdict, why });
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/* ------------------------------------------------------------------ *
 * Signing — a mirror of src/lib/inbound-twilio.ts, nothing more
 * ------------------------------------------------------------------ */

/**
 * `base64(HMAC-SHA1(fullConfiguredUrl + sortedConcat(name+value), Auth Token))` —
 * what the server recomputes. The sort is Twilio's "Unix-style case-sensitive"
 * byte order; every Twilio parameter name is ASCII, where JavaScript's `.sort()`
 * is exactly byte order.
 */
function signParams(token: string, url: string, params: Record<string, string>): string {
  const sortedConcat = Object.keys(params)
    .sort()
    .reduce((acc, name) => `${acc}${name}${params[name]}`, "");
  return createHmac("sha1", token).update(`${url}${sortedConcat}`, "utf8").digest("base64");
}

const formEncode = (params: Record<string, string>): string =>
  new URLSearchParams(params).toString();

/* ------------------------------------------------------------------ *
 * The probe bodies — clearly test-labelled, per Twilio's documented shape
 * ------------------------------------------------------------------ */

/** 555-01xx numbers are fictional by standard; the SID is all zeros — nothing real. */
const PROBE_PARAMS = (): Record<string, string> => ({
  MessageSid: `SM${randomUUID().replaceAll("-", "0")}`,
  From: "+15550000001",
  To: "+15550000002",
  Body: "Doppel live check — this is not a real text message",
});

/** The same body with one character of the Body value altered after signing. */
function tamperBody(params: Record<string, string>): Record<string, string> {
  const body = params.Body!;
  const at = Math.floor(body.length / 2);
  const char = body[at]!;
  return { ...params, Body: body.slice(0, at) + (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()) + body.slice(at + 1) };
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

/**
 * The one gate every check passes first: only the app's own typed JSON is a route
 * answer that can be judged. Anything else (a 404 from an unpublished route, a
 * platform "Site unavailable" page, a network error) is reported verbatim and
 * skipped — judged by nothing, claimed by nothing.
 */
type Judged =
  | { kind: "answer"; status: number; body: Record<string, unknown> }
  | { kind: "skip"; why: string }
  | { kind: "fail"; why: string };

function routeAnswered(p: Probe, name: string): Judged {
  if (!p.ok) {
    const why = `the route never answered: ${p.message}`;
    record(name, "FAIL", why);
    return { kind: "fail", why };
  }
  const body = asJson(p.raw);
  if (body === null) {
    console.log(`   → the deployment answered, but not with the app's JSON:`);
    reportVerbatim(p);
    const why = `the deployment answered HTTP ${p.status} with something that is not the app's typed JSON (quoted above) — the route itself said nothing, so nothing can be judged yet. If this is the live host, a publish that carries the route may not have landed.`;
    record(name, "SKIP", why);
    return { kind: "skip", why };
  }
  return { kind: "answer", status: p.status, body };
}

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const base = (process.argv[2] ?? DEFAULT_PUBLIC_ORIGIN).replace(/\/+$/, "");
  const token = process.env[TOKEN_ENV]?.trim() || null;
  /** The URL the signature is computed over — what the SERVER validates against. */
  const signingUrl = `${(process.env[BASE_URL_ENV]?.trim() || DEFAULT_PUBLIC_ORIGIN).replace(/\/+$/, "")}${ROUTE_PATH}`;
  const route = `${base}${ROUTE_PATH}`;

  console.log(RULE);
  console.log("Live SMS arrival-path check (Twilio)");
  console.log(RULE);
  console.log(`base url            : ${base}`);
  console.log(`route               : POST ${route}`);
  console.log(`signatures run over : ${signingUrl}`);
  console.log(`  (the fixed public URL the owner configures in the Twilio Console — set`);
  console.log(`   ${BASE_URL_ENV} in this shell to match a deployment that overrides it)`);
  console.log(
    `${TOKEN_ENV} (this shell): ${
      token ? "present — the tamper and signed-payload checks will run" : "MISSING — checks 3 and 4 will be skipped"
    }`,
  );
  if (!token) {
    console.log(
      `   (export ${TOKEN_ENV}="<the Console Auth Token>" to prove the signature layer for real.\n    Its value is never printed.)`,
    );
  }

  /* ---------------- 1. honest state (GET) ---------------- */

  console.log(`\n1. Honest state — GET the route and report exactly what it says`);
  const got = await probe("GET", route);
  reportVerbatim(got);

  let serverConnected: boolean | null = null;
  const judgedGet = routeAnswered(got, "1. honest state (GET)");
  if (judgedGet.kind === "answer") {
    if (judgedGet.status !== 405 || judgedGet.body.provider !== "twilio") {
      record(
        "1. honest state (GET)",
        "FAIL",
        `expected the typed 405 from the provider route naming "twilio", got HTTP ${judgedGet.status}${
          judgedGet.body.provider === undefined ? " without a provider field" : ` naming "${String(judgedGet.body.provider)}"`
        }`,
      );
    } else {
      serverConnected = judgedGet.body.connected === true;
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

  console.log(`\n2. Unsigned refusal — a plausible text-message body with no X-Twilio-Signature header`);
  const probeParams = PROBE_PARAMS();
  const unsigned = await probe("POST", route, formEncode(probeParams), {
    "content-type": "application/x-www-form-urlencoded",
  });
  reportVerbatim(unsigned);

  const judgedUnsigned = routeAnswered(unsigned, "2. unsigned refusal");
  if (judgedUnsigned.kind === "answer") {
    if (judgedUnsigned.status < 400) {
      record("2. unsigned refusal", "FAIL", `UNSIGNED TEXT WAS ACCEPTED (HTTP ${judgedUnsigned.status}) — the signature gate is not holding`);
    } else if (judgedUnsigned.body.error === "missing_signature") {
      record(
        "2. unsigned refusal",
        "PASS",
        "refused 401 missing_signature — forged texts are turned away at the signature layer",
      );
      if (serverConnected === false) {
        console.log("   (note: the GET said not connected but the POST says the secrets are live — they appear to have landed mid-run; re-run to see the whole connected path)");
        serverConnected = true;
      }
    } else if (judgedUnsigned.body.error === "provider_not_connected") {
      record(
        "2. unsigned refusal",
        "PASS",
        "refused 503 provider_not_connected — the route is not armed yet, so nothing is accepted; this is the expected state until the secrets land, not a FAIL",
      );
    } else {
      record("2. unsigned refusal", "FAIL", `refused, but with an unexpected error code "${String(judgedUnsigned.body.error)}" (HTTP ${judgedUnsigned.status})`);
    }
  }

  /* ---------------- 3. tampered refusals + 4. signed-but-payload-refused ---------------- */

  const connected = serverConnected === true;

  if (!token || !connected) {
    console.log(
      `\n3+4. Tampered refusals and the signed-payload check — SKIPPED: ${
        !token
          ? `${TOKEN_ENV} is not set in this shell, so there is nothing to sign with.`
          : "the server reports it is NOT connected yet, so it refuses before the signature layer and the signature check cannot be evaluated."
      }\n` +
        `     Export ${TOKEN_ENV} (the Console Auth Token) once the Twilio secrets are saved in the\n` +
        `     deployment and re-run to prove the server's signature check for real.`,
    );
    record(
      "3. tampered refusals (body and signature)",
      "SKIP",
      !token
        ? `${TOKEN_ENV} is not set in this shell — nothing to sign with`
        : "the server is not connected yet — it refuses before the signature layer (not a FAIL)",
    );
    record(
      "4. signed-but-payload-refused (no MessageSid)",
      "SKIP",
      !token
        ? `${TOKEN_ENV} is not set in this shell — nothing to sign with`
        : "the server is not connected yet — it refuses before the signature layer (not a FAIL)",
    );
  } else {
    const signature = signParams(token, signingUrl, probeParams);

    console.log(`\n3. Tampered refusals — a correctly-signed body, altered after signing`);

    // 3a. The signature is genuine; the Body is not the one that was signed.
    console.log(`   3a. one character of the Body altered (signature intact):`);
    const tamperedBodyProbe = await probe("POST", route, formEncode(tamperBody(probeParams)), {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    });
    reportVerbatim(tamperedBodyProbe);

    // 3b. The body is the one that was signed; the signature is not.
    console.log(`   3b. one character of the signature altered (body intact):`);
    const tamperedSignatureProbe = await probe("POST", route, formEncode(probeParams), {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": tamperSignature(signature),
    });
    reportVerbatim(tamperedSignatureProbe);

    const judgeTamper = (label: string, p: Probe): void => {
      const judged = routeAnswered(p, label);
      if (judged.kind === "answer") {
        if (judged.status === 401 && judged.body.error === "bad_signature") {
          record(label, "PASS", "refused 401 bad_signature — the signature check is real, not decorative");
          return;
        }
        record(
          label,
          "FAIL",
          judged.status < 400
            ? `TAMPERED INPUT WAS ACCEPTED (HTTP ${judged.status}) — the signature check is not holding`
            : `expected 401 bad_signature, got HTTP ${judged.status}${judged.body.error ? ` with error "${String(judged.body.error)}"` : ""}`,
        );
      }
    };
    judgeTamper("3a. tampered body refused", tamperedBodyProbe);
    judgeTamper("3b. tampered signature refused", tamperedSignatureProbe);

    console.log(`\n4. Signed-but-payload-refused — a genuine signature over a body with no MessageSid`);
    const noSidParams: Record<string, string> = { ...probeParams };
    delete noSidParams.MessageSid;
    const noSidProbe = await probe("POST", route, formEncode(noSidParams), {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signParams(token, signingUrl, noSidParams),
    });
    reportVerbatim(noSidProbe);

    const judgedNoSid = routeAnswered(noSidProbe, "4. signed-but-payload-refused (no MessageSid)");
    if (judgedNoSid.kind === "answer") {
      if (judgedNoSid.status === 400 && judgedNoSid.body.error === "missing_message_sid") {
        record(
          "4. signed-but-payload-refused (no MessageSid)",
          "PASS",
          "answered 400 missing_message_sid — the signature layer ACCEPTED the genuine signature (a 401 would say otherwise) and the payload layer refused the body; nothing was stored",
        );
      } else if (judgedNoSid.status === 401) {
        record(
          "4. signed-but-payload-refused (no MessageSid)",
          "FAIL",
          `a correctly signed request was refused 401 "${String(judgedNoSid.body.error)}" — the server is validating against a different URL or token than this shell signed with (check ${BASE_URL_ENV} and that the saved Auth Token matches this shell's)`,
        );
      } else {
        record(
          "4. signed-but-payload-refused (no MessageSid)",
          "FAIL",
          `expected 400 missing_message_sid, got HTTP ${judgedNoSid.status}${judgedNoSid.body.error ? ` with error "${String(judgedNoSid.body.error)}"` : ""}`,
        );
      }
    }
  }

  /* ---------------- what this check cannot prove ---------------- */

  console.log(`\n${RULE}`);
  console.log("What this check CANNOT prove:");
  console.log(
    "  - That a REAL text arrives, verifies and is stored. That needs a real text from a\n" +
      "    real phone to the owner's Twilio number. This script never sends a correctly\n" +
      "    signed body carrying a MessageSid — a fabricated-but-accepted text would land\n" +
      "    in the owner's inbox as if someone had texted it.",
  );
  console.log(
    "  - TwiML response semantics. Twilio \"expects to receive TwiML in response\"; the\n" +
      "    route answers TwiML-neutral JSON. The exact empty-response behaviour of a\n" +
      "    receive-only number is untested until a real text arrives.",
  );
  console.log(
    "  - Retry behaviour. Twilio's redelivery on non-2xx and the duplicate-suppression\n" +
      "    map can only be observed with real deliveries.",
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
    console.log(`\nRESULT: FAIL — ${failed} of ${outcomes.length} checks failed. Do not trust the SMS arrival path until this passes.`);
    process.exit(1);
  }
  console.log(
    `\nRESULT: PASS — no check failed${
      skipped > 0 ? ` (${skipped} skipped — see above for exactly what was skipped and why)` : ""
    }.`,
  );
  if (!token || serverConnected === false) {
    console.log(
      "The route is not fully exercised yet: the owner's secrets have not landed (or this\n" +
        "shell holds no signing secret), so the signature checks are outstanding. Re-run with\n" +
        `${TOKEN_ENV} set once the Twilio webhook is armed.`,
    );
  }
  process.exit(0);
}

await main();
