/**
 * The art director's part of a night: one absolute look at the whole integrated game
 * (loop/ship-review.ts), the defects it names routed to the parts that own them, and the finish
 * mark that makes the look happen without the lead asking.
 *
 * Every judge of a night compared — a round against the one before, integration against the
 * start — and a night could win thirty rounds that way while nobody asked whether the game was
 * good. At the finish mark (a timed build's last 30% of working time, `finishMarkMs`; a goal build
 * once, when its lead idles or finishes with no review on its head) the studio asks: would you
 * ship this as the user's demo today? The lead is woken with the answer and the defects by part,
 * and from there the owners finish their parts (`stage=finish`). Each defect is a question on its
 * owner's board in the director's name, so its fix keeps the round (a strong flip). The verdict
 * is reported, never a landing veto, and it turns a goal build's finish back at most once.
 *
 * A new module, bound onto the night (director.ts `NIGHT_MODULES`): callers in older modules reach
 * it through the night and check that it is there. It reads budgets.ts and rules.ts by namespace,
 * so a kept older copy of either never stops it linking.
 */
import { shortSha } from "../git.ts";
import { isRunning, WorkerMode } from "../outcomes.ts";
import { DEFAULT_CAMERA } from "../cameras.ts";
import { uniqueCheckId } from "../facet/defects.ts";
import { DefectSeverity } from "../ship-review.ts";
import { CheckKind, CheckOrigin, CheckWeight, type Check } from "../spec.ts";
import { clip, CLIP_QUOTE, CLIP_REASON } from "../text.ts";
import { MINUTE_MS, SECOND_MS } from "../time.ts";
import { Against } from "../verdict.ts";
import * as budgetParts from "./budgets.ts";
import { goalCommission } from "./commission.ts";
import * as ruleParts from "./rules.ts";
import { list } from "./args.ts";
import { contractAloneOnStart } from "./contract-gate.ts";
import { ART_SKIPPED, shipFinishRefusal, shipGateSkipped } from "./art-direction-prompts.ts";
import { BuildTarget } from "./night.ts";
import { NoteKind } from "./wake-schedule.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { ShipDefect, ShipPart, ShipReview } from "../ship-review.ts";
import type { Night, Worker } from "./night.ts";
import type { ShelvedDefect } from "./rules.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a night
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/**
 * How soon after it starts the studio's own ship review must be done asking: it borrows the
 * studio's window as the close does, and a goal build's runs inside the lead's `finish` call,
 * which the engine gives up on after ten minutes.
 */
export const ART_DIRECTION_JUDGE_MS = 4 * MINUTE_MS;
/** The engine gives up on one tool call after this: a goal build's finish gate and its close share one `finish` call. */
const FINISH_CALL_MS = 10 * MINUTE_MS;
/** One look at a build, as a finish call budgets it (a big game's patient look). */
const LOOK_MS = 2 * MINUTE_MS;
/** What a finish call keeps beyond the gate and the close's own look and settle, for the answer and a slow host. */
const FINISH_MARGIN_MS = MINUTE_MS;
/** How long a close waits for stopped workers when a kept older budgets.ts does not say (budgets.ts `CLOSE_SETTLE_MS`). */
const CLOSE_SETTLE_FALLBACK_MS = 90 * SECOND_MS;
/** How many replacements deep a part's running owner is looked for (`replaces`), so a cycle never loops. */
const MAX_REPLACEMENTS = 8;
/** Who names a ship defect on a board and on the ledger: never a worker id. */
const ART_DIRECTOR = "art-director";
/** The ledger's owner of a defect no part owns: the lead's integration. */
const LEAD_OWNS = BuildTarget.Integration;

/** The art director's last word on the integration branch: the head it looked at, ship or not, and its defects. */
export interface LastShip {
  head: string | null;
  ship: boolean | null;
  defects: ShipDefect[];
  at: number;
}

/** One ship defect as a question on its owner's board: the part it is for (null: nobody's), and the check. */
export interface ShipRoute {
  part: string | null;
  defect: ShipDefect;
  check: Check;
}

/** What the studio's look at the finish mark found: the review, or why there was none. */
export interface ArtDirection {
  head: string | null;
  review: LastShip | null;
  skipped: string | null;
}

