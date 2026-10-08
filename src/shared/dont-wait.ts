/**
 * "Don't wait for me": the person's run setting. By default a worker's question waits in the chat
 * for the person; with it on, the question is refused at once, the worker carries on, and the
 * question stays in the chat. Only the person switches it (the Loop menu, or the one-click card an
 * agent may show); the host keeps it on the run (`main/run-settings.ts`), and both records below
 * are written by the host only.
 */

/** Which run a switch reaches: the one going in the chat now, or the chat's next one. */
export const DontWaitScope = { Run: "run", NextRun: "next_run" } as const;
export type DontWaitScope = (typeof DontWaitScope)[keyof typeof DontWaitScope];

/** The setting as the Loop menu shows it: on or off, for the run going now or the chat's next. */
export interface DontWaitState {
  on: boolean;
  scope: DontWaitScope;
}

/** A `dont_wait_offer` record: the card an agent showed, which only the person's click acts on. */
export interface DontWaitOfferPayload {
  offerId: string;
  threadId: string;
  project: string;
}

/**
 * A `dont_wait_set` record: the person switched it, for a run (`runId`) or the chat's next run
 * (null); `offerId` names the card the click came from.
 */
export interface DontWaitSetPayload {
  threadId: string;
  runId: string | null;
  on: boolean;
  offerId?: string;
}
