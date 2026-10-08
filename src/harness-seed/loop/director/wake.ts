import { estimateTokens } from "../prompt.ts";
import { reviewProgress } from "./progress.ts";
import { durationCommission } from "./commission.ts";
/**
 * The director's wake loop. The lead ends its turn after every decision; between turns nothing
 * of it runs; the studio wakes the SAME session with a digest when something happens — the user
 * speaks, a worker lands a round or ends, the studio's look finds a violation, a timer is due
 * (wake-schedule.ts decides which). One turn at a time: what arrives during a turn opens the next
 * digest. The limit wait and the fresh-session fallback cover every turn, not only the first.
 *
 * It replaces the long turn (`wait` in a loop, and a "continue" prompt whenever the turn ended
 * with time left), which kept one session alive across a whole night — seventeen hours, once.
 * That loop stays behind `run.directorLoop: "turn"` for one release (director.ts).
 *
 * The journal holds what the loop needs after a restart (journal.ts): a wake and a rest save it, and
 * so does news that reaches a resting lead and wakes nobody; a resumed night's first message is a
 * digest read from it.
 *
 * The lead answers the chat while the night runs (live chat, lead-line.ts): a message the person
 * sends wakes a resting lead at once, and reaches a turn under way — read at its next step by an
 * engine that takes input mid-turn, or by cutting a later turn short (never inside a tool call) and
 * resuming the same session with the words in front. What the lead writes is the chat's.
 *
 * Its functions take the night explicitly; they are not bound onto it.
 */
import { isResumeFailure } from "../chat-session.ts";
import { HostMethod } from "../host-methods.ts";
import { jobEndLine } from "../jobs/prompts.ts";
import { JOB_POLL_MS, jobEnds } from "../jobs/watch.ts";
import { EngineFailure, StopReason, outageDelays, withProviderPatience } from "../outage.ts";
import { RunEvent } from "../run-events.ts";
import { SteerDelivery } from "../steer-delivery.ts";
import { MINUTE_MS, minutes, SECOND_MS, sleep } from "../time.ts";
import { rejectedNews, unrejected } from "../workers/director-pool.ts";
import { limitResumePrompt, wrapUpPrompt } from "./briefs.ts";
import { MAX_WORKERS, workerWindows } from "./budgets.ts";
import { waitDigest } from "./digests.ts";
import {
  priorDigestWorkers,
  priorWorkersSummary,
  recordNight,
  restoredWake,
  resumedFromJournal,
  wakeRecord,
} from "./journal.ts";
import { resumeClosing, resumedHeading } from "./journal-prompts.ts";
import { isReopened } from "./reopen.ts";
import { reopenClosing, reopenedHeading } from "./reopen-prompts.ts";
import { folderBusy } from "./lead-session.ts";
import {
  carryOn,
  FRESH_LOG_LINES,
  FRESH_NOTES,
  freshStart,
  idleAsk,
  SESSION_LOST_WHY,
  sinceThen,
  userSaysBlock,
  wakeDigest,
  wakeRules,
  wrapLead,
} from "./wake-prompts.ts";
// Read by namespace, not by name: a seed upgrade keeps an agent-edited wake-prompts.ts, and an
// older copy has no `buildCard` — a named import of it would keep the harness from linking.
import * as wakeWords from "./wake-prompts.ts";
import {
  afterTurn,
  HEARTBEAT_MS,
  nextWake,
  NoteKind,
  TurnEnd,
  WAKE_WINDOW_MS,
  WakeCause,
  WRAP_UP_MARGIN_MS,
  WrapCause,
} from "./wake-schedule.ts";
import { cutShortWake, midTurnUserSays } from "./live-prompts.ts";
import { workingGoal } from "../goal-prompts.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { DelegateResult } from "../../types/host-api.d.ts";
import type { RestoredWake } from "./journal.ts";
import type { LeadLine } from "./lead-line.ts";
import type { Night, NightState, Worker } from "./night.ts";
import type { CardFacts, DigestFacts, DigestWorker, WorkerRoom, WorkersLimitFacts } from "./wake-prompts.ts";
import type { TurnFacts, TurnVerdict, Wake, WakeReason, WakeView } from "./wake-schedule.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a night
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/** A session limit is waited out at most this often a night. */
export const MAX_LIMIT_WAITS = 2;
/** …and only when it resets at least this long before the turn's deadline. */
export const LIMIT_WAIT_MARGIN_MS = 5 * MINUTE_MS;
/** A wrap-up is worth a turn with at least this much of the night left. */
export const WRAP_UP_MIN_MS = 90 * SECOND_MS;
/** How often a resting lead's inbox, log and clocks are read. */
export const WAKE_POLL_MS = SECOND_MS;
/** A night opens at most this many fresh sessions for a lead whose own was lost. */
export const MAX_FRESH_SESSIONS = 3;
/**
 * A turn the host refused because another session holds the lead's lock (the paused night's last
 * turn, still settling under a Resume) is asked again after this wait, at most this many times.
 */
export const BUSY_RETRY_MS = 15 * SECOND_MS;
export const MAX_BUSY_RETRIES = 4;
/**
 * News that reaches a resting lead is saved once it has waited this long for a wake that did not
 * come, and at most this often (a wake saves what it tells).
 */
const JOURNAL_NEWS_MS = 5 * SECOND_MS;
const WAKE_TOKEN_BUDGET = 8_000;

/** The user's own reasons to wake the lead: never held back by the hourly cap, so never counted in it. */
const USER_WAKES: ReadonlySet<WakeReason> = new Set<WakeReason>([
  WakeCause.UserMessage,
  WakeCause.FinishRequested,
  NoteKind.UserToWorker,
]);

/** The director's session as the night talks to it: one turn at a time, and the session id it resumes. */
export interface DirectorTalk {
  session: (prompt: string, sid: string | null | undefined, timeoutMs: number) => Promise<Partial<DelegateResult>>;
  sessionId: string | null;
  /** Keep the session a turn answered with, on the journal where a resume finds it. */
  keep: (result: Partial<DelegateResult> | null | undefined) => Promise<void>;
}

/** The loop's clock: the real one, or one a test moves. */
export interface WakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
/** The wall clock. */
export const SYSTEM_CLOCK: WakeClock = { now: () => Date.now(), sleep };

