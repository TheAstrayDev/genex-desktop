/**
 * The art director (loop/ship-review.ts, director/art-direction.ts), without a rig: one absolute
 * look at the whole game — every camera it registered, its eyes, its demos' end frames and its
 * motion — asked "would you ship this as the user's demo today?", with each defect typed to the
 * plan part that owns it. The lead can ask for it (`judge ship=yes`); the studio runs it itself at
 * the finish mark of a timed build, and once for a goal build whose lead idles or finishes with no
 * review on its head. Its defects go to their owners' boards as the director's own checks. It is
 * reported, never a landing veto. Every clock here is a number the test chooses, and the judge is
 * a host that answers what the row needs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { blindCompare } from "../../src/harness-seed/loop/judge.ts";
import { createScope } from "../../src/harness-seed/loop/scope.ts";
import { CheckOrigin, CheckWeight } from "../../src/harness-seed/loop/spec.ts";
import { strongFlips } from "../../src/harness-seed/loop/facet/rules.ts";
import { FacetStage } from "../../src/harness-seed/loop/facet/stage.ts";
import { DefectSeverity, SHIP_REVIEW_IMAGES, SHIP_VIEW, shipReview } from "../../src/harness-seed/loop/ship-review.ts";
import * as nightFunctions from "../../src/harness-seed/loop/director/night.ts";
import * as toolFunctions from "../../src/harness-seed/loop/director/tools.ts";
import * as workerFunctions from "../../src/harness-seed/loop/director/workers.ts";
import * as integrateFunctions from "../../src/harness-seed/loop/director/integrate.ts";
import * as artDirectionFunctions from "../../src/harness-seed/loop/director/art-direction.ts";
import { shipDefectsToChecks } from "../../src/harness-seed/loop/director/art-direction.ts";
import { SHIP_QUESTION } from "../../src/harness-seed/loop/director/art-direction-prompts.ts";
import { finishMarkMs } from "../../src/harness-seed/loop/director/budgets.ts";
import { priorWorkersStatus, restoreNight } from "../../src/harness-seed/loop/director/journal.ts";
import { runWakeLoop, type DirectorTalk, type WakeClock } from "../../src/harness-seed/loop/director/wake.ts";
import { WakeCause } from "../../src/harness-seed/loop/director/wake-schedule.ts";
import { HOUR_MS, MINUTE_MS } from "../../src/harness-seed/loop/time.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const T0 = Date.UTC(2026, 9, 6, 1, 0, 0);
const FORK = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BRIEF = () => "You are the DIRECTOR of run run_ad";

/** The plan's parts, as `plan` keeps them. */
const PARTS = [
  { id: "hud", title: "The race HUD", seam: "the screen", owns: ["src/hud.js"] },
  { id: "track", title: "The track", seam: "the road", owns: ["src/track.js"] },
];

/** A frame with pixels. */
const shot = (camera: string) => ({ camera, path: `/frames/${camera}.jpg`, base64: `px-${camera}` });

/** A whole game's evidence: registered cameras, the player's eyes, a demo's end, the user's view and motion. */
function gameEvidence(cameras: readonly string[] = ["default", "chase", "side", "top", "finish", "pit"]) {
  return {
    ok: true,
    problems: [],
    warnings: [],
    consoleErrors: [],
    shots: [
      ...cameras.map(shot),
      shot("eye:spawn"),
      shot("eye:here"),
      shot("eye:down"),
      shot("demo:lap"),
      shot("user:view"),
    ],
    motion: Array.from({ length: 6 }, (_, i) => ({ base64: `motion-${i + 1}` })),
    state: { speed: 41, lap: 2 },
    registeredCameras: [...cameras],
  };
}

/** The art director's answer: a blocker in the HUD, a visible fault in the track, a nit nobody owns. */
const SHIP_NO = {
  ship: false,
  defects: [
    { what: "the speed digits are cut off at the right edge", camera: "default", part: "hud", severity: "blocker" },
    { what: "the road texture swims as the car moves", camera: "chase", part: "track", severity: "visible" },
    { what: "one stray pixel above the sky", camera: "top", part: null, severity: "nit" },
  ],
  strengths: ["the dusk light"],
  reason: "the HUD is broken at a glance",
};

