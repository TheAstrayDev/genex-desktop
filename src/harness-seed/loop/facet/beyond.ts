/**
 * Steps beyond what the user asked for (scope.ts `isBeyondScope`), put to the user as decision cards:
 * the Midnight Apex night built police, traffic and a pursuit meter into a street race nobody asked
 * for, one reviewer's move at a time. Each proposal is asked about once, and a part asks at most
 * `BEYOND_CARDS_PER_PART` times: a taste judge names a big move every round, and one that rewords
 * the same idea each time would otherwise post a card a round. The user's yes is a steer; until
 * then the step waits. A new module, so a kept older sibling can never shadow these names.
 */
import { clip, CLIP_QUOTE } from "../text.ts";
import { isBeyondScope } from "../scope.ts";
import { recordDecision } from "./record.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { FacetLoopState } from "./state.ts";

/** How many cards about steps beyond the ask one part puts to the user, whoever proposed them. */
export const BEYOND_CARDS_PER_PART = 2;

/** What the user and the lead read about a step beyond the ask, by who proposed it. */
export const BEYOND_MESSAGE = {
  reviewer: (what: string) => `A reviewer proposes ${what}, which is outside what you asked; say so to add it`,
  planner: (what: string) => `The planner proposes ${what}, which is outside what you asked; say so to add it`,
  critic: (what: string) => `The critic proposes ${what}, which is outside what you asked; say so to add it`,
  player: (what: string) => `The player proposes ${what}, which is outside what you asked; say so to add it`,
  playerStep: (what: string) => ` — the player's big step: ${what}`,
  playerBeyond: (what: string) => ` — the player proposes ${what}, outside the ask: the user decides; never a move`,
} as const;

/** The part as a card about a step beyond the ask reads and records it. */
type BeyondLoop = Pick<FacetLoopState, "run" | "appendRun"> & {
  facet: AnyRecord;
  surfacedBeyond?: string[];
};

/**
 * Put one step beyond the ask to the user as a decision card: once per proposal, and never past the
 * part's cap. Remembers what was asked on `loop.surfacedBeyond` (it rides a Resume).
 */
export async function askUserAboutBeyond(
  loop: BeyondLoop,
  proposal: AnyRecord,
  words: (what: string) => string,
): Promise<void> {
  const what = String(proposal.what ?? "").trim();
  const asked = loop.surfacedBeyond ?? [];
  if (!what || asked.includes(what) || asked.length >= BEYOND_CARDS_PER_PART) return;
  loop.surfacedBeyond = [...asked, what];
  await recordDecision(loop, `${loop.facet.title ?? loop.facet.id}: ${words(clip(what, CLIP_QUOTE))}`);
}

/**
 * What the lead reads about a playtester's big step, and the card for the user when it adds to the
 * ask: a step inside the ask reads as it always did, and one beyond it is the user's decision.
 */
export function playtestStepWords(bigMove: AnyRecord | null | undefined): { note: string; card: string | null } {
  const what = typeof bigMove?.what === "string" ? bigMove.what.trim() : "";
  if (!what) return { note: "", card: null };
  if (!isBeyondScope(bigMove)) return { note: BEYOND_MESSAGE.playerStep(what), card: null };
  const quoted = clip(what, CLIP_QUOTE);
  return { note: BEYOND_MESSAGE.playerBeyond(quoted), card: BEYOND_MESSAGE.player(quoted) };
}