/** Why a night the waking lead left open ended, when the wrap-up had a cause of its own (the report's sentence). */
export const WAKE_ENDING = {
  [WrapCause.Idle]: "the director had nothing left to run and did not call finish in its wrap-up",
  [WrapCause.Finish]: "the user asked to finish and the director did not call finish in its wrap-up",
} as const satisfies Partial<Record<WrapCause, string>>;

/** What the loop keeps between the lead's turns. */
export interface WakeState {
  turns: number;
  /** The build card this turn's digest left out because the session had seen it, for a fresh one. */
  cardLeftOut?: string;
  asleepFromSeq: number;
  asleepSince: number | null;
  idleAsked: boolean;
  idleDue: boolean;
  wrapping: boolean;
  wrapCause: WrapCause | null;
  wakes: number;
  wakesAt: number[];
  lastWakeAt: number | null;
  userWaiting: boolean;
  /**
   * The user's words the lead was told although the store refused to record their hand-over:
   * the inbox still has them as untold, at the head of its list, and they are never said again.
   */
  heardUnrecorded: string[];
  /** The user's words handed into a turn that ended before it read them: they open the next message. */
  owed: string[];
  /** The line the chat reaches the lead on (lead-line.ts), when the night opened one. */
  line: LeadLine | null;
  /** How many of the chat's messages the line had been handed when the lead's latest message was told them. */
  promptThrough: number;
  /** The user's words the lead's latest message carried: said again when no turn worked on it. */
  promptWords: string[];
  /** The turn under way was cut short to hand the lead the user's words: it is resumed at once with them. */
  cut: boolean;
  finishNew: boolean;
  finishSaid: boolean;
  /** The plan window (its `planReviewUntil`) whose closing a wake has said. */
  planWindowSaid: number | null;
  /** The log's sequence number, and the time, the loop last saved the journal (a kept older night.ts counts only these). */
  journaledSeq: number;
  journaledAt: number;
  limitWaits: number;
  freshSessions: number;
  /** The turn whose failure started the wrap-up. */
  failed: Partial<DelegateResult> | null;
  /** When the run's job ends were last asked for (null: not yet), so the host is asked at most every `JOB_POLL_MS`. */
  jobsPolledAt: number | null;
}

/** How the loop ended: the last turn's answer, why the wrap-up started, and the turn that failed. */
export interface WakeOutcome {
  result: Partial<DelegateResult>;
  wrapCause: WrapCause | null;
  failed: Partial<DelegateResult> | null;
}

/** What a turn needs besides the night: the brief a fresh session opens with, the clock, and the chat's line. */
interface TurnKit {
  talk: DirectorTalk;
  brief: () => string;
  clock: WakeClock;
  line: LeadLine | null;
}

/** One message to the lead's session, and when its turn must be over. */
interface TurnAsk {
  prompt: string;
  deadline: number;
}

/** The loop's state as a night starts: a resumed one takes back what its journal kept of it. */
function newWakeState(restored: RestoredWake = { idleAsked: false, wakesAt: [] }): WakeState {
  return {
    turns: 0,
    asleepFromSeq: 0,
    asleepSince: null,
    idleAsked: restored.idleAsked,
    idleDue: false,
    wrapping: false,
    wrapCause: null,
    wakes: 0,
    wakesAt: restored.wakesAt,
    lastWakeAt: null,
    userWaiting: false,
    heardUnrecorded: [],
    owed: [],
    line: null,
    promptThrough: 0,
    promptWords: [],
    cut: false,
    finishNew: false,
    finishSaid: false,
    planWindowSaid: null,
    journaledSeq: 0,
    journaledAt: 0,
    limitWaits: 0,
    freshSessions: restored.freshSessions ?? 0,
    failed: null,
    jobsPolledAt: null,
  };
}

/** The night is over for the lead: it finished, the user stopped it, or it failed on its own. */
const nightOver = (night: Night): boolean =>
  night.state.finished || night.ctx.cancelled === true || Boolean(night.report.failure);

/** Is the user's window to read the plan still open? */
const planWindowOpen = (state: NightState, now: number): boolean =>
  state.planReviewUntil !== null && !state.planGo && state.planReviewUntil > now;

/** When the workers' engine limit lifts, when the engine said. */
const workersLimitLifts = (state: NightState): number | null =>
  state.workerLimit && typeof state.workerLimit.retryAfterMs === "number"
    ? state.workerLimit.at + state.workerLimit.retryAfterMs
    : null;

/** Is the workers' engine limit still ahead of `now`? */
function workersLimitPending(state: NightState, now: number): boolean {
  const lifts = workersLimitLifts(state);
  return lifts !== null && lifts > now;
}

/** Of the inbox's untold steers, what the lead has not heard: those it was told on a refused hand-over lead the list. */
function unheard(wake: WakeState, untold: readonly string[]): string[] {
  const stillLeading = wake.heardUnrecorded.every((text, i) => untold[i] === text);
  // A reader took them since (a kept playbook's `wait`): the inbox has them as told after all.
  if (!stillLeading) wake.heardUnrecorded = [];
  return untold.slice(wake.heardUnrecorded.length);
}

/**
 * The user's words the lead is told now — what a turn was handed and did not read first, then the
 * inbox's — and how many of the chat's messages the line had been handed by then (`through`). The
 * count is the one read after the inbox, and read again until it stands still: a message handed
 * while the inbox was read may or may not be in its answer.
 */
async function userWords(night: Night, wake: WakeState): Promise<{ words: string[]; through: number }> {
  const owed = wake.owed.splice(0);
  const { line } = wake;
  let through = line?.count() ?? 0;
  const words = await takeUntold(night, wake);
  while (line && line.count() !== through) {
    through = line.count();
    words.push(...(await takeUntold(night, wake)));
  }
  return { words: [...owed, ...words], through };
}

/**
 * The user's words a message to the lead carries, taken off the inbox, which records their
 * hand-over. When the store refuses that record the lead still hears them — read without taking
 * them — and the loop remembers it did: the untaken steer woke the lead on every poll, each time
 * with nothing said. They are heard once a turn works on the message (`promptThrough`), and said
 * again in the next one when none does (`promptWords`).
 */