/** What the fake host saw: every call, and each journal as it was written. */
interface FakeHost {
  calls: Array<{ method: string; params: Record<string, any> }>;
  journals: Array<Record<string, any>>;
}
const fakeHost = (): FakeHost => ({ calls: [], journals: [] });

/** The judge's reply, as the engine would give it. */
const replying = (reply: unknown) => () => ({
  message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) },
  model: "judge-model",
});

/** A loop worker building its part, with a board the router can add to. */
function loopWorker(id: string, over: Record<string, unknown> = {}) {
  let settle = () => {};
  return {
    id,
    title: id,
    mode: "loop",
    brief: `Build ${id}`,
    owns: [`src/${id}.js`],
    ownsMain: false,
    cameras: ["default"],
    identity: [],
    setup: null,
    from: FORK,
    replaces: null,
    baseConsole: [],
    worktree: `/runs/run_ad/${id}`,
    handle: null,
    threadId: `t-${id}`,
    startedAt: T0,
    endedAt: null,
    deadline: T0 + 4 * HOUR_MS,
    state: "running",
    stopRequested: false,
    stopWhy: null,
    iterationsCap: undefined,
    steering: [] as string[],
    iterations: [],
    roundMs: [],
    lastIterationAt: null,
    monitor: null,
    result: null,
    lastCommit: null,
    summary: "",
    error: null,
    spec: { id, title: id, intent: "", brief: "", checks: [] as Array<Record<string, unknown>>, cameras: ["default"] },
    problems: [],
    unsatisfiable: [],
    stateKeys: null,
    notVerified: null,
    rarelyMeasurable: [],
    policy: {},
    policyOverrides: {},
    loop: null,
    settled: false,
    settle: new Promise<void>((resolve) => {
      settle = resolve;
    }),
    resolveSettle: () => settle(),
    ...over,
  };
}

/**
 * A night as prepareNight leaves it — its data plain, its parts the real ones, bound the way
 * `bindNight` binds them — on a host that records what it is asked. Its looks are the given
 * evidence (`seen` keeps what each look was asked), on a window it is always lent.
 */
