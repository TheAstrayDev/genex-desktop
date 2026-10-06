/**
 * Numeric facts a judge reads beside the frames — what the build measured about itself and a
 * picture cannot state exactly.
 *
 * The first is the HUD's: a HUD that covered a third of the frame once passed every judge, because
 * nothing told them how much it covered. The template's HUD (`src/hud.js`, generation 2) measures
 * the share of the frame its items cover and the items that run into each other, and `state().hud`
 * carries both. A build whose HUD did not measure (an older HUD, a game with its own UI) gets no
 * line: a judge is never handed a number nobody measured.
 */
import { isRecord } from "./json.ts";

/** How many overlapping pairs the line names before it says how many more there are. */
const HUD_FACT_PAIRS = 4;
/** How much of one item id the line keeps: ids are the build's own words. */
const HUD_FACT_ID_CHARS = 32;

/** An item id as the line shows it: one line, clipped. */
function shownId(value: unknown): string {
  const flat = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > HUD_FACT_ID_CHARS ? `${flat.slice(0, HUD_FACT_ID_CHARS)}…` : flat;
}

/** The pairs of items that run into each other, as `a/b`, or `none`. */
function overlapWords(overlaps: unknown): string {
  const pairs = Array.isArray(overlaps) ? overlaps.filter((pair) => Array.isArray(pair) && pair.length >= 2) : [];
  if (pairs.length === 0) return "none";
  const named = pairs.slice(0, HUD_FACT_PAIRS).map((pair) => `${shownId(pair[0])}/${shownId(pair[1])}`);
  const more = pairs.length > HUD_FACT_PAIRS ? ` (+${pairs.length - HUD_FACT_PAIRS} more)` : "";
  return `${named.join(", ")}${more}`;
}

/** How many items the HUD holds: its own count, or the ids it listed when it gave none. */
function itemCount(hud: Record<string, unknown>): number {
  if (typeof hud.count === "number" && Number.isFinite(hud.count)) return hud.count;
  return Array.isArray(hud.items) ? hud.items.length : 0;
}

/**
 * The judge's HUD line from a build's `state().hud`: "HUD: covers N% of the frame (budget M%),
 * K items, overlaps: a/b". No line when the coverage is not a measured number. `budget` is the
 * share the game's kind allows the HUD; without one the line names none.
 */
export function hudFactLines(hud: unknown, budget: number | null = null): string[] {
  if (!isRecord(hud)) return [];
  const coverage = hud.coverage;
  if (typeof coverage !== "number" || !Number.isFinite(coverage)) return [];
  const allowed = typeof budget === "number" && Number.isFinite(budget) ? ` (budget ${Math.round(budget * 100)}%)` : "";
  return [
    `HUD: covers ${Math.round(coverage * 100)}% of the frame${allowed}, ${itemCount(hud)} items, overlaps: ${overlapWords(hud.overlaps)}`,
  ];
}
