/**
 * The builders the stage's own hooks send with (`events/builds.ts` names the events): Live's load
 * and what the game says once it shows, Reload, the first plan's wait, the Builds graph, an engine
 * setup card's rows and a Roblox publish. Pure, so each is tested without a DOM; every time comes
 * in from the caller.
 */
import { isUserCancelled } from "../../shared/errors.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { type EventEnvelope, EventKind } from "../../shared/event-log.ts";
import type { LiveBehindReason } from "../../shared/live-behind.ts";
import { PluginSourceKind } from "../../shared/plugins.ts";
import type { StepRow, StepsCard } from "../chat/engine-steps.ts";
import { GraphSelection, isPartSelection } from "../panels/inspector/selection.ts";
import {
  type BuildsEventProperties,
  type BuildsEvent,
  type LiveGameShownProperties,
  type LiveOutcome,
  type LiveTrigger,
  NodeKind,
  type PlanningEnd,
  pluginRef,
  PressOutcome,
  SetupStepState,
} from "./events/builds.ts";
import { elapsedMs, oneOf } from "./properties.ts";

/** A game shown this long without drawing anything is suspected blank. */
export const BLANK_AFTER_MS = 10 * SECOND_MS;
/** A Reload this soon after the last one of the same game is a rapid one. */
export const RAPID_RELOAD_MS = 10 * SECOND_MS;

type Props<E extends BuildsEvent> = BuildsEventProperties[E];

// ── Live ────────────────────────────────────────────────────────────────────────────────────

/** What a game's page reports about itself, as far as analytics reads it: whether it plays, and its draws. */
export function gameSays(state: Record<string, unknown> | null): { playing: boolean | null; draws: number | null } {
  const flow = state?.flow;
  const playing = typeof flow === "object" && flow !== null && "playing" in flow ? flow.playing : undefined;
  const draws = state?.drawCalls;
  return {
    playing: typeof playing === "boolean" ? playing : null,
    draws: typeof draws === "number" && Number.isFinite(draws) ? draws : null,
  };
}

