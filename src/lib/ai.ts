/**
 * The ONE module that talks to a language model.
 *
 * Everything AI-shaped in this app goes through here: importance ranking,
 * date/time extraction, and reply drafting. Two rules hold it together:
 *
 *  1. **One provider seam.** `getProvider()` reads `OPENAI_API_KEY`, then falls
 *     back to `ANTHROPIC_API_KEY`. No other module reads either variable.
 *  2. **A labelled deterministic fallback.** With no key connected (today), every
 *     function runs a keyword/regex/template heuristic and reports
 *     `mode: "heuristic"`. The UI prints that mode next to the output, so a rules
 *     result is never dressed up as a model result — and if a model call fails we
 *     fall back but say so in `note`.
 *
 * Times are interpreted in **UTC** everywhere in this build. One timezone, stated
 * in the UI, beats a silent guess about the owner's.
 */

import type { AiMode, AiStatus, DateCandidate, Importance } from "~/lib/inbox-types";
import { failureLogLine } from "~/lib/log-line";

export type EmailForAi = {
  fromLabel: string;
  fromEmail: string | null;
  subject: string;
  body: string;
  receivedAt: string;
  /**
   * Set only when the message is real but arrived with no readable text (an
   * attachment-only forward, say). The draft then says so instead of claiming
   * to have read words that never arrived.
   */
  bodyNote?: string;
};

export type AiOutcome<T> = {
  value: T;
  mode: AiMode;
  provider: string;
  label: string;
  note?: string;
};

const MAX_BODY_CHARS = 4000;
const MODEL_TIMEOUT_MS = 20_000;

type Provider = { name: "openai" | "anthropic"; model: string; key: string };

/** The single place a model credential is read. */
export function getProvider(): Provider | null {
  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) {
    return { name: "openai", model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini", key: openai };
  }
  const anthropic = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) {
    return {
      name: "anthropic",
      model: process.env.ANTHROPIC_MODEL?.trim() || "claude-3-5-haiku-latest",
      key: anthropic,
    };
  }
  return null;
}

const HEURISTIC_STATUS: AiStatus = {
  mode: "heuristic",
  provider: "heuristic",
  label: "Built-in rules — no model key connected yet",
  note: "Ranking, date extraction and drafting are running on deterministic keyword and regex rules. Connect OPENAI_API_KEY (or ANTHROPIC_API_KEY) in Settings → Secrets and the same pipeline starts using the model — no code change, no redeploy of the app logic.",
};

/**
 * The note shown when the model cannot be reached at all — logged when the call
 * fails (under `~/lib/log-line`, as a string, never the error object) and returned as
 * the fallback's `note`, so the log line and the visitor's copy can never drift apart.
 */
const NO_MODEL_RESPONSE_NOTE =
  "The model didn't answer in time, so this result comes from the built-in rules instead.";

/** What the UI strip shows: which producer is live right now. */
export function aiStatus(): AiStatus {
  const provider = getProvider();
  if (!provider) return HEURISTIC_STATUS;
  return {
    mode: "model",
    provider: `${provider.name}:${provider.model}`,
    label: `Language model — ${provider.name} ${provider.model}`,
  };
}