function fakeNight(
  host: FakeHost,
  {
    over = {},
    answers = {},
    evidence = gameEvidence(),
    budgets = { wallClockMs: 5 * HOUR_MS, completionPolicy: "duration" },
    clock = { started: T0, softDeadline: T0 + 4 * HOUR_MS, finalDeadline: T0 + 4 * HOUR_MS + 15 * MINUTE_MS },
  }: {
    over?: Record<string, unknown>;
    answers?: Record<string, unknown>;
    evidence?: Record<string, unknown>;
    budgets?: Record<string, unknown>;
    clock?: { started: number; softDeadline: number; finalDeadline: number };
  } = {},
) {
  const run = {
    runId: "run_ad",
    project: "derby",
    goal: "a night race around the plaza",
    engine: "codex",
    reference: { name: "Night race", shots: [] },
    budgets,
  };
  const ctx = {
    threadId: "t1",
    cancelled: false,
    workspace: "/nowhere",
    setStatus: () => {},
    notify: () => {},
    call: async (method: string, params: Record<string, any>) => {
      host.calls.push({ method, params });
      if (method === HostMethod.ArtifactWrite) host.journals.push(structuredClone(params.value));
      if (method === HostMethod.PreviewScreens) return [];
      const answer = answers[method];
      return typeof answer === "function" ? answer(params) : (answer ?? null);
    },
  };
  const data = {
    ctx,
    threadId: "t1",
    run,
    resume: false,
    inbox: {
      steering: async () => [],
      finishing: async () => false,
      addressed: async () => [],
      backlog: async () => [],
    },
    started: clock.started,
    softDeadline: clock.softDeadline,
    finalDeadline: clock.finalDeadline,
    clock: { ...clock },
    priorJournal: null,
    report: { notes: [], workers: {}, iterations: [], verdicts: [] },
    integrationWorktree: "/runs/run_ad/integration",
    integrationRef: "refs/studio/runs/run_ad/integration",
    baseCommit: FORK,
    projectDir: "/games/derby",
    state: {
      run,
      workers: new Map(),
      ledger: [] as Array<Record<string, unknown>>,
      log: [] as Array<Record<string, unknown>>,
      plan: { summary: "A night race.", workers: PARTS } as Record<string, unknown> | null,
      planReviewUntil: null as number | null,
      planGo: true,
      planSaidFrom: 0,
      integrationHead: HEAD,
      integrationHealthy: true as boolean | null,
      workerLimit: null as Record<string, unknown> | null,
      limit: null,
      lastJudge: null,
      finish: null,
      finished: false,
      monitor: null as Promise<unknown> | null,
      fromScratch: false,
      startEvidence: null as Record<string, unknown> | null,
      healthByHead: new Map<string, boolean>([[HEAD, true]]),
      consoleByHead: new Map<string, string[]>(),
      evidenceByHead: new Map(),
      baseHeads: new Set<string>([FORK]),
      facetSpecs: [],
      judges: 0,
      plays: 0,
      softDeadline: clock.softDeadline,
      finalDeadline: clock.finalDeadline,
    },
    journal: { runId: "run_ad", run, director: { sessionId: null, workers: {}, notes: [] }, plan: {} },
    logSeq: 0,
    waitSeq: 0,
    tonight: [],
    priorLedger: [],
    ledgerWrites: Promise.resolve(),
    ...over,
  };
  const night = nightFunctions.bindNight(data as never, [
    nightFunctions,
    workerFunctions,
    toolFunctions,
    integrateFunctions,
    artDirectionFunctions,
  ]) as any;
  const seen: Array<Record<string, any>> = [];
  night.withLease = async (_label: string, fn: (handle: string | null) => Promise<unknown>) => fn("h1");
  night.patientEvidence = async (root: string, options: Record<string, any>) => {
    seen.push({ root, ...options });
    return structuredClone(evidence);
  };
  return { night, seen };
}

/** The labels of the images the judge was shown, call by call. */
const imageLabels = (host: FakeHost): string[][] =>
  host.calls
    .filter((c) => c.method === HostMethod.EngineComplete)
    .map((c) => (c.params.messages?.[0]?.images ?? []).map((image: { label: string }) => image.label));

/** The loop's clock, moved by its own sleeps; `onSleep` runs after each. */
function fakeClock(start: number, onSleep: (now: number) => void = () => {}): WakeClock & { at: number } {
  const clock = {
    at: start,
    now: () => clock.at,
    sleep: async (ms: number) => {
      clock.at += ms;
      onSleep(clock.at);
    },
  };
  return clock;
}

/** The lead's session: each turn answered by `script`, every prompt kept. */
function lead(script: (turn: number) => Record<string, unknown>) {
  const turns: Array<{ prompt: string }> = [];
  const talk: DirectorTalk = {
    sessionId: "lead-1",
    keep: async () => {},
    session: async (prompt) => {
      turns.push({ prompt });
      return script(turns.length);
    },
  };
  return { talk, turns };
}

