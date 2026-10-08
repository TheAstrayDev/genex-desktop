/**
 * The harness's copy of Genex's one worker model: the tools a lead runs workers with, how a worker
 * stands in the project, the lead's word on what one delivered, the codes a refused worker's call
 * carries and the event a worker's question is recorded as. The app's copy is `shared/workers.ts`
 * (and `DelegationRefusal`, `SnapshotRefusal`, `CustomEvent.ToolPermission`);
 * `seed-contracts.test.ts` holds the two together. Wire values: never rename one. It imports nothing,
 * so every worker module can read it while any other module is still loading.
 */

/** The tools a lead runs its workers with, by the names its engine sends. */
export const WorkerTool = {
  Start: "worker_start",
  Status: "worker_status",
  Wait: "worker_wait",
  Steer: "worker_steer",
  Stop: "worker_stop",
  Mark: "worker_mark",
} as const;
export type WorkerTool = (typeof WorkerTool)[keyof typeof WorkerTool];

/**
 * How a worker stands in the project: `read` works in place and writes nothing; `copy` writes in a
 * copy of its own and hands its work back for the lead to merge; `lock` writes in place, one such
 * worker at a time per game.
 */
export const WorkerIsolation = { Read: "read", Copy: "copy", Lock: "lock" } as const;
export type WorkerIsolation = (typeof WorkerIsolation)[keyof typeof WorkerIsolation];

/** The lead's word on what a worker delivered: the digest stops repeating it. */
export const WorkerVerdict = { Used: "used", Rejected: "rejected" } as const;
export type WorkerVerdict = (typeof WorkerVerdict)[keyof typeof WorkerVerdict];

/** The most workers a lead's pool runs at once. Depth is one: a worker never starts workers of its own. */
export const MAX_WORKERS_AT_ONCE = 8;

/**
 * Why the host refused a worker's call (the error's `code`): past the most workers the person's
 * Settings allow, or a copy too large to make (work in the game folder itself instead).
 */
export const WorkerRefusal = { TooManyWorkers: "too_many_workers", CopyTooLarge: "copy-too-large" } as const;
export type WorkerRefusal = (typeof WorkerRefusal)[keyof typeof WorkerRefusal];

/** The custom event a worker's question to the person is recorded as, in the chat's log. */
export const WORKER_QUESTION_EVENT = "tool_permission";

/** A worker's question still waiting for the person's answer (the event's `state`); settled ones say how. */
export const WORKER_QUESTION_PENDING = "pending";

/** What the pool reads of a worker's question: which one it is, where it stands, whose it is and what it asks. */
export interface WorkerQuestion {
  requestId: string;
  state: string;
  worker?: { id: string };
  /** The engine's own sentence, e.g. "Claude wants to run npm install". */
  title?: string;
  /** The one thing to decide on: the command, the file path, the URL or host. */
  subject?: string;
}

/** The longest `worker_wait`, in seconds: the director's own `wait` cap (`director/budgets.ts` `MAX_WAIT_S`). */
export const MAX_WORKER_WAIT_S = 240;
/** The most characters of a worker's title the graph and the chat show. */
export const WORKER_TITLE_CHARS = 80;