function modelStatus(provider: Provider): AiStatus {
  return {
    mode: "model",
    provider: `${provider.name}:${provider.model}`,
    label: `Language model — ${provider.name} ${provider.model}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Model transport                                                            */
/* -------------------------------------------------------------------------- */

async function callModel(system: string, user: string): Promise<string | null> {
  const provider = getProvider();
  if (!provider) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    if (provider.name === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${provider.key}`,
        },
        body: JSON.stringify({
          model: provider.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) {
        console.error(`[ai] openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return null;
      }
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content ?? null;
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": provider.key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 1500,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      console.error(`[ai] anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return json.content?.find((part) => part.type === "text")?.text ?? null;
  } catch (err) {
    console.error(failureLogLine(NO_MODEL_RESPONSE_NOTE, err, "model"));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(text: string): unknown | null {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * One wrapper for all three tasks: try the model, validate what comes back, and
 * fall back to the labelled heuristic if anything at all is off.
 */
async function withModel<T>(opts: {
  task: string;
  system: string;
  user: string;
  validate: (raw: unknown) => T | null;
  heuristic: () => T;
}): Promise<AiOutcome<T>> {
  const provider = getProvider();
  const fallback = (note?: string): AiOutcome<T> => ({
    value: opts.heuristic(),
    mode: "heuristic",
    provider: "heuristic",
    label: HEURISTIC_STATUS.label,
    note,
  });

  if (!provider) return fallback(HEURISTIC_STATUS.note);

  const text = await callModel(opts.system, opts.user);
  if (!text) {
    console.error(`[ai] ${opts.task}: no usable model response, using heuristic`);
    return fallback(NO_MODEL_RESPONSE_NOTE);
  }
  const parsed = parseJsonObject(text);
  const value = parsed === null ? null : opts.validate(parsed);
  if (value === null) {
    console.error(`[ai] ${opts.task}: model response failed validation, using heuristic`);
    return fallback(
      "The model's answer couldn't be read, so this result comes from the built-in rules instead.",
    );
  }
  return { value, ...modelStatus(provider) };
}

function promptFor(email: EmailForAi): string {
  return [
    `Received: ${email.receivedAt} (UTC)`,
    `From: ${email.fromLabel}`,
    `Subject: ${email.subject}`,
    "",
    "Message:",
    email.body.slice(0, MAX_BODY_CHARS),
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* 1. Importance ranking                                                       */
/* -------------------------------------------------------------------------- */

const TRIAGE_SYSTEM =
  "You triage a small business owner's inbox. Reply with JSON only, no prose, using exactly this " +
  'shape: {"score": <0-100 integer>, "reason": "<one short sentence, under 20 words>", ' +
  '"needsReply": <true|false>}. Score 80+ only for things that need the owner today (an angry or ' +
  "blocked client, a deadline today, money at risk). 50-79 is a real request from a real person. " +
  "20-49 is routine admin. Under 20 is bulk mail, newsletters and notifications. `needsReply` is " +
  "true only if a human is waiting on an answer.";

function validateImportance(raw: unknown): Importance | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const score = Number(obj.score);
  const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
  const needsReply = obj.needsReply;
  if (!Number.isFinite(score) || !reason || typeof needsReply !== "boolean") return null;
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reason: reason.slice(0, 220),
    needsReply,
  };
}

export function rankImportance(email: EmailForAi, dateCount = 0): Promise<AiOutcome<Importance>> {
  return withModel<Importance>({
    task: "rankImportance",
    system: TRIAGE_SYSTEM,
    user: promptFor(email),
    validate: validateImportance,
    heuristic: () => heuristicImportance(email, dateCount),
  });
}

/* -------------------------------------------------------------------------- */
/* 2. Date / time extraction                                                   */
/* -------------------------------------------------------------------------- */

const DATES_SYSTEM =
  "You find appointments and deadlines inside a business email. Reply with JSON only, using " +
  'exactly this shape: {"events": [{"label": "<the words from the email, verbatim and short>", ' +
  '"startsAt": "<YYYY-MM-DDTHH:mm:00Z or YYYY-MM-DD for an all-day date>", "hasTime": <true|false>}]}. ' +
  "Resolve relative words (today, tomorrow, next Tuesday) against the Received timestamp, which is " +
  "in UTC. Include at most 4 items. Include an item only if it names a real day the owner could " +
  "put in a calendar. Never invent a date. Return an empty list if there is none.";

function buildCandidate(
  id: string,
  label: string,
  startsAt: Date,
  hasTime: boolean,
): DateCandidate {
  const allDay = !hasTime;
  const startMs = allDay ? Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth(), startsAt.getUTCDate()) : startsAt.getTime();
  const reminderMs = allDay ? startMs + 9 * 60 * 60 * 1000 : startMs - 30 * 60 * 1000;
  return {
    id,
    label,
    startsAt: new Date(startMs).toISOString(),
    startsAtLabel: formatWhen(startMs, allDay),
    allDay,
    reminderAt: new Date(reminderMs).toISOString(),
    reminderLabel: allDay ? "9:00 AM on the day" : "30 minutes before",
    reminderMinutes: allDay ? null : 30,
  };
}

function validateDates(raw: unknown): DateCandidate[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const list = (raw as Record<string, unknown>).events;
  if (!Array.isArray(list)) return null;
  const out: DateCandidate[] = [];
  for (const item of list.slice(0, 4)) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const label = typeof obj.label === "string" ? obj.label.trim().slice(0, 80) : "";
    const startsAt = typeof obj.startsAt === "string" ? obj.startsAt : "";
    const hasTime = obj.hasTime === true || /T\d{2}:\d{2}/.test(startsAt);
    const when = new Date(startsAt);
    if (!label || Number.isNaN(when.getTime())) continue;
    out.push(buildCandidate(`d${out.length + 1}`, label, when, hasTime));
  }
  return out;
}

export function extractDates(email: EmailForAi): Promise<AiOutcome<DateCandidate[]>> {
  return withModel<DateCandidate[]>({
    task: "extractDates",
    system: DATES_SYSTEM,
    user: promptFor(email),
    validate: validateDates,
    heuristic: () => heuristicDates(email),
  });
}

/* -------------------------------------------------------------------------- */
/* 3. Reply drafting                                                           */
/* -------------------------------------------------------------------------- */

const DRAFT_SYSTEM =
  "You draft a reply that a small business owner will read, edit and send themselves. Write in " +
  "the first person as the owner, in plain British English, warm and brief (under 130 words). " +
  'Never invent facts, prices, dates or commitments the email did not supply. Reply with JSON ' +
  'only: {"draft": "<the email body, including a greeting and sign-off>"}. If the message needs ' +
  "no reply (a newsletter or a notification), say so plainly in one sentence instead of pretending " +
  "to answer it.";

function validateDraft(raw: unknown): { body: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = (raw as Record<string, unknown>).draft;
  if (typeof body !== "string" || body.trim().length < 10) return null;
  return { body: body.trim().slice(0, 4000) };
}

export function draftReply(
  email: EmailForAi,
  hints: { needsReply: boolean; dates: DateCandidate[] },
): Promise<AiOutcome<{ body: string }>> {
  return withModel<{ body: string }>({
    task: "draftReply",
    system: DRAFT_SYSTEM,
    user: `${promptFor(email)}\n\nTriage: needsReply=${hints.needsReply}; dates already found: ${
      hints.dates.map((d) => d.label).join("; ") || "none"
    }`,
    validate: validateDraft,
    heuristic: () => ({ body: heuristicDraft(email, hints) }),
  });
}

/* -------------------------------------------------------------------------- */
/* Heuristics — the deterministic path, clearly labelled as such in the UI     */
/* -------------------------------------------------------------------------- */

const URGENT = [
  /\burgent(?:ly)?\b/i,
  /\basap\b/i,
  /as soon as possible/i,
  /\bimmediately\b/i,
  /\bby (?:end of|close of) (?:business )?(?:day|today)\b/i,
  /\bdeadline\b/i,
  /\boverdue\b/i,
  /final notice/i,
  /time[- ]sensitive/i,
  /\bcancel(?:ling|lation)\b/i,
];
const MONEY = [
  /\binvoice\b/i,
  /\bpayment\b/i,
  /\bquote|quotation\b/i,
  /\bproposal\b/i,
  /\bbudget\b/i,
  /\bremittance\b/i,
  /\brefund\b/i,
  /\bprice|pricing\b/i,
];
const ASK = [
  /\?/,
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bplease\b/i,
  /\blet me know\b/i,
  /\bconfirm\b/i,
  /\bwould like\b/i,
  /\bneed(?:ed)?\b/i,
  /\brequest(?:ing)?\b/i,
  /\bhelp me\b/i,
];
const MEETING = [
  /\bschedul/i,
  /\bmeeting\b/i,
  /\bappointment\b/i,
  /\breschedul/i,
  /\bcall\b/i,
  /\bavailable\b/i,
  /\bsite visit\b/i,
  /\bvisit\b/i,
];
const BULK = [
  /unsubscribe/i,
  /view (?:this|it) in (?:your )?browser/i,
  /\bnewsletter\b/i,
  /\bwebinar\b/i,
  /\bpromotion/i,
  /\bdigest\b/i,
  /you(?:'| a)re receiving this/i,
  /\bno-?reply@/i,
  /\bnoreply@/i,
  /\bnotification@s?\b/i,
];
const LEAD = [/\benquir/i, /\bquote|quotation\b/i, /\bproposal\b/i, /\binterested in\b/i, /\bpricing\b/i];
const INVOICE = [/\binvoice\b/i, /\bremittance\b/i, /\bpayment run\b/i, /\bdue\b/i];

const hits = (patterns: RegExp[], text: string): RegExp[] => patterns.filter((re) => re.test(text));

/** Pure, testable, and the reason the pipeline works before a key is connected. */
export function heuristicImportance(email: EmailForAi, dateCount = 0): Importance {
  const text = `${email.subject}\n${email.body}`;
  const urgent = hits(URGENT, text);
  const money = hits(MONEY, text);
  const ask = hits(ASK, text);
  const meeting = hits(MEETING, text);
  const bulk = hits(BULK, text);

  if (bulk.length >= 1) {
    const score = Math.min(34, 12 + money.length * 4 + urgent.length * 6);
    return {
      score,
      reason:
        urgent.length > 0
          ? "Bulk mail that does use urgent language — no action likely needed."
          : "Bulk mail or a notification — nothing here to answer.",
      needsReply: false,
    };
  }

  let score = 35;
  const why: string[] = [];

  if (urgent.length > 0) {
    score += 32;
    why.push("uses urgent language");
  }
  if (money.length > 0) {
    score += 14;
    why.push("about money");
  }
  if (ask.length > 0) {
    score += 14;
    why.push("asks the owner something");
  }
  if (meeting.length > 0) {
    score += 8;
    why.push("about a time or a visit");
  }
  if (dateCount > 0) {
    score += 8;
    why.push("contains a date");
  }
  if (email.body.length > 0 && email.body.length < 320) {
    score += 5;
    why.push("a short, direct note");
  }
  if (/\bre:/i.test(email.subject)) {
    score += 4;
    why.push("part of an existing thread");
  }

  score = Math.max(0, Math.min(100, score));
  return {
    score,
    reason:
      why.length > 0
        ? `${why.slice(0, 3).join(", ").replace(/^./, (c) => c.toUpperCase())}.`
        : "Routine message with no obvious pressure.",
    needsReply: ask.length > 0 || meeting.length > 0 || urgent.length > 0,
  };
}

/* ---- date/time parsing ---------------------------------------------------- */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)";
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const WEEKDAY_RE = "sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat";

type Span = { start: number; end: number; date: Date; text: string };
type TimeSpan = { start: number; end: number; hours: number; minutes: number; text: string };

function utcDay(base: Date): number {
  return Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
}

function weekdayIndex(word: string): number | null {
  const w = word.toLowerCase();
  if (w in WEEKDAYS) return WEEKDAYS[w];
  const full = Object.keys(WEEKDAYS).find((day) => day.startsWith(w));
  return full ? WEEKDAYS[full] : null;
}

/** Find the days named in a message, resolved against `now`. */
export function findDaySpans(text: string, now: Date): Span[] {
  const spans: Span[] = [];
  const seen = new Set<number>();
  const add = (m: RegExpExecArray, date: Date, raw?: string) => {
    const key = utcDay(date);
    if (Number.isNaN(key) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) return;
    if (seen.has(key)) return;
    seen.add(key);
    const at = m.index ?? 0;
    spans.push({
      start: at,
      end: at + m[0].length,
      date,
      text: (raw ?? m[0]).replace(/\s+/g, " ").trim(),
    });
  };

  // 2026-09-24
  for (const m of text.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    const [, y, mo, d] = m;
    add(m, new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))));
  }
  // 24/09/2026 and 24-09-2026  (day first — the rest of this file is British)
  for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/g)) {
    const [, d, mo, y] = m;
    add(m, new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))));
  }
  // 24 September 2026 / 24th Sept
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?\\s*,?\\s*(20\\d{2})?`, "gi"))) {
    const [, d, mon, year] = m;
    add(m, new Date(Date.UTC(year ? Number(year) : now.getUTCFullYear(), MONTHS[mon.toLowerCase()] ?? 0, Number(d))));
  }
  // September 24, 2026 / Sept 24
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(20\\d{2})?`, "gi"))) {
    const [, mon, d, year] = m;
    add(m, new Date(Date.UTC(year ? Number(year) : now.getUTCFullYear(), MONTHS[mon.toLowerCase()] ?? 0, Number(d))));
  }
  // tomorrow / today / tonight
  for (const m of text.matchAll(/\b(tomorrow|today|tonight|this (?:morning|afternoon|evening))\b/gi)) {
    const word = m[1].toLowerCase();
    const offset = word.startsWith("tomorrow") ? 1 : 0;
    add(m, new Date(utcDay(now) + offset * 86_400_000));
  }
  // Friday / next Tuesday
  for (const m of text.matchAll(new RegExp(`\\b(?:(next|this|on)\\s+)?(${WEEKDAY_RE})\\b`, "gi"))) {
    const target = weekdayIndex(m[2]);
    if (target === null) continue;
    const today = new Date(utcDay(now));
    let ahead = (target - today.getUTCDay() + 7) % 7;
    if (ahead === 0) ahead = /^this$/i.test(m[1] ?? "") ? 0 : 7;
    if (/^next$/i.test(m[1] ?? "")) ahead = ahead === 0 ? 7 : ahead;
    add(m, new Date(today.getTime() + ahead * 86_400_000), `${m[1] ? m[1] + " " : ""}${m[2]}`);
  }

  return spans.sort((a, b) => a.start - b.start);
}

