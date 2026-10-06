/**
 * What a builder is told about the screen's one owner (loop/screen-owner.ts). The rule already had
 * teeth — a non-owner's call into the contract HUD is a code-review finding — but nothing a builder
 * read said the screen had an owner, so the Midnight Apex race part drew its pursuit meter beside
 * the HUD part's readouts and learnt the rule only from the review. The brief and the opening prompt
 * say it now, from the spec's typed fields and never from its words; a run where no part owns the
 * screen renders nothing here. A new module, so a kept older sibling can never shadow these names.
 */

/** The part as the lines read it: the same two fields the screen-owner rule reads. */
export interface ScreenOwnerSpec {
  ownsScreen?: unknown;
  screenOwner?: unknown;
}

/** What each side of the rule is told. */
const SCREEN_OWNER_WORDS = {
  owner:
    "- YOU OWN THE SCREEN: this part draws the HUD, the menus and the layout for the whole game — the title, the start on a key, the countdown and the results among them. The other parts publish their values in __studio.state() or their module's API; read them there and decide where each one goes.",
  other: (owner: string) =>
    `- THE SCREEN IS PART "${owner}"'s: publish your values in __studio.state() or your module's API — the screen owner ${owner} draws them. Never draw on the screen from this part (no __studio.hud text, bars, arcs, panels or menus): each such line is a code-review finding you remove before your build is judged.`,
} as const;

/** The part that owns the screen while this one does not, read exactly as screen-owner.ts reads it. */
function otherScreenOwner(spec: ScreenOwnerSpec): string | null {
  if (spec.ownsScreen === true) return null;
  return typeof spec.screenOwner === "string" && spec.screenOwner ? spec.screenOwner : null;
}

/**
 * The brief's and the opening prompt's line about the screen's owner: the owner hears that the
 * HUD, menus and layout are its; every other part hears to publish its values for the owner to
 * draw. Null when no part owns the screen, so that run's brief and prompt are as they were.
 */
export function screenOwnerLine(spec: ScreenOwnerSpec | null | undefined): string | null {
  if (!spec) return null;
  if (spec.ownsScreen === true) return SCREEN_OWNER_WORDS.owner;
  const owner = otherScreenOwner(spec);
  return owner ? SCREEN_OWNER_WORDS.other(owner) : null;
}
