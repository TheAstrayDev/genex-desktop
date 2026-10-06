/**
 * Provider outages are weather, not verdicts.
 *
 * The medieval-village run (3 Sep 2026) ended at 3 h 11 m with every facet, the integration
 * facet, the ledger and the global judge reporting "API Error: 529 Overloaded" / "500 Internal
 * server error" inside one 25-minute window. The loop read each failed build turn as "the
 * challenger did not produce a judgeable build", counted two with the same cause and tripped
 * the circuit breaker on all four facets — a policy written for builds that crash, applied to
 * an API that was briefly down.
 *
 * `isTransientProviderError` tells the two apart; `withProviderPatience` waits it out with a
 * capped backoff (about half an hour in total) before the caller's own policy takes over. A
 * usage or auth failure is never transient: those have a sign-in button or a reset time.
 */

import { CLIP_REASON } from "./text.ts";
import { MINUTE_MS, SECOND_MS, sleepUnlessCancelled } from "./time.ts";
import type { HarnessCtx } from "../types/harness.d.ts";

/** How much of the error a status line quotes while it waits. */
const STATUS_ERROR_CHARS = 80;

/**
 * How an engine call failed (the `kind` on the error the host rethrows). The app's copy is
 * `EngineFailureKind` in `shared/engine-requests.ts`; the values are the host's: never rename one.
 */
export const EngineFailure = {
  RateLimit: "rate_limit",
  /** A subscription cap (weekly/session) that no in-run wait can outlive — end the run, don't retry. */
  UsageLimit: "usage_limit",
  Auth: "auth",
  Unavailable: "unavailable",
  ContextThreshold: "context_threshold",
  ContextOverflow: "context_overflow",
  Aborted: "aborted",
  /** A completion outlived its ceiling. Distinct from "aborted": nobody asked for this stop. */
  Timeout: "timeout",
  Other: "other",
} as const;
export type EngineFailure = (typeof EngineFailure)[keyof typeof EngineFailure];

/**
 * Why a delegated build ended (`DelegateResult.stopReason`). A vendor's own subtype may also
 * arrive, so the field stays a string. The app's copy is `StopReason` in
 * `shared/engine-requests.ts`; logs keep the values: never rename one.
 */
