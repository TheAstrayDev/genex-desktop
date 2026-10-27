/** The chat and its composer (plan §1.5): sending, waiting for the answer, the cards that block a turn, stopping and rewinding. */
import type { AreaObservers } from "../observers.ts";

export const ChatEvent = {} as const;

export type ChatEventProperties = Record<never, never>;

/** What this area hears from the log and from main's events; none yet. */
export function createChatObservers(): AreaObservers {
  return {};
}
