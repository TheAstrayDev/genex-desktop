/** Plugins, connectors, the Harness room and Play (plan §1.7). */
import type { AreaObservers } from "../observers.ts";

export const PluginsEvent = {} as const;

export type PluginsEventProperties = Record<never, never>;

/** What this area hears from the log and from main's events; none yet. */
export function createPluginsObservers(): AreaObservers {
  return {};
}
