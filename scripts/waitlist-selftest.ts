/**
 * Exercises the waitlist logic without a live database.
 *
 *   bun run scripts/waitlist-selftest.ts
 *
 * Covers the branches the HTTP form can't reach while `DATABASE_URL` is
 * unconnected: a first-time insert ("joined"), a duplicate email ("already"),
 * a database failure, and email normalisation. The fake executor records the
 * SQL it is handed so the test also proves the table is created on first write
 * and the dedupe rides on a unique constraint.
 */
import { addToWaitlist, type QueryExecutor } from "../src/lib/waitlist-server";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`, detail === undefined ? "" : detail);
  }
}

type Call = { sql: string; values: unknown[] };

function fakeDb(insertReturns: Record<string, unknown>[], opts: { throwOn?: "create" | "insert" } = {}) {
  const calls: Call[] = [];
  const exec: QueryExecutor = async (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ sql: text, values });
    const isCreate = text.toLowerCase().startsWith("create table");
    if (opts.throwOn === "create" && isCreate) throw new Error("connection refused");
    if (opts.throwOn === "insert" && !isCreate) throw new Error("connection refused");
    return isCreate ? [] : insertReturns;
  };
  return { exec, calls };
}

async function main() {
  console.log("\n1. No DATABASE_URL, no executor — graceful 'unavailable', never a throw");
  delete process.env.DATABASE_URL;
  const noDb = await addToWaitlist({ email: "sam@example.com" });
  check("status is unavailable", noDb.status === "unavailable", noDb);
  check(
    "message is human copy, not a stack trace",
    noDb.status === "unavailable" &&
      /switched on yet/i.test(noDb.message) &&
      !/DATABASE_URL/.test(noDb.message),
    noDb,
  );

  console.log("\n2. Validation before any database work");
  const bad = await addToWaitlist({ email: "  not-an-email  " });
  check("invalid shape → invalid", bad.status === "invalid", bad);
  const empty = await addToWaitlist({ email: "   " });
  check("blank email → invalid", empty.status === "invalid", empty);
  const noDbInvalid = await addToWaitlist({ email: "" });
  check("invalid wins over the missing database", noDbInvalid.status === "invalid", noDbInvalid);

  console.log("\n3. First insert — table created on first write, row stored");
  const first = fakeDb([{ id: 1 }]);
  const joined = await addToWaitlist(
    { email: "  Sam@Example.COM ", name: " Sam ", businessType: "Trades / home services" },
    first.exec,
  );
  check("status is joined", joined.status === "joined", joined);
  check("two statements ran (create, then insert)", first.calls.length === 2, first.calls.length);
  check(
    "create table if not exists waitlist with a unique email",
    /^create table if not exists waitlist \(/.test(first.calls[0].sql) &&
      /email text not null unique/.test(first.calls[0].sql) &&
      /created_at timestamptz not null default now\(\)/.test(first.calls[0].sql),
    first.calls[0].sql,
  );
  check(
    "insert dedupes on the unique email",
    /on conflict \(email\) do nothing/.test(first.calls[1].sql) &&
      /returning id/.test(first.calls[1].sql),
    first.calls[1].sql,
  );
  check(
    "values are trimmed and lower-cased, optional fields included",
    first.calls[1].values[0] === "sam@example.com" &&
      first.calls[1].values[1] === "Sam" &&
      first.calls[1].values[2] === "Trades / home services",
    first.calls[1].values,
  );

  console.log("\n4. Duplicate email — distinct 'already' state, not an error");
  const dup = fakeDb([]);
  const already = await addToWaitlist({ email: "sam@example.com" }, dup.exec);
  check("status is already", already.status === "already", already);

  console.log("\n5. Optional fields may be omitted");
  const bare = fakeDb([{ id: 2 }]);
  const bareResult = await addToWaitlist({ email: "jo@example.com" }, bare.exec);
  check("status is joined", bareResult.status === "joined", bareResult);
  check(
    "nulls are bound for name and business type",
    bare.calls[1].values[1] === null && bare.calls[1].values[2] === null,
    bare.calls[1].values,
  );

  console.log("\n6. Database errors are contained");
  const createFails = fakeDb([{ id: 3 }], { throwOn: "create" });
  const failedCreate = await addToWaitlist({ email: "a@example.com" }, createFails.exec);
  check("create failure → error", failedCreate.status === "error", failedCreate);
  const insertFails = fakeDb([], { throwOn: "insert" });
  const failedInsert = await addToWaitlist({ email: "b@example.com" }, insertFails.exec);
  check("insert failure → error", failedInsert.status === "error", failedInsert);
  check(
    "error message mentions nothing was recorded",
    failedInsert.status === "error" && /nothing was recorded/i.test(failedInsert.message),
    failedInsert,
  );

  console.log(
    failures === 0 ? "\nAll waitlist checks passed.\n" : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