/** Find clock times in a message. */
export function findTimeSpans(text: string): TimeSpan[] {
  const spans: TimeSpan[] = [];
  const push = (m: RegExpExecArray, hours: number, minutes: number) => {
    if (hours > 23 || minutes > 59) return;
    const at = m.index ?? 0;
    spans.push({
      start: at,
      end: at + m[0].length,
      hours,
      minutes,
      text: m[0].replace(/\s+/g, " ").trim(),
    });
  };

  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi)) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const mer = (m[3] ?? "").toLowerCase();
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    push(m, h, min);
  }
  for (const m of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h > 12) continue; // already handled by the 24h pattern
    // Don't re-read "9:30pm" as "30pm": the match must not start mid-token.
    const before = (m.index ?? 0) > 0 ? text[(m.index ?? 0) - 1] : "";
    if (before === ":" || /\d/.test(before)) continue;
    if (/pm/i.test(m[3]) && h < 12) h += 12;
    if (/am/i.test(m[3]) && h === 12) h = 0;
    push(m, h, min);
  }
  for (const m of text.matchAll(/\b(noon|midday|midnight)\b/gi)) {
    push(m, /midnight/i.test(m[1]) ? 0 : 12, 0);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s*o'?clock\b/gi)) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) continue;
    push(m, h <= 7 ? h + 12 : h === 12 ? 12 : h, 0);
  }

  return spans.sort((a, b) => a.start - b.start);
}

