/**
 * The one place that turns a thrown value into text that is safe to put in the
 * server log. Every failure path in the app logs through here — never an `Error`.
 *
 * Why this exists (measured, not theorised): on this runtime `console.error("prefix:",
 * err)` does not print just `err.message`. Formatting an error **object** prints a
 * **code frame** — the source line the error was thrown from. When that line belongs
 * to a bundled/minified dependency (a database driver inside `node_modules`, a Vite
 * bundle) it is the whole module on a single line: 1–6 KB per log line. It then adds
 * every own property — error code, the failing statement and its parameters — and the
 * stack. Assigning `err.stack` does not suppress any of it. So: log a **string**.
 *
 * The string is the app's own typed, already-reviewed user-facing sentence (never the
 * driver's words) followed by a short, sanitized version of the engine's message. The
 * message is capped and collapsed to one line, its first line of *prose* is preferred
 * (a driver can embed a code frame in the message itself), and addresses, SQLSTATE-style
 * codes and product/driver names are withheld.
 *
 * Nothing here reads `err.code`, `err.query`, `err.stack` or any other property, and
 * nothing here changes control flow: it returns a string and nothing else, so a caller
 * still throws, rethrows or returns exactly what it did before. Pure string work — safe
 * to import from server or client code.
 */

/** The longest engine message worth putting on a log line. */
const ENGINE_WORDS_MAX = 120;
/** An address or URL a driver may paste into its own message. */
const ADDRESSISH = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** A SQLSTATE-style code, or the all-caps token a driver puts beside one. */
const CODEISH = /\b[0-9A-Z]{5}\b/g;
/** Product and driver names that can turn up inside a driver's own message. */
const VENDORISH = /\b(neon|pglite|postgres(?:ql)?|supabase|tiger(?:data)?|resend|knock|vercel|bun)\b/gi;
/** What stands in for anything a log line must not carry. */
const WITHHELD = "[withheld]";

/**
 * The engine's own words for a failure, reduced to one short, safe line.
 *
 * A driver's message is not safe to print as it stands. It can arrive carrying the
 * source line that threw — and when that code is bundled and minified, one line of
 * "message" is several kilobytes of module source. Its error *object* carries more
 * still: the stack, an error code, the failing statement and its parameters. So only
 * the first line of prose is kept (a code frame is skipped), length-capped, with
 * addresses, codes and product names withheld.
 */
export function safeWords(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // A code-frame line is source, not an explanation; prefer prose when there is any.
  const prose = lines.find((line) => !/[{};]=>|import\s*\{|\bexport\b/.test(line)) ?? lines[0] ?? "";
  const one = prose
    .replace(/\s+/g, " ")
    .replace(ADDRESSISH, WITHHELD)
    .replace(CODEISH, WITHHELD)
    .replace(VENDORISH, WITHHELD)
    .trim();
  if (!one) return "no message came back with it";
  return one.length > ENGINE_WORDS_MAX ? `${one.slice(0, ENGINE_WORDS_MAX - 1)}…` : one;
}

/**
 * The line a failure path logs: the app's own typed sentence for that path — the same
 * words the visitor is shown, or the note that explains the fallback — followed by the
 * engine's message in short, under a short label for where it came from (`query engine`
 * for a database, the default `engine` otherwise).
 *
 * It returns a **string, never an `Error`**. See the module note above for why printing
 * an error object at all is the defect this function exists to prevent.
 */
export function failureLogLine(sentence: string, err: unknown, label = "engine"): string {
  return `${sentence} (${label}: ${safeWords(err)})`;
}
