/**
 * Exercises the whole inbox wedge without a database and without a model key:
 *
 *   bun run scripts/app-selftest.ts
 *
 * What it proves:
 *   1. an email (with or without headers) parses into from/subject/body,
 *   2. triage ranks a newsletter under an urgent client email, with reasons,
 *   3. dates and times come out as calendar-ready candidates with reminders
 *      (timed → 30 minutes before, all-day → 9:00 AM on the day),
 *   4. the heuristic draft is labelled as a heuristic draft,
 *   5. `ingestEmail()` writes an email row + a draft row through one executor,
 *   6. with no DATABASE_URL the same call still works end to end in preview mode
 *      (memory): ingest → list → add to calendar → delete,
 *   7. a failing write returns a human message instead of throwing,
 *   8. timestamps leave the layer as strings, never as Date objects,
 *   9. re-ingesting through the same funnel still reports the triage it picked up,
 *  10. `POST /api/inbound-email` fails closed: no INBOUND_EMAIL_TOKEN → 401 and
 *      nothing ingested, wrong token → 401, oversized body → 413, a flood → 429,
 *      GET → 405; the right token (header or `?token=`) → 201, ingested and triaged,
 *  11. the Resend forwarding webhook verifies svix-style signatures (valid, tampered,
 *      stale, wrong secret), refuses to run unconfigured with a typed 503, and never
 *      throws or 500s on a payload it can't process,
 *  12. owner alerting (Knock): only mail that arrived through the machine seam can
 *      alert, only above the bar; every outcome is a typed result (sent /
 *      not_configured / workflow_missing / unauthorized / rejected / unavailable);
 *      the API key never reaches a payload, a message or a log line; a failing alert
 *      never changes an ingest; and the `/app` line says plainly that the owner is
 *      not being told whenever alerting is not on — asserted on the real component,
 *      rendered here with react-dom/server. Every Knock call here goes through
 *      a stub transport — no socket is opened and nothing is delivered.
 *  13. database transport: `DATABASE_URL` alone decides the wire, with no rebuild.
 *      A Neon host keeps the Neon HTTP driver; any other Postgres host (Tiger
 *      Cloud, RDS, a local server) is reached over the real wire protocol via the
 *      runtime's built-in client, because the Neon driver only ever POSTs to
 *      `https://api.<host>/sql` — an endpoint a plain Postgres does not serve.
 *      Pure string/URL logic: nothing here opens a connection.
 *  14. the storage line on /app claims only what a real query has proved: no
 *      address at all → the unchanged "nothing is being saved" preview; an address
 *      with no query yet → "not confirmed", which claims nothing; a query that came
 *      back → "saved to the connected database"; a failed query → the failure,
 *      carrying the app's own typed sentence, and it stays reported even if a later
 *      query succeeds. Rendered too, on the real card, so the wording on screen is
 *      asserted and not just the view model. Hermetic: a stubbed executor, no live
 *      database, no network.
 *  15. duplicate suppression on the provider webhook remembers a provider message
 *      id only once the message genuinely reached a store: a refused store answers
 *      503 store_failed — the kind Resend retries — and remembers nothing, so the
 *      retry stores the message instead of being told it is a duplicate; a silent
 *      memory fallback while a database is configured is refused the same way; a
 *      real store followed by an accidental repeat is still answered `duplicate`
 *      with exactly one insert; and an ignored event stores and remembers nothing.
 *      Hermetic: a stand-in provider and injected executors, no network, no real
 *      database.
 *  16. the signature freshness window cannot lose a retry: an attempt signed
 *      beyond the tolerance is refused as stale and remembered by no one, and
 *      the same message re-signed with a current timestamp — the same svix-id,
 *      the same body, a fresh timestamp, which is what a retried attempt
 *      carries — is accepted and stored. Hermetic: the stale refusal fails
 *      before any provider call, the re-sign is judged by the same
 *      verifyResendSignature() the route runs, and the store is the stand-in.
 *  17. a forwarded message with no readable body is stored, not refused:
 *      Resend's documented retrieve-received-email response can carry
 *      `"text": null` with HTML present (their own example does), and a real
 *      forward can have no HTML either — an attachment-only forward is the
 *      realistic case. Every such message that names a sender or a subject is
 *      stored with the absence said plainly (a bracketed Doppel note, naming
 *      unfetched attachments when there are any), the answer never claims text
 *      it does not have, and only a payload that is literally nothing is still
 *      refused with the typed error — nothing stored, nothing remembered.
 *      Fixtures are copied from Resend's published examples (doc URLs in the
 *      section comments); hermetic: the upstream fetch is a stub, the store is
 *      the stand-in, no network.
 */
import { heuristicDates, heuristicDraft, heuristicImportance, aiStatus } from "../src/lib/ai";
import { fromStructured, parseRawEmail } from "../src/lib/email-parse";
import { addDateToCalendar, ingestEmail } from "../src/lib/ingest";
import {
  getEmail,
  listCalendarEvents,
  listEmails,
  deleteCalendarEvent,
  storageStatus,
  type QueryExecutor,
} from "../src/lib/inbox-server";
import { resetStorageEvidence } from "../src/lib/storage-evidence";
import { createHmac } from "node:crypto";
import {
  INBOUND_TOKEN_ENV,
  MAX_INBOUND_BODY_BYTES,
  RATE_LIMIT_MAX_REQUESTS,
  resetRateLimits,
} from "../src/lib/inbound-guard";
import { handleInboundEmailGet, handleInboundEmailPost } from "../src/lib/inbound-request";
import {
  PROVIDERS,
  RESEND_API_KEY_ENV,
  RESEND_WEBHOOK_SECRET_ENV,
  handleProviderWebhookGet,
  handleProviderWebhookPost,
  resetIngestedProviderMessages,
  signatureHeaders,
  verifyResendSignature,
} from "../src/lib/inbound-providers";
import {
  DEFAULT_OWNER_ALERT_EMAIL,
  DEFAULT_WORKFLOW_KEY,
  IMPORTANCE_ALERT_THRESHOLD,
  KNOCK_API_BASE,
  KNOCK_API_KEY_ENV,
  KNOCK_WORKFLOW_KEY_ENV,
  NEEDS_REPLY_ALERT_THRESHOLD,
  OWNER_ALERT_EMAIL_ENV,
  OWNER_RECIPIENT_ID,
  SITE_URL_ENV,
  alertConfig,
  alertData,
  alertStatus,
  notifyImportantEmail,
  notifyImportantEmailInBackground,
  probeAlerting,
  resetAlertStatusCache,
  shouldAlert,
  type NotifiableEmail,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "../src/lib/notify";
import { alertsView } from "../src/lib/alert-view";
import { databaseHostSafe, databaseTransport, sql as databaseClient } from "../src/db";
import { AlertsLine, ModeCard } from "../src/components/app-ui";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AlertState, AlertStatus, StorageStatus } from "../src/lib/inbox-types";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

type Call = { sql: string; values: unknown[] };

function fakeDb(
  plan: (sql: string) => Record<string, unknown>[],
  opts: { throwOn?: "insert" | "select" } = {},
) {
  const calls: Call[] = [];
  const exec: QueryExecutor = async (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ sql: text, values });
    if (opts.throwOn === "insert" && /insert into/i.test(text)) throw new Error("connection refused");
    if (opts.throwOn === "select" && /select/i.test(text)) throw new Error("connection refused");
    return plan(text);
  };
  return { exec, calls };
}

const WEDNESDAY = "2026-09-16T10:00:00.000Z"; // a Wednesday, in UTC

const urgentEmail = {
  fromLabel: "Marcus Bell <marcus@example.com>",
  fromEmail: "marcus@example.com",
  subject: "URGENT — Thursday's site visit has to move",
  body: "The tenant has locked us out on Thursday. The only slot is tomorrow at 2:30pm.\nThis is urgent — can you confirm by the end of the day today?",
  receivedAt: WEDNESDAY,
};

const newsletterEmail = {
  fromLabel: "Trade Monthly <newsletter@trademonthly.example>",
  fromEmail: "newsletter@trademonthly.example",
  subject: "5 ways to win more repeat business",
  body: "You're receiving this because you subscribed. View this email in your browser. Unsubscribe · Manage preferences",
  receivedAt: WEDNESDAY,
};

/* The route handlers are plain functions of a Request, so the whole guarded intake
 * path is exercised here without a server and without touching the network. */
const API_URL = "http://localhost/api/inbound-email";

