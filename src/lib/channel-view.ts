/**
 * The display half of the Connections card: pure functions turning the server's
 * `ChannelStatus` into the exact words, chips and tones `/app` shows.
 *
 * Why it is separate from the component: the honesty rules are the part that
 * matters, and pure functions are testable in the app self-test without a browser.
 * The rules, all asserted there:
 *
 *   - only `proven` may show the "Connected" chip — every other state says in words
 *     that mail is not flowing, through `honesty`, which is present in every state
 *     except `proven`;
 *   - the not-configured state names the missing env vars by name;
 *   - a failure says so and stays on the card until a later event supersedes it;
 *   - the owner's steps appear exactly as the adapter declared them, in order.
 *
 * No server-only import here: this runs in the browser on a payload the server
 * function already produced, and it must never see an env value.
 */
import type { ChannelCheckRecord } from "~/lib/channel-evidence";
import type { ChannelStatus } from "~/lib/channels";

export type ChannelTone = "emerald" | "amber" | "rose" | "slate";

/** The chip and card tone per state. `proven` is the only emerald. */
const STATE_PRESENTATION: Record<
  ChannelStatus["state"],
  { chip: string; tone: ChannelTone }
> = {
  not_configured: { chip: "Not connected", tone: "slate" },
  configured_unproven: { chip: "Configured, not proven", tone: "amber" },
  proven: { chip: "Connected", tone: "emerald" },
  failed: { chip: "Failed", tone: "rose" },
};

export type CheckFactView = {
  label: string;
  status: number;
  expected: boolean;
  /** The handler's own message sentence, verbatim. */
  detail: string;
  /** Any typed flags worth showing, as "flag: value" strings. */
  flags: string[];
};

export type ChannelCheckView = {
  kind: ChannelCheckRecord["kind"];
  ranAtLabel: string;
  /** For kind "ok": what the check established — and what it did not. */
  summary?: string;
  /** For kind "failed": why. */
  reason?: string;
  /** For kind "error": the plain sentence saying it could not run. */
  message?: string;
  facts: CheckFactView[];
};

export type ChannelView = {
  id: string;
  label: string;
  purpose: string;
  state: ChannelStatus["state"];
  chip: string;
  tone: ChannelTone;
  /** The channel's own sentence for its state, shown unchanged. */
  message: string;
  /** Present in every state except `proven`. */
  honesty: string | null;
  /** The proof line, only when proven. */
  provenLine: string | null;
  /** The failure line, only when failed. */
  failureLine: string | null;
  envVars: { name: string; role: string }[];
  missingEnvVars: string[];
  needsLine: string | null;
  ownerSteps: string[];
  standingLine: string;
  webhookUrl: string | null;
  canCheck: boolean;
  lastCheck: ChannelCheckView | null;
};

const FLAG_KEYS = ["error", "connected", "duplicate", "ignored", "stored", "provider"] as const;

function factView(label: string, status: number, body: Record<string, unknown>, expected: boolean): CheckFactView {
  const flags: string[] = [];
  for (const key of FLAG_KEYS) {
    if (body[key] !== undefined) flags.push(`${key}: ${String(body[key])}`);
  }
  return {
    label,
    status,
    expected,
    detail: typeof body.message === "string" ? body.message : "",
    flags,
  };
}

export function checkView(record: ChannelCheckRecord | null): ChannelCheckView | null {
  if (!record) return null;
  const facts =
    record.kind === "error"
      ? []
      : record.facts.map((fact) => factView(fact.label, fact.status, fact.body, fact.expected));
  switch (record.kind) {
    case "ok":
      return { kind: record.kind, ranAtLabel: record.ranAtLabel, summary: record.summary, facts };
    case "failed":
      return { kind: record.kind, ranAtLabel: record.ranAtLabel, reason: record.reason, facts };
    case "error":
      return { kind: record.kind, ranAtLabel: record.ranAtLabel, message: record.message, facts: [] };
  }
}

export function channelView(status: ChannelStatus): ChannelView {
  const { chip, tone } = STATE_PRESENTATION[status.state];
  const missing = status.missingEnvVars;
  const needsLine =
    status.state === "not_configured" && missing.length > 0
      ? `Missing: ${missing.join(" and ")}.`
      : null;
  return {
    id: status.id,
    label: status.label,
    purpose: status.purpose,
    state: status.state,
    chip,
    tone,
    message: status.message,
    honesty: status.honesty,
    provenLine:
      status.state === "proven" && status.provenAt && status.provenWhere
        ? `Proven: a real forwarded message was fetched and stored at ${utcLabelOf(status.provenAt)} into ${status.provenWhere}.`
        : null,
    failureLine:
      status.state === "failed" && status.failure
        ? `${status.failure.message} (failed at ${utcLabelOf(status.failure.at)})`
        : null,
    envVars: status.envVars.map((envVar) => ({ name: envVar.name, role: envVar.role })),
    missingEnvVars: missing,
    needsLine,
    ownerSteps: [...status.ownerSteps],
    standingLine: status.standingLine,
    webhookUrl: status.webhookUrl,
    canCheck: status.canCheck,
    lastCheck: checkView(status.lastCheck),
  };
}

/** `2026-09-24 at 14:03 UTC` — ISO timestamps are formatted, never raw. */
export function utcLabelOf(iso: string): string {
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}
