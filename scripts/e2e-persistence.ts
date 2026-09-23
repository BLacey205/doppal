/**
 * End-to-end persistence proof — does a write in one request really come back in
 * the next, with real PostgreSQL semantics underneath?
 *
 *   bun run scripts/e2e-persistence.ts
 *
 * Why this exists: `/app`'s storage line has only ever been shown reaching the
 * "confirmed" state against a **stubbed** executor (`scripts/app-selftest.ts`), and
 * no test has yet driven a write in one request and a *separate* read back. This
 * script closes that gap. It runs the app's own code — the inbound route handler,
 * the waitlist write, and the same read functions `/app` calls — with the Postgres
 * client pointed at **PGlite** (PostgreSQL compiled to WebAssembly, running in this
 * process). Real PostgreSQL semantics: real parser, real types, real error codes.
 *
 * What it asserts, per step, PASS/FAIL (it exits non-zero if any check fails):
 *
 *   1. a waitlist signup goes in, and a later, separate request reads it back —
 *      the text and the row count match what was submitted;
 *   2. an email POSTed to /api/inbound-email (the real handler, a real `Request`)
 *      is stored, scored worst-first with a reason, its dates become calendar
 *      events with reminders, and a later read of /app's data returns that same
 *      message — write in one request, read in another;
 *   3. persistence is real, not in-memory: a **fresh process** (fresh module state,
 *      fresh database client, same PGlite data directory) still finds those rows;
 *   4. `ensureSchema` is idempotent: the app's DDL and its operations run again over
 *      the existing schema without erroring or duplicating rows;
 *   5. the storage status the app computes reports `confirmed` with the
 *      "Saved to the connected database" wording — and the moment a query is made
 *      to fail, reports `failed` instead, and stays there.
 *
 * Hermetic: no network, no credentials, no live database. Nothing is written to the
 * owner's database — PGlite lives entirely in a temporary directory under /tmp. The
 * only dependency is PGlite itself, installed outside the repo (see `PGLITE_HOME`
 * below); the repo gains no runtime dependency.
 *
 * This is **not** a proof about the owner's database: their host, DNS, TLS,
 * credentials, permissions and server version are all still unproven. PGlite is
 * PostgreSQL 18.3 compiled to WASM.
 *
 * NOTE on the client: the app reaches a plain Postgres host over the wire protocol
 * with `Bun.SQL` (`src/db.ts` → transport `bun-tcp`). This harness keeps that
 * decision — `DATABASE_URL` is a plain `postgres://` address, so the app's own
 * transport selection picks `bun-tcp` — but supplies a PGlite-backed tagged-template
 * client in its place, because in this environment `Bun.SQL` hangs (no error, no
 * timeout) on **parameterised** statements against PGlite's WASM socket server:
 * `select 1` returns, `select $1::int` never does. That is a limitation of the
 * WASM socket server, not of the app's SQL. With the client substituted, the SQL,
 * the schema, the parameter binding and the error codes are all PostgreSQL's own.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/* -------------------------------------------------------------------------- */
