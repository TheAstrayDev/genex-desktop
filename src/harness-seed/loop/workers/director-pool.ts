/**
 * The director in Genex's one worker model. Its `worker_start` keeps building in copies (isolation
 * copy, the default: today's builder in its own worktree); isolation read starts a reader from the
 * run's shared pool, in the game folder, and isolation lock is refused, because the web method never
 * writes in the game folder itself. `worker_mark` is the lead's word on a builder: used integrates
 * its last accepted commit, rejected stops its news in every digest and `worker_wait`. The worker
 * tools reach a reader by its id. The marks live with the night; a resumed night starts with none.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import { slug } from "../director/args.ts";
import type { Night, Worker } from "../director/night.ts";
import { modelOn, roleEffort, RoleKey, roleEngine } from "../model-roles.ts";
import { isRunning } from "../outcomes.ts";
import { CLIP_DETAIL, clip, hasText } from "../text.ts";
import { WorkerIsolation, WorkerTool, WorkerVerdict } from "./contract.ts";
import { folderLabelOf, WEB_AT_ROOT } from "./identity.ts";
import { DIRECTOR_MARK_WORDS, RUN_POOL_WORDS } from "./prompts.ts";
import { REAL_CLOCK } from "./records.ts";
import { waitingWorkers } from "./questions.ts";
import { closeRunPool, type RunPoolSeat, runPool, runPoolCall, runPoolStatus } from "./run-pool.ts";

/** The worker tools that name one worker, which a reader of the run's pool answers for its own id. */
const ONE_WORKER_TOOLS: ReadonlySet<string> = new Set([
  WorkerTool.Status,
  WorkerTool.Wait,
  WorkerTool.Steer,
  WorkerTool.Stop,
  WorkerTool.Mark,
]);

/** The lead's marks on its builders, by night: what it said, and the note it gave. */
const marks = new WeakMap<object, Map<string, { verdict: WorkerVerdict; note: string | null }>>();

/** The night's marks, made on first use. */
function marksOf(night: Night): Map<string, { verdict: WorkerVerdict; note: string | null }> {
  const known = marks.get(night);
  if (known) return known;
  const made = new Map<string, { verdict: WorkerVerdict; note: string | null }>();
  marks.set(night, made);
  return made;
}

/** The builders the lead rejected: no digest and no `worker_wait` names them again. */
export function rejectedWorkers(night: Night): ReadonlySet<string> {
  const rejected = [...marksOf(night)].filter(([, mark]) => mark.verdict === WorkerVerdict.Rejected);
  return new Set(rejected.map(([id]) => id));
}

/** Whether a line of the night's log is news of a worker the lead rejected (every such line opens `worker <id>`). */
export function rejectedNews(night: Night, text: string): boolean {
  for (const id of rejectedWorkers(night))
    if (text.startsWith(`worker ${id}:`) || text.startsWith(`worker ${id} `)) return true;
  return false;
}

/** The workers a digest names: all but those the lead rejected. */
export function unrejected<T extends { id: string }>(night: Night, workers: readonly T[]): T[] {
  const rejected = rejectedWorkers(night);
  return workers.filter((worker) => !rejected.has(worker.id));
}

/** The brief a director's `worker_start` carries: `task`, else a kept prompt's `brief`. */
export function briefOf(args: AnyRecord): string {
  return String((hasText(args.task) ? args.task : args.brief) ?? "").trim();
}

/** The director's run pool: the builders' engine, readers in the game folder, merges into the integration worktree. */
function seatOf(night: Night): RunPoolSeat {
  const { ctx, integrationWorktree, projectDir, run, threadId } = night;
  const engine = roleEngine(run, RoleKey.Builder);
  const model = modelOn(run, engine);
  const effort = roleEffort(run, RoleKey.Builder);
  return {
    ctx,
    project: run.project,
    threadId,
    runId: run.runId,
    engine,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    gameDir: projectDir,
    leadFolder: integrationWorktree,
    identity: { folderLabel: folderLabelOf(projectDir, run.project), facts: night.gameFacts ?? WEB_AT_ROOT },
    clock: REAL_CLOCK,
    onEnded: (record) => night.note(RUN_POOL_WORDS.ended(record.id, record.title, record.state)),
  };
}

