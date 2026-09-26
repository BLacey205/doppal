/**
 * The display half of the Model connection card: pure functions turning the
 * server's `ModelCredentialCard` into the exact words, chips and tones /app
 * shows, plus the fixed privacy and cost copy.
 *
 * Why it is separate from the component (same reason as `~/lib/channel-view`):
 * the honesty rules are the part that matters, and pure functions are testable
 * in the app self-test without a browser. The rules, all asserted there:
 *
 *   - only the `connected` state shows the "Connected" chip — and "connected"
 *     only ever means a real validation call succeeded;
 *   - every other state carries an `honesty` line saying the pipeline is NOT
 *     using a model key right now;
 *   - a failure says why and stays until a later event supersedes it;
 *   - the view model physically carries no key — only a mask and timestamps.
 *
 * No server-only import here: this runs in the browser on a payload the server
 * function already produced, and it must never see a key value.
 */
import type { ModelCredentialCard } from "~/lib/model-credentials";

export type CredentialTone = "emerald" | "amber" | "rose" | "slate";

const STATE_PRESENTATION: Record<
  ModelCredentialCard["state"],
  { chip: string; tone: CredentialTone }
> = {
  not_connected: { chip: "Not connected", tone: "slate" },
  saved_unconfirmed: { chip: "Saved, not confirmed", tone: "amber" },
  connected: { chip: "Connected", tone: "emerald" },
  failed: { chip: "Failed", tone: "rose" },
};

export type ModelCredentialView = {
  state: ModelCredentialCard["state"];
  chip: string;
  tone: CredentialTone;
  providerId: "openai" | "anthropic" | null;
  providerLabel: string | null;
  model: string | null;
  engineTag: string | null;
  mask: string | null;
  savedAtLabel: string | null;
  validatedAtLabel: string | null;
  message: string;
  honesty: string | null;
  failureLine: string | null;
  scopeNote: string;
};

export function modelCredentialView(card: ModelCredentialCard): ModelCredentialView {
  const { chip, tone } = STATE_PRESENTATION[card.state];
  return {
    state: card.state,
    chip,
    tone,
    providerId: card.providerId,
    providerLabel: card.providerLabel,
    model: card.model,
    engineTag: card.engineTag,
    mask: card.mask,
    savedAtLabel: card.savedAtLabel,
    validatedAtLabel: card.validatedAtLabel,
    message: card.message,
    honesty: card.honesty,
    failureLine:
      card.failure && card.state !== "failed"
        ? `${card.failure.message} (at ${card.failure.atLabel})`
        : card.state === "failed" && card.failure
          ? `Last refusal at ${card.failure.atLabel}.`
          : null,
    scopeNote: card.scopeNote,
  };
}

/** The privacy / usage copy, in plain words — rendered verbatim on the card. */
export const PRIVACY_LEAD =
  "What this is: your own API key, your own account. Doppel uses it to run ranking, date-finding and drafting for your mail.";

export const PRIVACY_LINES: readonly string[] = [
  "What leaves our servers: the text of the messages we process goes to the provider you connected, to be ranked, mined for dates and turned into a draft. Nothing else is sent, and no mail is ever sent on your behalf — Doppel only drafts, always.",
  "Your key is stored encrypted (AES-256-GCM) under a platform secret, is never shown back to you — only a mask like sk-…abcd and the date you saved it — and never appears in a URL or an error message.",
  "To remove it, press Remove: the stored key is genuinely deleted, and triage falls straight back to the built-in rules. Replace saves a new key in its place, validated the same way before anything is kept.",
];

export const PROVIDER_CHOICES: readonly {
  id: "openai" | "anthropic";
  label: string;
  costLine: string;
}[] = [
  {
    id: "openai",
    label: "OpenAI",
    costLine: "OpenAI bills you directly for what the pipeline uses, at OpenAI's own published prices — Doppel adds nothing on top and never sees your bill.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    costLine: "Anthropic bills you directly for what the pipeline uses, at Anthropic's own published prices — Doppel adds nothing on top and never sees your bill.",
  },
];