/* Verdict plumbing                                                            */
/* -------------------------------------------------------------------------- */

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
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function note(label: string, detail: unknown): void {
  console.log(`        ${label}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

/* -------------------------------------------------------------------------- */
/* PGlite (outside the repo, never added as a dependency)                      */
/* -------------------------------------------------------------------------- */

const PGLITE_HOME = process.env.PGLITE_HOME ?? "/tmp/pg-dry-run";
const PGLITE_ENTRY = `${PGLITE_HOME}/node_modules/@electric-sql/pglite/dist/index.js`;

/** The connection string the app's own transport selection is handed. */
const DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5444/postgres?sslmode=disable";

/** Set by the app's own `/api/inbound-email` guard, which fails closed without it. */
const INBOUND_EMAIL_TOKEN = "e2e-persistence-token";

/** The live database handle the substituted client talks to. Swapped on reopen. */
let live: { query: (text: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } | null = null;

/**
 * Stand in for `Bun.SQL`, whose tagged-template call shape is exactly the app's
 * executor seam: `new Bun.SQL(url, { prepare: false })` returns a callable that
 * takes (strings, ...values) and resolves to an array of rows.
 */
function installClient(): void {
  const bun = (globalThis as { Bun?: Record<string, unknown> }).Bun;
  if (!bun) throw new Error("this harness runs under bun (it needs the app's runtime)");
  bun.SQL = function BunSqlBackedByPGlite(_url: string) {
    const client: unknown = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!live) throw new Error("connection terminated unexpectedly");
      // Same placeholder translation as a real driver: $1, $2 … bound server-side.
      let text = strings[0];
      for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
      const result = await live.query(text, values);
      return result.rows;
    };
    (client as { close?: () => Promise<void> }).close = async () => {};
    return client;
  };
}

async function openDatabase(dataDir: string): Promise<unknown> {
  const pg = (await import(PGLITE_ENTRY)) as {
    PGlite: new (dataDir?: string) => {
      query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      exec: (text: string) => Promise<unknown>;
      close: () => Promise<void>;
    };
  };
  const db = new pg.PGlite(dataDir);
  // First statement: prove the engine is really there before anything else runs.
  await db.query("select 1");
  live = db as unknown as typeof live;
  return db;
}

/** True when PGlite is where this harness expects it. Never installs anything. */
function pglitePresent(): boolean {
  try {
    readFileSync(PGLITE_ENTRY, "utf8");
    return true;
  } catch {
    return false;
  }
}

function pgliteMissing(): never {
  console.log(`PGlite is not installed at ${PGLITE_HOME}.`);
  console.log("Install it outside the repo (once), then re-run:");
  console.log("  mkdir -p /tmp/pg-dry-run && cd /tmp/pg-dry-run");
  console.log('  printf \'{"name":"pg-dry-run","private":true,"type":"module"}\\n\' > package.json');
  console.log("  bun add @electric-sql/pglite");
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* Shared types                                                                */
/* -------------------------------------------------------------------------- */

type Executor = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

type Manifest = {
  email: string;
  name: string;
  businessType: string;
  subject: string;
  emailId: string;
  score: number;
  dateCount: number;
  eventCount: number;
};

async function readManifest(path: string): Promise<Manifest> {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/* -------------------------------------------------------------------------- */
/* Phase 2 — a fresh process reads what the first process wrote                */
/* -------------------------------------------------------------------------- */

async function runReadBackPhase(dataDir: string, manifestPath: string): Promise<number> {
  const { sql } = await import("../src/db");
  const { ensureSchema, getEmail, listCalendarEvents, listEmails, saveDraft } = await import(
    "../src/lib/inbox-server"
  );
  const { addToWaitlist } = await import("../src/lib/waitlist-server");
  const { addDateToCalendar } = await import("../src/lib/ingest");
  const manifest = await readManifest(manifestPath);

  console.log("Read-back phase: a fresh process, fresh module state, same PGlite data directory.");

  /* ------------------------------ step 3: real persistence ------------------------------ */
  step("3. after the writing process is gone, are the rows still there?");
  const signups = await sql()`select email, name, business_type from waitlist where email = ${manifest.email}`;
  check(
    "the waitlist signup written by the first process is still there, with its text intact",
    signups.length === 1 &&
      String(signups[0].email) === manifest.email &&
      String(signups[0].name) === manifest.name &&
      String(signups[0].business_type) === manifest.businessType,
    signups,
  );

  const mail = await listEmails();
  check("the message written by the first process is read back by the app's own read path", mail.ok === true && mail.value.length >= 1, mail.ok ? mail.value.length : mail.message);
  if (mail.ok) {
    const found = mail.value.find((email) => String(email.id) === manifest.emailId);
    check(
      "…the same subject, score and extracted dates came back",
      Boolean(found) && found!.subject === manifest.subject && found!.importance.score === manifest.score && found!.dates.length === manifest.dateCount,
      found && { subject: found.subject, score: found.importance.score, dates: found.dates.length },
    );
  }
  const events = await listCalendarEvents();
  check(
    "the calendar event written by the first process is still on the calendar, with its reminder",
    events.ok === true && events.value.filter((event) => String(event.emailId) === manifest.emailId).length === manifest.eventCount,
    events.ok ? events.value.filter((event) => String(event.emailId) === manifest.emailId).length : events.message,
  );

  /* --------------------- step 4: ensureSchema over the existing schema --------------------- */
  step("4. the app's DDL and operations, run again over a schema that already exists");
  let schemaError: string | null = null;
  try {
    // A fresh process, so this really re-executes `create table if not exists` against
    // tables that are already there — the idempotency the app relies on instead of a
    // migration step.
    await ensureSchema(sql() as unknown as Executor);
  } catch (err) {
    schemaError = err instanceof Error ? err.message : String(err);
  }
  check("re-running ensureSchema over the existing schema does not error", schemaError === null, schemaError);

  const tables = await sql()`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name in ('emails', 'drafts', 'calendar_events', 'waitlist')
    order by table_name
  `;
  check("all four tables are still exactly the four the app creates", tables.length === 4, tables.map((row) => String(row.table_name)));

  const before = {
    signups: Number((await sql()`select count(*)::int as n from waitlist`)[0].n),
    emails: Number((await sql()`select count(*)::int as n from emails`)[0].n),
    events: Number((await sql()`select count(*)::int as n from calendar_events`)[0].n),
  };
  // Emails are deliberately append-only (a message arriving twice is two messages), so
  // the repeated operations checked here are the ones the app itself makes idempotent.
  const repeatSignup = await addToWaitlist({ email: manifest.email, name: manifest.name, businessType: manifest.businessType });
  check("the same signup again is 'already' on the list, not a second row", repeatSignup.status === "already", repeatSignup);

  const again = await getEmail(manifest.emailId);
  if (again.ok && again.value) {
    await saveDraft(
      { emailId: manifest.emailId, body: "edited once", mode: "heuristic", provider: "heuristic", label: "E2E" },
      undefined,
    );
    await saveDraft(
      { emailId: manifest.emailId, body: "edited twice", mode: "heuristic", provider: "heuristic", label: "E2E" },
      undefined,
    );
    const drafts = await sql()`select count(*)::int as n from drafts where email_id = ${Number(manifest.emailId)}`;
    check("saving the draft twice updates in place — one draft row, not two", Number(drafts[0].n) === 1, drafts);
    const eventCountBefore = Number((await sql()`select count(*)::int as n from calendar_events`)[0].n);
    const redated = await addDateToCalendar(again.value, again.value.dates[0]?.id ?? "");
    const eventCountAfter = Number((await sql()`select count(*)::int as n from calendar_events`)[0].n);
    check(
      "adding the same date to the calendar again adds no second event",
      redated.ok === true && eventCountAfter === eventCountBefore,
      { redated, eventCountBefore, eventCountAfter },
    );
  } else {
    check("the message could be read back for the repeated-operations checks", false, again);
  }

  const after = {
    signups: Number((await sql()`select count(*)::int as n from waitlist`)[0].n),
    emails: Number((await sql()`select count(*)::int as n from emails`)[0].n),
    events: Number((await sql()`select count(*)::int as n from calendar_events`)[0].n),
  };
  check("no duplicated rows appeared: waitlist and calendar unchanged, messages not re-inserted", after.signups === before.signups && after.events === before.events && after.emails === before.emails, { before, after });

  if (live) await (live as unknown as { close: () => Promise<void> }).close();
  return failures;
}

/* -------------------------------------------------------------------------- */
/* Phase 1 — the writing process                                               */
/* -------------------------------------------------------------------------- */

async function runWritePhase(dataDir: string, manifestPath: string): Promise<number> {
  const { databaseTransport } = await import("../src/db");
  const { resetStorageEvidence } = await import("../src/lib/storage-evidence");
  const { CONFIRMED_LABEL, storageStatus } = await import("../src/lib/inbox-server");
  const { handleInboundEmailPost } = await import("../src/lib/inbound-request");
  const { addToWaitlist } = await import("../src/lib/waitlist-server");
  const { sql } = await import("../src/db");

  resetStorageEvidence();

  step("0. the app's own transport selection, and the state before any query");
  note("DATABASE_URL", DATABASE_URL);
  check("the app picks its real wire-protocol client for a plain Postgres host", databaseTransport(DATABASE_URL) === "bun-tcp", databaseTransport(DATABASE_URL));
  const virgin = storageStatus();
  check("before any query the storage status claims nothing (state 'unverified')", virgin.state === "unverified", virgin);
  check("…and the success wording is absent", !JSON.stringify(virgin).includes(CONFIRMED_LABEL), virgin.label);

  const stamp = Date.now().toString(36);
  const waitlistEmail = `e2e+${stamp}@example.com`;
  const waitlistName = "End To End";
  const businessType = "Trades / home services";

  /* ------------------------------ step 1: waitlist ------------------------------ */
  step("1. a waitlist signup, written then read back in a separate request");
  const submit = await addToWaitlist({ email: waitlistEmail, name: waitlistName, businessType });
  check("request 1: the waitlist write reports the signup was accepted", submit.status === "joined", submit);
  // A separate call, using the app's own read-back path (the signup form's only read is
  // the unique-email check, which is what makes 'already' possible).
  const second = await addToWaitlist({ email: waitlistEmail, name: waitlistName, businessType });
  check("request 2: the same signup is already on the list, so the row is really there", second.status === "already", second);
  const stored = await sql()`select email, name, business_type from waitlist where email = ${waitlistEmail}`;
  check(
    "the stored text matches what was submitted",
    stored.length === 1 && String(stored[0].email) === waitlistEmail && String(stored[0].name) === waitlistName && String(stored[0].business_type) === businessType,
    stored,
  );
  const signupCount = await sql()`select count(*)::int as n from waitlist`;
  check("the count the app can read back is 1", Number(signupCount[0].n) === 1, signupCount);

  /* --------------------------- step 2: the inbound route --------------------------- */
  step("2. an email POSTed to /api/inbound-email, then read back by /app");
  const subject = `E2E persistence ${stamp}`;
  const urgent = {
    from: "Rita Okafor <rita@northgate-timber.co.uk>",
    subject,
    receivedAt: "2026-10-05T09:00:00Z",
    text: [
      "The site on Mill Road is leaking again and the tenant is chasing us today.",
      "Can someone confirm a visit on Tuesday 14:30? Please reply today.",
      "Invoice INV-2291 is due 2026-10-01 and the OFT number is on the form.",
    ].join("\n\n"),
  };
  const newsletter = {
    from: "Trade Weekly <news@trade-weekly.example>",
    subject: `E2E newsletter ${stamp}`,
    receivedAt: "2026-10-04T06:00:00Z",
    text: "This week's supplier offers, plus a round-up of industry news. Unsubscribe at any time.",
  };

  const post = (payload: Record<string, string>) =>
    handleInboundEmailPost(
      new Request("https://doppel.example/api/inbound-email", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${INBOUND_EMAIL_TOKEN}` },
        body: JSON.stringify(payload),
      }),
      // The owner alert is injected away: this run opens no socket and tells nobody.
      { notify: () => undefined },
    );

  const urgentResponse = await post(urgent);
  const urgentBody = (await urgentResponse.json()) as {
    ok: boolean;
    stored: boolean;
    email: { id: string; subject: string; importance: { score: number; reason: string }; dates: { id: string; label: string; reminderAt: string | null; reminderLabel: string | null }[] };
    note: string;
  };
  check("POST /api/inbound-email answers 201 for a real payload with the token", urgentResponse.status === 201, urgentResponse.status);
  check("…ok:true, and 'stored' is only true because a real query came back", urgentBody.ok === true && urgentBody.stored === true, { ok: urgentBody.ok, stored: urgentBody.stored });
  check("the message was scored, with a reason a person can read", Number.isInteger(urgentBody.email.importance.score) && urgentBody.email.importance.reason.trim().length > 0, urgentBody.email.importance);
  check(
    "dates and times inside the message became calendar-ready candidates, each with a reminder",
    urgentBody.email.dates.length >= 2 && urgentBody.email.dates.every((date) => Boolean(date.reminderAt) && Boolean(date.reminderLabel)),
    urgentBody.email.dates,
  );
  note("response note", urgentBody.note);

  const newsletterResponse = await post(newsletter);
  const newsletterBody = (await newsletterResponse.json()) as { ok: boolean; email: { id: string; importance: { score: number } } };
  check("a second message through the same route is accepted too", newsletterResponse.status === 201 && newsletterBody.ok === true, newsletterResponse.status);

  const { getEmail, listCalendarEvents, listEmails } = await import("../src/lib/inbox-server");
  const { addDateToCalendar } = await import("../src/lib/ingest");

  const inbox = await listEmails();
  if (inbox.ok) {
    const scores = inbox.value.map((email) => email.importance.score);
    const worstFirst = scores.every((score, index) => index === 0 || scores[index - 1] >= score);
    check("a later read of /app's data returns the message that was POSTed", inbox.value.some((email) => String(email.id) === urgentBody.email.id && email.subject === subject), inbox.value.map((email) => email.subject));
    check("the inbox comes back ranked worst-first by score", worstFirst, scores);
    check("…with the urgent message above the newsletter", inbox.value.findIndex((email) => String(email.id) === urgentBody.email.id) < inbox.value.findIndex((email) => String(email.id) === newsletterBody.email.id), scores);
  } else {
    check("a later read of /app's data returns the message that was POSTed", false, inbox.message);
  }

  const readBack = await getEmail(urgentBody.email.id);
  check("reading that one message back gives the same score and dates", readBack.ok === true && readBack.value?.importance.score === urgentBody.email.importance.score && readBack.value?.dates.length === urgentBody.email.dates.length, readBack.ok ? readBack.value?.importance : readBack.message);

  let eventCount = 0;
  if (readBack.ok && readBack.value) {
    const firstDate = readBack.value.dates[0];
    const added = await addDateToCalendar(readBack.value, firstDate?.id ?? "");
    check("a date from that message goes onto the calendar with its reminder", added.ok === true, added);
    const events = await listCalendarEvents();
    eventCount = events.ok ? events.value.filter((event) => String(event.emailId) === urgentBody.email.id).length : 0;
    check("the calendar read (what /app's calendar page calls) returns that event, reminder included", events.ok === true && eventCount === 1 && Boolean(events.value.find((event) => String(event.emailId) === urgentBody.email.id)?.reminderAt), events.ok ? events.value.map((event) => ({ id: event.id, emailId: event.emailId, reminderAt: event.reminderAt })) : events.message);
  } else {
    check("a date from that message goes onto the calendar with its reminder", false, readBack);
  }

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        email: waitlistEmail,
        name: waitlistName,
        businessType,
        subject,
        emailId: urgentBody.email.id,
        score: urgentBody.email.importance.score,
        dateCount: urgentBody.email.dates.length,
        eventCount: eventCount || 1,
      } satisfies Manifest,
      null,
      2,
    ),
  );

  /* --------------------------- step 5a: the storage line --------------------------- */
  step("5a. what the storage status on /app computes from those real reads");
  const confirmed = storageStatus();
  note("state", confirmed.state);
  note("label", confirmed.label);
  check("after a real query the state is 'confirmed'", confirmed.state === "confirmed", confirmed);
  check(`…and the label is the existing wording "${CONFIRMED_LABEL}"`, confirmed.label === CONFIRMED_LABEL, confirmed.label);
  check("…and the note says what earned it (a query that came back, not an address being set)", /came back/i.test(confirmed.note ?? ""), confirmed.note);

  // The card itself, rendered from the real status, so the wording on screen is asserted
  // and not only the view model.
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ModeCard } = await import("../src/components/app-ui");
  const { aiStatus } = await import("../src/lib/ai");
  const html = renderToStaticMarkup(React.createElement(ModeCard, { ai: aiStatus(), storage: storageStatus() }));
  check("the rendered card carries the same wording, with a Database chip rather than Preview", html.includes(CONFIRMED_LABEL) && html.includes("Database") && !html.includes("Preview"), html.length);

  if (live) await (live as unknown as { close: () => Promise<void> }).close();
  return failures;
}