async function tellUser(night: Night, wake: WakeState): Promise<string[]> {
  const { words, through } = await userWords(night, wake);
  wake.promptThrough = through;
  wake.promptWords = words;
  return words;
}

/** The inbox's steers the lead has not heard, taken off it (`tellUser`). */
async function takeUntold(night: Night, wake: WakeState): Promise<string[]> {
  const { inbox } = night;
  const taken = await inbox.steering(undefined, true, { onlyNew: true }).catch(() => null);
  if (taken) {
    const words = unheard(wake, taken);
    wake.heardUnrecorded = [];
    return words;
  }
  const untold = await inbox.steering(undefined, false, { onlyNew: true }).catch(() => []);
  const words = unheard(wake, untold);
  wake.heardUnrecorded = [...untold];
  return words;
}

/**
 * The first message: the brief, how the night runs, and whatever the user said before it began —
 * on a resumed night, inside a digest read from its journal (`resumedDigest`). A night whose working
 * time is already over opens in its wrap-up.
 */
async function firstPrompt(night: Night, wake: WakeState, brief: () => string, now: number): Promise<string> {
  const said = await tellUser(night, wake);
  const opening = [brief(), wakeRules({ heartbeatMinutes: minutes(HEARTBEAT_MS) })];
  if (resumedFromJournal(night)) return [...opening, resumedDigest(night, wake, said, now)].join("\n\n");
  const closing = wake.wrapping ? closingFor(night, wake, [], now) : "";
  return [...opening, said.length ? userSaysBlock(said) : "", closing].filter(Boolean).join("\n\n");
}

/**
 * A resumed night's first digest, read from what its journal kept: the workers and the defects
 * nobody owns from before the pause, the news the lead never heard, the plan window and the
 * night's own clock — under a heading of its own, since nothing woke the lead.
 */
function resumedDigest(night: Night, wake: WakeState, userSays: string[], now: number): string {
  const happened = readUnread(night);
  const said = { now, reasons: [], userSays, finishNew: false, happened, closing: resumedClosing(night, wake, now) };
  // The one digest that gives the workers from before the pause their full lines.
  const facts = digestFacts(night, wake, said, { priorInFull: true });
  return wakeDigest({ ...facts, heading: resumedHeadingOf(night, now) });
}

/** How a resumed night's first digest ends: its wrap-up, or what to decide — a paused night's rest, or a reopened build's ask. */
function resumedClosing(night: Night, wake: WakeState, now: number): string {
  if (wake.wrapping) return closingFor(night, wake, [], now);
  return isReopened(night) ? reopenClosing(!durationCommission(night.run)) : resumeClosing();
}

/** The heading of a resumed night's first digest: it paused and picks up, or it had finished and goes on (director/reopen.ts). */
function resumedHeadingOf(night: Night, now: number): string {
  if (!isReopened(night)) return resumedHeading(now);
  return reopenedHeading({ now, minutesLeft: minutes(night.softDeadline - now) });
}

/** Everything `afterTurn` decides on, read from the night as the turn ends. */
async function turnFacts(
  night: Night,
  wake: WakeState,
  result: Partial<DelegateResult>,
  now: number,
): Promise<TurnFacts> {
  const { inbox, runningWorkers, state } = night;
  const finishRequested = await inbox.finishing().catch(() => false);
  return {
    ok: result?.ok === true,
    closed: nightOver(night) || Boolean(state.limit) || wake.wrapping,
    running: runningWorkers().length,
    planWindowOpen: planWindowOpen(state, now),
    workersLimitPending: workersLimitPending(state, now),
    idleAsked: wake.idleAsked,
    workingTimeLeft: now < night.softDeadline && !finishRequested,
    finishRequested,
  };
}

/**
 * The wrap-up starts now: the working deadline moves up to this moment, so every clock the night
 * reads (run_status, `finish`, a new worker's budget) agrees that the working time is over.
 */
function startWrapUp(night: Night, wake: WakeState, cause: WrapCause, now: number): void {
  if (!wake.wrapCause) wake.wrapCause = cause;
  const at = Math.min(night.softDeadline, now);
  night.softDeadline = at;
  night.state.softDeadline = at;
}

/** Act on the end of a turn: owe the lead the idle question, or start the wrap-up. */
function settleTurn(night: Night, wake: WakeState, verdict: TurnVerdict, result: Partial<DelegateResult>, now: number) {
  wake.idleAsked = verdict.idleAsked;
  if (verdict.next === TurnEnd.AskIdle) wake.idleDue = true;
  if (verdict.next !== TurnEnd.WrapUp) return;
  if (verdict.wrapCause === WrapCause.Failed) wake.failed = result;
  startWrapUp(night, wake, verdict.wrapCause ?? WrapCause.Deadline, now);
}

/**
 * The run's jobs (the lead's and its workers') that ended since the lead last heard, each a line
 * of the night's log that wakes it soon; asked at most every `JOB_POLL_MS`. The cursor moves past
 * every end read, the agent's own stops included, and the journal keeps it with the next save.
 */
async function watchJobs(night: Night, wake: WakeState, now: number): Promise<void> {
  if (wake.jobsPolledAt !== null && now - wake.jobsPolledAt < JOB_POLL_MS) return;
  wake.jobsPolledAt = now;
  const { ctx, run, state } = night;
  const read = await jobEnds(ctx, { project: run.project, runId: run.runId }, state.jobsCursor ?? 0);
  state.jobsCursor = read.cursor;
  for (const end of read.ends) night.note(jobEndLine(end), NoteKind.JobEnded);
}

/** Read the inbox while the lead rests: what the user said, a finish request, steers addressed to a worker, and job ends. */
async function collect(night: Night, wake: WakeState, now: number): Promise<void> {
  const { inbox, routeUserSteers, state } = night;
  await reviewProgress(night, now);
  await watchJobs(night, wake, now);
  const untold = await inbox.steering(undefined, false, { onlyNew: true }).catch(() => []);
  wake.userWaiting = wake.owed.length > 0 || unheard(wake, untold).length > 0;
  wake.finishNew = !wake.finishSaid && (await inbox.finishing().catch(() => false));
  // Before the first worker there is no monitor to hand a worker's steer over.
  if (!state.monitor) await routeUserSteers().catch(() => {});
}

