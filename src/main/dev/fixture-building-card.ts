/**
 * The `building-card` fixture: a racing Loop still going, for the chat's Building card and its list
 * of parts, after an earlier Loop of the same chat that finished, so Builds has two tabs. Of the
 * plan's five parts two are added, one works on its second round with its time left, one was
 * stopped and restarted (`replaces`, one row) and works on its first round, and one has not
 * started; the Loop was given 4 hours. Written once the app has started: the start closes every run
 * an earlier app left open, so a Loop still going written before it would read as stopped.
 */
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { HOUR_MS, MINUTE_MS } from "../../shared/duration.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import { EngineId } from "../../shared/providers.ts";
import { WorkerEnd, WorkerIsolation, WorkerStopCode } from "../../shared/workers.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun } from "./fixture-kit.ts";

const RUN_ID = "fixture-building-card";
const GOAL = "Make a night street race on rain-slicked city streets.";
/** The chat's earlier Loop, finished: its own tab on Builds. */
const EARLIER_RUN_ID = "fixture-building-card-earlier";
const EARLIER_GOAL = "Give the cars arcade handling and a drift boost.";
/** The time the Loop was given, shown under the card's clock ("up to 4h"). */
const LOOP_MS = 4 * HOUR_MS;
/** How long the car part's round has left when the fixture is written. */
const CARS_LEFT_MS = 25 * MINUTE_MS;

/** The plan's parts, in its order: id and title. */
const PLAN: ReadonlyArray<[string, string]> = [
  ["hud", "Speed and lap HUD"],
  ["track", "Track and night city"],
  ["cars", "Cars: clear-coat finish"],
  ["world", "World: building facades"],
  ["sound", "Engine, tyres and rain"],
];

/** Records of the run. */
type Scoped = ReturnType<typeof fixtureRun>;

/** A worker starting its first round. */
function begins(run: Scoped, workerId: string, title: string, extra: Record<string, unknown> = {}): EventData[] {
  return [
    run(CustomEvent.WorkerStarted, { workerId, title, isolation: WorkerIsolation.Copy, task: title }),
    run(CustomEvent.DirectorWorker, { workerId, title, mode: "loop", state: "running", ...extra }),
    run(CustomEvent.FacetBuildStarted, { facetId: workerId, facetTitle: title, iteration: 1 }),
  ];
}

/** A round's end: judged and kept, or stopped before a verdict. */
function roundEnds(run: Scoped, workerId: string, title: string, stopped: string | null): EventData {
  return run(CustomEvent.FacetIteration, {
    facetId: workerId,
    facetTitle: title,
    iteration: 1,
    winner: stopped ? null : "challenger",
    satisfied: false,
    verdictSource: stopped ? "stopped" : "checks",
    reason: stopped ?? "the checks it was given now pass",
    shots: [],
    flags: [],
    diffs: {},
  });
}

/** A worker whose kept round the lead merged into the build. */
function added(run: Scoped, workerId: string, title: string, head: string): EventData[] {
  return [
    ...begins(run, workerId, title),
    roundEnds(run, workerId, title, null),
    run(CustomEvent.DirectorWorker, { workerId, title, mode: "loop", state: "done" }),
    run(CustomEvent.WorkerFinished, { workerId, title, state: WorkerEnd.Done }),
    run(CustomEvent.IntegrationMerge, { facetId: workerId, commit: head, head, conflict: false, stage: "director" }),
  ];
}

/** The chat's earlier Loop: two parts, both added, and its close. */
function finishedLoop(project: string): EventData[] {
  const run = fixtureRun({ runId: EARLIER_RUN_ID, project });
  return [
    { type: EventKind.Messages, messages: [{ role: "user", content: EARLIER_GOAL }] },
    run(CustomEvent.RunStarted, { goal: EARLIER_GOAL, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 2, facets: [], workerRecords: true }),
    run(CustomEvent.AutopilotPlanReview, {
      summary: "Arcade handling for every car, and a boost for holding a drift.",
      waitMinutes: 0,
      facets: [
        { id: "handling", title: "Arcade handling", identity: [], cameras: [], checks: [] },
        { id: "drift", title: "Drift boost", identity: [], cameras: [], checks: [] },
      ],
    }),
    ...added(run, "handling", "Arcade handling", "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d"),
    ...added(run, "drift", "Drift boost", "0b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e"),
    run(CustomEvent.RunFinished, { stoppedBecause: "both parts were added and checked" }),
  ];
}

/** The Loop: its plan, two parts added, one at work with its time left, one restarted, one waiting. */
function buildingLoop(project: string, now: number): EventData[] {
  const run = fixtureRun({ runId: RUN_ID, project });
  const stopped = "stopped by the director: the facades start again on the new street grid";
  return [
    { type: EventKind.Messages, messages: [{ role: "user", content: GOAL }] },
    run(CustomEvent.RunStarted, {
      goal: GOAL,
      engine: EngineId.ClaudeCode,
      model: FIXTURE_MODEL,
      budgets: { wallClockMs: LOOP_MS },
    }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 3, facets: [], workerRecords: true }),
    run(CustomEvent.AutopilotPlanReview, {
      summary: "A night street race: a lit circuit, cars with a wet finish, and their sound.",
      waitMinutes: 0,
      facets: PLAN.map(([id, title]) => ({ id, title, identity: [], cameras: [], checks: [] })),
    }),
    ...added(run, "hud", "Speed and lap HUD", "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"),
    ...added(run, "track", "Track and night city", "2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e"),
    run(CustomEvent.WorkerStarted, {
      workerId: "cars",
      title: "Cars: clear-coat finish",
      isolation: WorkerIsolation.Copy,
    }),
    run(CustomEvent.DirectorWorker, {
      workerId: "cars",
      title: "Cars: clear-coat finish",
      mode: "loop",
      state: "running",
    }),
    run(CustomEvent.FacetBuildStarted, {
      facetId: "cars",
      facetTitle: "Cars: clear-coat finish",
      iteration: 2,
      deadlineMs: now + CARS_LEFT_MS,
    }),
    ...begins(run, "world", "World: building facades"),
    roundEnds(run, "world", "World: building facades", stopped),
    run(CustomEvent.DirectorWorker, {
      workerId: "world",
      title: "World: building facades",
      mode: "loop",
      state: "stopped",
      stoppedBecause: stopped,
    }),
    run(CustomEvent.WorkerFinished, {
      workerId: "world",
      title: "World: building facades",
      state: WorkerEnd.Stopped,
      stopCode: WorkerStopCode.StoppedByLead,
    }),
    ...begins(run, "world-2", "World: building facades", { replaces: "world" }),
  ];
}

/** Writes the Loop into the game's chat once; a profile reused after its first start keeps it. */
export async function seedBuildingCard(core: StudioCore, project: string, threadId: string): Promise<void> {
  const events = await core.store.listEvents(threadId);
  if (events.some((e) => customRecord(e.data)?.payload.runId === RUN_ID)) return;
  await core.append([...finishedLoop(project), ...buildingLoop(project, Date.now())], threadId);
}
