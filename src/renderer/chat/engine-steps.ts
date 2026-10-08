/**
 * The steps card an engine plugin offers in a game's chat (Unreal's is "Unreal setup").
 * The chat's log says when it was offered (`engine_steps`); its rows are the plugin's `steps`
 * action's answer, read live so a step the person finishes is ticked without being told. The
 * answer comes from plugin code, so only well-formed rows are drawn.
 */
import { CustomEvent, customEvent } from "../../shared/custom-events.ts";
import type { EventEnvelope } from "../types.ts";

/** The plugin action the card reads its rows from. */
export const STEPS_ACTION = "steps";

/** Where the card was last offered: the record's id (Not now remembers it), the plugin and the game. */
export type StepsOffer = { id: string; pluginId: string; project: string };

/** A step's button: the plugin action it runs, with its arguments, and its label. */
export type StepButton = { name: string; args: Record<string, string>; label: string };
/** One row: a done step is ticked; an open one may have a button, or a line to run in Terminal. */
export type StepRow = {
  id: string;
  label: string;
  detail: string;
  done: boolean;
  action?: StepButton;
  command?: string;
};
/** The card as the plugin answers it. */
export type StepsCard = { title: string; intro: string; open: boolean; steps: StepRow[] };

/** The newest offer in a chat's log, or null. */
export function stepsOffer(events: readonly EventEnvelope[]): StepsOffer | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const offered = event ? customEvent(event, CustomEvent.EngineSteps) : null;
    if (!event || !offered) continue;
    return offered.pluginId && offered.project
      ? { id: event.id, pluginId: offered.pluginId, project: offered.project }
      : null;
  }
  return null;
}

/** Whether an offer still shows: the person said Not now to an earlier one, or to none. */
export const stepsShown = (offer: StepsOffer | null, dismissed: string | null): offer is StepsOffer =>
  offer !== null && offer.id !== dismissed;

const isText = (value: unknown): value is string => typeof value === "string";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parseButton(raw: unknown): StepButton | undefined {
  if (!isRecord(raw) || !isText(raw.name) || !isText(raw.label) || !isRecord(raw.args)) return undefined;
  const args = Object.fromEntries(
    Object.entries(raw.args).filter((entry): entry is [string, string] => isText(entry[1])),
  );
  return { name: raw.name, args, label: raw.label };
}

function parseRow(raw: unknown): StepRow | undefined {
  if (!isRecord(raw) || !isText(raw.id) || !isText(raw.label) || typeof raw.done !== "boolean") return undefined;
  const action = parseButton(raw.action);
  return {
    id: raw.id,
    label: raw.label,
    detail: isText(raw.detail) ? raw.detail : "",
    done: raw.done,
    ...(action ? { action } : {}),
    ...(isText(raw.command) && raw.command ? { command: raw.command } : {}),
  };
}

/** The plugin's answer as the card draws it, or null when it isn't a card at all. */
export function parseSteps(raw: unknown): StepsCard | null {
  if (!isRecord(raw) || !isText(raw.title) || !isText(raw.intro) || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps.map(parseRow).filter((row): row is StepRow => row !== undefined);
  return { title: raw.title, intro: raw.intro, open: raw.open === true, steps };
}
