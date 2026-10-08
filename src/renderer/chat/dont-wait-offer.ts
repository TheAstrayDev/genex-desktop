/**
 * The "Don't wait for me" card an agent shows in the chat (`offer_dont_wait`, recorded as
 * `dont_wait_offer`) and the line the person's switch leaves (`dont_wait_set`): pure reads of the
 * records, so an old or partial one draws nothing. Only the person's click on the card switches it.
 */
import type { DontWaitOfferPayload, DontWaitSetPayload } from "../../shared/dont-wait.ts";
import { DONT_WAIT_WORDS } from "../words.ts";

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A record's card, or null for one that names no card, chat or game. */
export function parseDontWaitOffer(payload: Partial<DontWaitOfferPayload>): DontWaitOfferPayload | null {
  const { offerId, threadId, project } = payload;
  if (!isText(offerId) || !isText(threadId) || !isText(project)) return null;
  return { offerId, threadId, project };
}

/** The person's switch as the chat says it, or null for a record that says neither on nor off. */
export function dontWaitSetLine(payload: Partial<DontWaitSetPayload>): string | null {
  if (typeof payload.on !== "boolean") return null;
  return DONT_WAIT_WORDS.set(payload.on, isText(payload.runId));
}
