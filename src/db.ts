import { neon } from "@neondatabase/serverless";

/**
 * Server-only handle to the team's database.
 *
 * The connection string comes from `DATABASE_URL`, which the owner connects via
 * the database card and which is injected into the sandbox and passed to the live
 * host on publish. It is resolved lazily (per call, not at module load) so the
 * site still builds and serves before a database is connected, and so setting the
 * variable switches the app over without a rebuild.
 *
 * ## Two transports, chosen by host
 *
 * `@neondatabase/serverless`'s `neon()` does **not** open a Postgres connection:
 * it derives an HTTPS endpoint (`https://api.<host>/sql`) and POSTs the SQL to
 * Neon's own query API, passing the connection string in a header. That works
 * only where Neon's `/sql` route answers — a plain Postgres server (Tiger Cloud,
 * RDS, a local server) has no such route, so `neon()` can never reach one.
 *
 * So: Neon hosts keep the HTTP driver; every other host is reached over the real
 * Postgres wire protocol with Bun's built-in client (`Bun.SQL`, no extra
 * dependency, and the runtime this site is served on: `bun run serve.ts`). If
 * neither transport exists for the given host we throw a typed error rather than
 * firing a request at an endpoint that cannot exist.
 *
 * The client is a per-process singleton, memoised by connection string: `sql()`
 * is still resolved lazily per call, but repeated calls with the same address
 * reuse one small pool instead of opening a brand-new one per request. The
 * first version built a fresh client on every call and never closed it — every
 * request leaked its connections and the database ran out of connection slots
 * (`FATAL: remaining connection slots are reserved …`).
 *
 * Use it only inside a `createServerFn()` handler or an `src/routes/api/*` route
 * (never client code):
 *
 *   const getPosts = createServerFn().handler(async () => {
 *     const rows = await sql()`select id, title, created_at from posts`;
 *     // Coerce non-primitive columns (timestamps are JS Dates) to strings before
 *     // returning to the client, or React will refuse to render them:
 *     return rows.map((r) => ({ ...r, created_at: String(r.created_at) }));
 *   });
 */

/** Which wire we use to reach the database behind `DATABASE_URL`. */
export type DatabaseTransport = "neon-http" | "bun-tcp" | "unavailable";

const NO_TRANSPORT_MESSAGE =
  "This deployment has no driver for that database address (it is neither a Neon host nor reachable with the server's built-in Postgres client), so nothing was saved.";

/**
 * Pick the transport for a connection string. Pure on purpose: exported so the
 * self-tests can cover the choice without a live database.
 */
export function databaseTransport(url: string): DatabaseTransport {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "unavailable";
  }
  if (!host) return "unavailable";
  if (host.endsWith(".neon.tech") || host.endsWith(".neon.build") || host === "neon.tech") {
    return "neon-http";
  }
  const bun = (globalThis as { Bun?: { SQL?: unknown } }).Bun;
  return typeof bun?.SQL === "function" ? "bun-tcp" : "unavailable";
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — connect a database (via the database card) before running queries."
    );
  }
  return url;
}

/** The connection string's host with any password stripped — safe to show or log. */
export function databaseHostSafe(url: string): string {
  try {
    return new URL(url).host || "(unparseable address)";
  } catch {
    return "(unparseable address)";
  }
}

/** One client per connection string, for the life of the process. */
const clientCache = new Map<string, ReturnType<typeof neon>>();

/**
 * Small, explicit pool limits for the Bun TCP client. Every value in seconds:
 * - `prepare: false` = unnamed statements. Deliberately off: named prepared
 *   statements are rejected by transaction-mode poolers (a shape managed
 *   Postgres commonly hands out), and this is the configuration the dry run
 *   exercised end-to-end against a real Postgres over TCP.
 * - `max: 3` — this app serves one owner; three concurrent queries is generous.
 * - `idleTimeout: 20` — an unused backend is gone after 20s, it does not sit on
 *   the server's connection slots.
 * - `connectionTimeout: 15` — a wedged connect fails fast instead of hanging a
 *   request.
 */
const BUN_TCP_POOL_OPTIONS = {
  prepare: false,
  max: 3,
  idleTimeout: 20,
  connectionTimeout: 15,
} as const;

export const sql = (): ReturnType<typeof neon> => {
  const url = databaseUrl();
  const cached = clientCache.get(url);
  if (cached) return cached;
  let client: ReturnType<typeof neon>;
  switch (databaseTransport(url)) {
    case "neon-http":
      // The Neon driver opens no socket at all (it POSTs over HTTPS), so the
      // pool limits above do not apply — memoising it is pure CPU saving.
      client = neon(url);
      break;
    case "bun-tcp": {
      const bun = (globalThis as {
        Bun: { SQL: new (connectionString: string, options?: { prepare?: boolean }) => unknown };
      }).Bun;
      client = new bun.SQL(url, BUN_TCP_POOL_OPTIONS) as unknown as ReturnType<typeof neon>;
      break;
    }
    default:
      throw new Error(NO_TRANSPORT_MESSAGE);
  }
  clientCache.set(url, client);
  return client;
};