describe("the art director's question (loop/ship-review.ts)", () => {
  it("AD-1. the ship review is shown every camera the build registered and the motion strip, is asked an absolute question with no BUILD B, and keeps a defect's part only when it is one of the plan's parts", async () => {
    const recorder = ctxRecorder({
      handlers: {
        "engine.complete": replying({
          ...SHIP_NO,
          defects: [
            SHIP_NO.defects[0],
            { what: "the radio hisses", camera: "default", part: "radio", severity: "loud" },
          ],
        }),
      },
    });
    const run = {
      runId: "run_ad",
      project: "derby",
      goal: "a night race around the plaza",
      reference: { name: "Night race", shots: [] },
      scope: createScope({ asked: ["a night race around the plaza"], cut: ["online multiplayer"] }),
    };
    const review = await shipReview(recorder.ctx as never, {
      run: run as never,
      evidence: gameEvidence() as never,
      parts: PARTS,
    });

    const request = recorder.paramsOf("engine.complete")[0] as Record<string, any>;
    const labels: string[] = request.messages[0].images.map((image: { label: string }) => image.label);
    for (const camera of [
      "default",
      "chase",
      "side",
      "top",
      "finish",
      "pit",
      "eye:spawn",
      "eye:here",
      "eye:down",
      "demo:lap",
    ])
      assert.ok(
        labels.some((label) => label.endsWith(camera)),
        `${camera} is shown: ${labels.join(", ")}`,
      );
    assert.ok(!labels.some((label) => label.includes("user:view")), "the user's view is not the art director's frame");
    assert.equal(labels.filter((label) => /MOTION/.test(label)).length, 3, "first, middle and last motion frames");
    assert.ok(labels.length <= SHIP_REVIEW_IMAGES, `${labels.length} images`);
    const asked = String(request.messages[0].content);
    assert.doesNotMatch(asked, /BUILD B/, "one build, no comparison");
    assert.match(asked, /hud/, "the plan's parts are named as data");
    assert.match(asked, /online multiplayer/, "the user's cut is in the review's scope, so it is never asked for");

    assert.equal(review.ship, false);
    assert.deepEqual(
      review.defects.map((d) => [d.part, d.severity]),
      [
        ["hud", DefectSeverity.Blocker],
        [null, DefectSeverity.Visible],
      ],
      "a part that is not the plan's is nobody's, and an unknown severity is visible",
    );

    const prose = ctxRecorder({ handlers: { "engine.complete": replying("Looks great, ship it!") } });
    const unusable = await shipReview(prose.ctx as never, {
      run: run as never,
      evidence: gameEvidence() as never,
      parts: PARTS,
    });
    assert.equal(unusable.ship, null, "an answer nobody can read is no verdict, never a no");
    assert.deepEqual(unusable.defects, []);
    assert.equal(unusable.parse, "invalid");
  });
});