/** How the studio's own look is asked: what else the one look answers, as whose judge, and by when. */
export interface ArtDirectionAsk {
  /** More of the judge's arguments for the same look (the close's own question, at the finish gate). */
  ask?: AnyRecord;
  /** The look is the close's own judge of the head it makes live (`LastJudge.final`). */
  final?: boolean;
  /** How long its judge calls may take from the start of the pass. */
  judgeMs?: number;
}

/** The plan's parts as the art director is told them: the only ids a defect may name. */
export function shipParts(plan: AnyRecord | null | undefined): ShipPart[] {
  const workers: AnyRecord[] = Array.isArray(plan?.workers) ? plan.workers : [];
  return workers
    .filter((w) => typeof w?.id === "string" && w.id)
    .map((w) => ({ id: w.id, title: String(w.title ?? w.id), seam: String(w.seam ?? ""), owns: list(w.owns) }));
}

/** Can this worker take a question on its board now: a loop still running, with a spec. */
const takesShipDefects = (worker: Worker | undefined): worker is Worker & { spec: AnyRecord } =>
  Boolean(worker && isRunning(worker) && worker.mode === WorkerMode.Loop && worker.spec);

/**
 * The worker that owns `part` now: the running loop worker of that id, or the running one that
 * replaced it (`worker_start replaces=`, followed through each replacement by its typed field);
 * else the part's own worker, finished or not, or none.
 */
function ownerOf(workers: ReadonlyMap<string, Worker>, part: string | null): Worker | undefined {
  if (!part) return undefined;
  const own = workers.get(part);
  if (takesShipDefects(own)) return own;
  const replacesPart = (worker: Worker): boolean => {
    let replaced = worker.replaces;
    for (let depth = 0; replaced && depth < MAX_REPLACEMENTS; depth++) {
      if (replaced === part) return true;
      replaced = workers.get(replaced)?.replaces ?? null;
    }
    return false;
  };
  return [...workers.values()].find((worker) => takesShipDefects(worker) && replacesPart(worker)) ?? own;
}

/**
 * The frame a ship defect's question is asked on: the camera it named (ship-review.ts keeps only
 * one the review was shown, `shownCameras`), else the default.
 */
const checkCamera = (camera: string | null): string => camera ?? DEFAULT_CAMERA;

/** A blocker or a visible defect decides whether the part is done; a nit counts and decides nothing. */
const weightOf = (defect: ShipDefect): string =>
  defect.severity === DefectSeverity.Nit ? CheckWeight.Normal : CheckWeight.Identity;

/** One ship defect as the director's own vision question: yes once the frame no longer shows it. */
function shipCheck(board: { checks: AnyRecord[] }, defect: ShipDefect): Check {
  const text = clip(defect.what, CLIP_REASON);
  return {
    id: uniqueCheckId(board, `ship-${text}`),
    kind: CheckKind.Vision,
    weight: weightOf(defect),
    hard: false,
    camera: checkCamera(defect.camera),
    ask: `Is this gone? "${clip(text, CLIP_QUOTE)}" — answer yes only if the frame no longer shows it.`,
    expect: "yes",
    origin: CheckOrigin.Director,
    defect: text,
    note: `the art director's ship review (${defect.severity})`,
  };
}

/**
 * Every ship defect as a question for the part that owns it, by the part's id alone — never by
 * reading the defect's words. A running loop worker's ids are unique on its own board; a part with
 * no board (finished, a single session, never started) or no part at all gets a board of its own.
 */
export function shipDefectsToChecks(
  review: Pick<ShipReview, "defects">,
  workers: ReadonlyMap<string, Worker>,
): ShipRoute[] {
  const boards = new Map<string, { checks: AnyRecord[] }>();
  const boardOf = (part: string | null): { checks: AnyRecord[] } => {
    const key = part ?? "";
    const known = boards.get(key);
    if (known) return known;
    const worker = ownerOf(workers, part);
    const board = { checks: [...(takesShipDefects(worker) ? (worker.spec.checks ?? []) : [])] };
    boards.set(key, board);
    return board;
  };
  return review.defects.map((defect) => {
    const board = boardOf(defect.part);
    const check = shipCheck(board, defect);
    board.checks.push(check);
    return { part: defect.part, defect, check };
  });
}