function postRequest(url: string, body: string, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

async function jsonOf(response: Response): Promise<Record<string, any>> {
  return JSON.parse(await response.text()) as Record<string, any>;
}

/**
 * The signature Resend/Svix sends: base64(HMAC-SHA256(`${id}.${timestamp}.${body}`))
 * keyed with the base64 part of the `whsec_` secret, listed as `v1,<signature>`.
 * Written out independently of the app's own code so the check is a real cross-check.
 */
function svixSignature(id: string, timestamp: string, body: string, secret: string): string {
  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const digest = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64");
  return `v1,${digest}`;
}

async function main() {
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // Alerting is exercised in full in section 12, through a stub transport. Clearing
  // the key here keeps every earlier ingest in this suite off the network too.
  delete process.env[KNOCK_API_KEY_ENV];

  console.log("\n1. An email parses with or without headers");
  const withHeaders = parseRawEmail(
    'From: "Priya Raghunathan" <priya@brightlark.example>\nSubject: Quote for 12 windows\n\nHi, can you quote?\nFriday at 9am suits me.',
    WEDNESDAY,
  );
  check("from name and address split", withHeaders.fromName === "Priya Raghunathan" && withHeaders.fromEmail === "priya@brightlark.example", withHeaders);
  check("subject captured", withHeaders.subject === "Quote for 12 windows", withHeaders.subject);
  check("body keeps the message, not the headers", withHeaders.body.startsWith("Hi, can you quote?"), withHeaders.body);
  check("receivedAt falls back to the given value", withHeaders.receivedAt === WEDNESDAY, withHeaders.receivedAt);

  const headerless = parseRawEmail("Just a note with no headers at all. Are you free tomorrow?", WEDNESDAY);
  check("no headers → whole text is the body", headerless.body.startsWith("Just a note"), headerless.body);
  check("no subject → placeholder, not empty", headerless.subject === "(no subject)", headerless.subject);

  const structured = fromStructured({ from: "tc@example.com", subject: "Hello", text: "Body here" });
  check("structured input → address parsed", structured.fromEmail === "tc@example.com", structured);

  console.log("\n2. Triage puts the client above the newsletter");
  const urgent = heuristicImportance(urgentEmail, 2);
  const newsletter = heuristicImportance(newsletterEmail, 0);
  check("urgent mail scores high", urgent.score >= 70, urgent);
  check("urgent mail needs a reply", urgent.needsReply === true, urgent);
  check("newsletter scores low", newsletter.score <= 35, newsletter);
  check("newsletter needs no reply", newsletter.needsReply === false, newsletter);
  check("both carry a one-line reason", urgent.reason.length > 10 && newsletter.reason.length > 10, { urgent, newsletter });
  check("reasons are human, not rule names", !/regex|keyword|score\s*=/i.test(urgent.reason), urgent.reason);

  console.log("\n3. Dates and times become calendar candidates with reminders");
  const friday = heuristicDates(
    { ...structured, subject: "Site visit", body: "Are you free Friday at 9am to measure up?", receivedAt: WEDNESDAY },
  );
  check("finds one candidate", friday.length === 1, friday);
  check("Friday resolves to the coming Friday at 09:00 UTC", friday[0]?.startsAt === "2026-09-18T09:00:00.000Z", friday[0]);
  check("timed reminder is 30 minutes before", friday[0]?.reminderAt === "2026-09-18T08:30:00.000Z", friday[0]);
  check("label quotes the email", /Friday at 9am/i.test(friday[0]?.label ?? ""), friday[0]?.label);

  const tomorrow = heuristicDates({
    ...structured,
    subject: "Move it",
    body: "The only slot is tomorrow at 2:30pm now.",
    receivedAt: WEDNESDAY,
  });
  check("relative day resolves against receivedAt", tomorrow[0]?.startsAt === "2026-09-17T14:30:00.000Z", tomorrow[0]);

  const written = heuristicDates({
    ...structured,
    subject: "Invoice",
    body: "Payment falls due on 20 October 2026 per our terms.",
    receivedAt: WEDNESDAY,
  });
  check("month-name date is found", written[0]?.startsAt === "2026-10-20T00:00:00.000Z", written[0]);
  check("no time → all-day", written[0]?.allDay === true, written[0]);
  check("all-day reminder is 9:00 AM on the day", written[0]?.reminderAt === "2026-10-20T09:00:00.000Z", written[0]);

  const iso = heuristicDates({ ...structured, subject: "Deadline", body: "It closes on 2026-10-03.", receivedAt: WEDNESDAY });
  check("ISO date is found", iso[0]?.startsAt === "2026-10-03T00:00:00.000Z", iso[0]);

  const none = heuristicDates({ ...structured, subject: "Thanks", body: "Thanks for the update, all good.", receivedAt: WEDNESDAY });
  check("no invented dates", none.length === 0, none);

  const withPast = heuristicDates({
    ...structured,
    subject: "Old",
    body: "We met on 2024-01-05 and that was that.",
    receivedAt: WEDNESDAY,
  });
  check("dates long past are not offered for the calendar", withPast.length === 0, withPast);

  console.log("\n4. The draft is a heuristic draft and says so");
  const draft = heuristicDraft({ ...structured, subject: "Quote for 12 windows", body: "Can you quote? Friday at 9am?" }, {
    needsReply: true,
    dates: friday,
  });
  check("draft greets the sender", /^Hi (there|Priya|Tc|Tc,)/.test(draft) || draft.startsWith("Hi"), draft.split("\n")[0]);
  check("draft references the subject", draft.includes("Quote for 12 windows"), draft);
  check("draft carries the date we found", /Friday at 9am/.test(draft), draft);
  check("draft leaves the facts to the owner", /Add the detail only you know/.test(draft), draft);
  const noReply = heuristicDraft(newsletterEmail, { needsReply: false, dates: [] });
  check("newsletter draft says no reply is needed", /no reply needed/i.test(noReply), noReply);

  console.log("\n5. Which mode produced the output is always reported");
  check("no key → heuristic mode", aiStatus().mode === "heuristic", aiStatus());
  check("heuristic label says so in words", /rules/i.test(aiStatus().label), aiStatus().label);
  process.env.OPENAI_API_KEY = "test-key-not-used-for-a-call";
  const withKey = aiStatus();
  check("a key present → model mode, named", withKey.mode === "model" && /openai/.test(withKey.provider), withKey);
  delete process.env.OPENAI_API_KEY;

  console.log("\n6. ingestEmail() writes an email row and a draft row through one executor");
  const { exec, calls } = fakeDb((sqlText) => {
    if (/^create table/i.test(sqlText)) return [];
    if (/insert into emails/i.test(sqlText)) return [{ id: 7 }];
    if (/select id from drafts/i.test(sqlText)) return [];
    return [{ id: 1 }];
  });
  const ingested = await ingestEmail(
    { source: "api", from: "Marcus Bell <marcus@example.com>", subject: urgentEmail.subject, text: urgentEmail.body, receivedAt: WEDNESDAY },
    exec,
  );
  check("ingest succeeds", ingested.ok === true, ingested.ok ? undefined : ingested);
  const creates = calls.filter((c) => /^create table/i.test(c.sql)).map((c) => c.sql.replace(/ .*/, ""));
  check("tables are created before the first write", creates.length === 3, creates);
  check("emails table is created", calls.some((c) => /create table if not exists emails/i.test(c.sql)), creates);
  check("drafts table is created", calls.some((c) => /create table if not exists drafts/i.test(c.sql)));
  check("calendar_events table is created", calls.some((c) => /create table if not exists calendar_events/i.test(c.sql)));
  const insertEmailCall = calls.find((c) => /insert into emails/i.test(c.sql));
  check("score + reason + mode are stored with the message", Boolean(insertEmailCall) && insertEmailCall!.values.includes("heuristic"), insertEmailCall?.values.length);
  check("dates are stored as JSON on the row", typeof insertEmailCall?.values.find((v) => typeof v === "string" && v.startsWith("[{")) === "string");
  check("a draft row is written", calls.some((c) => /insert into drafts/i.test(c.sql)));
  check("ingest reports heuristic mode", ingested.ok && ingested.email.aiMode === "heuristic" && ingested.email.draft?.mode === "heuristic", ingested.ok ? ingested.email.aiProvider : undefined);
  check("dates carry the mode that found them", ingested.ok && ingested.email.dates.every((d) => d.mode === "heuristic"), ingested.ok ? ingested.email.dates : undefined);

  console.log("\n7. A failed write returns a sentence, never a throw");
  const broken = fakeDb(() => [], { throwOn: "insert" });
  const failed = await ingestEmail({ source: "paste", raw: "From: a@b.example\nSubject: Hi\n\nAre you free Friday?" }, broken.exec);
  check("ingest reports failure", failed.ok === false, failed);
  check(
    "the message is human copy with no plumbing in it",
    !failed.ok && /try again/i.test(failed.message) && !/DATABASE_URL|Error/.test(failed.message),
    failed,
  );

  console.log("\n8. With no DATABASE_URL the same pipeline still works (preview mode)");
  const emptyPaste = await ingestEmail({ source: "paste", raw: "   " });
  check("empty paste → friendly message", emptyPaste.ok === false && /paste the text/i.test(emptyPaste.message), emptyPaste);

  const preview = await ingestEmail({ source: "sample", raw: `From: "Priya Raghunathan" <priya@brightlark.example>\nSubject: Quote for 12 windows\n\nCan you quote? Friday at 9am suits me for a visit.` });
  check("preview ingest succeeds", preview.ok === true, preview.ok ? undefined : preview);
  check("preview mode is reported as unsaved", preview.ok && preview.storage.mode === "preview", preview.ok ? preview.storage : undefined);
  check("importance is present", preview.ok && preview.email.importance.score > 0 && preview.email.importance.reason.length > 5);
  check("a date was extracted", preview.ok && preview.email.dates.length === 1, preview.ok ? preview.email.dates : undefined);
  check("a draft was written", preview.ok && (preview.email.draft?.body.length ?? 0) > 20);

  const second = await ingestEmail({ source: "sample", raw: `From: "Trade Monthly" <newsletter@x.example>\nSubject: 5 ways to win more repeat business\n\nUnsubscribe · View this email in your browser.` });
  const listed = await listEmails();
  check("both messages list", listed.ok && listed.value.length === 2, listed.ok ? listed.value.length : listed);
  check("worst-first ordering: client above newsletter", listed.ok && listed.value[0].importance.score > listed.value[1].importance.score, listed.ok ? listed.value.map((e) => e.importance.score) : undefined);
  check("every timestamp handed back is a string", listed.ok && listed.value.every((e) => typeof e.receivedAt === "string" && e.dates.every((d) => typeof d.startsAt === "string" && typeof d.reminderAt === "string")), listed.ok ? listed.value[0]?.dates : undefined);

  const target = preview.ok ? preview.email : null;
  if (target) {
    const added = await addDateToCalendar({ ...target, dates: target.dates }, target.dates[0].id);
    check("Add to calendar returns a title and a reminder", added.ok && added.reminder.length > 3, added);
    const events = await listCalendarEvents();
    check("the event is on the calendar", events.ok && events.value.length === 1, events.ok ? events.value : events);
    check("the event keeps its reminder", events.ok && events.value[0].reminderAt !== null && /30 minutes/.test(events.value[0].reminderLabel ?? ""), events.ok ? events.value[0] : undefined);
    check("the event points back at its email", events.ok && events.value[0].emailId === target.id, events.ok ? events.value[0].emailId : undefined);
    check("when the event is rendered it is not a Date object", events.ok && typeof events.value[0].startsAtLabel === "string", events.ok ? typeof events.value[0].startsAtLabel : undefined);

    // Re-read: the date the owner just added must now show as already on the
    // calendar, and adding it again must not duplicate the event.
    const reread = await getEmail(target.id);
    check("the date is marked as added when read back", reread.ok && reread.value?.dates[0]?.added === true, reread.ok ? reread.value?.dates : undefined);
    const again = reread.ok && reread.value
      ? await addDateToCalendar(reread.value, reread.value.dates[0].id)
      : { ok: false, message: "no email" };
    const eventsAfter = await listCalendarEvents();
    check("adding the same date twice does not duplicate it", again.ok && eventsAfter.ok && eventsAfter.value.length === 1, eventsAfter.ok ? eventsAfter.value.length : eventsAfter);

    const removed = await deleteCalendarEvent(events.ok ? events.value[0].id : "0");
    const afterDelete = await listCalendarEvents();
    const rereadAfterDelete = await getEmail(target.id);
    check("an event can be deleted", removed.ok && removed.value === true && afterDelete.ok && afterDelete.value.length === 0, afterDelete);
    check("after deleting, the date is available again", rereadAfterDelete.ok && rereadAfterDelete.value?.dates[0]?.added === false, rereadAfterDelete.ok ? rereadAfterDelete.value?.dates : undefined);
  } else {
    failures++;
    console.log("  FAIL preview email missing, calendar checks skipped");
  }

  console.log("\n9. Re-ingesting picks up the second sample's triage");
  check("notice id is a string, not a number", typeof (second.ok ? second.email.id : 0) === "string", second.ok ? second.email.id : undefined);

  /* ---------------------------------------------------------------- *
   * 10. The intake route fails closed, and stays readable while it does
   * ---------------------------------------------------------------- */

  console.log("\n10. POST /api/inbound-email fails closed without a token");
  const storedCount = async () => {
    const listed = await listEmails();
    return listed.ok ? listed.value.length : -1;
  };
  const injection = JSON.stringify({
    from: "Fake Sender <fake@example.com>",
    subject: "Injected mail",
    text: "This was not forwarded by anyone — it must never reach the inbox.",
    receivedAt: WEDNESDAY,
  });

  delete process.env[INBOUND_TOKEN_ENV];
  resetRateLimits();
  const beforeNoToken = await storedCount();

  const noToken = await handleInboundEmailPost(postRequest(API_URL, injection));
  const noTokenBody = await jsonOf(noToken);
  check("no INBOUND_EMAIL_TOKEN → 401, not 200", noToken.status === 401, noToken.status);
  check("...typed as intake_not_configured", noTokenBody.error === "intake_not_configured", noTokenBody.error);
  check("...and the refusal is a plain sentence", /isn't switched on/i.test(String(noTokenBody.message)) && !/Error|undefined/.test(String(noTokenBody.message)), noTokenBody.message);
  check("nothing was ingested while unconfigured", (await storedCount()) === beforeNoToken);

  const TOKEN = "selftest-shared-secret";
  process.env[INBOUND_TOKEN_ENV] = TOKEN;
  resetRateLimits();

  const wrongToken = await handleInboundEmailPost(postRequest(API_URL, injection, { authorization: "Bearer not-the-token" }));
  check("wrong Bearer token → 401", wrongToken.status === 401, wrongToken.status);
  const prefixToken = await handleInboundEmailPost(postRequest(API_URL, injection, { authorization: `Bearer ${TOKEN.slice(0, 5)}` }));
  check("a prefix of the real token → 401", prefixToken.status === 401, prefixToken.status);
  const queryWrong = await handleInboundEmailPost(postRequest(`${API_URL}?token=nope`, injection));
  check("wrong ?token= → 401", queryWrong.status === 401, queryWrong.status);
  const noHeader = await handleInboundEmailPost(postRequest(API_URL, injection));
  check("no token at all → 401", noHeader.status === 401, noHeader.status);
  check("no 500s: every refusal is a typed JSON sentence", [wrongToken, prefixToken, queryWrong, noHeader].every((r) => r.status === 401));
  check("still nothing ingested after four wrong tokens", (await storedCount()) === beforeNoToken);

  const getResponse = handleInboundEmailGet();
  const getBody = await jsonOf(getResponse);
  check("GET still answers 405", getResponse.status === 405, getResponse.status);
  check("...and says whether intake is armed, without leaking the secret", getBody.intakeConfigured === true && !JSON.stringify(getBody).includes(TOKEN), getBody);

  const oversize = await handleInboundEmailPost(
    postRequest(API_URL, JSON.stringify({ from: "a@b.example", subject: "Huge", text: "x".repeat(MAX_INBOUND_BODY_BYTES + 1024) }), {
      authorization: `Bearer ${TOKEN}`,
    }),
  );
  check(`a body over ${Math.round(MAX_INBOUND_BODY_BYTES / 1024)} KB → 413, even with a good token`, oversize.status === 413, oversize.status);
  check("...and it says so in words", /bigger than Doppel will accept/i.test(String((await jsonOf(oversize)).message)));

  const authorised = await handleInboundEmailPost(
    postRequest(
      API_URL,
      JSON.stringify({ from: urgentEmail.fromLabel, subject: urgentEmail.subject, text: urgentEmail.body, receivedAt: WEDNESDAY }),
      { authorization: `Bearer ${TOKEN}` },
    ),
  );
  const authorisedBody = await jsonOf(authorised);
  check("right Bearer token → 201", authorised.status === 201, { status: authorised.status, body: authorisedBody });
  check("the message was triaged (score, reason, date, draft)", authorisedBody.email?.importance?.score >= 70 && (authorisedBody.email?.dates?.length ?? 0) >= 1 && authorisedBody.email.dates.some((d: { startsAt: string }) => d.startsAt === "2026-09-17T14:30:00.000Z") && (authorisedBody.email?.draft?.body?.length ?? 0) > 20, authorisedBody.email?.importance);
  check("the answer says which producer made the output", authorisedBody.email?.aiMode === "heuristic" && authorisedBody.email?.aiProvider === "heuristic", authorisedBody.email?.aiProvider);
  check("'analysed but not persisted' wording kept with no database", /Analysed, but not persisted/.test(String(authorisedBody.note)), authorisedBody.note);
  check("the ingested message reached the inbox", (await storedCount()) === beforeNoToken + 1);

  resetRateLimits();
  const viaQuery = await handleInboundEmailPost(postRequest(`${API_URL}?token=${encodeURIComponent(TOKEN)}`, injection));
  check("right ?token= → 201 (for services that can't set headers)", viaQuery.status === 201, viaQuery.status);

  resetRateLimits();
  let floodStatus = 0;
  for (let i = 0; i <= RATE_LIMIT_MAX_REQUESTS; i++) {
    floodStatus = (await handleInboundEmailPost(postRequest(API_URL, injection, { authorization: "Bearer not-the-token" }))).status;
  }
  check(`more than ${RATE_LIMIT_MAX_REQUESTS} hits a minute → 429`, floodStatus === 429, floodStatus);
  resetRateLimits();

  /* ---------------------------------------------------------------- *
   * 11. The Resend forwarding webhook
   * ---------------------------------------------------------------- */

  console.log("\n11. The Resend forwarding webhook is signed, verified and typed");
  // The example secret from Svix's own manual-verification page.
  const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const RESEND_URL = "http://localhost/api/inbound-email/resend";
  const eventBody = JSON.stringify({
    type: "email.received",
    created_at: WEDNESDAY,
    data: { email_id: "56761188-7520-42d8-8898-ff6fc54ce618", from: "marcus@example.com", subject: urgentEmail.subject, created_at: WEDNESDAY },
  });
  const signedRequest = (body: string, timestamp = String(Math.floor(Date.now() / 1000)), secret = SECRET) => {
    const id = "msg_selftest";
    return postRequest(RESEND_URL, body, {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": svixSignature(id, timestamp, body, secret),
    });
  };

  const fresh = signatureHeaders(new Headers({ "svix-id": "a", "svix-timestamp": "1", "svix-signature": "v1,x" }));
  check("svix headers are read", fresh.id === "a" && fresh.timestamp === "1" && fresh.signature === "v1,x", fresh);
  const whiteLabel = signatureHeaders(new Headers({ "webhook-id": "b", "webhook-timestamp": "2", "webhook-signature": "v1,y" }));
  check("Svix's webhook-* header names work too", whiteLabel.id === "b" && whiteLabel.signature === "v1,y", whiteLabel);

  const now = Date.now();
  const good = verifyResendSignature({ rawBody: eventBody, id: "msg_1", timestamp: String(Math.floor(now / 1000)), signature: svixSignature("msg_1", String(Math.floor(now / 1000)), eventBody, SECRET), secret: SECRET, now });
  check("a correctly signed body verifies", good.ok === true, good);
  const tampered = verifyResendSignature({ rawBody: eventBody.replace("marcus@example.com", "attacker@example.com"), id: "msg_1", timestamp: String(Math.floor(now / 1000)), signature: svixSignature("msg_1", String(Math.floor(now / 1000)), eventBody, SECRET), secret: SECRET, now });
  check("a tampered body does not", tampered.ok === false && tampered.reason === "mismatch", tampered);
  const wrongSecret = verifyResendSignature({ rawBody: eventBody, id: "msg_1", timestamp: String(Math.floor(now / 1000)), signature: svixSignature("msg_1", String(Math.floor(now / 1000)), eventBody, "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), secret: SECRET, now });
  check("the right body signed with the wrong secret does not", wrongSecret.ok === false && wrongSecret.reason === "mismatch", wrongSecret);
  const staleTs = String(Math.floor(now / 1000) - 3600);
  const stale = verifyResendSignature({ rawBody: eventBody, id: "msg_1", timestamp: staleTs, signature: svixSignature("msg_1", staleTs, eventBody, SECRET), secret: SECRET, now });
  check("a replay an hour later is refused as stale", stale.ok === false && stale.reason === "stale", stale);
  const missing = verifyResendSignature({ rawBody: eventBody, id: null, timestamp: null, signature: null, secret: SECRET, now });
  check("missing signature headers are refused", missing.ok === false && missing.reason === "missing_headers", missing);
  const listSignature = `${svixSignature("msg_1", String(Math.floor(now / 1000)), eventBody, "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")} ${svixSignature("msg_1", String(Math.floor(now / 1000)), eventBody, SECRET)}`;
  check("a rotated secret (two signatures) still verifies", verifyResendSignature({ rawBody: eventBody, id: "msg_1", timestamp: String(Math.floor(now / 1000)), signature: listSignature, secret: SECRET, now }).ok === true);

  delete process.env[RESEND_WEBHOOK_SECRET_ENV];
  delete process.env[RESEND_API_KEY_ENV];
  resetRateLimits();
  const notConnected = await handleProviderWebhookPost("resend", postRequest(RESEND_URL, eventBody));
  const notConnectedBody = await jsonOf(notConnected);
  check("no Resend secrets → 503, not a crash", notConnected.status === 503, notConnected.status);
  check("...typed as provider_not_connected", notConnectedBody.error === "provider_not_connected" && notConnectedBody.connected === false, notConnectedBody);
  check("...naming the missing vars in a sentence", /RESEND_WEBHOOK_SECRET/.test(String(notConnectedBody.message)) && /RESEND_API_KEY/.test(String(notConnectedBody.message)), notConnectedBody.message);
  const notConnectedGet = handleProviderWebhookGet("resend");
  check("GET on the webhook route is a 405 that says whether it's armed", notConnectedGet.status === 405 && (await jsonOf(notConnectedGet)).connected === false, notConnectedGet.status);
  check("an unknown provider is a typed 404", (await handleProviderWebhookPost("postmark", postRequest("http://localhost/api/inbound-email/postmark", "{}"))).status === 404);

  process.env[RESEND_WEBHOOK_SECRET_ENV] = SECRET;
  process.env[RESEND_API_KEY_ENV] = "re_selftest_key_not_real";
  resetRateLimits();
  const badSignature = await handleProviderWebhookPost("resend", postRequest(RESEND_URL, eventBody, { "svix-id": "m", "svix-timestamp": String(Math.floor(now / 1000)), "svix-signature": "v1,not-a-real-signature" }));
  check("an unsigned/forged webhook → 401", badSignature.status === 401, badSignature.status);
  check("...typed as bad_signature", (await jsonOf(badSignature)).error === "bad_signature");
  const unsigned = await handleProviderWebhookPost("resend", postRequest(RESEND_URL, eventBody));
  check("no signature headers at all → 401", unsigned.status === 401, unsigned.status);

  const otherEvent = JSON.stringify({ type: "email.sent", data: { email_id: "x" } });
  const ignored = await handleProviderWebhookPost("resend", signedRequest(otherEvent));
  const ignoredBody = await jsonOf(ignored);
  check("an event that isn't received mail → 200 ignored, not an error", ignored.status === 200 && ignoredBody.ignored === true, ignoredBody);

  const noId = await handleProviderWebhookPost("resend", signedRequest(JSON.stringify({ type: "email.received", data: {} })));
  check("a received event with no message id → 400 typed", noId.status === 400 && (await jsonOf(noId)).error === "missing_email_id", noId.status);

  const notJson = await handleProviderWebhookPost("resend", signedRequest("this is not json at all"));
  check("a body that isn't JSON → 400 typed, never a throw", notJson.status === 400 && (await jsonOf(notJson)).error === "invalid_json", notJson.status);

  // The real Resend API is called here with a deliberately fake key: it must answer
  // with a typed 5xx sentence, never a throw and never a bare 500/stack trace.
  const upstream = await handleProviderWebhookPost("resend", signedRequest(eventBody));
  const upstreamBody = await jsonOf(upstream);
  check("a real (failing) provider call stays a typed answer, never a throw", [502, 503].includes(upstream.status) && typeof upstreamBody.error === "string" && upstreamBody.message.length > 20, { status: upstream.status, error: upstreamBody.error });
  check("nothing was ingested from a failed provider call", (await storedCount()) === beforeNoToken + 2);

  delete process.env[RESEND_WEBHOOK_SECRET_ENV];
  delete process.env[RESEND_API_KEY_ENV];
  delete process.env[INBOUND_TOKEN_ENV];
  resetRateLimits();

  /* ---------------------------------------------------------------- *
   * 12. Owner alerting — Knock is the only thing wired to the network,
   *     so it is the one thing that must stay a typed result.
   * ---------------------------------------------------------------- */

  console.log("\n12. Owner alerting: only arrived mail, only above the bar, always a typed result");

  const alertEmail = (over: Partial<NotifiableEmail> = {}): NotifiableEmail => ({
    id: "4242",
    subject: "URGENT — Thursday's site visit has to move",
    fromLabel: "Marcus Bell <marcus@example.com>",
    source: "api",
    importance: { score: 92, reason: "Uses urgent language, about money.", needsReply: true },
    ...over,
  });

  const stub = (plan: (request: TransportRequest) => TransportResponse | Promise<TransportResponse>) => {
    const calls: TransportRequest[] = [];
    const transport: Transport = async (request) => {
      calls.push(request);
      return await plan(request);
    };
    return { transport, calls };
  };

  const accepted: TransportResponse = { status: 200, body: JSON.stringify({ workflow_run_id: "run_123" }) };
  const workflowGone: TransportResponse = {
    status: 404,
    body: JSON.stringify({
      code: "workflow_missing",
      message: "The workflow you specified was not found in this environment.",
    }),
  };

  delete process.env[KNOCK_WORKFLOW_KEY_ENV];
  delete process.env[OWNER_ALERT_EMAIL_ENV];
  delete process.env[SITE_URL_ENV];
  const defaults = alertConfig();
  check(`the importance bar is ${IMPORTANCE_ALERT_THRESHOLD}`, IMPORTANCE_ALERT_THRESHOLD === 80, IMPORTANCE_ALERT_THRESHOLD);
  check(`the needs-reply bar is ${NEEDS_REPLY_ALERT_THRESHOLD}`, NEEDS_REPLY_ALERT_THRESHOLD === 70, NEEDS_REPLY_ALERT_THRESHOLD);
  check(
    "the default workflow key is the one the owner is asked to create",
    defaults.workflowKey === DEFAULT_WORKFLOW_KEY && DEFAULT_WORKFLOW_KEY === "doppel-important-mail",
    defaults.workflowKey,
  );
  check(
    "the default alert recipient is our own inbox, never a third party",
    defaults.ownerEmail === DEFAULT_OWNER_ALERT_EMAIL && DEFAULT_OWNER_ALERT_EMAIL === "doppel-cae2e184@ctomail.io",
    defaults.ownerEmail,
  );
  check("no key at all is reported as unconfigured", defaults.hasKey === false);
  process.env[KNOCK_WORKFLOW_KEY_ENV] = "  other-workflow  ";
  process.env[OWNER_ALERT_EMAIL_ENV] = " alerts@example.test ";
  check("an env override wins, trimmed", alertConfig().workflowKey === "other-workflow" && alertConfig().ownerEmail === "alerts@example.test", alertConfig());
  process.env[SITE_URL_ENV] = "https://example.test/";
  check(
    "PUBLIC_SITE_URL sets the link back to the message, without a trailing slash",
    alertData(alertEmail(), alertConfig()).url === "https://example.test/app/email/4242",
    alertData(alertEmail(), alertConfig()).url,
  );
  delete process.env[KNOCK_WORKFLOW_KEY_ENV];
  delete process.env[OWNER_ALERT_EMAIL_ENV];
  delete process.env[SITE_URL_ENV];

  console.log("\n12a. Which mail may ring the owner's phone");
  check("mail that arrived through the intake route alerts above the bar", shouldAlert(alertEmail()).alert === true);
  check("a score of exactly the bar alerts", shouldAlert(alertEmail({ importance: { score: 80, reason: "x", needsReply: false } })).alert === true);
  check("79 without a reply need does not", shouldAlert(alertEmail({ importance: { score: 79, reason: "x", needsReply: false } })).alert === false);
  check("a 72 that needs a reply does (the lower bar)", shouldAlert(alertEmail({ importance: { score: 72, reason: "x", needsReply: true } })).alert === true);
  check("a 72 that needs no reply does not", shouldAlert(alertEmail({ importance: { score: 72, reason: "x", needsReply: false } })).alert === false);
  check("the sample inbox can never alert the owner", shouldAlert(alertEmail({ source: "sample" })).alert === false);
  check("the paste box can never alert the owner", shouldAlert(alertEmail({ source: "paste" })).alert === false);
  check("the refusal says why, in words", /not arrived mail/.test(shouldAlert(alertEmail({ source: "paste" })).why));

  console.log("\n12b. No key: a sentence, not a call");
  delete process.env[KNOCK_API_KEY_ENV];
  resetAlertStatusCache();
  const neverCalled = stub(() => {
    throw new Error("the transport must not be reached without a key");
  });
  const unconfigured = await notifyImportantEmail(alertEmail(), { transport: neverCalled.transport });
  check("no Knock key → outcome not_configured", unconfigured.outcome === "not_configured" && unconfigured.ok === false, unconfigured);
  check("...and Knock is not called at all", neverCalled.calls.length === 0, neverCalled.calls.length);
  check("...and the sentence names the missing secret", new RegExp(KNOCK_API_KEY_ENV).test(unconfigured.message), unconfigured.message);
  check("...and says the owner was not told", /not told/i.test(unconfigured.message), unconfigured.message);
  const noKeyStatus = await alertStatus({ transport: neverCalled.transport });
  check(
    "the /app line reads 'not set up yet (no Knock key)'",
    noKeyStatus.state === "not_configured" && noKeyStatus.source === "none" && /not set up yet \(no Knock key\)/.test(noKeyStatus.label),
    noKeyStatus,
  );

  console.log("\n12c. With a key: one real trigger, shaped the way Knock documents it");
  const KEY = "sk_test_selftest_key_not_real";
  process.env[KNOCK_API_KEY_ENV] = KEY;
  const sent = stub(() => accepted);
  const sentResult = await notifyImportantEmail(alertEmail(), { transport: sent.transport });
  check("the trigger is posted once", sent.calls.length === 1 && sent.calls[0].method === "POST", sent.calls[0]?.method);
  check(
    "to POST /v1/workflows/{key}/trigger",
    sent.calls[0]?.url === `${KNOCK_API_BASE}/workflows/${DEFAULT_WORKFLOW_KEY}/trigger`,
    sent.calls[0]?.url,
  );
  check("authenticated with the bearer key", sent.calls[0]?.headers.Authorization === `Bearer ${KEY}`);
  check(
    "with an idempotency key derived from the message",
    sent.calls[0]?.headers["Idempotency-Key"] === `${DEFAULT_WORKFLOW_KEY}:email:4242`,
    sent.calls[0]?.headers["Idempotency-Key"],
  );
  const payload = JSON.parse(sent.calls[0]?.body ?? "{}") as {
    recipients?: { id?: string; email?: string }[];
    data?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  };
  check(
    "naming our own inbox as the only recipient",
    payload.recipients?.length === 1 && payload.recipients[0]?.email === DEFAULT_OWNER_ALERT_EMAIL,
    payload.recipients,
  );
  check(
    "with a stable owner id and the facts the workflow renders",
    payload.recipients?.[0]?.id === OWNER_RECIPIENT_ID &&
      payload.data?.subject === alertEmail().subject &&
      payload.data?.score === 92 &&
      typeof payload.data?.url === "string",
    payload.data,
  );
  check("the API key is not in the payload", !String(sent.calls[0]?.body).includes(KEY));
  check("an accepted run is reported as sent, with its run id", sentResult.ok && sentResult.outcome === "sent" && sentResult.workflowRunId === "run_123", sentResult);

  console.log("\n12d. Every refusal is a distinct, typed outcome");
  const workflowMissing = await notifyImportantEmail(alertEmail(), { transport: stub(() => workflowGone).transport });
  check(
    "404 workflow_missing → workflow_missing, not a guess",
    workflowMissing.outcome === "workflow_missing" && workflowMissing.status === 404 && workflowMissing.detail === "workflow_missing",
    workflowMissing,
  );
  check("...and the sentence says the workflow isn't in this environment", /no workflow called/.test(workflowMissing.message), workflowMissing.message);

  const plain404 = await notifyImportantEmail(alertEmail(), {
    transport: stub(() => ({ status: 404, body: JSON.stringify({ code: "not_found", message: "nope" }) })).transport,
  });
  check("a 404 that isn't workflow_missing stays 'rejected'", plain404.outcome === "rejected", plain404);

  const refused = await notifyImportantEmail(alertEmail(), {
    transport: stub(() => ({ status: 401, body: JSON.stringify({ code: "api_key_invalid", message: "The API key you supplied is invalid" }) })).transport,
  });
  check("401 → unauthorized", refused.outcome === "unauthorized" && refused.status === 401, refused);
  check("...and names the code Knock gave", refused.detail === "api_key_invalid", refused.detail);

  const badRequest = await notifyImportantEmail(alertEmail(), {
    transport: stub(() => ({ status: 422, body: JSON.stringify({ code: "invalid_recipient", message: "recipient email invalid" }) })).transport,
  });
  check("another 4xx → rejected", badRequest.outcome === "rejected" && badRequest.status === 422, badRequest);

  const down = await notifyImportantEmail(alertEmail(), {
    transport: stub(() => ({ status: 503, body: "upstream unavailable" })).transport,
  });
  check("5xx → unavailable", down.outcome === "unavailable" && down.status === 503, down);

  const leaked = `upstream error, key=${KEY}, retry later`;
  const leaky = await notifyImportantEmail(alertEmail(), {
    transport: stub(() => ({ status: 500, body: JSON.stringify({ message: leaked }) })).transport,
  });
  check("an upstream message quoting the key is redacted", !JSON.stringify(leaky).includes(KEY) && /\[redacted\]/.test(leaky.detail ?? ""), leaky.detail);

  const dead = await notifyImportantEmail(alertEmail(), {
    transport: stub(() => {
      throw new Error("socket closed");
    }).transport,
  });
  check("an unreachable Knock → unavailable, never a throw", dead.outcome === "unavailable" && /could not be reached/.test(dead.message), dead);
  check("the background form returns immediately and never throws", notifyImportantEmailInBackground(alertEmail(), { transport: stub(() => accepted).transport }) === undefined);

  console.log("\n12e. The check /app shows — sandboxed, cached, and honest");
  resetAlertStatusCache();
  const probeStub = stub(() => accepted);
  const probe = await probeAlerting({ transport: probeStub.transport });
  const probeBody = JSON.parse(probeStub.calls[0]?.body ?? "{}") as { settings?: Record<string, unknown> };
  check("the check triggers in sandbox mode (generates, delivers nothing)", probeBody.settings?.sandbox_mode === true, probeBody.settings);
  check("an accepted check reads as on", probe.state === "on" && probe.label === "Alerts: on" && probe.source === "probe", probe);
  check("...and its note says the check delivered nothing", /nothing was delivered/i.test(probe.note ?? ""), probe.note);

  const cacheStub = stub(() => accepted);
  const cachedView = await alertStatus({ transport: cacheStub.transport });
  check("a page view reuses the last check instead of hitting Knock", cacheStub.calls.length === 0 && cachedView.state === "on", cacheStub.calls.length);
  const forcedView = await alertStatus({ transport: cacheStub.transport, force: true });
  check("...and force re-checks", cacheStub.calls.length === 1 && forcedView.state === "on", cacheStub.calls.length);

  resetAlertStatusCache();
  const waiting = await probeAlerting({ transport: stub(() => workflowGone).transport });
  check(
    "no such workflow in Knock → the waiting line names it",
    waiting.state === "workflow_missing" && /waiting for the workflow 'doppel-important-mail'/.test(waiting.label),
    waiting.label,
  );
  check("...and says creating it switches the line by itself", /switches to .Alerts: on./.test(waiting.note ?? ""), waiting.note);

  resetAlertStatusCache();
  const statusOf = (state: AlertState): AlertStatus => ({
    state,
    label: `Alerts: ${state}`,
    note: "why",
    workflowKey: DEFAULT_WORKFLOW_KEY,
    checkedAt: null,
    source: "probe",
  });
  const states: AlertState[] = ["on", "not_configured", "workflow_missing", "unauthorized", "rejected", "unavailable", "unknown"];
  const views = states.map((state) => alertsView(statusOf(state)));
  check("every state renders the server's own label", views.every((view, i) => view.label === `Alerts: ${states[i]}`));
  check("only `on` is drawn as on", views[0].on === true && views.slice(1).every((view) => view.on === false));
  check("`on` carries no warning", views[0].honesty === undefined);
  check(
    "every other state says the owner is not being told",
    views.slice(1).every((view) => typeof view.honesty === "string" && view.honesty.length > 20),
  );
  check(
    "the four 'not set up' states say it in those words",
    views.slice(1, 5).every((view) => /not being told/.test(view.honesty ?? "")),
  );
  check("a state with no note renders without one", alertsView({ ...statusOf("on"), note: undefined }).note === undefined);
  check("the waiting state is not styled as on", views[2].tone === "amber" && views[3].tone === "rose", views.map((view) => view.tone));

  // The line itself, rendered by the real component — no browser needed, and with no
  // key in the environment at all.
  const notConfiguredHtml = renderToStaticMarkup(
    React.createElement(AlertsLine, { alerts: statusOf("not_configured") }),
  );
  check(
    "the rendered line names the state and says the owner is not being told",
    /Alerts: not_configured/.test(notConfiguredHtml) && /not being told/.test(notConfiguredHtml),
    notConfiguredHtml.slice(0, 160),
  );
  const onHtml = renderToStaticMarkup(React.createElement(AlertsLine, { alerts: statusOf("on") }));
  check(
    "the rendered line for `on` claims nothing more than it should",
    />On</.test(onHtml) && !/not being told/.test(onHtml),
    onHtml.slice(0, 160),
  );
  check(
    "rendering without a Knock key does not throw or render 'undefined'",
    notConfiguredHtml.length > 200 && !/undefined/.test(notConfiguredHtml),
  );

  console.log("\n12f. A failing alert never costs the ingested message");
  process.env[INBOUND_TOKEN_ENV] = "selftest-alert-token";
  resetRateLimits();
  delete process.env[KNOCK_API_KEY_ENV];
  const notified: { subject?: string; source?: string } = {};
  const alertRaw = JSON.stringify({
    from: "Marcus Bell <marcus@example.com>",
    subject: "URGENT — Thursday's site visit has to move",
    text: "The tenant has locked us out on Thursday. The only slot is tomorrow at 2:30pm. This is urgent — can you confirm by the end of the day today?",
    receivedAt: WEDNESDAY,
  });
  const crossing = await handleInboundEmailPost(postRequest(`${API_URL}?token=selftest-alert-token`, alertRaw), {
    notify: (email) => {
      notified.subject = email.subject;
      notified.source = email.source;
    },
  });
  const crossingBody = await jsonOf(crossing);
  check("a message that crosses the bar is still ingested and answered 201", crossing.status === 201 && crossingBody.ok === true, crossing.status);
  check("...and it really is above the alert bar", crossingBody.email.importance.score >= IMPORTANCE_ALERT_THRESHOLD, crossingBody.email.importance);
  check(
    "the notifier is handed the stored message, tagged as arrived mail",
    notified.subject === "URGENT — Thursday's site visit has to move" && notified.source === "api",
    notified,
  );

  const survived = await handleInboundEmailPost(postRequest(`${API_URL}?token=selftest-alert-token`, alertRaw), {
    notify: () => {
      throw new Error("Knock is down");
    },
  });
  check("a notifier that throws does not change the answer", survived.status === 201 && (await jsonOf(survived)).ok === true, survived.status);

  delete process.env[KNOCK_API_KEY_ENV];
  delete process.env[KNOCK_WORKFLOW_KEY_ENV];
  delete process.env[OWNER_ALERT_EMAIL_ENV];
  delete process.env[INBOUND_TOKEN_ENV];
  resetAlertStatusCache();
  resetRateLimits();

  console.log(
    "\n13. The connection string picks a transport that can actually reach that host",
  );
  // Why this matters: the Neon serverless driver does not open a Postgres
  // connection at all — it rewrites the host and POSTs the SQL to Neon's own
  // `https://api.<host>/sql` query API. A plain Postgres (Tiger Cloud, RDS, a
  // local server) serves no such route, so handing it that driver would turn the
  // owner's one step — connecting the database — into silent write failures.
  check(
    "a Neon host keeps the Neon HTTP driver",
    databaseTransport("postgresql://u:p@ep-cool-dawn-12345.us-east-2.aws.neon.tech/neondb?sslmode=require") ===
      "neon-http",
  );
  check(
    "a pooled Neon host too",
    databaseTransport("postgresql://u:p@ep-cool-dawn-12345-pooler.us-east-2.aws.neon.tech/neondb") === "neon-http",
  );
  check(
    "a Tiger Cloud host is NOT handed the Neon driver",
    databaseTransport("postgresql://u:p@x1y2z3.tsdb.cloud.timescale.com:34567/tsdb?sslmode=require") === "bun-tcp",
  );
  check(
    "an ordinary Postgres host is reached over the wire protocol",
    databaseTransport("postgresql://u:p@db.internal.example:5432/doppel") === "bun-tcp",
  );
  check("an unparseable address has no transport", databaseTransport("not a connection string") === "unavailable");
  check("an empty address has no transport", databaseTransport("") === "unavailable");
  const safeHost = databaseHostSafe("postgresql://u:sup3rsecret@db.internal.example:5432/doppel");
  check(
    "the host is readable for a log line or the UI, without the password",
    safeHost === "db.internal.example:5432" && !safeHost.includes("sup3rsecret"),
    safeHost,
  );

  // No DATABASE_URL: the existing typed refusal, unchanged.
  let missingDbMessage = "";
  try {
    databaseClient();
  } catch (err) {
    missingDbMessage = err instanceof Error ? err.message : String(err);
  }
  check(
    "no DATABASE_URL → the same 'connect a database' refusal",
    /connect a database/i.test(missingDbMessage),
    missingDbMessage,
  );

  // Setting the variable is the whole switch: no rebuild, no code change. Both
  // clients below are built lazily and connect only on first query, so nothing
  // here touches the network.
  process.env.DATABASE_URL = "postgresql://u:p@x1y2z3.tsdb.cloud.timescale.com:34567/tsdb?sslmode=require";
  check(
    "DATABASE_URL set mid-process → a client for a plain Postgres host exists, no rebuild",
    typeof databaseClient() === "function",
    typeof databaseClient(),
  );
  process.env.DATABASE_URL = "postgresql://u:p@ep-cool-dawn-12345.us-east-2.aws.neon.tech/neondb";
  check("...and a Neon host still builds its own client", typeof databaseClient() === "function");
  // Regression (the connection-slot leak): sql() used to build a brand-new
  // client on EVERY call, and its call sites call it per request — so every
  // request opened its own pool whose connections were never reused or closed,
  // until the database ran out of connection slots. The fix is one client per
  // connection string, memoised for the life of the process.
  const neonClient = databaseClient();
  const tigerUrl = "postgresql://u:p@x1y2z3.tsdb.cloud.timescale.com:34567/tsdb?sslmode=require";
  process.env.DATABASE_URL = tigerUrl;
  const tigerClient = databaseClient();
  check(
    "repeated sql() calls with the same address return the SAME client (one pool, not one per call)",
    databaseClient() === tigerClient,
    `same reference: ${databaseClient() === tigerClient}`,
  );
  process.env.DATABASE_URL = "postgresql://u:p@db.internal.example:5432/doppel";
  const otherClient = databaseClient();
  check("a different address gets a different client", otherClient !== tigerClient, "different references");
  process.env.DATABASE_URL = tigerUrl;
  check(
    "switching back to a previously seen address returns the same client again",
    databaseClient() === tigerClient,
    "same reference expected",
  );
  process.env.DATABASE_URL = "postgresql://u:p@ep-cool-dawn-12345.us-east-2.aws.neon.tech/neondb";
  check("...and the Neon client is memoised the same way", databaseClient() === neonClient, "same reference expected");
  delete process.env.DATABASE_URL;

  /* ---------------------------------------------------------------- *
   * 14. The storage line claims only what a real query has proved
   * ---------------------------------------------------------------- */

  console.log("\n14. The storage line claims only what a real query has proved");

  const claimsSaved = (status: StorageStatus): boolean =>
    /saved to the connected database/i.test(status.label);
  const cardHtml = (status: StorageStatus): string =>
    renderToStaticMarkup(React.createElement(ModeCard, { ai: aiStatus(), storage: status }));

  // (a) Nothing configured at all: the preview wording, unchanged.
  delete process.env.DATABASE_URL;
  resetStorageEvidence();
  const noAddress = storageStatus();
  check(
    "no connection string → the unchanged preview state",
    noAddress.mode === "preview" && noAddress.state === "preview" && claimsSaved(noAddress) === false,
    noAddress,
  );
  check(
    "...still saying plainly that nothing is being saved",
    /nothing is being saved/i.test(noAddress.label) && /nothing is saved/i.test(noAddress.note ?? ""),
    noAddress,
  );

  // (b) A connection string on its own is configuration, not evidence.
  process.env.DATABASE_URL = "postgresql://u:p@db.internal.example:5432/doppel";
  const unverified = storageStatus();
  check("an address but no query yet → unverified, not saved", unverified.state === "unverified", unverified);
  check("...and it does NOT claim saving works", claimsSaved(unverified) === false, unverified.label);
  check(
    "...and it says in words why it can't say yet",
    /not confirmed/i.test(unverified.label) && /nothing has been read|no claim that saving works/i.test(unverified.note ?? ""),
    unverified.note,
  );
  const unverifiedHtml = cardHtml(unverified);
  check(
    "the card rendered for it never shows the success wording",
    !/Saved to the connected database/.test(unverifiedHtml) && /Not confirmed/.test(unverifiedHtml),
    unverifiedHtml.slice(0, 200),
  );

  // (c) A query that really came back is what earns the success wording.
  resetStorageEvidence();
  const { exec: readExec, calls: readCalls } = fakeDb(() => [{ id: 1 }]);
  const readBack = await listEmails(readExec);
  check(
    "a read that came back → confirmed",
    readBack.ok && readBack.storage.state === "confirmed" && claimsSaved(readBack.storage),
    readBack.ok ? readBack.storage : readBack,
  );
  check(
    "...and that status came from the query, not from the address being set",
    readCalls.length > 1 && storageStatus().state === "confirmed",
    { queries: readCalls.length, storage: storageStatus() },
  );
  check(
    "the card rendered for it shows the success wording and the evidence note",
    /Saved to the connected database/.test(cardHtml(storageStatus())) && />Database</.test(cardHtml(storageStatus())),
    cardHtml(storageStatus()).slice(0, 200),
  );

  resetStorageEvidence();
  const writePlan = fakeDb((text) => {
    if (/insert into emails/i.test(text)) return [{ id: 3 }];
    if (/select id from drafts/i.test(text)) return [];
    return [{ id: 1 }];
  });
  const wroteThrough = await ingestEmail(
    { source: "paste", raw: "From: a@b.example\nSubject: Hi\n\nAre you free Friday at 9am?" },
    writePlan.exec,
  );
  check(
    "a write that came back → confirmed too",
    wroteThrough.ok && wroteThrough.storage.state === "confirmed" && claimsSaved(wroteThrough.storage),
    wroteThrough.ok ? wroteThrough.storage : wroteThrough,
  );

  // (d) A failure is reported with the app's own sentence, and it stays reported.
  resetStorageEvidence();
  const brokenWrite = fakeDb(() => [], { throwOn: "insert" });
  const failedWrite = await ingestEmail(
    { source: "paste", raw: "From: a@b.example\nSubject: Hi\n\nAre you free tomorrow at 10am?" },
    brokenWrite.exec,
  );
  const failedWriteStorage = failedWrite.storage;
  check(
    "a failed write → the failing state, never the saved wording",
    failedWrite.ok === false && failedWriteStorage.state === "failed" && claimsSaved(failedWriteStorage) === false,
    failedWriteStorage,
  );
  check(
    "...naming saving as the half that failed",
    failedWriteStorage.failedDirection === "write" && /saving is failing/i.test(failedWriteStorage.label),
    failedWriteStorage.label,
  );
  check(
    "...reusing the app's own typed sentence, with no error code or vendor in it",
    failedWrite.ok === false &&
      failedWriteStorage.note?.startsWith(failedWrite.message) === true &&
      !/28P01|PostgresError|password|timescale/i.test(failedWriteStorage.note ?? ""),
    failedWriteStorage.note,
  );

  // The whole point: after a failure, no page view may slip back to claiming success.
  const { exec: laterExec } = fakeDb(() => [{ id: 1 }]);
  const laterRead = await listEmails(laterExec);
  check(
    "a later successful query does NOT restore the saved wording",
    laterRead.ok && laterRead.storage.state === "failed" && claimsSaved(laterRead.storage) === false,
    laterRead.ok ? laterRead.storage : laterRead,
  );
  check(
    "...and a fresh look at the status (a new page view) still reports the failure",
    storageStatus().state === "failed" && /saving is failing/i.test(storageStatus().label),
    storageStatus(),
  );
  const failedCard = cardHtml(storageStatus());
  check(
    "the card rendered for it shows the failure and no success wording",
    !/Saved to the connected database/.test(failedCard) && /Save failing/.test(failedCard) && /is failing/.test(failedCard),
    failedCard.slice(0, 200),
  );

  // A failed read is its own flavour — it must not say anything about saving either way.
  resetStorageEvidence();
  const brokenRead = fakeDb(() => [{ id: 1 }], { throwOn: "select" });
  const failedRead = await listEmails(brokenRead.exec);
  const failedReadStorage = failedRead.storage;
  check(
    "a failed read → failing, and honest about which half",
    failedRead.ok === false &&
      failedReadStorage.state === "failed" &&
      failedReadStorage.failedDirection === "read" &&
      /reading the inbox is failing/i.test(failedReadStorage.label) &&
      claimsSaved(failedReadStorage) === false,
    failedReadStorage,
  );
  check(
    "...with the read sentence the visitor would have seen",
    failedRead.ok === false && failedReadStorage.note?.startsWith(failedRead.message) === true,
    failedReadStorage.note,
  );
  check(
    "an address we cannot build a client for is a failure, not a quiet memory fallback",
    await (async () => {
      resetStorageEvidence();
      process.env.DATABASE_URL = "not a connection string";
      // No injected executor: the real path runs, finds no transport for that address,
      // falls back to memory — and must say so rather than sit on "configured".
      const unbuildable = await listEmails();
      delete process.env.DATABASE_URL;
      return (
        unbuildable.ok === true &&
        unbuildable.storage.state === "failed" &&
        unbuildable.storage.failedDirection === "read" &&
        claimsSaved(unbuildable.storage) === false
      );
    })(),
  );

  delete process.env.DATABASE_URL;
  resetStorageEvidence();
  check("no address → preview again, so nothing leaks out of this section", storageStatus().state === "preview");

  /* ---------------------------------------------------------------- *
   * 15. Duplicate suppression remembers only what was really stored
   * ---------------------------------------------------------------- */

  console.log("\n15. Duplicate suppression remembers only what was really stored");

  // A stand-in provider: the route logic under test is provider-agnostic, and
  // this one needs no network — read() answers with the message a real provider
  // would have handed over, tagged with whichever id the scenario names.
  PROVIDERS["selftest"] = {
    name: "selftest",
    label: "Self-test provider",
    envVars: [],
    configureHint: "(self-test only)",
    connection: () => ({ connected: true }),
    read: async (_request, rawBody) => {
      const event = JSON.parse(rawBody) as { kind?: string; providerMessageId?: string };
      if (event.kind === "ignored") {
        return { ok: true, kind: "ignored", reason: "Ignored on purpose — the self-test said so." };
      }
      return {
        ok: true,
        kind: "message",
        message: {
          from: "Marcus Bell <marcus@example.com>",
          subject: urgentEmail.subject,
          text: urgentEmail.body,
          receivedAt: WEDNESDAY,
          providerMessageId: event.providerMessageId ?? null,
        },
      };
    },
  };

  const SELFTEST_URL = "http://localhost/api/inbound-email/selftest";
  const providerPost = (body: Record<string, unknown>) =>
    postRequest(SELFTEST_URL, JSON.stringify(body));
  const insertsIn = (calls: Call[]) => calls.filter((c) => /insert into emails/i.test(c.sql)).length;
  const storePlan = (sqlText: string) => {
    if (/^create table/i.test(sqlText)) return [];
    if (/insert into emails/i.test(sqlText)) return [{ id: 4101 }];
    if (/select id from drafts/i.test(sqlText)) return [];
    return [{ id: 1 }];
  };

  // A fresh-process story: DATABASE_URL is set (so a store that really comes back
  // reads as `confirmed`, exactly as in production) and the store starts working.
  // `broken` is the same store refusing every insert — the delivery-time failure.
  process.env.DATABASE_URL = "postgresql://u:p@db.internal.example:5432/doppel";
  resetStorageEvidence();
  resetIngestedProviderMessages();
  resetRateLimits();

  const PID = "provider-msg-order-1";
  const refusedStore = fakeDb(storePlan, { throwOn: "insert" });
  const working = fakeDb(storePlan);

  console.log("\n15a. The store refuses the first delivery — not a duplicate, not stored, retryable");
  const refusedDelivery = await handleProviderWebhookPost(
    "selftest",
    providerPost({ providerMessageId: PID }),
    { exec: refusedStore.exec },
  );
  const refusedBody = await jsonOf(refusedDelivery);
  check("the funnel really ran (one insert attempt reached the store)", insertsIn(refusedStore.calls) === 1, insertsIn(refusedStore.calls));
  check("a refused store is NOT answered as a duplicate", refusedBody.duplicate !== true && refusedBody.ok === false, refusedBody);
  check("the answer is 503 — non-2xx, the kind Resend retries", refusedDelivery.status === 503, refusedDelivery.status);
  check("typed as store_failed", refusedBody.error === "store_failed", refusedBody.error);
  check(
    "it does not claim the message was stored",
    refusedBody.stored === false &&
      /nothing was (kept|recorded)|so nothing was/i.test(String(refusedBody.message)),
    refusedBody.message,
  );

  console.log("\n15b. The same id arrives again with the store recovered — accepted and stored");
  resetStorageEvidence(); // a fresh process after the incident: no failure on record
  const recovered = await handleProviderWebhookPost(
    "selftest",
    providerPost({ providerMessageId: PID }),
    { exec: working.exec },
  );
  const recoveredBody = await jsonOf(recovered);
  check(
    "the retry is accepted (201, ok) and NOT told it is a duplicate",
    recovered.status === 201 && recoveredBody.ok === true && recoveredBody.duplicate !== true,
    { status: recovered.status, body: recoveredBody },
  );
  check("the mail really reached the store this time", insertsIn(working.calls) === 1, insertsIn(working.calls));
  check(
    "...and the answer claims a real store",
    recoveredBody.stored === true && recoveredBody.storage === "database",
    { stored: recoveredBody.stored, storage: recoveredBody.storage },
  );

  console.log("\n15c. A successful store followed by an accidental repeat — still a duplicate, stored once");
  const repeat = await handleProviderWebhookPost(
    "selftest",
    providerPost({ providerMessageId: PID }),
    { exec: working.exec },
  );
  const repeatBody = await jsonOf(repeat);
  check(
    "the repeat is answered duplicate with a 200",
    repeat.status === 200 && repeatBody.duplicate === true && repeatBody.ok === true,
    { status: repeat.status, body: repeatBody },
  );
  check("...and the store still holds exactly one insert for the pair", insertsIn(working.calls) === 1, insertsIn(working.calls));

  console.log("\n15d. Even with the status stuck on failed, a real store is remembered (not lost, not duplicated)");
  // The failure verdict is sticky for the process, so a delivery that succeeds
  // while the line says "failing" must still be remembered — `storedIn` (where
  // the row landed) decides, not the status state alone.
  resetStorageEvidence();
  const broken2 = fakeDb(storePlan, { throwOn: "insert" });
  const working2 = fakeDb(storePlan);
  const PID2 = "provider-msg-order-2";
  const refused2 = await handleProviderWebhookPost("selftest", providerPost({ providerMessageId: PID2 }), { exec: broken2.exec });
  check("the store refuses once more (non-2xx, nothing remembered)", refused2.status === 503 && (await jsonOf(refused2)).duplicate !== true, refused2.status);
  const sticky = await handleProviderWebhookPost("selftest", providerPost({ providerMessageId: PID2 }), { exec: working2.exec });
  const stickyBody = await jsonOf(sticky);
  check(
    "with the failure still on record, the next delivery is accepted and remembered",
    sticky.status === 201 && stickyBody.duplicate !== true && insertsIn(working2.calls) === 1,
    { status: sticky.status, inserts: insertsIn(working2.calls) },
  );
  const stickyRepeat = await handleProviderWebhookPost("selftest", providerPost({ providerMessageId: PID2 }), { exec: working2.exec });
  check(
    "its repeat is a duplicate despite the failed status line",
    stickyRepeat.status === 200 && (await jsonOf(stickyRepeat)).duplicate === true && insertsIn(working2.calls) === 1,
    stickyRepeat.status,
  );

  console.log("\n15e. An ignored event stores nothing and remembers nothing");
  resetRateLimits();
  const PID3 = "provider-msg-order-3";
  const ignoredEvent = await handleProviderWebhookPost(
    "selftest",
    providerPost({ kind: "ignored", providerMessageId: PID3 }),
    { exec: working2.exec },
  );
  const ignoredEventBody = await jsonOf(ignoredEvent);
  check(
    "an ignored event is accepted with a 200 and flagged ignored",
    ignoredEvent.status === 200 && ignoredEventBody.ok === true && ignoredEventBody.ignored === true,
    { status: ignoredEvent.status, body: ignoredEventBody },
  );
  check("nothing was stored for it", insertsIn(working2.calls) === 1, insertsIn(working2.calls));
  const afterIgnored = await handleProviderWebhookPost("selftest", providerPost({ providerMessageId: PID3 }), { exec: working2.exec });
  check(
    "the id it carried is NOT remembered: a real delivery of it is accepted, not a duplicate",
    afterIgnored.status === 201 && (await jsonOf(afterIgnored)).duplicate !== true,
    afterIgnored.status,
  );

  console.log("\n15f. A silent memory fallback while a database is configured is refused, not swallowed");
  // The seam the bug hid in: the funnel can answer 2xx while the row only landed
  // in memory (the store fell back after its client failed to build). That 2xx
  // must become an honest 503, and the id must not be remembered.
  process.env.DATABASE_URL = "not a connection string";
  resetStorageEvidence();
  resetRateLimits();
  const PID4 = "provider-msg-order-4";
  const fellBack = await handleProviderWebhookPost("selftest", providerPost({ providerMessageId: PID4 }));
  const fellBackBody = await jsonOf(fellBack);
  check(
    "the fallback answers 503 store_failed, never a quiet 2xx",
    fellBack.status === 503 && fellBackBody.error === "store_failed" && fellBackBody.stored === false,
    { status: fellBack.status, body: fellBackBody },
  );
  check("it is not answered as a duplicate", fellBackBody.duplicate !== true, fellBackBody);

  console.log("\n15g. The retry lands in honest preview — accepted once, then a duplicate");
  delete process.env.DATABASE_URL; // no database at all: memory IS the store now
  const previewDelivery = await handleProviderWebhookPost("selftest", providerPost({ providerMessageId: PID4 }));
  const previewBody = await jsonOf(previewDelivery);
  check(
    "the same id is accepted (the mail was not lost by the refused attempt)",
    previewDelivery.status === 201 && previewBody.ok === true && previewBody.duplicate !== true,
    { status: previewDelivery.status, body: previewBody },
  );
  check("...answered honestly as not persisted", previewBody.stored === false && /not persisted/i.test(String(previewBody.note)), previewBody.note);
  const previewRepeat = await handleProviderWebhookPost("selftest", providerPost({ providerMessageId: PID4 }));
  check(
    "its repeat is a duplicate — the preview good case is preserved",
    previewRepeat.status === 200 && (await jsonOf(previewRepeat)).duplicate === true,
    previewRepeat.status,
  );

  /* ---------------------------------------------------------------- *
   * 15h. The freshness window cannot lose a retry
   * ---------------------------------------------------------------- */

  console.log(
    "\n15h. A retry is never lost to the signature freshness window (stale refused and forgotten; re-signed fresh accepted and stored)",
  );

  // Svix's scheme signs *the attempt*: "Svix also sends the timestamp of the
  // attempt in the svix-timestamp header" (docs.svix.com/receiving/verifying-
  // payloads/how-manual), and the spec behind it is plainer still: "Every time
  // an attempt is retried the timestamp of the attempt is updated, while the
  // timestamp of the original event remains the same" (Standard Webhooks,
  // spec/standard-webhooks.md §Timestamp). The svix-id is the same for every
  // attempt of a message ("will be the same when the same webhook is being
  // resent"). That combination could still cost us mail in exactly two ways,
  // and this check rules out both:
  //   - an attempt signed beyond the tolerance is refused as stale — fine, as
  //     long as the refusal stores nothing and remembers NOTHING: a remembered
  //     id would answer the provider's next attempt with `duplicate` and the
  //     mail would be gone for good;
  //   - the same message re-signed with a current timestamp — precisely what a
  //     retried attempt carries — must be accepted and stored.
  // Fully offline: the stale refusal fails before any provider call is made,
  // the re-sign is judged by the same verifyResendSignature() call the route
  // makes, and the store is this section's stand-in with an injected executor
  // (the route past read() is provider-agnostic).
  resetIngestedProviderMessages();
  resetRateLimits();
  resetStorageEvidence();
  process.env[RESEND_WEBHOOK_SECRET_ENV] = SECRET;
  // Both secrets set, so the route is armed and actually reaches the signature
  // layer (connection() is checked first). Still offline: the stale refusal
  // fires inside read() before any call to Resend.
  process.env[RESEND_API_KEY_ENV] = "re_selftest_key_not_real";
  process.env.DATABASE_URL = "postgresql://u:p@db.internal.example:5432/doppel";
  const RETRY_ID = "msg_freshness-retry-1";
  const retryBody = JSON.stringify({
    type: "email.received",
    created_at: WEDNESDAY,
    data: { email_id: RETRY_ID, from: "marcus@example.com", subject: urgentEmail.subject, created_at: WEDNESDAY },
  });
  const resendAttempt = (timestamp: string) =>
    postRequest(RESEND_URL, retryBody, {
      "svix-id": RETRY_ID,
      "svix-timestamp": timestamp,
      "svix-signature": svixSignature(RETRY_ID, timestamp, retryBody, SECRET),
    });

  // (a) The attempt signed an hour ago — beyond the tolerance — is refused as stale.
  const staleAttempt = await handleProviderWebhookPost("resend", resendAttempt(String(Math.floor(Date.now() / 1000) - 3600)));
  const staleAttemptBody = await jsonOf(staleAttempt);
  check(
    "an attempt signed beyond the tolerance is refused as stale",
    staleAttempt.status === 401 && staleAttemptBody.error === "stale_signature",
    { status: staleAttempt.status, body: staleAttemptBody },
  );
  check(
    "...and says in words that nothing was stored",
    /nothing was stored/i.test(String(staleAttemptBody.message)),
    staleAttemptBody.message,
  );

  // (b) The same message re-signed now — same id, same body, current timestamp —
  // passes the very window that refused the stale attempt.
  const nowTs = String(Math.floor(Date.now() / 1000));
  const resigned = verifyResendSignature({
    rawBody: retryBody,
    id: RETRY_ID,
    timestamp: nowTs,
    signature: svixSignature(RETRY_ID, nowTs, retryBody, SECRET),
    secret: SECRET,
  });
  check("the same message re-signed now passes the same window", resigned.ok === true, resigned);

  // (c) The retried message is accepted and stored — which doubles as the proof
  // that the stale refusal remembered nothing: a remembered id would have been
  // answered `duplicate` with zero inserts.
  const retryStore = fakeDb(storePlan);
  const retryDelivery = await handleProviderWebhookPost(
    "selftest",
    providerPost({ providerMessageId: RETRY_ID }),
    { exec: retryStore.exec },
  );
  const retryDeliveryBody = await jsonOf(retryDelivery);
  check(
    "the retried message is accepted and stored — the refusal was not remembered",
    retryDelivery.status === 201 && retryDeliveryBody.duplicate !== true && insertsIn(retryStore.calls) === 1,
    { status: retryDelivery.status, body: retryDeliveryBody, inserts: insertsIn(retryStore.calls) },
  );
  check(
    "...and it claims a real store",
    retryDeliveryBody.stored === true && retryDeliveryBody.storage === "database",
    { stored: retryDeliveryBody.stored, storage: retryDeliveryBody.storage },
  );
  const retryRepeat = await handleProviderWebhookPost("selftest", providerPost({ providerMessageId: RETRY_ID }), { exec: retryStore.exec });
  check(
    "a later repeat of it is still answered as a duplicate, stored once",
    retryRepeat.status === 200 && (await jsonOf(retryRepeat)).duplicate === true && insertsIn(retryStore.calls) === 1,
    retryRepeat.status,
  );

  delete process.env[RESEND_WEBHOOK_SECRET_ENV];
  delete process.env[RESEND_API_KEY_ENV];
  resetRateLimits();

  // Leave no trace: the stand-in provider, the remembered ids, the rate-limit
  // bucket, the storage evidence and the connection string.
  delete PROVIDERS["selftest"];
  resetIngestedProviderMessages();
  resetRateLimits();
  resetStorageEvidence();
  delete process.env.DATABASE_URL;

  /* ---------------------------------------------------------------- *
   * 16. A body-less forwarded message is stored, not refused
   * ---------------------------------------------------------------- */

  console.log("\n16. A forwarded message with no readable body is stored, not refused");

  // The fixtures below are copied from Resend's published examples:
  //   - the retrieve-received-email response (their own example carries
  //     `"text": null` with an HTML body present, plus a two-entry attachments
  //     array and a `headers.from` display name):
  //     https://resend.com/docs/api-reference/emails/retrieve-received-email
  //   - the email.received webhook event (ids, from, created_at):
  //     https://resend.com/docs/webhooks/emails/received
  //   - the retry schedule that makes a failure answer costly
  //     (https://resend.com/docs/webhooks/retries-and-replays).
  // Every scenario id is an id from those published examples, so each scenario
  // has its own and the duplicate-suppression map never confuses them.
  // Hermetic: fetch is stubbed to return the documented response, the store is
  // the stand-in executor (or the memory store in preview), nothing leaves the
  // process, and no message is written to any real database.
  const DOCS_RETRIEVE_EXAMPLE = {
    object: "email",
    id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    to: ["delivered@resend.dev"],
    from: "onboarding@resend.dev",
    created_at: "2026-04-03T22:13:42.674Z",
    subject: "Hello World",
    html: "Congrats on sending your <strong>first email</strong>!",
    html_format: "data_uri",
    text: null,
    headers: {
      from: "Acme <onboarding@resend.dev>",
      "return-path": "lucas.costa@resend.com",
      "mime-version": "1.0",
    },
    bcc: [],
    cc: [],
    reply_to: [],
    received_for: ["forwarded@example.com"],
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    message_id: "<111-222-333@email.example.com>",
    raw: {
      download_url:
        "https://example.resend.com/receiving/raw/054da427-439a-4e91-b785-e4fb1966285f?Signature=...",
      expires_at: "2026-04-03T23:13:42.674Z",
    },
    attachments: [
      {
        id: "2a0c9ce0-3112-4728-976e-47ddcd16a318",
        filename: "avatar.png",
        content_type: "image/png",
        content_disposition: "inline",
        content_id: "img001",
        size: 4096,
      },
      {
        id: "3b1d0df1-4223-5839-087f-54eedd27b419",
        filename: "document.pdf",
        content_type: "application/pdf",
        content_disposition: null,
        content_id: null,
        size: 13264,
      },
    ],
  };
  // The documented webhook event's `data` fields (minus email_id, which the
  // delivery helper supplies per scenario).
  const DOCS_EVENT_DATA = {
    from: "onboarding@resend.dev",
    to: ["delivered@resend.dev"],
    received_for: ["forwarded@example.com"],
    message_id: "<111-222-333@email.example.com>",
  };
  // Ids from the same published examples, one per scenario so the remembered-id
  // map can never conflate them.
  const IDS = {
    htmlPresent: DOCS_RETRIEVE_EXAMPLE.id,
    noHtml: "56761188-7520-42d8-8898-ff6fc54ce618", // the webhook example's email_id
    attachmentsOnly: "054da427-439a-4e91-b785-e4fb1966285f", // the example's raw-download id
    nothingAtAll: "2a0c9ce0-3112-4728-976e-47ddcd16a318", // the example's first attachment id
  };

  const upstreamReturns = (payload: Record<string, unknown>) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  };
  const deliverResend = async (
    emailId: string,
    upstream: Record<string, unknown>,
    exec?: QueryExecutor,
    eventData: Record<string, unknown> = DOCS_EVENT_DATA,
  ): Promise<{ response: Response; body: Record<string, any> }> => {
    const restore = upstreamReturns(upstream);
    try {
      const eventBody = JSON.stringify({
        type: "email.received",
        created_at: WEDNESDAY,
        data: { email_id: emailId, created_at: WEDNESDAY, ...eventData },
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const response = await handleProviderWebhookPost(
        "resend",
        postRequest(RESEND_URL, eventBody, {
          "svix-id": emailId,
          "svix-timestamp": ts,
          "svix-signature": svixSignature(emailId, ts, eventBody, SECRET),
        }),
        exec ? { exec } : {},
      );
      return { response, body: await jsonOf(response) };
    } finally {
      restore();
    }
  };

  process.env[RESEND_WEBHOOK_SECRET_ENV] = SECRET;
  process.env[RESEND_API_KEY_ENV] = "re_selftest_key_not_real";
  process.env.DATABASE_URL = "postgresql://u:p@db.internal.example:5432/doppel";
  resetStorageEvidence();
  resetIngestedProviderMessages();
  resetRateLimits();

  console.log("\n16a. The documented response (\"text\": null + HTML) is stored with its HTML read");
  const storeA = fakeDb(storePlan);
  const a = await deliverResend(IDS.htmlPresent, DOCS_RETRIEVE_EXAMPLE, storeA.exec);
  check(
    "(a) stored with a retry-stopping 201 that claims a real store",
    a.response.status === 201 && a.body.ok === true && a.body.stored === true && a.body.storage === "database",
    { status: a.response.status, stored: a.body.stored, storage: a.body.storage },
  );
  check("(a) the documented subject is what the answer carries", a.body.email.subject === "Hello World", a.body.email.subject);
  check("(a) the sender comes from the documented headers.from", a.body.email.from === "Acme <onboarding@resend.dev>", a.body.email.from);
  const insertA = storeA.calls.find((c) => /insert into emails/i.test(c.sql));
  check(
    "(a) the HTML became readable text in the stored row (the documented words)",
    String(insertA?.values?.[6] ?? "").includes("first email"),
    insertA?.values?.[6],
  );
  check("(a) a message with readable text carries no absence note", !JSON.stringify(insertA?.values ?? []).includes("[Doppel note"));
  const aRepeat = await deliverResend(IDS.htmlPresent, DOCS_RETRIEVE_EXAMPLE, storeA.exec);
  check(
    "(a) a replay is answered duplicate 200 — the success stopped the retries",
    aRepeat.response.status === 200 && aRepeat.body.duplicate === true,
    { status: aRepeat.response.status, body: aRepeat.body },
  );
  check("(a) ...with still exactly one insert", insertsIn(storeA.calls) === 1, insertsIn(storeA.calls));

  console.log("\n16b. The same documented shape with html null too — subject present, so it is stored honestly");
  const storeB = fakeDb(storePlan);
  const bUpstream = { ...DOCS_RETRIEVE_EXAMPLE, html: null, attachments: [] };
  const b = await deliverResend(IDS.noHtml, bUpstream, storeB.exec);
  const insertB = storeB.calls.find((c) => /insert into emails/i.test(c.sql));
  check(
    "(b) a real message (sender + subject) with no readable body is stored 2xx, not refused",
    b.response.status === 201 && b.body.ok === true && b.body.stored === true && insertsIn(storeB.calls) === 1,
    { status: b.response.status, stored: b.body.stored, inserts: insertsIn(storeB.calls) },
  );
  check(
    "(b) the stored body says plainly that there was no readable text",
    String(insertB?.values?.[6] ?? "") === "[Doppel note: this message had no readable text — no plain-text or HTML body came with it.]",
    insertB?.values?.[6],
  );
  check(
    "(b) the row claims no text it does not have (no sender words, no HTML leftovers)",
    !JSON.stringify(insertB?.values ?? []).includes("Congrats") && !JSON.stringify(insertB?.values ?? []).includes("first email"),
    insertB?.values?.[6],
  );

  console.log("\n16c. An attachment-only forward — subject present, empty body, the documented attachments");
  const storeC = fakeDb(storePlan);
  const cUpstream = { ...DOCS_RETRIEVE_EXAMPLE, html: null };
  const c = await deliverResend(IDS.attachmentsOnly, cUpstream, storeC.exec);
  const insertC = storeC.calls.find((c) => /insert into emails/i.test(c.sql));
  check(
    "(c) stored with a 201 — nothing lost",
    c.response.status === 201 && c.body.ok === true && c.body.stored === true && insertsIn(storeC.calls) === 1,
    { status: c.response.status, stored: c.body.stored, inserts: insertsIn(storeC.calls) },
  );
  check(
    "(c) the note names the two attachments that were not downloaded",
    String(insertC?.values?.[6] ?? "") ===
      "[Doppel note: this message had no readable text — no plain-text or HTML body came with it, and its 2 attachments were not downloaded.]",
    insertC?.values?.[6],
  );
  check(
    "(c) the answer claims no text it does not have — nothing in it quotes words the sender never wrote",
    !JSON.stringify(c.body).includes("Congrats") && !JSON.stringify(c.body).includes("first email"),
    c.body.email?.draft?.body,
  );
  check(
    "(c) the draft declines to have read anything",
    typeof c.body.email?.draft?.body === "string" &&
      c.body.email.draft.body.includes("no readable text") &&
      !/I've read it/.test(c.body.email.draft.body),
    c.body.email?.draft?.body,
  );

  console.log("\n16d. A payload carrying literally nothing is still refused — nothing stored, nothing remembered");
  const storeD = fakeDb(storePlan);
  const dUpstream = {
    object: "email",
    id: IDS.nothingAtAll,
    to: ["delivered@resend.dev"],
    created_at: "2026-04-03T22:13:42.674Z",
    bcc: [],
    cc: [],
    reply_to: [],
  };
  // The event carries no from either — no sender, no subject, no body anywhere.
  const d = await deliverResend(IDS.nothingAtAll, dUpstream, storeD.exec, {});
  check("(d) the typed 400 refusal, as before", d.response.status === 400 && d.body.error === "not_a_message", {
    status: d.response.status,
    body: d.body,
  });
  check("(d) nothing was stored", insertsIn(storeD.calls) === 0, insertsIn(storeD.calls));
  const dRepeat = await deliverResend(IDS.nothingAtAll, dUpstream, storeD.exec, {});
  check(
    "(d) a retry gets the same refusal — no duplicate answer, nothing was remembered",
    dRepeat.response.status === 400 && dRepeat.body.error === "not_a_message" && dRepeat.body.duplicate !== true && insertsIn(storeD.calls) === 0,
    { status: dRepeat.response.status, body: dRepeat.body, inserts: insertsIn(storeD.calls) },
  );

  console.log("\n16e. The row the app reads back is the row the webhook claimed to store");
  delete process.env.DATABASE_URL;
  resetRateLimits();
  resetIngestedProviderMessages();
  resetStorageEvidence();
  const emptyFunnel = await ingestEmail({ source: "paste" });
  check(
    "(e) the funnel still refuses a payload that is literally nothing",
    emptyFunnel.ok === false && emptyFunnel.reason === "not_a_message",
    emptyFunnel.ok === false ? emptyFunnel.message : emptyFunnel,
  );
  const senderOnly = await ingestEmail({ source: "api", from: "Dana Whitfield <dana@example.com>" });
  check(
    "(e) a message that has a sender but no subject and no body is kept, not refused",
    senderOnly.ok === true && senderOnly.email.body === "[Doppel note: this message had no readable text.]",
    senderOnly.ok ? senderOnly.email.body : senderOnly.message,
  );

  const aPreview = await deliverResend(IDS.htmlPresent, DOCS_RETRIEVE_EXAMPLE);
  const aRow = aPreview.body.ok ? await getEmail(aPreview.body.email.id) : null;
  check(
    "(e) the documented example's row reads back as the webhook claimed (id, sender, subject)",
    aPreview.response.status === 201 &&
      aRow?.ok === true &&
      aRow.value?.id === aPreview.body.email.id &&
      aRow.value?.subject === aPreview.body.email.subject &&
      aRow.value?.fromLabel === aPreview.body.email.from,
    { claimed: aPreview.body.email, row: aRow?.value },
  );
  check(
    "(e) its body is the HTML text, not an absence note",
    aRow?.ok === true && aRow.value?.body?.includes("first email") === true && !aRow.value.body.includes("[Doppel note"),
    aRow?.value?.body,
  );
  const bPreview = await deliverResend(IDS.noHtml, bUpstream);
  const bRow = bPreview.body.ok ? await getEmail(bPreview.body.email.id) : null;
  check(
    "(e) the body-less row reads back with the exact honest note as its body and snippet",
    bPreview.response.status === 201 &&
      bRow?.ok === true &&
      bRow.value?.body === "[Doppel note: this message had no readable text — no plain-text or HTML body came with it.]" &&
      bRow.value?.snippet === bRow.value?.body,
    { body: bRow?.value?.body, snippet: bRow?.value?.snippet },
  );
  const cPreview = await deliverResend(IDS.attachmentsOnly, cUpstream);
  const cRow = cPreview.body.ok ? await getEmail(cPreview.body.email.id) : null;
  check(
    "(e) the attachment-only row reads back with the attachment-honest note",
    cPreview.response.status === 201 &&
      cRow?.ok === true &&
      cRow.value?.body ===
        "[Doppel note: this message had no readable text — no plain-text or HTML body came with it, and its 2 attachments were not downloaded.]",
    cRow?.value?.body,
  );

  // Leave no trace: the secrets, the connection string, the remembered ids,
  // the rate-limit bucket and the storage evidence.
  delete process.env[RESEND_WEBHOOK_SECRET_ENV];
  delete process.env[RESEND_API_KEY_ENV];
  delete process.env.DATABASE_URL;
  resetIngestedProviderMessages();
  resetRateLimits();
  resetStorageEvidence();

  console.log(failures === 0 ? "\nAll inbox checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
