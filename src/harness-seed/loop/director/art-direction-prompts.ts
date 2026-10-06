/**
 * What the art director's look says to the lead (director/art-direction.ts, tools.ts `judge
 * ship=yes`, integrate.ts `finish`): ship or not, the defects grouped by the part that owns them,
 * and the rule from the finish mark on. Plain facts in, text out. A new module: it imports only
 * from modules as new as it, so a seed upgrade never finds it older than a caller.
 */
import { DefectSeverity } from "../ship-review.ts";
import { shortSha } from "../git.ts";
import type { ShipDefect } from "../ship-review.ts";

/** The question every ship review is asked, as the verdict record names it. */
export const SHIP_QUESTION = "Would you ship this as the user's demo today?";

/** The group of the defects no plan part owns: the lead's. */
export const NO_PART = "no part — yours";

/** The rule from the finish mark on, as the lead reads it. */
export const FINISH_MARK_RULE =
  "From here no new parts or systems: finish what exists. worker_steer stage=finish on each running owner of a part with defects (or, for a finished part, worker_start stage=finish replaces=<its id> owns=<its files> from=integration); a finish round may win on polish. Integrate, then judge ship=yes again.";

/** What to do next when the art director would ship the build. */
const SHIP_YES_NEXT =
  "The art director would ship this build: hand any nits left to their owners with stage=finish, or finish.";

/** What to do next when nobody could read the art director's answer. */
const SHIP_UNREAD_NEXT =
  "The art director's answer could not be read — no verdict either way: go on, and judge ship=yes again later.";

/** Why the studio's own look at the finish mark did not happen, in the lead's words. */
export const ART_SKIPPED = {
  nothingNew: "the integration branch has nothing beyond the starting point yet",
  doesNotLoad: "the integrated build did not load at its last look",
  notJudged: "the art director could not look at the integrated build",
  stopped: "the run is stopping",
  olderTools: "this workspace keeps an older tools.ts without the art director",
} as const;

/** The art director's answer as a review has it. */
interface ShipWords {
  ship: boolean | null;
  defects: readonly ShipDefect[];
}

/** One defect in a line: how much it matters, what, and where it shows. */
export function defectLine(defect: ShipDefect): string {
  return `${defect.severity}: ${defect.what}${defect.camera ? ` (${defect.camera})` : ""}`;
}

/** The defects grouped by the part that owns them; those no part owns under `NO_PART`. */
export function defectsByPart(defects: readonly ShipDefect[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const defect of defects) {
    const part = defect.part ?? NO_PART;
    groups[part] = [...(groups[part] ?? []), defectLine(defect)];
  }
  return groups;
}

/** How many of the defects a player would notice: blockers and visible ones. */
export const noticed = (defects: readonly ShipDefect[]): number =>
  defects.filter((d) => d.severity !== DefectSeverity.Nit).length;

/** The line that says what to do after a ship review. */
export function shipNext({ ship, defects }: ShipWords): string {
  if (ship === null) return SHIP_UNREAD_NEXT;
  if (ship && !noticed(defects)) return SHIP_YES_NEXT;
  return FINISH_MARK_RULE;
}

/** Ship or not, in the words a sentence starts with. */
function verdictWords({ ship }: ShipWords): string {
  if (ship === true) return "would ship";
  if (ship === false) return "would not ship";
  return "gave no readable answer about";
}

/**
 * The wake's paragraph at the finish mark: what the art director said of the integrated build,
 * its defects by part, and the rule — or, when it could not look, why, and the rule all the same.
 */
export function artDirectionBlock({
  head,
  review,
  skipped = null,
}: {
  head: string | null;
  review: ShipWords | null;
  skipped?: string | null;
}): string {
  const heading = "THE FINISH MARK — the art director's look at the whole game";
  if (!review) return [heading, `- no ship review: ${skipped ?? ART_SKIPPED.notJudged}`, FINISH_MARK_RULE].join("\n");
  const groups = Object.entries(defectsByPart(review.defects)).map(
    ([part, lines]) => `- ${part}: ${lines.join(" | ")}`,
  );
  return [
    heading,
    `The art director ${verdictWords(review)} the integrated build ${shortSha(head)} as the user's demo today.`,
    ...(groups.length ? ["DEFECTS BY PART:", ...groups] : ["- no defects named"]),
    shipNext(review),
  ].join("\n");
}

/** What `finish` adds about the art director's last look at the head it closed on, or nothing. */
export function shipFinishLine(review: ShipWords | null): string {
  if (!review || review.ship === null) return "";
  if (review.ship) return " The art director would ship this build.";
  return ` The art director would not ship this build; ${review.defects.length} defects left — say so, and claim no more.`;
}

/** Why a goal build's first finish is turned back: the art director's look found what to finish. */
export function shipFinishRefusal(review: ShipWords): string {
  const groups = Object.entries(defectsByPart(review.defects)).map(([part, lines]) => `${part}: ${lines.join(" | ")}`);
  return `finish turned back once: the art director would not ship this build — ${groups.join("; ") || "no defects named"}. ${FINISH_MARK_RULE} Calling finish again closes the build as it stands.`;
}
