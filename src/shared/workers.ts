/**
 * Genex's one worker model, as the app and the harness both name it: the tools a lead runs workers
 * with, how a worker stands in the project, the lead's word on what one delivered, and the kinds of
 * worker a plugin declares. Renderer-safe (no Node). The harness's copy is
 * `loop/workers/contract.ts`, held to this one by `seed-contracts.test.ts`.
 */

/** The tools a lead runs its workers with, by the names its engine sends: never rename a value. */
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
 * worker at a time per game. Manifests and journals keep them: never rename a value.
 */
export const WorkerIsolation = { Read: "read", Copy: "copy", Lock: "lock" } as const;
export type WorkerIsolation = (typeof WorkerIsolation)[keyof typeof WorkerIsolation];

/** The lead's word on what a worker delivered: the digest stops repeating it. Never rename a value. */
export const WorkerVerdict = { Used: "used", Rejected: "rejected" } as const;
export type WorkerVerdict = (typeof WorkerVerdict)[keyof typeof WorkerVerdict];

/** The most workers a lead's pool runs at once. Depth is one: a worker never starts workers of its own. */
export const MAX_WORKERS_AT_ONCE = 8;

/**
 * A kind of worker a plugin declares (`PluginManifest.workerTypes`), as the registry hands it to a
 * lead: `tools` are agent names (`<plugin>__<tool>`) or name prefixes (`<plugin>__`) a worker of
 * this kind is offered.
 */
export interface WorkerType {
  pluginId: string;
  id: string;
  description: string;
  tools: string[];
  isolation: WorkerIsolation;
}

/**
 * What the harness asks for when it starts a worker: its id and title, the run or the chat turn it
 * belongs to, and whether it may search the web as a reader. Honoured only by the host's own
 * finding; a grant it cannot confirm leaves the session unattended.
 */
export interface WorkerGrant {
  id: string;
  title: string;
  /** The run whose lead started it: a run started in this game's open chat, still running. */
  runId?: string;
  /** The chat message whose turn started it: the one the chat's own session answers now. */
  turn?: string;
  /** It may search and read the web even as a reader. */
  research?: boolean;
}

/** The key an in-place worker's delegation runs under, so it never shares the game folder's lock. */
export const workerLockKey = (cwd: string, id: string): string => `${cwd}#worker:${id}`;

const WORKER_TOOLS: ReadonlySet<string> = new Set(Object.values(WorkerTool));
const WORKER_ISOLATIONS: ReadonlySet<string> = new Set(Object.values(WorkerIsolation));

/** Whether `name` is one of the worker tools. */
export const isWorkerTool = (name: unknown): name is WorkerTool => typeof name === "string" && WORKER_TOOLS.has(name);

/** Whether `value` is a worker isolation. */
export const isWorkerIsolation = (value: unknown): value is WorkerIsolation =>
  typeof value === "string" && WORKER_ISOLATIONS.has(value);