/** A defect on the run's ledger, under the part (or the lead) it is for: the rules.ts shelf when it has one. */
function shelve(ledger: ShelvedDefect[], defect: { text: string; owner: string }): void {
  const fn = (ruleParts as { shelveDefect?: typeof ruleParts.shelveDefect }).shelveDefect;
  if (typeof fn === "function") {
    fn(ledger, { ...defect, from: ART_DIRECTOR });
    return;
  }
  if (!ledger.some((d) => d.text === defect.text)) ledger.push({ ...defect, from: ART_DIRECTOR, at: Date.now() });
}

/** Put a ship question on a running worker's board and tell it: rules.ts's board when it has one, its router otherwise. */
function onBoard(night: Night, worker: Worker & { spec: AnyRecord }, route: ShipRoute): void {
  const { note, state } = night;
  const put = (ruleParts as { putOnBoard?: typeof ruleParts.putOnBoard }).putOnBoard;
  if (typeof put !== "function") {
    ruleParts.makeRouteDefect({ workers: state.workers, from: ART_DIRECTOR, ledger: state.ledger, note })(
      worker.id,
      route.check,
    );
    return;
  }
  if (!put(worker.spec, route.check)) return;
  worker.steering.push(
    `The art director looked at the whole game and would not ship it with this, in your part: "${route.check.defect}". It is on your board now as ${route.check.id} — fix it this iteration.`,
  );
  note(
    `worker ${worker.id}: the art director's defect is on its board — "${clip(route.check.defect, CLIP_QUOTE)}"`,
    NoteKind.DefectRouted,
  );
}

/**
 * Hand each ship defect to its owner: the running loop worker whose part it names gets it on its
 * board as the director's own question (its fix is a strong flip, so the round is kept); a part
 * that is finished, a single session or not started has it on the ledger under its id; a defect
 * no part owns is the lead's, on the ledger under the integration. Answers what went where.
 */
export function routeShipDefects(night: Night, review: Pick<ShipReview, "defects">): ShipRoute[] {
  const { note, state } = night;
  const routes = shipDefectsToChecks(review, state.workers);
  for (const route of routes) {
    const worker = ownerOf(state.workers, route.part);
    if (takesShipDefects(worker)) {
      onBoard(night, worker, route);
      continue;
    }
    const owner = route.part ?? LEAD_OWNS;
    shelve(state.ledger, { text: String(route.check.defect), owner });
    note(
      `the art director's defect for ${owner} is on the run's ledger — "${clip(route.check.defect, CLIP_QUOTE)}"`,
      NoteKind.DefectShelved,
    );
  }
  return routes;
}

/** Has the integration branch anything beyond the run's starting point at `head`? */
function movedBeyondStart(night: Night, head: string | null): head is string {
  const { baseCommit, state } = night;
  if (!head || head === baseCommit || state.baseHeads.has(head)) return false;
  // The module contract written on the start alone is a document, not a build (contract-gate.ts).
  return !contractAloneOnStart(night, head);
}

/** The art director's word on `head`, when its last look was at that head. */
export function shipReviewOn(night: Night, head: string | null): LastShip | null {
  const last = night.state.lastShip ?? null;
  if (!last || !head) return null;
  return last.head === head ? last : null;
}

/**
 * Is a goal build owed the art director's look: its integration has moved, nothing says it does
 * not load, and no review stands on its head. A timed build has its finish mark instead.
 */
export function shipOwed(night: Night): boolean {
  const { run, state } = night;
  const head = state.integrationHead;
  if (!goalCommission(run) || !movedBeyondStart(night, head)) return false;
  return state.healthByHead.get(head) !== false && !shipReviewOn(night, head);
}

/**
 * When a timed build reaches its finish mark (budgets.ts `finishMarkMs`, from the night's own
 * clock so a Resume keeps it), or null — a goal build, a short one, or a kept budgets.ts without it.
 */
export function finishMarkAt(night: Night): number | null {
  const markMs = (budgetParts as { finishMarkMs?: typeof budgetParts.finishMarkMs }).finishMarkMs;
  if (typeof markMs !== "function") return null;
  const clock = night.clock ?? { started: night.started, softDeadline: night.softDeadline };
  const ms = markMs(night.run, clock.softDeadline - clock.started);
  return ms === null ? null : clock.softDeadline - ms;
}

