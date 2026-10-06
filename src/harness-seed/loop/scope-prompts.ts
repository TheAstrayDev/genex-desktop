/**
 * The scope as every agent that reads the goal reads it (loop/scope.ts): the user's own words, what
 * is in scope, what is cut, and that a named reference sets the look, not the features. The rules
 * travel here, in code, and not only in skills/director.md or a judge rubric, which a seed upgrade
 * keeps at an agent-edited older vintage. A run without scope renders nothing, so an older run's
 * prompts stay byte-identical. A new module; it imports only from scope.ts, which is as new.
 */
import { runScope } from "./scope.ts";

/** The words the scope is rendered with. */
const WORDS = {
  heading: "SCOPE",
  asked: "THE USER ASKED (verbatim):",
  inScope: "IN SCOPE:",
  inScopeUnnamed: "IN SCOPE: what the user asked, nothing more",
  cut: "CUT — not this build; never build or propose it:",
  added: "ADDED beyond the ask — not in scope until the user says yes:",
  reference: "The reference is a look-and-feel bar, not a feature list.",
} as const;

/** How the items of one line are joined. */
const ITEM_JOIN = "; ";

/** The judges' rule: depth of what is in scope; a proposal needing more says so in its typed field. */
export const SCOPE_RULE =
  'Judge the depth and quality of what is in SCOPE; a proposal that needs something not in scope is scope:"adds".';

/** The lead's rule: it narrows, the user widens. */
export const DIRECTOR_SCOPE_RULE =
  "Decide what to cut, not what to add. Work only inside SCOPE; anything else is a decision card the user can accept.";

/** One message of the ask as a list item; a message of several lines stays together, indented. */
function askedItem(message: string): string {
  return `- ${message.split("\n").join("\n  ")}`;
}

/**
 * The scope block an agent reads beside the goal: the user's words verbatim, in scope, cut, added
 * beyond the ask, and the reference rule. '' for a run without scope.
 */
export function scopeLines(run: { scope?: unknown } | null | undefined): string {
  const scope = runScope(run);
  if (!scope) return "";
  return [
    WORDS.heading,
    WORDS.asked,
    ...scope.asked.map(askedItem),
    scope.inScope.length ? `${WORDS.inScope} ${scope.inScope.join(ITEM_JOIN)}` : WORDS.inScopeUnnamed,
    scope.cut.length ? `${WORDS.cut} ${scope.cut.join(ITEM_JOIN)}` : "",
    scope.added.length ? `${WORDS.added} ${scope.added.join(ITEM_JOIN)}` : "",
    WORDS.reference,
  ]
    .filter(Boolean)
    .join("\n");
}