export function heuristicDates(email: EmailForAi, now = new Date(email.receivedAt)): DateCandidate[] {
  const base = Number.isNaN(now.getTime()) ? new Date() : now;
  const days = findDaySpans(email.body, base).filter(
    (span) => span.date.getTime() >= utcDay(base) - 31 * 86_400_000,
  );
  const times = findTimeSpans(email.body);
  const usedTimes = new Set<number>();
  const out: DateCandidate[] = [];

  for (const day of days.slice(0, 5)) {
    // A time belongs to a day if it sits just after it ("Friday at 10:00") or
    // just before it ("10:00 on Friday").
    const after = times.find(
      (t) => !usedTimes.has(t.start) && t.start >= day.end && t.start - day.end <= 40,
    );
    const before = times.find(
      (t) => !usedTimes.has(t.start) && t.end <= day.start && day.start - t.end <= 12,
    );
    const time = after ?? before ?? null;
    if (time) usedTimes.add(time.start);

    const text = time
      ? `${day.text}, ${time.text}`.replace(/, ([^,]*)$/, " at $1")
      : day.text;
    const start = time
      ? new Date(utcDay(day.date) + (time.hours * 60 + time.minutes) * 60_000)
      : day.date;
    out.push(buildCandidate(`d${out.length + 1}`, text, start, Boolean(time)));
  }

  return dedupe(out);
}