/** A director's `worker_start` asking for a reader: one from the run's pool, in the game folder. */
async function startReader(night: Night, args: AnyRecord): Promise<string> {
  const pool = await runPool(seatOf(night));
  const title = hasText(args.title) ? args.title : String(args.id ?? "");
  return pool.call(WorkerTool.Start, {
    title,
    task: briefOf(args),
    isolation: WorkerIsolation.Read,
    ...(args.research === undefined ? {} : { research: args.research }),
  });
}

/**
 * A worker tool call the run's shared pool answers for the director: a reader's start, a lock
 * refused, or a call naming one of the pool's readers. Null for everything the director's own
 * handlers answer (a builder's start, a builder's id, or no id at all).
 */
export async function pooledAnswer(night: Night, name: string, args: AnyRecord): Promise<string | null> {
  if (name === WorkerTool.Start) {
    const isolation = String(args.isolation ?? "").trim();
    if (isolation === WorkerIsolation.Lock) return RUN_POOL_WORDS.noLock;
    return isolation === WorkerIsolation.Read ? startReader(night, args) : null;
  }
  if (!ONE_WORKER_TOOLS.has(name)) return null;
  const id = args.id ?? args.worker;
  if (!hasText(id) || night.state.workers.has(slug(id))) return null;
  return runPoolCall(night.run.runId, name, args);
}

/** The run pool's readers, as lines after the builders' status; "" when there are none. */
export function readerLines(night: Night): Promise<string> {
  return runPoolStatus(night.run.runId, (pool) => pool.call(WorkerTool.Status, {}));
}

/** The questions already told in each night's log, by `<worker>:<question>`: each is told once. */
const told = new WeakMap<object, Set<string>>();

/**
 * The night's builders that wait on the person now, by id, with what each asks: read from the
 * chat's log (`waitingWorkers`). A builder that newly waits is told once in the night's log, so
 * `worker_wait` wakes on it and the lead can stop it or work around it. The run pool's readers are
 * the pool's to read.
 */
export async function waitingBuilders(night: Night): Promise<Map<string, string>> {
  const waiting = await waitingWorkers(night.ctx, night.threadId);
  const builders = new Map([...waiting].filter(([id]) => night.state.workers.has(id)));
  const said = told.get(night) ?? new Set<string>();
  told.set(night, said);
  for (const [id, question] of builders) {
    const key = `${id}:${question}`;
    if (said.has(key)) continue;
    said.add(key);
    night.note(RUN_POOL_WORDS.waiting(id, question));
  }
  return builders;
}

/** The night closes: its readers stop. */
export function closeReaders(night: Night): Promise<void> {
  return closeRunPool(night.run.runId);
}

/** `worker_mark used`: the builder's last accepted commit is integrated; the mark stands once the head moved. */
async function markUsed(night: Night, worker: Worker, note: string | null): Promise<string> {
  const before = night.state.integrationHead;
  const answer = await night.integrate({ worker: worker.id });
  if (night.state.integrationHead !== before) marksOf(night).set(worker.id, { verdict: WorkerVerdict.Used, note });
  return typeof answer === "string" ? answer : JSON.stringify(answer);
}

/** `worker_mark rejected`: its news stops, and the feed says so. */
async function markRejected(night: Night, worker: Worker, note: string | null): Promise<string> {
  if (isRunning(worker)) return DIRECTOR_MARK_WORDS.stillRunning(worker.id);
  marksOf(night).set(worker.id, { verdict: WorkerVerdict.Rejected, note });
  await night.decision(
    DIRECTOR_MARK_WORDS.rejectedCard(worker.id, note),
    DIRECTOR_MARK_WORDS.rejectedPlain(worker.title),
  );
  return DIRECTOR_MARK_WORDS.rejected(worker.id);
}

/** `worker_mark`: the director's word on one of its builders. */
export async function markWorker(night: Night, args: AnyRecord): Promise<string> {
  const id = slug(args.id ?? args.worker);
  const worker = night.state.workers.get(id);
  if (!worker) return DIRECTOR_MARK_WORDS.unknown(id);
  const note = hasText(args.note) ? clip(args.note.trim(), CLIP_DETAIL) : null;
  if (args.verdict === WorkerVerdict.Used) return markUsed(night, worker, note);
  if (args.verdict === WorkerVerdict.Rejected) return markRejected(night, worker, note);
  return DIRECTOR_MARK_WORDS.badVerdict;
}