/**
 * The studio's own look at the finish mark: when the integration branch has moved beyond the start
 * and nothing says it does not load, the art director judges it (`judge ship=yes`, through the
 * studio's window when every other is taken, done by `ART_DIRECTION_JUDGE_MS`) and its defects go
 * to their owners. `how` lets the same look answer the close's own question (the finish gate).
 * Answers the review, or why there was none.
 */
export async function artDirectionPass(night: Night, how: ArtDirectionAsk = {}): Promise<ArtDirection> {
  const { ctx, note, state } = night;
  const { ask = {}, final = false, judgeMs = ART_DIRECTION_JUDGE_MS } = how;
  const head = (await night.syncHead().catch(() => null)) ?? state.integrationHead;
  if (ctx.cancelled) return { head, review: null, skipped: ART_SKIPPED.stopped };
  if (!movedBeyondStart(night, head)) return { head, review: null, skipped: ART_SKIPPED.nothingNew };
  if (state.healthByHead.get(head) === false) return { head, review: null, skipped: ART_SKIPPED.doesNotLoad };
  const judged = { ...ask, target: BuildTarget.Integration, against: Against.None, ship: "yes" };
  await night
    .judge(judged, { borrow: true, final, until: Date.now() + judgeMs })
    .catch((err: unknown) =>
      note(`the art director could not judge ${shortSha(head)}: ${clip((err as Error)?.message ?? err, CLIP_REASON)}`),
    );
  const review = shipReviewOn(night, head);
  return { head, review, skipped: review ? null : ART_SKIPPED.notJudged };
}

/**
 * How long the finish gate's judge may take from its start: one `finish` call holds the gate's
 * look and judge, then the close's settle and its own look, inside the engine's ten minutes.
 */
function finishGateJudgeMs(): number {
  const settle = (budgetParts as { CLOSE_SETTLE_MS?: number }).CLOSE_SETTLE_MS ?? CLOSE_SETTLE_FALLBACK_MS;
  return Math.min(ART_DIRECTION_JUDGE_MS, FINISH_CALL_MS - settle - LOOK_MS - FINISH_MARGIN_MS);
}

/**
 * The judge the close still owes the head (tools.ts `closeJudgeAsk`): null when a judge on that
 * head already holds its word, undefined under a kept older tools.ts that cannot say.
 */
function closeJudgeOwed(night: Night): AnyRecord | null | undefined {
  if (typeof night.closeJudgeAsk !== "function") return undefined;
  return night.closeJudgeAsk(night.state.integrationHead);
}

/**
 * A goal build's finish with no review on its head: the art director looks once, and a "no" turns
 * the finish back once, with the defects — never twice, never for the user's own finish, never in
 * the wrap-up (no time to act on it). The look runs inside the lead's `finish` call, so it is
 * bounded by `finishGateJudgeMs` and answers the close's own question too, so the close does not
 * judge the head again; when the close still owes a blind judge against the start, there is no
 * time for both, and the finish closes without it. Answers the refusal, or null to close.
 */
export async function shipFinishGate(night: Night, userEnds: boolean): Promise<string | null> {
  const { ctx, note, state } = night;
  const notOurs = userEnds || ctx.cancelled || state.shipFinishRefused === true;
  const noTimeToAct = Date.now() >= night.softDeadline;
  if (notOurs || noTimeToAct) return null;
  if (!shipOwed(night)) return null;
  const owed = closeJudgeOwed(night);
  if (owed === undefined) return null;
  if (owed && owed.against !== Against.None) {
    note(shipGateSkipped(state.integrationHead));
    return null;
  }
  const how = owed ? { ask: { question: owed.question }, final: true } : {};
  const { review } = await artDirectionPass(night, { ...how, judgeMs: finishGateJudgeMs() });
  if (review?.ship !== false) return null;
  state.shipFinishRefused = true;
  await night.saveJournal();
  return shipFinishRefusal(review);
}

/** What the report says of the art director's look at the head it closed on, or null when it looked at another. */
export function shipReport(night: Night): AnyRecord | null {
  const review = shipReviewOn(night, night.state.integrationHead);
  if (!review) return null;
  return {
    head: review.head,
    ship: review.ship,
    defectsLeft: review.defects.length,
    blockers: review.defects.filter((d) => d.severity === DefectSeverity.Blocker).length,
    at: new Date(review.at).toISOString(),
  };
}