/**
 * Step 5b, deliberately last: it drops a table, so it must not run before the fresh
 * process has read the rows back. A real failure, from real Postgres — not a stub
 * that throws.
 */
async function runFailurePhase(): Promise<number> {
  step("5b. a query that really fails — does the line drop the success wording?");
  // Local to this phase: the write phase's stamp is not in scope here.
  const stamp = Date.now().toString(36);
  const { listEmails, storageStatus, CONFIRMED_LABEL } = await import("../src/lib/inbox-server");
  const { addToWaitlist } = await import("../src/lib/waitlist-server");
  const db = live as unknown as { exec: (text: string) => Promise<unknown> };
  // `cascade` because the drafts and calendar_events rows carry foreign keys onto
  // `emails`: without it Postgres refuses (2BP01) and the app would still see a
  // working table.
  await db.exec("drop table emails cascade");
  const { sql: handle } = await import("../src/db");
  let engineWords = "";
  try {
    await handle()`select * from emails`;
  } catch (err) {
    engineWords = err instanceof Error ? err.message : String(err);
  }
  note("the engine's own words for the failing query", engineWords);
  check("the database really is refusing that query now (not simulated in the harness)", /emails/.test(engineWords) && /exist/i.test(engineWords), engineWords);

  const broken = await listEmails();
  check("the app's read reports the failure instead of throwing", broken.ok === false, broken);
  const failed = storageStatus();
  note("state", failed.state);
  note("label", failed.label);
  note("note", failed.note ?? "");
  check("the storage state is now 'failed', naming the half that failed", failed.state === "failed" && failed.failedDirection === "read", failed);
  check("…and the confirmed wording is gone", !failed.label.includes(CONFIRMED_LABEL), failed.label);
  check("…and the note is the app's own typed sentence, with no error code, stack or vendor in it", /couldn't read the inbox/i.test(failed.note ?? "") && !/relation|42P01|postgres/i.test(failed.note ?? ""), failed.note);

  const other = await addToWaitlist({ email: `e2e-after-failure+${stamp}@example.com` });
  const afterSuccess = storageStatus();
  check("a later query that succeeds does not restore the success wording (failures stay sticky)", other.status === "joined" && afterSuccess.state === "failed" && afterSuccess.label === failed.label, afterSuccess);

  if (live) await (live as unknown as { close: () => Promise<void> }).close();
  return failures;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  if (!pglitePresent()) pgliteMissing();

  const args = process.argv.slice(2);
  const readBackAt = args.indexOf("--read-back");
  const dataDirArg = args.indexOf("--data-dir");
  const dirArg = dataDirArg >= 0 ? args[dataDirArg + 1] : undefined;

  const dataDir = resolve(dirArg ?? join(tmpdir(), `doppel-e2e-pglite-${Date.now().toString(36)}`));
  const manifestPath = join(dataDir, "manifest.json");

  if (readBackAt >= 0) {
    const from = args[readBackAt + 1];
    if (!from) {
      console.log("usage: bun run scripts/e2e-persistence.ts --read-back <dataDir> <manifest>");
      process.exit(2);
    }
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.INBOUND_EMAIL_TOKEN = INBOUND_EMAIL_TOKEN;
    await openDatabase(from);
    installClient();
    await runReadBackPhase(from, args[readBackAt + 2] ?? join(from, "manifest.json"));
    process.exit(failures === 0 ? 0 : 1);
  }

  mkdirSync(dataDir, { recursive: true });
  console.log("Doppel — end-to-end persistence proof (real PostgreSQL semantics via PGlite)");
  console.log("Nothing here touches the owner's database: no network, no credentials, no live host.");
  console.log(`data directory: ${dataDir}`);

  await openDatabase(dataDir);
  const engine = (await live!.query("select version() as v", [])).rows[0];
  console.log(`engine        : ${String(engine.v)}`);
  console.log(`pglite        : ${PGLITE_HOME} (outside the repo — the repo gained no dependency)`);

  process.env.DATABASE_URL = DATABASE_URL;
  process.env.INBOUND_EMAIL_TOKEN = INBOUND_EMAIL_TOKEN;

  installClient();
  await runWritePhase(dataDir, manifestPath);

  /* --------- step 3/4: hand over to a fresh process on the same data directory --------- */
  const bunBin = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun?.which?.("bun") ?? process.execPath;
  const child = Bun.spawn({
    cmd: [bunBin, "run", new URL(import.meta.url).pathname, "--read-back", dataDir, manifestPath],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const childOut = await new Response(child.stdout).text();
  const childErr = await new Response(child.stderr).text();
  const childCode = await child.exited;

  console.log("\n--- output of the fresh process (verbatim) ---");
  console.log(childOut.trimEnd());
  if (childErr.trim()) console.log(childErr.trimEnd());
  console.log("--- end of fresh process output ---");
  check("the fresh process found everything the first process wrote and left with a clean verdict", childCode === 0, { exitCode: childCode });

  // Only now, with the rows read back by another process, make a query fail for real.
  await openDatabase(dataDir);
  await runFailurePhase();

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED.`);
    console.log(`The PGlite data directory is kept for inspection: ${dataDir}`);
    process.exit(1);
  }
  console.log("VERDICT: PASS — every step held against real PostgreSQL semantics.");
  console.log("Still unproven: the owner's host, DNS/TLS, credentials, permissions and server version.");
  rmSync(dataDir, { recursive: true, force: true });
}

await main();
