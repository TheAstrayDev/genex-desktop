/**
 * Run settings store: the person's "Don't wait for me" (`shared/dont-wait.ts`), kept on each run and,
 * set while no run is going, for a chat's next run. Host-only, like the permission store: the file
 * lives under engine-homes, which no agent's file tools reach and no RPC names. Writes are atomic
 * and queued one after another. A file that is not there reads as nothing set; one that could not
 * be read (or holds no store) fails the call and is read again next time, so it is never written
 * over: a worker's question then waits, the default.
 */
import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "../substrate/fsx.ts";

/** The file's format. */
const STORE_VERSION = 1;
/** The longest run or chat id the store keeps. */
const ID_MAX = 200;
/** How many runs and chats it keeps; the oldest go first. */
const RUNS_KEPT = 1000;
const CHATS_KEPT = 1000;

/** Why a call is refused. */
const MESSAGE = {
  invalidId: "Invalid run or chat id",
  unreadable: (file: string) => `The run settings in ${file} could not be read; nothing was changed.`,
} as const;

/** A run's own setting, and the chat it was started in. */
interface RunSetting {
  threadId: string;
  on: boolean;
}

/** A chat's setting for its next run, and when the person made it (ms since the epoch). */
interface NextRunSetting {
  on: boolean;
  at: number;
}

interface RunSettingsState {
  runs: Map<string, RunSetting>;
  nextRun: Map<string, NextRunSetting>;
}

function validId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= ID_MAX;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The runs the file holds, cleaned: a run with no chat or no switch is left out. */
function parseRuns(value: unknown): Map<string, RunSetting> {
  const runs = new Map<string, RunSetting>();
  if (!isRecord(value)) return runs;
  for (const [runId, item] of Object.entries(value)) {
    if (!validId(runId) || !isRecord(item)) continue;
    if (validId(item.threadId) && typeof item.on === "boolean")
      runs.set(runId, { threadId: item.threadId, on: item.on });
  }
  return runs;
}

/** The chats' next-run settings the file holds, cleaned. */
function parseNextRun(value: unknown): Map<string, NextRunSetting> {
  const chats = new Map<string, NextRunSetting>();
  if (!isRecord(value)) return chats;
  for (const [threadId, item] of Object.entries(value)) {
    if (!validId(threadId) || !isRecord(item)) continue;
    const at = Number(item.at);
    if (typeof item.on === "boolean" && Number.isFinite(at)) chats.set(threadId, { on: item.on, at });
  }
  return chats;
}

/** The store a file holds; text that is no store at all throws, so it is never written over. */
function parse(text: string, file: string): RunSettingsState {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(MESSAGE.unreadable(file));
  }
  if (!isRecord(data)) throw new Error(MESSAGE.unreadable(file));
  return { runs: parseRuns(data.runs), nextRun: parseNextRun(data.nextRun) };
}

/** A run's own setting, when it is this chat's run. */
function ownSetting(state: RunSettingsState, runId: string, threadId: string): boolean {
  const own = state.runs.get(runId);
  return own?.threadId === threadId && own.on;
}

/** Whether the chat has a next-run setting made before a run that started at `runStartedAt`. */
function takesNextRun(state: RunSettingsState, threadId: string, runStartedAt: number): boolean {
  const pending = state.nextRun.get(threadId);
  return pending !== undefined && pending.at <= runStartedAt;
}

/** Keep the newest `max` entries of a map, in the order they were set. */
function newest<T>(map: Map<string, T>, max: number): Map<string, T> {
  return new Map([...map].slice(-max));
}

export class RunSettingsStore {
  readonly file: string;
  readonly #now: () => number;
  #state: Promise<RunSettingsState> | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  /** `now` is the clock a next-run setting is stamped with (injectable for tests). */
  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.#now = now;
  }

  #load(): Promise<RunSettingsState> {
    if (this.#state) return this.#state;
    // Only a file that is not there reads as nothing set; any other failure is retried next time.
    const loading = readFile(this.file, "utf8").then(
      (text) => parse(text, this.file),
      (error: NodeJS.ErrnoException) => {
        if (error?.code === "ENOENT") return { runs: new Map(), nextRun: new Map() };
        throw error;
      },
    );
    this.#state = loading;
    loading.catch(() => {
      if (this.#state === loading) this.#state = null;
    });
    return loading;
  }

  /** Change a copy, write it, and only then let readers see it: a failed write changes nothing. */
  async #update<T>(change: (state: RunSettingsState) => T): Promise<T> {
    const operation = this.#tail.then(async () => {
      const current = await this.#load();
      const next: RunSettingsState = { runs: new Map(current.runs), nextRun: new Map(current.nextRun) };
      const result = change(next);
      const kept = { runs: newest(next.runs, RUNS_KEPT), nextRun: newest(next.nextRun, CHATS_KEPT) };
      await atomicWriteJson(this.file, {
        version: STORE_VERSION,
        runs: Object.fromEntries(kept.runs),
        nextRun: Object.fromEntries(kept.nextRun),
      });
      this.#state = Promise.resolve(kept);
      return result;
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }

  /**
   * Whether the person asked not to be waited for in run `runId` of chat `threadId`: the run's own
   * value, else a setting for the chat's next run made before the run started, which this run then
   * takes for its own (the chat's next-run setting is cleared). Off when neither is set.
   */
  async dontWait(runId: string, threadId: string, runStartedAt: number): Promise<boolean> {
    if (!validId(runId) || !validId(threadId)) return false;
    const state = await this.#load();
    if (!state.runs.has(runId) && !takesNextRun(state, threadId, runStartedAt)) return false;
    if (state.runs.has(runId)) return ownSetting(state, runId, threadId);
    return this.#update((next) => {
      // Read again in the queue: another call may have taken it meanwhile.
      if (next.runs.has(runId) || !takesNextRun(next, threadId, runStartedAt)) return ownSetting(next, runId, threadId);
      const on = next.nextRun.get(threadId)?.on === true;
      next.runs.set(runId, { threadId, on });
      next.nextRun.delete(threadId);
      return on;
    });
  }

  /** The chat's setting for its next run: off unless the person switched it on. */
  async nextRun(threadId: string): Promise<boolean> {
    if (!validId(threadId)) return false;
    return (await this.#load()).nextRun.get(threadId)?.on === true;
  }

  /**
   * Switch it for run `runId` of chat `threadId`. A next-run setting made before the run started
   * belonged to this run, so it goes.
   */
  async setForRun(runId: string, threadId: string, on: boolean, runStartedAt = 0): Promise<void> {
    if (!validId(runId) || !validId(threadId)) throw new Error(MESSAGE.invalidId);
    await this.#update((state) => {
      state.runs.delete(runId);
      state.runs.set(runId, { threadId, on });
      const pending = state.nextRun.get(threadId);
      if (pending && pending.at <= runStartedAt) state.nextRun.delete(threadId);
    });
  }

  /** Switch it for the chat's next run, from now on; off forgets it (off is the default). */
  async setForNextRun(threadId: string, on: boolean): Promise<void> {
    if (!validId(threadId)) throw new Error(MESSAGE.invalidId);
    await this.#update((state) => {
      state.nextRun.delete(threadId);
      if (on) state.nextRun.set(threadId, { on, at: this.#now() });
    });
  }
}
