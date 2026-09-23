/**
 * Live database check — does the real Postgres behind `DATABASE_URL` actually keep
 * what the app writes?
 *
 * Writes through the app's own code paths (`ingestEmail`, `addToWaitlist`), then
 * reads the rows straight back out of the database and prints the outcome verbatim.
 * Run it twice to prove the data is in the database rather than in one process's
 * memory:
 *
 *   bun run scripts/db-live-check.ts                  # write the marker rows
 *   bun run scripts/db-live-check.ts --read <marker>  # a NEW process reads them back
 *
 * `--read` takes the marker printed by the write run (the `dbcheck+…@example.com`
 * address) and looks that signup up again, so a PASS on the second run can only
 * mean the row survived the process that wrote it.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.log("DATABASE_URL is not set on this machine — nothing to check.");
  process.exit(0);
}

const { databaseTransport, sql } = await import("~/db");
const { storageStatus } = await import("~/lib/inbox-server");

const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "(unparseable)";
  }
})();
const transport = databaseTransport(url);
const storage = storageStatus();
console.log(`host      : ${host}`);
console.log(`transport : ${transport}`);
console.log(`/app says : ${storage.label}`);
// The line above is evidence-based: in a fresh process no query has run yet, so it
// reports `unverified` however healthy the database may be. It is re-read at the end.
console.log(`   state  : ${storage.state} (no query has run in this process yet)`);

if (transport === "unavailable") {
  console.log("\nRESULT: FAIL — this deployment has no driver for that host, so nothing was written.");
  process.exit(1);
}

type Row = Record<string, unknown>;

/** The driver's own words, without a stack: this harness prints outcomes verbatim. */
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Read a marker signup back. Returns null when the read itself failed. */
async function readSignup(marker: string): Promise<Row[] | null> {
  try {
    return (await sql()`select email, name, created_at from waitlist where email = ${marker}`) as Row[];
  } catch (err) {
    console.log(`read failed : ${errorText(err)}`);
    return null;
  }
}

const readAt = process.argv.indexOf("--read");
if (readAt >= 0) {
  const marker = process.argv[readAt + 1];
  if (!marker) {
    console.log("Usage: bun run scripts/db-live-check.ts --read <dbcheck+…@example.com>");
    process.exit(2);
  }
  console.log(`\nlooked up   : ${marker}`);
  const rows = await readSignup(marker);
  if (rows === null) {
    console.log("\nRESULT: FAIL — a fresh process could not read that signup back.");
    process.exit(1);
  }
  console.log(`rows found  : ${rows.length}`);
  for (const row of rows) {
    console.log(`  email=${String(row.email)} name=${String(row.name)} created_at=${String(row.created_at)}`);
  }
  const ok = rows.length === 1;
  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"} — a fresh process ${ok ? "found" : "did not find"} that signup in the database.`);
  process.exit(ok ? 0 : 1);
}

/* ------------------------------- write mode ------------------------------- */
const stamp = Date.now().toString(36);
const subject = `db-live-check ${stamp}`;
const waitEmail = `dbcheck+${stamp}@example.com`;

const { ingestEmail } = await import("~/lib/ingest");
const ingested = await ingestEmail({
  source: "api",
  from: `Live Check <${waitEmail}>`,
  subject,
  text: "This message exists only to prove that the database keeps what the app writes.",
});

console.log("\n1. ingestEmail — the app's own write path");
console.log(`   ok      : ${ingested.ok}`);
console.log(`   id      : ${ingested.ok ? ingested.email.id : "-"}`);
console.log(`   storage : ${ingested.storage.label} [${ingested.storage.state}]`);
if (!ingested.ok) console.log(`   message : ${ingested.message}`);

const { addToWaitlist } = await import("~/lib/waitlist-server");
const joined = await addToWaitlist({ email: waitEmail, name: "Live check" });
console.log("\n2. addToWaitlist — a real signup");
console.log(`   status  : ${joined.status}`);
if ("message" in joined) console.log(`   message : ${joined.message}`);

console.log("\n3. read straight back from the database");
let emails: Row[] = [];
let signups: Row[] = [];
let readFailure: string | null = null;
try {
  emails = (await sql()`select id, subject, importance_score from emails where subject = ${subject}`) as Row[];
  signups = (await sql()`select id, email, name from waitlist where email = ${waitEmail}`) as Row[];
  console.log(`   emails   : ${emails.length} row(s) ${JSON.stringify(emails.map((r) => ({ id: String(r.id), subject: String(r.subject), score: String(r.importance_score) })))}`);
  console.log(`   waitlist : ${signups.length} row(s) ${JSON.stringify(signups.map((r) => ({ email: String(r.email), name: String(r.name) })))}`);
} catch (err) {
  // These raw reads deliberately bypass the app's typed paths, so the driver's own
  // words are printed — then the run carries on to the storage line and the verdict
  // below instead of dying on a stack trace.
  readFailure = errorText(err);
  console.log(`   read failed: ${readFailure}`);
}

const ok =
  readFailure === null && ingested.ok && emails.length === 1 && signups.length === 1 && joined.status === "joined";

// What the storage card on /app would show now, after those real attempts: the whole
// point of this check is that it may not say "saved" unless a query came back.
const afterWrites = storageStatus();
console.log("\n4. what the /app storage card would say now");
console.log(`   state   : ${afterWrites.state}`);
console.log(`   label   : ${afterWrites.label}`);
if (afterWrites.note) console.log(`   note    : ${afterWrites.note}`);

console.log(`\nmarker: ${waitEmail}`);
console.log(`RESULT: ${ok ? "PASS" : "FAIL"} — the app's writes ${ok ? "are" : "are NOT"} in the database.`);
console.log(`Next: bun run scripts/db-live-check.ts --read ${waitEmail}`);
process.exit(ok ? 0 : 1);
