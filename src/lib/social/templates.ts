/**
 * The reply templates the composer starts from.
 *
 * Pure and dependency-free on purpose: both the server (`~/lib/social/replies`, which
 * saves drafts and proposes the text) and the page (`~/components/social-ui`, which
 * has to fill the box) need the same words, and a component must not import the
 * draft store. One copy, two callers.
 *
 * This text is a **template**, not the owner's words and not a model's: the label
 * shown beside the box says so, and the draft records what produced it.
 */
import type { ReplyTarget } from "~/lib/social/types";

export const SUGGESTION_LABEL = "Built-in reply template — a starting point, not your words";
export const SUGGESTION_PROVIDER = "built-in reply template";

/** The starting point for one target. Deterministic: no model is called. */
export function suggestReplyText(target: Pick<ReplyTarget, "kind">): string {
  switch (target.kind) {
    case "post":
      return "Thanks for the support on this one — glad it landed well. If you'd like the same doing for you, send us a message and we'll pick it up from there.";
    case "comment":
      return "Thanks for getting in touch — yes, we can help with that. Send over the location and roughly when you need it and we'll come straight back with a price.";
    case "dm":
      return "Thanks for the message. Happy to help — tell me a bit more about what you need and I'll come back with the next step.";
  }
}
