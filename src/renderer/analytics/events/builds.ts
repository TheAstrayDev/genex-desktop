/** Builds, runs, Live, assets and engine projects (plan §1.6): from a first message to a game that plays. */
import type { AreaObservers } from "../observers.ts";

export const BuildsEvent = {} as const;

export type BuildsEventProperties = Record<never, never>;

/** What this area hears from the log and from main's events; none yet. */
export function createBuildsObservers(): AreaObservers {
  return {};
}