/** The plan window's closing, while it is open and no wake has said it. */
function planWindowUnsaid(state: NightState, wake: WakeState): number | null {
  const open = state.planReviewUntil !== null && !state.planGo;
  return open && wake.planWindowSaid !== state.planReviewUntil ? state.planReviewUntil : null;
}

/** What `nextWake` decides on, read from the night. */
function wakeView(night: Night, wake: WakeState, now: number): WakeView {
  const { state } = night;
  return {
    now,
    // A worker the lead rejected wakes it no more (`worker_mark rejected`).
    unread: night.notesSince(night.waitSeq).filter((entry) => !rejectedNews(night, entry.text)),
    asleepFromSeq: wake.asleepFromSeq,
    asleepSince: wake.asleepSince ?? now,
    userWaiting: wake.userWaiting,
    finishNew: wake.finishNew,
    running: night.runningWorkers().length,
    planWindowEndsAt: planWindowUnsaid(state, wake),
    // The wake that says it lifted clears it (`markSaid`), so it is said once.
    workersLimitLiftsAt: workersLimitLifts(state),
    softDeadline: night.softDeadline,
    wrapping: wake.wrapping,
    idleDue: wake.idleDue,
    idleAsked: wake.idleAsked,
    wakesAt: wake.wakesAt,
  };
}

/** A wrap-up that would not have its minimum before the night's end is not started. */
const tooLateToWrap = (night: Night, due: Wake, now: number): boolean =>
  due.reasons.includes(WakeCause.WrapUp) && night.finalDeadline - now <= WRAP_UP_MIN_MS;

/**
 * What happened while the lead rests reaches the journal before its next turn: the wake it causes
 * saves it (`wakePrompt`); news that has waited `JOURNAL_NEWS_MS` for a wake that did not come — one
 * the cap holds, or a line that wakes nobody — is saved here. News a save already holds is not.
 */
async function journalNews(night: Night, wake: WakeState, now: number): Promise<void> {
  const saved = Math.max(wake.journaledSeq, night.journaledSeq ?? 0);
  const oldest = night.notesSince(saved)[0];
  if (!oldest) return;
  const waited = now - oldest.at >= JOURNAL_NEWS_MS && now - wake.journaledAt >= JOURNAL_NEWS_MS;
  if (waited) await keepWake(night, wake, now);
}

/** Rest until something is due, or the night ends under the lead (null); a message from the chat cuts it short. */
async function sleepUntilDue(night: Night, wake: WakeState, kit: TurnKit): Promise<Wake | null> {
  const { clock, line } = kit;
  for (;;) {
    if (nightOver(night) || clock.now() >= night.finalDeadline - WRAP_UP_MARGIN_MS) return null;
    const spoke = line?.heard();
    await collect(night, wake, clock.now());
    const now = clock.now();
    const due = nextWake(wakeView(night, wake, now));
    if (due && due.at <= now) return tooLateToWrap(night, due, now) ? null : due;
    await journalNews(night, wake, now);
    await (spoke ? Promise.race([clock.sleep(WAKE_POLL_MS), spoke]) : clock.sleep(WAKE_POLL_MS));
  }
}

/** The log's lines the lead has not read, as text; the shared cursor moves past them (`wait` reads it too). */
function readUnread(night: Night): string[] {
  const unread = night.notesSince(night.waitSeq);
  const last = unread.at(-1);
  if (last) night.waitSeq = Math.max(night.waitSeq, last.seq);
  return unread.map((entry) => entry.text).filter((text) => !rejectedNews(night, text));
}

/** Record the wake: the cap's window, and every timer and request it says, so none is said twice. */
function markSaid(night: Night, wake: WakeState, reasons: readonly WakeReason[], now: number): void {
  const { state } = night;
  wake.wakes += 1;
  wake.lastWakeAt = now;
  // The cap holds the night's news back, never the user: a wake that is theirs alone is not counted.
  const capped = reasons.some((reason) => !USER_WAKES.has(reason));
  wake.wakesAt = [...wake.wakesAt.filter((at) => at > now - WAKE_WINDOW_MS), ...(capped ? [now] : [])];
  wake.idleDue = false;
  // Asked once: a night that went idle under a resting lead is asked here, not by `afterTurn`.
  if (reasons.includes(WakeCause.IdleAsk)) wake.idleAsked = true;
  wake.userWaiting = false;
  if (wake.finishNew) wake.finishSaid = true;
  wake.finishNew = false;
  if (reasons.includes(WakeCause.PlanWindow)) wake.planWindowSaid = state.planReviewUntil;
  // The workers' limit has lifted: gone from the night, so nothing names it or wakes for it again.
  if (reasons.includes(WakeCause.WorkersLimitLifted)) state.workerLimit = null;
  if (!reasons.includes(WakeCause.WrapUp)) return;
  wake.wrapping = true;
  if (!wake.wrapCause) wake.wrapCause = WrapCause.Deadline;
}

/** Does this run commission a duration rather than goal completion? */
const isDirection = (night: Night): boolean => durationCommission(night.run);

/** How this wake's message ends: the wrap-up, the idle question, or carry on. */
function closingFor(night: Night, wake: WakeState, reasons: readonly WakeReason[], now: number): string {
  const { finalDeadline, run, state } = night;
  if (wake.wrapping) {
    const wrapUp = wrapUpPrompt({
      run,
      finalDeadline,
      integrationHead: state.integrationHead,
      integrationHealthy: state.integrationHealthy,
      workers: [...state.workers.values()],
      fromScratch: state.fromScratch,
    });
    return wrapLead(wake.wrapCause ?? WrapCause.Deadline, wrapUp);
  }
  if (reasons.includes(WakeCause.IdleAsk))
    return idleAsk({ direction: isDirection(night), minutesLeft: minutes(night.softDeadline - now) });
  return carryOn();
}

/** One worker as the digest names it. */
function digestWorker(worker: Worker, now: number): DigestWorker {
  const line = waitDigest(worker, now);
  return {
    id: worker.id,
    title: worker.title,
    state: worker.state,
    minutesLeft: line.minutesLeft,
    round: line.round,
    accepted: line.accepted,
    passing: line.passing,
    mandatoryFix: line.mandatoryFix,
    minutesInRound: line.minutesInRound,
    filesChanged: line.filesChanged,
    violations: line.violations,
    lastLook: line.lastLook,
    stoppedBecause: line.stoppedBecause,
    ideas: latestIdeas(worker),
  };
}