describe("the lead's judge ship=yes (director/tools.ts)", () => {
  it("AD-2. judge ship=yes on integration answers ship and the defects grouped by the part that owns them, writes them into judge_<n>/verdict.json and keeps them for that head across a Resume", async () => {
    const host = fakeHost();
    const { night, seen } = fakeNight(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    night.state.workers.set("hud", loopWorker("hud"));
    night.state.workers.set("track", loopWorker("track", { state: "done", endedAt: T0 + HOUR_MS }));

    const answer = JSON.parse(await night.judge({ target: "integration", against: "none", ship: "yes" }));

    assert.deepEqual(seen[0]!.viewport, SHIP_VIEW, "AD-6: the whole game is looked at at 1600×900");
    assert.deepEqual(SHIP_VIEW, { width: 1600, height: 900 });
    assert.equal(answer.ship.ship, false);
    assert.match(answer.ship.defectsByPart.hud.join(" "), /speed digits/);
    assert.match(answer.ship.defectsByPart.track.join(" "), /road texture/);
    assert.equal(Object.keys(answer.ship.defectsByPart).length, 3, "the unowned nit has a group of its own");
    assert.match(answer.ship.next, /stage=finish/);

    const written = host.calls.find(
      (c) => c.method === HostMethod.RunArtifact && c.params.name === "director/judge_1/verdict.json",
    )!;
    const verdict = JSON.parse(Buffer.from(written.params.base64, "base64").toString("utf8"));
    assert.equal(verdict.ship.ship, false);
    assert.equal(verdict.ship.defects.length, 3);
    assert.ok(
      night.report.verdicts.some((v: Record<string, unknown>) => JSON.stringify(v).includes(SHIP_QUESTION)),
      "the ship review is a judge verdict on the record, asked its own question",
    );

    // Each defect went to its owner: the running hud worker's board, the finished track's ledger line, the lead's.
    const hud = night.state.workers.get("hud");
    const routed = hud.spec.checks.find((c: Record<string, unknown>) => /speed digits/.test(String(c.defect)));
    assert.equal(routed?.origin, CheckOrigin.Director);
    assert.equal(routed?.weight, CheckWeight.Identity);
    assert.ok(
      hud.steering.some((line: string) => /speed digits/.test(line)),
      "and the worker is told",
    );
    assert.deepEqual(
      night.state.ledger.map((d: Record<string, unknown>) => d.owner).sort(),
      ["integration", "track"],
      "a finished part's defect waits under that part, an unowned one is the lead's",
    );

    assert.equal(night.state.lastShip.head, HEAD);
    assert.equal(night.state.lastShip.ship, false);
    const saved = host.journals.at(-1)!;
    const resumed = fakeNight(fakeHost(), { over: { resume: true, priorJournal: saved } }).night;
    restoreNight(resumed);
    assert.equal(resumed.state.lastShip.head, HEAD, "a Resume keeps the review of that head");
    assert.equal(resumed.state.lastShip.defects.length, 3);
  });

  it("AD-4. a ship defect lands on the board of the running worker whose part it names as a director check, weighted by severity, and its fix is a strong flip", () => {
    const hud = loopWorker("hud");
    const workers = new Map<string, any>([
      ["hud", hud],
      ["track", loopWorker("track", { state: "done" })],
    ]);
    const routes = shipDefectsToChecks(
      {
        ship: false,
        defects: [...SHIP_NO.defects, { ...SHIP_NO.defects[0]!, what: "the lap counter flickers", severity: "nit" }],
      } as never,
      workers as never,
    );
    assert.deepEqual(
      routes.map((r) => r.part),
      ["hud", "track", null, "hud"],
    );
    const [blocker, , nit, hudNit] = routes;
    assert.equal(blocker!.check.origin, CheckOrigin.Director);
    assert.equal(blocker!.check.kind, "vision");
    assert.equal(blocker!.check.expect, "yes");
    assert.equal(blocker!.check.camera, "default");
    assert.match(String(blocker!.check.ask), /^Is this gone\?/);
    assert.equal(blocker!.check.weight, CheckWeight.Identity);
    assert.equal(hudNit!.check.weight, CheckWeight.Normal, "a nit counts, but decides nothing");
    assert.equal(nit!.check.camera, "top");
    assert.notEqual(blocker!.check.id, hudNit!.check.id, "two checks on one board never share an id");
    // The director's own question flipping keeps the round: it is not the judge agreeing with itself.
    const spec = { checks: [blocker!.check] };
    assert.deepEqual(
      strongFlips(spec, { [blocker!.check.id]: { kind: "vision", origin: "director" } }, [blocker!.check.id]),
      [blocker!.check.id],
    );
  });
});

describe("a whole-game judge sees every camera", () => {
  it("AD-5. a lead's judge against the start with no cameras named shows the judge every camera both builds registered, cut alike", async () => {
    const host = fakeHost();
    const cameras = ["default", "chase", "side", "top"];
    const blind = '{"facets":{"works":"A","visuals":"A","feel":"tie","play":"tie"},"defects":[],"reason":"steadier"}';
    const { night } = fakeNight(host, {
      evidence: gameEvidence(cameras),
      answers: { [HostMethod.EngineComplete]: replying(blind) },
    });
    night.state.startEvidence = gameEvidence([...cameras, "only-in-the-start"]);
    await night.judge({ target: "integration", against: "start" });
    const [labels] = imageLabels(host);
    for (const side of ["BUILD A", "BUILD B"])
      for (const camera of cameras)
        assert.ok(labels!.includes(`${side} / ${camera}`), `${side} / ${camera} in ${labels!.join(", ")}`);
    assert.ok(!labels!.some((label) => label.endsWith("only-in-the-start")), "a camera one side lacks is cut");
    const a = labels!.filter((label) => label.startsWith("BUILD A")).map((label) => label.slice(10));
    const b = labels!.filter((label) => label.startsWith("BUILD B")).map((label) => label.slice(10));
    assert.deepEqual(a.sort(), b.sort(), "cut alike");
  });

  it("AD-5b. blindCompare's every-camera cut keeps both sides alike within its image cap", async () => {
    const recorder = ctxRecorder({ handlers: { "engine.complete": replying({ pick: "A" }) } });
    const many = ["default", "a", "b", "c", "d", "e", "f"];
    await blindCompare(
      recorder.ctx as never,
      {
        run: { runId: "r", reference: { name: "bar" } } as never,
        challenger: gameEvidence(many) as never,
        incumbentEvidence: gameEvidence(many) as never,
        cameras: many,
        everyCamera: true,
      } as never,
    );
    const labels: string[] = (recorder.paramsOf("engine.complete")[0] as any).messages[0].images.map(
      (image: { label: string }) => image.label,
    );
    const perSide = (tag: string) => labels.filter((label) => label.startsWith(tag)).length;
    assert.equal(perSide("BUILD A"), perSide("BUILD B"));
    assert.ok(perSide("BUILD A") > 4, `more than the taste judge's four: ${labels.join(", ")}`);
  });
});

describe("the finish mark (director/budgets.ts, wake.ts, art-direction.ts)", () => {
  it("finishMarkMs: a timed build keeps 30% of its working time for finishing, 30 to 120 minutes, none under an hour and a half; a goal build has no mark", () => {
    const timed = { reference: null, budgets: { completionPolicy: "duration" } } as never;
    const goal = { reference: null, budgets: { completionPolicy: "goal" } } as never;
    assert.equal(finishMarkMs(timed, 4 * HOUR_MS), 72 * MINUTE_MS);
    assert.equal(finishMarkMs(timed, 90 * MINUTE_MS), 30 * MINUTE_MS);
    assert.equal(finishMarkMs(timed, 10 * HOUR_MS), 120 * MINUTE_MS);
    assert.equal(finishMarkMs(timed, 89 * MINUTE_MS), null);
    assert.equal(finishMarkMs(goal, 10 * HOUR_MS), null);
  });

  it("AD-3. a timed build reaching its finish mark is judged ship-or-not by the studio itself, and the lead is woken once with the defects by part", async () => {
    const host = fakeHost();
    const { night, seen } = fakeNight(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    night.state.workers.set("hud", loopWorker("hud"));
    const mark = night.clock.softDeadline - finishMarkMs(night.run, 4 * HOUR_MS)!;
    const { talk, turns } = lead((turn) => {
      if (turn === 2) night.state.finished = true;
      return { ok: true, sessionId: "lead-1", turns: 1 };
    });
    await runWakeLoop(night, talk, BRIEF, fakeClock(mark - 2 * MINUTE_MS));

    assert.equal(turns.length, 2, turns.map((t) => t.prompt.slice(0, 120)).join("\n---\n"));
    const woken = turns[1]!.prompt;
    assert.match(woken, /finish mark/i);
    assert.match(woken, /would not ship/);
    assert.match(woken, /hud[^\n]*speed digits/);
    assert.match(woken, /stage=finish/);
    assert.match(woken, /no new parts or systems/);
    assert.equal(imageLabels(host).length, 1, "one review");
    assert.deepEqual(seen[0]!.viewport, SHIP_VIEW);
    assert.equal(night.state.lastShip.head, HEAD);
    const continued = host.calls
      .filter((c) => c.method === HostMethod.EventsAppend)
      .flatMap((c) => c.params.batch)
      .filter((e: Record<string, any>) => e.event_type === "director_continued");
    assert.ok(continued.some((e: Record<string, any>) => e.payload.reasons.includes(WakeCause.FinishMark)));
    assert.equal(host.journals.at(-1)!.director.wake.finishMarkSaid, true, "said once, and the journal keeps it");
  });

  it("AD-3b. a goal build whose lead idles twice with no ship review on its head is reviewed once before its wrap-up", async () => {
    const host = fakeHost();
    const { night } = fakeNight(host, {
      answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) },
      budgets: { wallClockMs: 2 * HOUR_MS, completionPolicy: "goal" },
      clock: { started: T0, softDeadline: T0 + HOUR_MS, finalDeadline: T0 + HOUR_MS + 10 * MINUTE_MS },
    });
    const { talk, turns } = lead((turn) => {
      if (turn === 4) night.state.finished = true;
      return { ok: true, sessionId: "lead-1", turns: 1 };
    });
    await runWakeLoop(night, talk, BRIEF, fakeClock(T0 + MINUTE_MS));

    assert.equal(turns.length, 4, turns.map((t) => t.prompt.slice(0, 160)).join("\n---\n"));
    assert.match(turns[1]!.prompt, /What next\?/, "asked what next first");
    assert.match(turns[2]!.prompt, /would not ship/, "then sent to art direction");
    assert.match(turns[3]!.prompt, /wrap-up/i, "then the wrap-up");
    assert.equal(imageLabels(host).length, 1, "reviewed once");
  });
});

