/**
 * The "Don't wait for me" card an agent showed in the chat (`offer_dont_wait`): what it does, and
 * one button the person may press, or On once their click switched it. Built like the plugin
 * suggestion card; only this click (or the Loop menu's switch) turns it on.
 */
import { type JSX, useState } from "react";
import type { Entry, EntryKind } from "../chat-entries.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { DONT_WAIT_WORDS } from "../words.ts";

/** An agent's offer of "Don't wait for me", in the transcript. */
export function DontWaitOfferCard({
  entry,
  onNotice,
}: {
  entry: Extract<Entry, { kind: typeof EntryKind.DontWaitOffer }>;
  onNotice: Notify;
}): JSX.Element {
  const { offer, on } = entry;
  const [busy, setBusy] = useState(false);
  const titleId = `dont-wait-offer-${entry.id}`;
  const press = () => {
    if (busy) return;
    setBusy(true);
    void window.studio
      .setDontWait(offer.threadId, true, offer.offerId)
      .catch(notifyProblem(onNotice))
      .finally(() => setBusy(false));
  };
  return (
    <section data-dont-wait-offer={offer.offerId} aria-labelledby={titleId} className="chat-question">
      <div className="min-h-0 overflow-y-auto px-4 py-3">
        <h3 id={titleId} className="text-chat font-medium">
          {DONT_WAIT_WORDS.cardTitle}
        </h3>
        <p className="mt-0.5 text-chat text-ink-2">{DONT_WAIT_WORDS.description}</p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-chat-sub text-ink-3">{DONT_WAIT_WORDS.onlyYou}</span>
          {on ? (
            <span className="text-chat-sub text-ink-3">{DONT_WAIT_WORDS.on}</span>
          ) : (
            <Button size="sm" variant="secondary" disabled={busy} onClick={press}>
              {DONT_WAIT_WORDS.button}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