/** What the worker's reviewers proposed last: its newest round that proposed anything. */
function latestIdeas(worker: Worker): string[] {
  const proposed = [...worker.iterations].reverse().find((round) => round.ideas?.length);
  return proposed?.ideas ?? [];
}

/** Workers running, and how many the pool allows at once, from the last capacity the studio gave. */
function workerRoom(night: Night): WorkerRoom | null {
  const cap = night.capacity;
  if (!cap || typeof cap.max !== "number") return null;
  const allowed = cap.headless === false ? 1 : Math.min(MAX_WORKERS, workerWindows(cap.max));
  return { running: night.runningWorkers().length, allowed };
}

/** The workers' engine limit while it is still ahead (or the engine never said when it resets). */
function workersLimitFacts(state: NightState, now: number): WorkersLimitFacts | null {
  const limit = state.workerLimit;
  if (!limit) return null;
  const liftsAt = workersLimitLifts(state);
  if (liftsAt !== null && liftsAt <= now) return null;
  return { engine: limit.engine, kind: limit.kind, liftsAt };
}

/** The run, its kind and its plan, for the build card. */
function cardFacts(night: Night): CardFacts {
  const { run, state } = night;
  return {
    runId: run.runId,
    project: run.project,
    goal: workingGoal(run),
    direction: isDirection(night),
    plan: state.plan
      ? { summary: String(state.plan.summary ?? ""), parts: (state.plan.workers ?? []).map((w: AnyRecord) => w.id) }
      : null,
    lead: Boolean(night.lead),
  };
}

/**
 * The digest's facts, read from the night at the moment of the wake. The workers from before the
 * pause get their full lines only when `priorInFull` (a resumed night's first digest); every later
 * digest names them in one line — they do not change, and each line is a few hundred characters.
 */
function digestFacts(
  night: Night,
  wake: WakeState,
  said: Pick<DigestFacts, "now" | "reasons" | "userSays" | "finishNew" | "happened" | "closing">,
  { priorInFull = false }: { priorInFull?: boolean } = {},
): DigestFacts {
  const { finalDeadline, ledgerLines, state } = night;
  const priorLine = priorInFull ? null : priorWorkersSummary(night);
  return {
    ...said,
    softDeadline: night.softDeadline,
    finalDeadline,
    wrapping: wake.wrapping,
    integrationHead: state.integrationHead,
    integrationHealthy: state.integrationHealthy,
    defects: state.ledger.length ? ledgerLines() : [],
    workers: [
      ...unrejected(night, [...state.workers.values()]).map((worker) => digestWorker(worker, said.now)),
      ...(priorInFull ? priorDigestWorkers(night) : []),
    ],
    room: workerRoom(night),
    ...(priorLine ? { priorLine } : {}),
    planWindowUntil: planWindowOpen(state, said.now) ? state.planReviewUntil : null,
    workersLimit: workersLimitFacts(state, said.now),
    finishRequested: wake.finishSaid,
    card: cardFacts(night),
  };
}

/** The message that wakes the lead: the user's words, the news, the night, the card and the closing. */
async function wakePrompt(night: Night, wake: WakeState, due: Wake, clock: WakeClock): Promise<string> {
  const now = clock.now();
  const userSays = await tellUser(night, wake);
  const happened = readUnread(night);
  const finishNew = wake.finishNew;
  markSaid(night, wake, due.reasons, now);
  await night.appendRun(RunEvent.DirectorContinued, {
    minutesLeft: minutes(night.softDeadline - now),
    reasons: due.reasons,
  });
  const closing = closingFor(night, wake, due.reasons, now);
  const told = digestFacts(night, wake, { now, reasons: due.reasons, userSays, finishNew, happened, closing });
  const director = night.journal.director;
  const card = JSON.stringify(told.card);
  const includeCard = director.lastWakeCard !== card;
  // Held to its budget (P08-F7): the oldest news gives way first, and the user's words never do.
  const render = (lines: readonly string[]) => wakeDigest({ ...told, happened: lines, userSays: [] }, includeCard);
  const facts = { ...told, happened: fitHappened(told.happened, render, WAKE_TOKEN_BUDGET) };
  const prompt = wakeDigest(facts, includeCard);
  director.lastWakeCard = card;
  // A fresh session opened for this message has never seen the card the digest leaves out (P08-V1).
  wake.cardLeftOut = includeCard ? "" : cardText(facts);
  const estimatedTokens = estimateTokens(wakeDigest({ ...facts, userSays: [] }, includeCard));
  director.wakePayload = {
    estimatedTokens,
    budget: WAKE_TOKEN_BUDGET,
    overBudget: estimatedTokens > WAKE_TOKEN_BUDGET,
    peakEstimatedTokens: Math.max(director.wakePayload?.peakEstimatedTokens ?? 0, estimatedTokens),
    excludes: "user messages, attachments and provider-managed prior context",
  };
  // What the lead has now been told is heard: a restart during its turn does not tell it again.
  await keepWake(night, wake, now);
  return prompt;
}

/** The digest's build card on its own, or nothing from an older wake-prompts.ts that cannot render one. */
function cardText(facts: Parameters<typeof wakeDigest>[0]): string {
  const render = (wakeWords as { buildCard?: (f: typeof facts) => string }).buildCard;
  return typeof render === "function" ? render(facts) : "";
}

/**
 * The news a wake can carry within `budget` tokens of `render`'s text: all of it when it fits;
 * otherwise the newest, halved until it fits, behind one line saying how much was left out (the
 * log still has it — run_status lists it). Exported for the incident tests.
 */
export function fitHappened(
  happened: readonly string[],
  render: (lines: readonly string[]) => string,
  budget: number,
): string[] {
  let kept = [...happened];
  const fits = (lines: readonly string[]) => estimateTokens(render(lines)) <= budget;
  while (!fits(withLeftOut(happened, kept)) && kept.length > 1) kept = kept.slice(-Math.floor(kept.length / 2));
  return withLeftOut(happened, kept);
}

