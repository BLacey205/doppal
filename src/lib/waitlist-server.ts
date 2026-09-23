/**
 * Server-only waitlist storage. Imported only from a `createServerFn()` handler
 * (dynamically, so it never reaches the client bundle) or from a server-only test
 * script — never from a component.
 *
 * Design notes:
 * - `DATABASE_URL` may not be connected yet. Every failure mode returns a typed
 *   result with human-readable copy instead of throwing, so a form submission can
 *   never surface as an unhandled 500.
 * - The table is created on first write, so there is no migration step to run.
 * - `addToWaitlist` takes an optional query executor so the logic can be exercised
 *   without a live database (see scripts/waitlist-selftest.ts).
 */
import { sql } from "~/db";
import { noteStorageQueryFailed, noteStorageQuerySucceeded } from "~/lib/storage-evidence";
import { failureLogLine } from "~/lib/log-line";

export type WaitlistInput = {
  email?: string | null;
  name?: string | null;
  businessType?: string | null;
};

export type WaitlistResult =
  /** Row written (or would have been). */
  | { status: "joined" }
  /** This email is already on the list — a distinct state, not an error. */
  | { status: "already" }
  /** The visitor's input needs fixing; show `message` next to the field. */
  | { status: "invalid"; message: string }
  /** No database connected on this deployment. Nothing was saved. */
  | { status: "unavailable"; message: string }
  /** The write itself failed. Nothing was saved. */
  | { status: "error"; message: string };

/** Rows come back from Neon as plain objects; timestamps are JS Dates. */
type Row = Record<string, unknown>;

export type QueryExecutor = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Row[]>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Kept deliberately calm: no "error code", no stack trace, no blame. */
const MISSING_DB_MESSAGE =
  "Signups aren't switched on yet on this deployment, and your email wasn't saved. Please try again a little later.";

const FAILED_MESSAGE =
  "We couldn't save that just now. Nothing was recorded — please try again in a minute.";

const clean = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export async function addToWaitlist(
  input: WaitlistInput,
  exec?: QueryExecutor,
): Promise<WaitlistResult> {
  const email = (clean(input?.email) ?? "").toLowerCase();
  const name = clean(input?.name);
  const businessType = clean(input?.businessType);

  if (!email) {
    return { status: "invalid", message: "Please add your email address so we can reach you." };
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return {
      status: "invalid",
      message: "That doesn't look like an email address — worth a second look?",
    };
  }
  if (name && name.length > 120) {
    return { status: "invalid", message: "That name is a little long — 120 characters is plenty." };
  }
  if (businessType && businessType.length > 120) {
    return { status: "invalid", message: "Please keep the business type under 120 characters." };
  }

  let query = exec;
  if (!query) {
    if (!process.env.DATABASE_URL) {
      return { status: "unavailable", message: MISSING_DB_MESSAGE };
    }
    try {
      query = sql() as unknown as QueryExecutor;
    } catch (err) {
      console.error(failureLogLine(MISSING_DB_MESSAGE, err, "connection"));
      // A connection string we cannot build a client for saves nothing: say so through
      // the shared storage evidence rather than only in this one form's answer.
      noteStorageQueryFailed("write", FAILED_MESSAGE);
      return { status: "unavailable", message: MISSING_DB_MESSAGE };
    }
  }
  const ready = query;

  /**
   * Every query through here is evidence for the storage line on /app: this form and
   * the inbox write to the same database, so one failed write must stop both from
   * claiming that saving works.
   */
  const db: QueryExecutor = async (strings, ...values) => {
    try {
      const rows = await ready(strings, ...values);
      noteStorageQuerySucceeded();
      return rows;
    } catch (err) {
      noteStorageQueryFailed("write", FAILED_MESSAGE);
      throw err;
    }
  };

  try {
    await db`
      create table if not exists waitlist (
        id bigserial primary key,
        email text not null unique,
        name text,
        business_type text,
        created_at timestamptz not null default now()
      )
    `;

    // `on conflict do nothing` + `returning` gives us dedupe and the
    // "already on the list" signal in a single round trip: an empty result means
    // this email was already stored.
    const inserted = await db`
      insert into waitlist (email, name, business_type)
      values (${email}, ${name}, ${businessType})
      on conflict (email) do nothing
      returning id
    `;

    return inserted.length > 0 ? { status: "joined" } : { status: "already" };
  } catch (err) {
    console.error(failureLogLine(FAILED_MESSAGE, err, "query engine"));
    return { status: "error", message: FAILED_MESSAGE };
  }
}