export const StopReason = {
  Completed: "completed",
  /** Somebody stopped it: the user, or the run pulling a worker off. */
  Stopped: "stopped",
  /** Its time budget ran out. */
  Deadline: "deadline",
  Error: "error",
  /** The model's output hit its length limit. */
  Length: "length",
  ContextOverflow: "context_overflow",
  NoProgress: "no_progress",
  MaxTurns: "max_turns",
  Aborted: "aborted",
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

/** Is this failure an engine's own limit — its session limit or its usage cap — rather than a fault? */
export function isEngineLimit(kind: unknown): boolean {
  return kind === EngineFailure.RateLimit || kind === EngineFailure.UsageLimit;
}

/** An engine's limit as a run keeps it: which one, what the engine said, when it resets and when it hit. */
export interface EngineLimit {
  kind: string;
  message: string;
  retryAfterMs: number | null;
  at: number;
}

/** The limit an engine error names (`isEngineLimit(err.kind)`), as a run keeps it. */
export function engineLimitOf(err: any, at = Date.now()): EngineLimit {
  return {
    kind: err.kind,
    message: String(err.message ?? err),
    retryAfterMs: typeof err.retryAfterMs === "number" ? err.retryAfterMs : null,
    at,
  };
}

/** A limit as a sentence names it: the plan's usage cap, or its session limit. */
export function limitWords(kind: unknown): string {
  return kind === EngineFailure.UsageLimit ? "usage cap" : "session limit";
}

// ── lost providers ──
//
// The NFS run (6 Oct 2026) lost its account 3 h 05 min in ("Your organization has disabled Claude
// subscription access…"). The lead's failed turn wrapped up and landed an unchecked build, a
// worker's round was counted broken, and thirteen more judge calls went to the dead account. A
// provider that is gone is no verdict on anybody's work: the run pauses, rounds wait, and nothing
// asks it again until the run resumes (or a limit resets).

/** Failures that take a provider away until the user acts or a limit resets: a lost sign-in, a cap, a session limit. */
const LOSS_KINDS: ReadonlySet<unknown> = new Set([
  EngineFailure.Auth,
  EngineFailure.UsageLimit,
  EngineFailure.RateLimit,
]);

/** Is this failure a provider lost for now — a sign-in gone, or one of its limits — rather than a fault? */
export function isProviderLoss(kind: unknown): boolean {
  return LOSS_KINDS.has(kind);
}

/** A provider loss as a sentence names it: a lost sign-in, the usage cap, the session limit, or an outage. */
export function lossWords(kind: unknown): string {
  if (kind === EngineFailure.Auth) return "lost sign-in";
  if (kind === EngineFailure.Unavailable) return "outage";
  return limitWords(kind);
}

/**
 * What the run's feed says when a provider loss pauses the lead: the lead's own line, and the
 * user's sentence (what paused it, and what brings it back).
 */
export function pauseDecision(kind: unknown, said: string): { line: string; plain: string } {
  if (kind === EngineFailure.Auth)
    return {
      line: `the engine lost its sign-in: ${said}`,
      plain:
        "the model provider stopped accepting this account, so the build paused — sign in again (or ask your admin to turn access back on), then press Resume",
    };
  if (kind === EngineFailure.Unavailable)
    return {
      line: `the lead's provider stayed down: ${said}`,
      plain: "the model provider stayed down, so the build paused — Resume picks it up where it stopped",
    };
  return {
    line: `the engine hit its ${limitWords(kind)}: ${said}`,
    plain: `your plan's ${limitWords(kind)} paused the build`,
  };
}

/** Why a night a provider loss paused ended, in the sentence its report keeps (`said` is the engine's own words). */
export function pauseEnding(kind: unknown, said: string): string {
  if (kind === EngineFailure.Auth)
    return `the engine lost its sign-in before the director called finish (${said}); the run is paused — sign in again (or have the admin turn access back on), then Resume`;
  if (kind === EngineFailure.Unavailable)
    return `the engine's provider stayed down before the director called finish (${said}); the run is paused — Resume it once the provider is back`;
  return `the engine hit its ${limitWords(kind)} before the director called finish (${said}); the run is paused — Resume it when the limit resets`;
}

/** A run's lost provider: the engine, the failure as the run keeps a limit, and where its caller may fall back. */
export interface ProviderLoss extends EngineLimit {
  engine: string;
  fallbacks: string[];
}

/** The run's lost providers, by run and engine. Every loop of a run (lead, workers, judges) reads the same table. */
const LOST_PROVIDERS = new Map<string, Map<string, ProviderLoss>>();

/**
 * Does `err` open its provider's circuit: a lost sign-in or a usage cap, or a session limit that
 * names its reset? A throttle that names none is retried by its caller, as it always was.
 */
function opensCircuit(err: any): boolean {
  if (err?.kind === EngineFailure.RateLimit) return typeof err.retryAfterMs === "number";
  return isProviderLoss(err?.kind);
}

/**
 * Remember that `engine` failed `err` for run `runId`: a provider loss that opens its circuit
 * (`opensCircuit`) stops calls to it until the run resumes or the limit resets. Answers the loss, or
 * null when `err` opened nothing (and nothing was remembered).
 */
export function noteProviderLoss(runId: unknown, engine: unknown, err: any, at = Date.now()): ProviderLoss | null {
  if (typeof runId !== "string" || typeof engine !== "string" || !opensCircuit(err)) return null;
  const fallbacks = Array.isArray(err.fallbacks) ? err.fallbacks.filter((f: unknown) => typeof f === "string") : [];
  const loss = { ...engineLimitOf(err, at), engine, fallbacks };
  const run = LOST_PROVIDERS.get(runId) ?? new Map<string, ProviderLoss>();
  run.set(engine, loss);
  LOST_PROVIDERS.set(runId, run);
  return loss;
}

/** Is `loss` still holding at `now`: a sign-in until the run resumes, a limit until it resets (and for good when it names no reset)? */
function holds(loss: ProviderLoss, now: number): boolean {
  return loss.retryAfterMs === null || now < loss.at + loss.retryAfterMs;
}

/** The loss that holds `engine` for run `runId` at `now`, or null: none, or a limit that has reset (its circuit closes). */
export function providerLossFor(runId: unknown, engine: unknown, now = Date.now()): ProviderLoss | null {
  if (typeof runId !== "string" || typeof engine !== "string") return null;
  const run = LOST_PROVIDERS.get(runId);
  const loss = run?.get(engine) ?? null;
  if (!loss || holds(loss, now)) return loss;
  run?.delete(engine);
  return null;
}

/** A lost sign-in on any engine of run `runId`: no wait mends it, so the run pauses for the user. */
export function lostSignIn(runId: unknown, now = Date.now()): ProviderLoss | null {
  if (typeof runId !== "string") return null;
  const engines = [...(LOST_PROVIDERS.get(runId)?.keys() ?? [])];
  for (const engine of engines) {
    const loss = providerLossFor(runId, engine, now);
    if (loss?.kind === EngineFailure.Auth) return loss;
  }
  return null;
}

/** A night of run `runId` (re)starts — the user's Resume, or the studio's: its providers are trusted again. */
export function forgetProviderLosses(runId: unknown): void {
  if (typeof runId === "string") LOST_PROVIDERS.delete(runId);
}

/**
 * What a call to a lost provider throws instead of reaching it: an engine error of the loss's own
 * kind, so every caller's policy for a lost sign-in or a limit applies, marked `providerLost`.
 */
export function providerLostError(loss: ProviderLoss): Error & { kind: string; retryAfterMs?: number } {
  const said = `${loss.engine} is unavailable to this run (its ${lossWords(loss.kind)}): ${loss.message}`;
  return Object.assign(new Error(said), {
    kind: loss.kind,
    providerLost: true,
    ...(loss.retryAfterMs !== null ? { retryAfterMs: Math.max(0, loss.at + loss.retryAfterMs - Date.now()) } : {}),
  });
}

/** Waits between retries, in order; the run's `budgets.outageDelays` overrides them (tests). */
export const OUTAGE_DELAYS = [MINUTE_MS, 2 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS, 15 * MINUTE_MS];

/** Words of a provider that is briefly down: an overloaded or failing gateway, a dropped connection. */
const TRANSIENT =
  /\b(529|502|503|504|500)\b|overloaded|internal server error|bad gateway|service unavailable|gateway time-?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error|temporarily unavailable|try again in a moment/i;
/** Words of a cap or a sign-in, which no wait fixes even when the rest reads like an outage. */
const NEVER_TRANSIENT =
  /weekly limit|usage limit|hit your limit|out of usage|resets? (at|on)\b|unauthori[sz]ed|forbidden|\b401\b|\b403\b|invalid api key|not logged in|sign in|session expired/i;

/** Failures no wait fixes: a usage cap, a sign-in, a stop somebody asked for. */
const NEVER_TRANSIENT_KINDS = new Set<unknown>([EngineFailure.UsageLimit, EngineFailure.Auth, EngineFailure.Aborted]);

/** True for an error (or its message) that names a provider hiccup, not a fault of the build. */
export function isTransientProviderError(errorOrText: unknown): boolean {
  const kind = typeof errorOrText === "object" && errorOrText ? (errorOrText as { kind?: unknown }).kind : null;
  if (NEVER_TRANSIENT_KINDS.has(kind)) return false;
  const text =
    typeof errorOrText === "string"
      ? errorOrText
      : String((errorOrText as { message?: unknown } | null | undefined)?.message ?? errorOrText ?? "");
  if (!text) return false;
  if (NEVER_TRANSIENT.test(text)) return false;
  if (kind === EngineFailure.Unavailable) return true;
  return TRANSIENT.test(text);
}

/** The delays a run uses: its own knob, else the schedule above. */
export function outageDelays(
  run: { budgets?: { outageDelays?: unknown; [knob: string]: unknown } } | null | undefined,
): number[] {
  const own = run?.budgets?.outageDelays;
  return Array.isArray(own) && own.every((n) => typeof n === "number" && n >= 0) ? own : OUTAGE_DELAYS;
}

/**
 * How long to wait before the next attempt after `err`, or null when patience is over: the error
 * is not a provider hiccup, the run was stopped, or the schedule or the deadline ran out.
 */
function nextWait(ctx: HarnessCtx, err: unknown, wait: number | undefined, deadline: number): number | null {
  if (!isTransientProviderError(err) || ctx?.cancelled) return null;
  if (wait === undefined || Date.now() + wait > deadline) return null;
  return wait;
}

/**
 * Run `attempt()`; on a transient provider error wait and try again through the schedule,
 * telling the log each time (`onWait({ wait, attempt, error })`). Anything else — or the
 * schedule and the deadline running out — rethrows the last error, so the caller's own policy
 * (auto-tie, circuit breaker, "judge unavailable") applies only to real failures.
 */
export async function withProviderPatience<T>(
  ctx: HarnessCtx,
  attempt: () => Promise<T>,
  {
    deadline = Infinity,
    delays = OUTAGE_DELAYS,
    onWait = null,
    label = "provider",
  }: {
    deadline?: number;
    delays?: number[];
    onWait?: ((wait: { wait: number; attempt: number; error: string }) => unknown) | null;
    label?: string;
  } = {},
): Promise<T> {
  let index = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (err: any) {
      const wait = nextWait(ctx, err, delays[index], deadline);
      if (wait === null) throw err;
      index += 1;
      const said = String(err?.message ?? err);
      ctx?.setStatus?.(
        `${label} is overloaded — waiting ${Math.round(wait / SECOND_MS)}s before retrying (${said.slice(0, STATUS_ERROR_CHARS)})`,
      );
      if (typeof onWait === "function") await onWait({ wait, attempt: index, error: said.slice(0, CLIP_REASON) });
      await sleepUnlessCancelled(ctx, wait);
      if (ctx?.cancelled) throw err;
    }
  }
}