/** `kept`, behind a line naming how many of `all` it leaves out, when it leaves any out. */
function withLeftOut(all: readonly string[], kept: string[]): string[] {
  const left = all.length - kept.length;
  return left > 0
    ? [`(${left} earlier events left out to keep this message short — run_status lists them)`, ...kept]
    : kept;
}

/** A turn that failed outright, as the loop reads it. */
function failedTurn(err: any): Partial<DelegateResult> {
  return { ok: false, stopReason: err?.kind ?? StopReason.Error, errorText: String(err?.message ?? err) };
}

/** Why the lead's session is gone and a fresh one must carry the night, or null when it is not. */
function lostSessionWhy(talk: DirectorTalk, err: any): string | null {
  if (talk.sessionId && isResumeFailure(err)) return SESSION_LOST_WHY.resumeFailed;
  const full = err?.kind === EngineFailure.ContextOverflow || err?.kind === EngineFailure.ContextThreshold;
  return full ? SESSION_LOST_WHY.contextFull : null;
}

/** The lead's notes and the log it has already read, for a fresh session. */
function freshContext(night: Night): { notes: string[]; recent: string[] } {
  const notes = (night.journal.director?.notes ?? []).slice(-FRESH_NOTES).map((n: AnyRecord) => String(n.text));
  const recent = night.state.log
    .filter((entry) => entry.seq <= night.waitSeq)
    .slice(-FRESH_LOG_LINES)
    .map((entry) => entry.text);
  return { notes, recent };
}

/**
 * A new session for a later turn. It knows nothing of the night, so it is told the brief, the
 * rules, the lead's notes, the night so far and this turn's message — never the message alone.
 */
function openFresh(
  night: Night,
  kit: TurnKit,
  turn: TurnAsk,
  { why, card }: { why: string; card: string },
): Promise<Partial<DelegateResult>> {
  const text = freshStart({
    why,
    brief: kit.brief(),
    rules: wakeRules({ heartbeatMinutes: minutes(HEARTBEAT_MS) }),
    ...freshContext(night),
    digest: turn.prompt,
    card,
    lead: Boolean(night.lead),
  });
  return kit.talk.session(text, null, turn.deadline - kit.clock.now());
}

/**
 * The lead's session is lost — it cannot be resumed, or its context is full: a fresh one carries
 * the night (`openFresh`). On the first turn the message already is the brief.
 */
async function freshSession(
  night: Night,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
  why: string,
): Promise<Partial<DelegateResult>> {
  const { talk, clock } = kit;
  if (wake.freshSessions >= MAX_FRESH_SESSIONS)
    return { ok: false, stopReason: StopReason.Error, errorText: `the lead's session was lost too often (${why})` };
  wake.freshSessions += 1;
  talk.sessionId = null;
  // The first turn already carries the brief: a Resume whose old session is gone opens a new one silently.
  if (wake.turns === 1) return talk.session(turn.prompt, null, turn.deadline - clock.now());
  await night.decision(
    `the director's session was lost (${why}); a fresh session carries the run on`,
    "the lead's conversation was lost, so a fresh one picks the build up from its notes",
  );
  return openFresh(night, kit, turn, { why, card: wake.cardLeftOut ?? "" });
}

/**
 * The lead's session asked this turn's message — and asked again, after a wait on the loop's clock,
 * while the host refuses it because another session holds its lock (`folderBusy`): that passes.
 */
async function askSession(night: Night, kit: TurnKit, turn: TurnAsk): Promise<Partial<DelegateResult>> {
  const { talk, clock } = kit;
  for (let tries = 0; ; tries += 1) {
    try {
      return await talk.session(turn.prompt, talk.sessionId, turn.deadline - clock.now());
    } catch (err: any) {
      if (!folderBusy(err) || tries >= MAX_BUSY_RETRIES || night.ctx.cancelled) throw err;
      await clock.sleep(BUSY_RETRY_MS);
    }
  }
}

/**
 * The lead's session asked, with a provider outage waited out on the run's outage ladder within
 * the turn's deadline (P08-F1): an overloaded gateway on one wake used to end the whole night —
 * workers stopped, head landed, night reported done. What the ladder cannot outlast still fails.
 */
function patientSession(night: Night, kit: TurnKit, turn: TurnAsk): Promise<Partial<DelegateResult>> {
  return withProviderPatience(night.ctx, () => askSession(night, kit, turn), {
    deadline: turn.deadline,
    delays: outageDelays(night.run),
    label: "the lead's provider",
    onWait: ({ wait, error }) =>
      night.decision(
        `the lead's provider failed (${error}); asking it again in ${Math.ceil(wait / SECOND_MS)} s`,
        "the lead's provider is briefly down, so the studio waits and asks again; the builders keep working",
      ),
  });
}

/**
 * One delegation of the lead's session, or a fresh session when its own is lost — or when a later
 * turn has none to resume (a fresh one that met the engine's limit before it began). A failure on
 * the first turn is the night's (the crash close); on a later one it is a failed turn — and so is a
 * first turn the host kept refusing because its lock stayed busy: the night closes on its own terms.
 */
async function sessionOrFresh(
  night: Night,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
): Promise<Partial<DelegateResult>> {
  const { talk } = kit;
  const failed = (err: any): Partial<DelegateResult> => {
    if (wake.turns === 1 && !folderBusy(err)) throw err;
    return failedTurn(err);
  };
  if (!talk.sessionId && wake.turns > 1)
    return openFresh(night, kit, turn, { why: SESSION_LOST_WHY.noSession, card: wake.cardLeftOut ?? "" }).catch(failed);
  let result: Partial<DelegateResult>;
  try {
    result = await patientSession(night, kit, turn);
  } catch (err: any) {
    const why = lostSessionWhy(talk, err);
    if (!why) return failed(err);
    return freshSession(night, wake, kit, turn, why).catch(failed);
  }
  if (result?.stopReason !== StopReason.ContextOverflow) return result;
  return freshSession(night, wake, kit, turn, SESSION_LOST_WHY.contextOverflowed).catch(failed);
}