function dedupe(items: DateCandidate[]): DateCandidate[] {
  const seen = new Set<string>();
  const out: DateCandidate[] = [];
  for (const item of items) {
    const key = `${item.startsAt}|${item.allDay}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, id: `d${out.length + 1}` });
  }
  return out;
}

export function heuristicDraft(
  email: EmailForAi,
  hints: { needsReply: boolean; dates: DateCandidate[] },
): string {
  const first = (email.fromName ?? "").split(/\s+/)[0];
  const greeting = first && !/^(info|admin|accounts|sales|support|no-?reply|noreply)$/i.test(first)
    ? `Hi ${first},`
    : "Hi there,";
  const text = `${email.subject}\n${email.body}`;
  const when = hints.dates[0];
  const whenLine = when
    ? when.allDay
      ? `I've put ${when.label} in the diary.`
      : `I've put ${when.label} in the diary — that works on my end.`
    : "";

  // A real message that arrived with no readable text: say so, and draft no
  // reply — pretending to have read the sender's words would be the one thing
  // this draft must never do.
  if (email.bodyNote) {
    return [
      greeting,
      "",
      `This message arrived with no readable text — it may have carried only attachments, or the format didn't survive the forward.`,
      "",
      "Doppel hasn't drafted a reply, because there's nothing here to answer yet. Ask the sender to resend it, or read the original at the source.",
    ].join("\n");
  }

  if (hits(BULK, text).length >= 1 && !hints.needsReply) {
    return [
      "No reply needed — this looks like bulk mail or a notification, so there's nothing here to answer.",
      "",
      "(Doppel drafted nothing because nobody is waiting on a response.)",
    ].join("\n");
  }

  const lines: string[] = [greeting, ""];

  if (hits(INVOICE, text).length > 0 && hits(MONEY, text).length > 0) {
    lines.push(`Thanks for this — I've picked up the document you sent through.`);
    lines.push(`I'll check it against our records and let you know if anything doesn't line up.`);
  } else if (hits(LEAD, text).length > 0) {
    lines.push(`Thanks for getting in touch about "${email.subject}".`);
    lines.push(`Yes, this is the sort of thing we take on — I'll come back to you with options and a price.`);
  } else if (hits(MEETING, text).length > 0) {
    lines.push(`Thanks for the note about "${email.subject}".`);
    lines.push(`Happy to sort this out — let me confirm the time works and I'll come back to you today.`);
  } else {
    lines.push(`Thanks for your email about "${email.subject}".`);
    lines.push(`I've read it and I'll come back to you properly shortly.`);
  }

  if (whenLine) {
    lines.push("");
    lines.push(whenLine);
  }

  lines.push("");
  lines.push("[Add the detail only you know — Doppel drafted the shape of this reply, not the facts.]");
  lines.push("");
  lines.push("Best,");
  lines.push("[Your name]");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Display helpers (shared with the UI so labels match the stored data)        */
/* -------------------------------------------------------------------------- */

export function formatWhen(iso: string | number, allDay: boolean): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(ms)) return "Unknown time";
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
  if (allDay) return `${date} (all day)`;
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(d);
  return `${date}, ${time}`;
}
