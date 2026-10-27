/** Launch, errors and updates (plan §1.1): what a launch costs, what breaks the window, and whether an update is taken. */
import type { AreaObservers } from "../observers.ts";

export const LaunchEvent = {} as const;

export type LaunchEventProperties = Record<never, never>;

/** What this area hears from the log and from main's events; none yet. */
export function createLaunchObservers(): AreaObservers {
  return {};
}