/** Is the lead's own session limit one to wait out: a rate limit that resets well before this turn's deadline? */
function limitToWait(night: Night, wake: WakeState, deadline: number, now: number): boolean {
  const { ctx, state } = night;
  const limit = state.limit;
  if (!limit || limit.kind !== EngineFailure.RateLimit || state.finished || ctx.cancelled) return false;
  const waitMs = limit.retryAfterMs ?? 0;
  const resetsInTime = now + waitMs + LIMIT_WAIT_MARGIN_MS <= deadline;
  return waitMs > 0 && wake.limitWaits < MAX_LIMIT_WAITS && resetsInTime;
}

/** Wait `ms` on the loop's clock, reading the inbox as the lead would; false when the user stopped the night. */
async function sleepThrough(night: Night, wake: WakeState, ms: number, clock: WakeClock): Promise<boolean> {
  const until = clock.now() + ms;
  while (clock.now() < until && !night.ctx.cancelled) {
    await collect(night, wake, clock.now());
    await clock.sleep(Math.min(WAKE_POLL_MS, until - clock.now()));
  }
  return !night.ctx.cancelled;
}

/**
 * What the lead is told after a limit it was made to wait out: that, this turn's message, and
 * what happened since. With no session to resume it goes out inside a fresh start (`sessionOrFresh`).
 */
async function retryPrompt(night: Night, wake: WakeState, kit: TurnKit, turn: { prompt: string }, waitMs: number) {
  // The brief already reached a session that exists; a wake's message may not have.
  const again = wake.turns > 1 || !kit.talk.sessionId ? turn.prompt : "";
  // The words that message carried ride again with it.
  const carried = again ? wake.promptWords : [];
  const userSays = await tellUser(night, wake);
  wake.promptWords = [...carried, ...userSays];
  const happened = readUnread(night);
  return [limitResumePrompt(minutes(waitMs)), again, sinceThen({ userSays, happened })].filter(Boolean).join("\n\n");
}

/**
 * The lead's own session limit, on any turn: one that resets well before the turn's deadline is
 * waited out while the workers keep going, and the same session carries on.
 */
async function waitOutLimit(
  night: Night,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
  first: Partial<DelegateResult>,
): Promise<Partial<DelegateResult>> {
  let result = first;
  while (limitToWait(night, wake, turn.deadline, kit.clock.now())) {
    const waitMs = night.state.limit?.retryAfterMs ?? 0;
    wake.limitWaits += 1;
    await night.decision(
      `waiting ${minutes(waitMs)} minutes for the engine's limit to reset; the workers keep going`,
      `waiting about ${minutes(waitMs)} minutes for that limit to reset; the builders keep working`,
    );
    if (!(await sleepThrough(night, wake, waitMs, kit.clock))) return result;
    night.state.limit = null;
    const prompt = await retryPrompt(night, wake, kit, turn, waitMs);
    result = await watchedSession(night, wake, kit, { prompt, deadline: turn.deadline });
  }
  return result;
}

/**
 * One turn of the lead's session, its limit waits included: until the working deadline, or the
 * night's end for the wrap-up. A turn that works on its message has heard what that message told it.
 */
async function oneTurn(night: Night, wake: WakeState, kit: TurnKit, prompt: string): Promise<Partial<DelegateResult>> {
  wake.turns += 1;
  const deadline = wake.wrapping ? night.finalDeadline - WRAP_UP_MARGIN_MS : night.softDeadline;
  const turn = { prompt, deadline };
  const result = await waitOutLimit(night, wake, kit, turn, await watchedSession(night, wake, kit, turn));
  await settleTold(wake, result);
  await kit.talk.keep(result);
  return result;
}

/**
 * The user's words a turn's message told: heard once the turn works on it, or answers; owed to the
 * next message when it failed first (an error, a limit) — unless it was cut before it read it, and
 * is asked that same message again (`takeTurn`). A failed turn is followed by the wrap-up or the
 * close (`afterTurn`), so owed words are said at most once more.
 */
async function settleTold(wake: WakeState, result: Partial<DelegateResult>): Promise<void> {
  const worked = result?.ok === true || startedWorking(result);
  if (!worked && wake.cut) return;
  if (worked) await wake.line?.heardThrough(wake.promptThrough);
  else wake.owed.unshift(...wake.promptWords);
  wake.promptWords = [];
}

/** Did the session read its message before it ended: it has a session and took a turn. */
const startedWorking = (result: Partial<DelegateResult>): boolean =>
  Boolean(result?.sessionId) && (result?.turns ?? 0) > 0;

/**
 * One turn of the lead's, and its resumptions. A turn cut short to hand the lead the user's words
 * is resumed at once in the same session, told it was cut, their words first (a wake of the
 * user's) — or, cut before it read its message, asked that message again with their words after
 * it. A cut is never a failed turn.
 */
async function takeTurn(night: Night, wake: WakeState, kit: TurnKit, prompt: string): Promise<Partial<DelegateResult>> {
  let asked = prompt;
  let result = await oneTurn(night, wake, kit, asked);
  while (wake.cut && !nightOver(night)) {
    wake.cut = false;
    asked = startedWorking(result)
      ? cutShortWake(
          await wakePrompt(night, wake, { at: kit.clock.now(), reasons: [WakeCause.UserMessage] }, kit.clock),
        )
      : await askAgain(night, wake, asked);
    result = await oneTurn(night, wake, kit, asked);
  }
  wake.cut = false;
  return result;
}

/** A turn cut before it read its message is asked it again — its words and all — with the user's newer words after it. */
async function askAgain(night: Night, wake: WakeState, asked: string): Promise<string> {
  const carried = wake.promptWords;
  const userSays = await tellUser(night, wake);
  wake.promptWords = [...carried, ...userSays];
  return [asked, sinceThen({ userSays, happened: [] })].filter(Boolean).join("\n\n");
}

/**
 * A later turn with a session to resume may be cut short for the user's words: never the first
 * (its brief), the wrap-up, a turn whose night is already over (its `finish` may be under way), or
 * one inside a tool call — cut there, the lead never gets the call's answer (tools.ts counts them).
 */
function mayCut(night: Night, wake: WakeState, kit: TurnKit): boolean {
  const later = wake.turns > 1 && Boolean(kit.talk.sessionId);
  const inCall = (night.toolsInFlight ?? 0) > 0;
  return later && !inCall && !wake.wrapping && !nightOver(night);
}

/**
 * What a turn under way was handed to read at its next step, by the id it went in under: the words,
 * and how many of the chat's messages the line had been handed then.
 */
