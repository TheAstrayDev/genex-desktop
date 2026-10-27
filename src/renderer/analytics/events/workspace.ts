/** Home, starting and opening games, navigation and Settings (plan §1.4): how people get to a game and around the app. */
import type { AreaObservers } from "../observers.ts";

export const WorkspaceEvent = {} as const;

export type WorkspaceEventProperties = Record<never, never>;

/** What this area hears from the log and from main's events; none yet. */
export function createWorkspaceObservers(): AreaObservers {
  return {};
}
