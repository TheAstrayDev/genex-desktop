/** The welcome, Connect and the model providers (plan §1.3): where a first launch gets stuck before a model is ready. */
import type { AreaObservers } from "../observers.ts";

export const WelcomeEvent = {} as const;

export type WelcomeEventProperties = Record<never, never>;

/** What this area hears from the log and from main's events; none yet. */
export function createWelcomeObservers(): AreaObservers {
  return {};
}