type Handed = Map<string, { words: string[]; through: number }>;

/**
 * Hand the user's words to the lead's turn under way (`engine.steer`, addressed by the run): an
 * engine that reads input mid-turn takes them at its next step (`handed`, settled against what the
 * turn says it read); one that cannot is cut short when `mayCut`, and resumed with them
 * (`wake.cut`) — asked with `interrupt: false` otherwise. Words neither took open the lead's next
 * message.
 */
async function handMidTurn(night: Night, wake: WakeState, kit: TurnKit, handed: Handed, id: string): Promise<void> {
  // A night that is over hears nothing more: what was sent stays untold rather than said to no one.
  if (nightOver(night)) return;
  const { words, through } = await userWords(night, wake);
  if (!words.length) return;
  const answer = await night.ctx
    .call(HostMethod.EngineSteer, {
      threadId: night.threadId,
      into: night.run.runId,
      messages: [{ id, text: midTurnUserSays(words) }],
      interrupt: mayCut(night, wake, kit),
    })
    .catch(() => null);
  const how = answer?.accepted.includes(id) ? answer.how : null;
  if (how === SteerDelivery.Native) {
    handed.set(id, { words, through });
    return;
  }
  wake.owed.push(...words);
  if (how === SteerDelivery.Interrupt) wake.cut = true;
}

/**
 * Watch a session call under way for the user's words (live chat): at once, then each time a
 * message is handed to the lead, until the call ends or it is cut short for them.
 */
function watchTurn(night: Night, wake: WakeState, kit: TurnKit, line: LeadLine) {
  const handed: Handed = new Map();
  let over = false;
  let count = 0;
  let end = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const watching = (async () => {
    while (!over && !wake.cut) {
      const next = line.heard();
      await handMidTurn(night, wake, kit, handed, `lead_${wake.turns}_${++count}`);
      await Promise.race([next, ended]);
    }
  })();
  const stop = async (): Promise<void> => {
    over = true;
    end();
    await watching.catch(() => {});
  };
  return { handed, stop };
}

/** One session call, watched for the user's words while it runs; what it read is heard, what it did not is owed. */
async function watchedSession(
  night: Night,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
): Promise<Partial<DelegateResult>> {
  if (!kit.line) return sessionOrFresh(night, wake, kit, turn);
  const watch = watchTurn(night, wake, kit, kit.line);
  let result: Partial<DelegateResult> | undefined;
  try {
    result = await sessionOrFresh(night, wake, kit, turn);
    return result;
  } finally {
    await watch.stop();
    let read = 0;
    for (const [id, told] of watch.handed) {
      if (result?.steered?.includes(id)) read = Math.max(read, told.through);
      else wake.owed.push(...told.words);
    }
    await kit.line.heardThrough(read);
  }
}

/** The journal keeps the loop's own state and the night's record (night.ts `saveJournal`) as they stand now. */
async function keepWake(night: Night, wake: WakeState, now: number): Promise<void> {
  journalWake(night, wake);
  wake.journaledSeq = night.logSeq;
  wake.journaledAt = now;
  await night.saveJournal();
}

/**
 * The lead rests: its own lines up to here are quiet, the journal holds what a restart needs, and
 * a round that lands from now on is saved with the wake it causes (`night.resting`).
 */
async function rest(night: Night, wake: WakeState, now: number): Promise<void> {
  wake.asleepFromSeq = night.logSeq;
  wake.asleepSince = now;
  night.resting = true;
  await keepWake(night, wake, now);
}

/**
 * The night as a series of the lead's turns. The first opens with the brief and the rules; each
 * later one is a wake with a digest; the wrap-up is the last. Returns when the night is over for
 * the lead — finished, stopped, paused on a limit, wrapped up, or out of time — and the caller
 * closes what it left open.
 */
export async function runWakeLoop(
  night: Night,
  talk: DirectorTalk,
  brief: () => string,
  clock: WakeClock = SYSTEM_CLOCK,
  line: LeadLine | null = null,
): Promise<WakeOutcome> {
  // A resumed night takes back what its journal kept of the loop: the idle question, the wake cap.
  const restored = resumedFromJournal(night)
    ? restoredWake(night.priorJournal?.director?.wake, clock.now())
    : undefined;
  const wake = newWakeState(restored);
  const kit: TurnKit = { talk, brief, clock, line };
  // This loop answers for what its lead hears of the chat: what it never hears goes back at the end.
  wake.line = line;
  line?.attend();
  // The parts the lead calls (the plan hold, worker_start) answer a night the wake loop drives
  // with "end your turn"; a kept older director.ts runs the long turn and never marks its night.
  night.waking = true;
  // Working time already over — a Resume after it, or a start that took all of it: the first turn is the wrap-up.
  if (clock.now() >= night.softDeadline) {
    wake.wrapping = true;
    wake.wrapCause = WrapCause.Deadline;
  }
  const first = await firstPrompt(night, wake, brief, clock.now());
  // The wrap-up takes no more of the chat: what is sent from now on waits for the night to close.
  if (wake.wrapping) line?.shut();
  let result = await takeTurn(night, wake, kit, first);
  for (;;) {
    const verdict = afterTurn(await turnFacts(night, wake, result, clock.now()));
    if (verdict.next === TurnEnd.Close) break;
    settleTurn(night, wake, verdict, result, clock.now());
    await rest(night, wake, clock.now());
    const due = await sleepUntilDue(night, wake, kit);
    night.resting = false;
    if (!due) break;
    const prompt = await wakePrompt(night, wake, due, clock);
    if (wake.wrapping) line?.shut();
    result = await takeTurn(night, wake, kit, prompt);
  }
  journalWake(night, wake);
  return { result, wrapCause: wake.wrapCause, failed: wake.failed };
}

/**
 * Put the wake loop's own state on the journal (`journal.director.wake`, journal.ts `wakeRecord`),
 * and the night's record with it: a kept night.ts from before the full journal saves without
 * writing the record (`recordNight` is idempotent). The caller saves it.
 */
export function journalWake(night: Night, wake: WakeState): void {
  const director = night.journal?.director;
  if (!director) return;
  recordNight(night);
  director.wake = wakeRecord(wake);
}