describe("the ship verdict on the record (director/integrate.ts)", () => {
  it("AD-7. the report says whether the art director would ship the head that was made live, and nothing when its review was of another head", async () => {
    const reported = async (reviewedHead: string) => {
      const { night } = fakeNight(fakeHost());
      night.state.lastShip = { head: reviewedHead, ship: false, defects: SHIP_NO.defects, at: T0 };
      await night.closeRun({ ok: true, line: "made live", verified: false, how: "fresh-health-pass" });
      return night.report;
    };
    const live = await reported(HEAD);
    assert.equal(live.shipReview.head, HEAD);
    assert.equal(live.shipReview.ship, false);
    assert.equal(live.shipReview.defectsLeft, 3);
    assert.equal(live.shipReview.blockers, 1);
    assert.equal((await reported(FORK)).shipReview, undefined, "a review of another head says nothing of this one");
  });

  it("AD-8. a goal build's finish with no ship review on its head is reviewed once and refused once on a no; the next finish closes and says how many defects are left", async () => {
    const host = fakeHost();
    const { night } = fakeNight(host, {
      answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) },
      budgets: { wallClockMs: 2 * HOUR_MS, completionPolicy: "goal" },
      clock: { started: Date.now(), softDeadline: Date.now() + HOUR_MS, finalDeadline: Date.now() + 2 * HOUR_MS },
    });
    const closes: unknown[] = [];
    night.closeTheNight = async (options: unknown) => {
      closes.push(options);
      return { ok: true, line: "made live" };
    };
    const first = await night.finish({ summary: "the race is ready" });
    assert.match(first, /would not ship/);
    assert.equal(closes.length, 0, "the first finish is turned back once, with the defects");
    const second = await night.finish({ summary: "the race is ready" });
    assert.equal(closes.length, 1, "never refused twice");
    assert.match(second, /would not ship this build; 3 defects left/);
    assert.equal(imageLabels(host).length, 1, "reviewed once");

    // A user who asks to finish is never turned back, and nothing is looked at for it.
    const quick = fakeHost();
    const asked = fakeNight(quick, {
      answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) },
      budgets: { wallClockMs: 2 * HOUR_MS, completionPolicy: "goal" },
      clock: { started: Date.now(), softDeadline: Date.now() + HOUR_MS, finalDeadline: Date.now() + 2 * HOUR_MS },
    }).night;
    asked.inbox.finishing = async () => true;
    asked.closeTheNight = async () => ({ ok: true, line: "made live" });
    assert.doesNotMatch(await asked.finish({ summary: "done" }), /refused|would not ship/);
    assert.equal(imageLabels(quick).length, 0);
  });

  it("AD-9. the journal keeps a finishing worker's stage, so a resumed lead restarts it in the finish stage", async () => {
    const host = fakeHost();
    const { night } = fakeNight(host);
    night.state.workers.set(
      "hud",
      loopWorker("hud", { spec: { ...loopWorker("hud").spec, stage: FacetStage.Finish } }),
    );
    night.state.workers.set("track", loopWorker("track"));
    await night.saveJournal();
    const workers = host.journals.at(-1)!.director.workers;
    assert.equal(workers.hud.stage, FacetStage.Finish);
    assert.equal(workers.track.stage, undefined, "a building worker's record is as it was");
    const resumed = fakeNight(fakeHost(), { over: { resume: true, priorJournal: host.journals.at(-1) } }).night;
    restoreNight(resumed);
    const before = priorWorkersStatus(resumed);
    assert.equal(before.find((w) => w.id === "hud")?.stage, FacetStage.Finish, "worker_status names it");
  });
});