/** When the chat's first message was sent, from its log; null before the log has one. */
export function firstMessageAt(events: readonly EventEnvelope[]): number | null {
  for (const event of events) {
    const said =
      event.data.type === EventKind.Messages && event.data.messages.some((message) => message.role === "user");
    const at = said ? Date.parse(event.created_at) : Number.NaN;
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/** What Live's wait ended on, for `live_game_shown`. */
export interface LiveShown {
  outcome: LiveOutcome;
  load: { since: number; trigger?: LiveTrigger };
  now: number;
  firstInLaunch: boolean;
  /** When the game was made (`GameProject.createdAt`), if the stage knows. */
  gameCreatedAt: string | null;
  firstMessageAt: number | null;
  /** What the page reported last. */
  state: Record<string, unknown> | null;
  /** The game's random ref (`game-ref.ts`). */
  gameRef: string | null;
}

const timeOf = (iso: string | null): number | null => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : null;
};

/** The properties of `live_game_shown`. */
export function liveShownProperties(shown: LiveShown): LiveGameShownProperties {
  const says = gameSays(shown.state);
  const created = timeOf(shown.gameCreatedAt);
  return {
    outcome: shown.outcome,
    load_ms: elapsedMs(shown.load.since, shown.now),
    trigger: shown.load.trigger ?? null,
    first_in_launch: shown.firstInLaunch,
    game_age_ms: created === null ? null : elapsedMs(created, shown.now),
    ms_since_first_message: shown.firstMessageAt === null ? null : elapsedMs(shown.firstMessageAt, shown.now),
    game_playing: says.playing,
    draws_seen: (says.draws ?? 0) > 0,
    game_ref: shown.gameRef,
  };
}

/**
 * Whether a shown game looks blank: it has drawn nothing for `BLANK_AFTER_MS` since it showed.
 * Draw counters that are not live (null) count as nothing drawn, and say so in the event.
 */
export function blankSuspected(
  shownAt: number,
  now: number,
  state: Record<string, unknown> | null,
): Props<typeof BuildsEvent.LiveBlankSuspected> | null {
  const says = gameSays(state);
  if ((says.draws ?? 0) > 0 || now - shownAt < BLANK_AFTER_MS) return null;
  return { ms_after_shown: elapsedMs(shownAt, now), draws_counted: says.draws !== null, game_playing: says.playing };
}

/** A Reload: what waited for it, and whether it came right after the last one. */
export function reloadPressed(
  reason: LiveBehindReason | null,
  last: number | null,
  now: number,
): Props<typeof BuildsEvent.LiveReloadPressed> {
  const gap = last === null ? null : elapsedMs(last, now);
  return { behind_reason: reason, rapid: gap !== null && gap < RAPID_RELOAD_MS, ms_since_last: gap };
}

/** The first plan's wait on an empty stage, once it ended. */
export function planningEnded(
  wait: { since: number; fromHome: boolean; gameRef: string | null },
  endedBy: PlanningEnd,
  now: number,
): Props<typeof BuildsEvent.BuildPlanningEnded> {
  return { ms: elapsedMs(wait.since, now), ended_by: endedBy, from_home: wait.fromHome, game_ref: wait.gameRef };
}

// ── Builds ──────────────────────────────────────────────────────────────────────────────────

/** What a Builds graph selection is: one of its fixed nodes, a part's row, or a step. */
export function nodeKindOf(id: string): GraphSelection | NodeKind {
  const fixed = oneOf(GraphSelection, id);
  if (fixed) return fixed;
  return isPartSelection(id) ? NodeKind.Part : NodeKind.Step;
}

/** How a press that ran a plugin action ended: an error the person caused by saying no is a decline. */
export function pressOutcomeOf(error: unknown): PressOutcome {
  if (error === undefined) return PressOutcome.Ok;
  return isUserCancelled(error) ? PressOutcome.Declined : PressOutcome.Failed;
}

// ── engine setup cards ──────────────────────────────────────────────────────────────────────

/** Where one row of the card stands. */
export function stepStateOf(row: Pick<StepRow, "done" | "you" | "working">): SetupStepState {
  if (row.done) return SetupStepState.Done;
  if (row.working) return SetupStepState.Working;
  if (row.you) return SetupStepState.You;
  return SetupStepState.Open;
}

/** A plugin as the card's events name it, and whether its own step ids may be named (bundled only). */
export interface SetupPlugin {
  ref: string;
  bundled: boolean;
}

/** The plugin behind a card, as its events may name it. */
export function setupPluginOf(
  pluginId: string,
  plugins: ReadonlyArray<{ manifest: { id: string }; source: PluginSourceKind }>,
): SetupPlugin {
  const plugin = plugins.find((entry) => entry.manifest.id === pluginId);
  return { ref: pluginRef(pluginId, plugins), bundled: plugin?.source === PluginSourceKind.Bundled };
}

/** A step's id when its plugin's ids may be named. */
export const setupStepId = (plugin: SetupPlugin, id: string | undefined): string | null =>
  plugin.bundled && id ? id : null;

/** The card's first showing: how many steps, how many open and how many wait on the person. */
export function setupCardShown(card: StepsCard, plugin: SetupPlugin): Props<typeof BuildsEvent.EngineSetupCardShown> {
  const open = card.steps.filter((row) => !row.done);
  return {
    plugin_ref: plugin.ref,
    step_count: card.steps.length,
    open_steps: open.length,
    you_steps: open.filter((row) => row.you).length,
    has_primary: card.primary !== undefined,
  };
}

/** Where each row stood and since when, by its id. */
export type StepStates = Map<string, { state: SetupStepState; since: number }>;

/** The rows whose state moved since the last answer; `seen` is updated. */
export function setupStepChanges(
  card: StepsCard,
  seen: StepStates,
  at: { plugin: SetupPlugin; now: number; shownAt: number | null },
): Array<Props<typeof BuildsEvent.EngineSetupStepChanged>> {
  const changes: Array<Props<typeof BuildsEvent.EngineSetupStepChanged>> = [];
  for (const row of card.steps) {
    const state = stepStateOf(row);
    const before = seen.get(row.id);
    if (before?.state === state) continue;
    seen.set(row.id, { state, since: at.now });
    if (!before) continue;
    changes.push({
      plugin_ref: at.plugin.ref,
      step_id: setupStepId(at.plugin, row.id),
      from: before.state,
      to: state,
      ms_in_previous: elapsedMs(before.since, at.now),
      ms_since_shown: at.shownAt === null ? null : elapsedMs(at.shownAt, at.now),
    });
  }
  return changes;
}
