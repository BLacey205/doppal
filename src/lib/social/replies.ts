/**
 * Reply drafts for the social gateway — the one place a social reply can be
 * written, and the reason it can never be sent.
 *
 * What this module deliberately does **not** have:
 *
 *   - no `"sent"` state (`SocialReplyDraftState` is exactly `"draft"`, and
 *     `saveReplyDraft` rejects any other value at runtime, so an older or hand-made
 *     record cannot smuggle one in);
 *   - no network call of any kind — it imports nothing that can open a socket or
 *     read a secret;
 *   - no function whose name or shape would let a caller post, reply in a thread or
 *     send a DM. The API surface is save-as-draft, list, and the text suggestion.
 *
 * Drafts live in memory for the life of the server process, in a `globalThis` map
 * (so it survives a dev-server reload and every route handler sees the same
 * drafts), exactly like the app's other preview store. Nothing here is persisted
 * yet, and the page says so.
 *
 * Every failure is a typed result, never a throw: an unknown target, an empty body
 * and an over-long body each come back as their own code plus the sentence the
 * caller shows.
 */
import type { AiMode } from "~/lib/inbox-types";
import { whenLabel } from "~/lib/social/normalise";
import { SUGGESTION_LABEL, SUGGESTION_PROVIDER, suggestReplyText } from "~/lib/social/templates";
import type {
  ReplySuggestion,
  ReplyTarget,
  SocialNetwork,
  SocialReplyDraft,
  SocialReplyDraftState,
  SocialReplyTargetKind,
} from "~/lib/social/types";
import { NETWORK_LABELS, SOCIAL_REPLY_DRAFT_STATES, isReplyDraftState } from "~/lib/social/types";

/** The longest reply we will hold for someone to copy out. */
export const MAX_REPLY_DRAFT_CHARS = 4000;

/**
 * What produced a suggested reply. It is a template, and it is labelled as one —
 * the wording lives in `~/lib/social/templates` so the page fills the box with
 * exactly the text this module would record.
 */
export const SUGGESTION_MODE: AiMode = "heuristic";
export { SUGGESTION_LABEL, SUGGESTION_PROVIDER } from "~/lib/social/templates";

export type SaveDraftFailure = {
  ok: false;
  code: "invalid_target" | "empty_body" | "body_too_long" | "not_a_draft" | "unknown_network";
  message: string;
};

export type SaveDraftResult = { ok: true; draft: SocialReplyDraft; message: string } | SaveDraftFailure;

export type DraftInput = {
  network: SocialNetwork;
  targetKind: SocialReplyTargetKind;
  targetId: string;
  body: string;
  /** Ignored by the type; rejected at runtime. Present so the guard is testable. */
  state?: SocialReplyDraftState | string;
};

/** How the caller proves a target exists. Without it, no target is accepted. */
export type DraftTargetLookup = (target: {
  network: SocialNetwork;
  targetKind: SocialReplyTargetKind;
  targetId: string;
}) => ReplyTarget | null;

/* ---------------------------------- store ---------------------------------- */

const STORE_KEY = "__doppelSocialReplyDrafts";

function draftStore(): Map<string, SocialReplyDraft> {
  const host = globalThis as unknown as Record<string, Map<string, SocialReplyDraft> | undefined>;
  if (!host[STORE_KEY]) host[STORE_KEY] = new Map();
  return host[STORE_KEY]!;
}

function draftKey(target: { network: SocialNetwork; targetKind: SocialReplyTargetKind; targetId: string }) {
  return `${target.network}:${target.targetKind}:${target.targetId}`;
}

/** Newest first. The page renders these as "Drafts for you to send". */
export function listReplyDrafts(): SocialReplyDraft[] {
  return [...draftStore().values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function replyDraftFor(target: {
  network: SocialNetwork;
  targetKind: SocialReplyTargetKind;
  targetId: string;
}): SocialReplyDraft | null {
  return draftStore().get(draftKey(target)) ?? null;
}

/** Test helper: forget every draft this process holds. */
export function resetReplyDrafts(): void {
  draftStore().clear();
}

/* --------------------------------- saving ---------------------------------- */

/**
 * Save a reply as a draft. This is the only write this module offers, and the only
 * state it can produce is `"draft"`.
 *
 * Order of checks mirrors the intake route: cheap shape checks, then the target
 * lookup (fail closed when the caller supplied no lookup), then the body.
 */
export function saveReplyDraft(
  input: DraftInput,
  options: { knownTarget?: DraftTargetLookup; now?: Date } = {},
): SaveDraftResult {
  if (!Object.hasOwn(NETWORK_LABELS, input.network)) {
    return { ok: false, code: "unknown_network", message: "That isn't one of the networks Doppel supports." };
  }

  // The state guard. `"draft"` is the only value the model has; anything else —
  // including "sent" — is refused here rather than stored.
  if (input.state !== undefined && !isReplyDraftState(input.state)) {
    return {
      ok: false,
      code: "not_a_draft",
      message:
        "Doppel only ever saves a draft. There is no code path that sends a reply, a comment or a direct message.",
    };
  }

  const lookup = options.knownTarget;
  const target = lookup
    ? lookup({ network: input.network, targetKind: input.targetKind, targetId: input.targetId })
    : null;
  if (!target) {
    return {
      ok: false,
      code: "invalid_target",
      message: "That post, comment or message isn't one Doppel can see — nothing was saved.",
    };
  }

  const body = input.body.trim();
  if (body.length === 0) {
    return { ok: false, code: "empty_body", message: "There's nothing in the reply yet — nothing was saved." };
  }
  if (body.length > MAX_REPLY_DRAFT_CHARS) {
    return {
      ok: false,
      code: "body_too_long",
      message: `That reply is longer than Doppel will hold (${MAX_REPLY_DRAFT_CHARS} characters). Nothing was saved.`,
    };
  }

  const now = options.now ?? new Date();
  const draft: SocialReplyDraft = {
    id: draftKey({ network: input.network, targetKind: input.targetKind, targetId: input.targetId }),
    network: input.network,
    targetKind: input.targetKind,
    targetId: input.targetId,
    targetLabel: target.label,
    body,
    // Frozen by the type and checked above: the only value that can reach a store.
    state: SOCIAL_REPLY_DRAFT_STATES[0]!,
    mode: SUGGESTION_MODE,
    provider: SUGGESTION_PROVIDER,
    provenanceLabel: SUGGESTION_LABEL,
    updatedAt: now.toISOString(),
    updatedAtLabel: whenLabel(now.toISOString()),
  };

  draftStore().set(draft.id, draft);
  return {
    ok: true,
    draft,
    message: `Saved as a draft for ${NETWORK_LABELS[input.network]} — copy it out when you're ready. Doppel hasn't sent anything.`,
  };
}

/* -------------------------------- suggestion -------------------------------- */

/**
 * A starting point, not a finished reply and not the owner's words. The template is
 * deterministic (`~/lib/social/templates`): no model is called for social replies in
 * this build. A model-backed suggestion is a later step, and when it lands it will
 * carry its own provenance the way the inbox drafts do.
 */
export function suggestReply(target: ReplyTarget): ReplySuggestion {
  return {
    network: target.network,
    targetKind: target.kind,
    targetId: target.id,
    body: suggestReplyText(target),
    mode: SUGGESTION_MODE,
    provider: SUGGESTION_PROVIDER,
    label: SUGGESTION_LABEL,
  };
}
