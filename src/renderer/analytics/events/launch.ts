/**
 * Launch, errors and updates (plan §1.1): what a launch costs, what breaks the window, and whether
 * an update is taken.
 *
 * An error is told by its kind, its built-in type and a fingerprint of where it was thrown (the top
 * stack frames, file names and positions only), never by its message, which can quote anything.
 * Long tasks are summed every few minutes, by screen. What a boot screen, main's own errors or a
 * hung window would add needs main to say it first, so it is not here.
 */
import {
  type ReadyUpdate,
  type UpdateAction,
  type UpdateCheckResult,
  UpdateCheckStatus,
} from "../../../shared/app-update.ts";
import { MINUTE_MS } from "../../../shared/duration.ts";
import { EngineStatusCode } from "../../../shared/engine-descriptor.ts";
import { UiEvent } from "../../../shared/ui-events.ts";
import { SessionStatus } from "../../state/session.ts";
import type { Studio } from "../../state/studio.ts";
import { guarded, track } from "../client.ts";
import type { AreaObservers } from "../observers.ts";
import { type CountBucket, countBucket, elapsedMs } from "../properties.ts";
import { currentScreen } from "../screens.ts";

/** How often the long tasks seen are summed and sent, while there were any. */
export const STALL_SUMMARY_MS = 5 * MINUTE_MS;
/** How many stack frames make an error's fingerprint. */
const FINGERPRINT_FRAMES = 5;
/** How many times one error (by fingerprint) is sent in a launch: a loop that throws is one problem. */
const ERROR_REPEATS_MAX = 3;

export const LaunchEvent = {
  AppReadyMeasured: "app_ready_measured",
  WorkspaceLoadRetried: "workspace_load_retried",
  AppErrorCaught: "app_error_caught",
  ErrorScreenAction: "error_screen_action",
  UiStallSummarized: "ui_stall_summarized",
  DiagnosticsCopied: "diagnostics_copied",
  UpdateReady: "update_ready",
  UpdateRestartPressed: "update_restart_pressed",
  UpdateCheckFinished: "update_check_finished",
} as const;

/** Where an error was caught. */
export const ErrorKind = {
  /** Thrown while rendering: the error screen took the window. */
  Render: "render",
  Uncaught: "uncaught",
  /** A promise rejected with nothing to catch it. */
  Rejection: "rejection",
} as const;
export type ErrorKind = (typeof ErrorKind)[keyof typeof ErrorKind];

/** The process an error was caught in; main's own are not sent yet. */
export const ErrorProcess = { Renderer: "renderer" } as const;
export type ErrorProcess = (typeof ErrorProcess)[keyof typeof ErrorProcess];

/** What the error screen offers. */
export const ErrorScreenAction = { Reload: "reload", Copy: "copy" } as const;
export type ErrorScreenAction = (typeof ErrorScreenAction)[keyof typeof ErrorScreenAction];

/** Where Relaunch to update was pressed. */
export const UpdateSurface = { Sidebar: "sidebar", About: "about" } as const;
export type UpdateSurface = (typeof UpdateSurface)[keyof typeof UpdateSurface];

/**
 * What Relaunch came to. Main answers false both when it kept a running build going and when there
 * was nothing to install, so the two share one value until it says which.
 */
export const RestartOutcome = {
  Relaunching: "relaunching",
  NotRelaunched: "not_relaunched",
  Failed: "failed",
} as const;
export type RestartOutcome = (typeof RestartOutcome)[keyof typeof RestartOutcome];

/** A Check for Updates whose call itself failed, beside the statuses main answers. */
export const CHECK_CALL_FAILED = "ipc_failed";

/** The error types a report may name: JavaScript's own. Anything else is "other". */
export const ERROR_TYPES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
]);
const OTHER_TYPE = "other";

export type LaunchEventProperties = {
  [LaunchEvent.AppReadyMeasured]: AppReadyProperties;
  [LaunchEvent.WorkspaceLoadRetried]: WorkspaceRetriedProperties;
  [LaunchEvent.AppErrorCaught]: AppErrorProperties;
  [LaunchEvent.ErrorScreenAction]: { action: ErrorScreenAction };
  [LaunchEvent.UiStallSummarized]: StallSummaryProperties;
  [LaunchEvent.DiagnosticsCopied]: { ok: boolean };
  [LaunchEvent.UpdateReady]: { action: UpdateAction; at_bootstrap: boolean };
  [LaunchEvent.UpdateRestartPressed]: { surface: UpdateSurface; outcome: RestartOutcome; waited_ms: number | null };
  [LaunchEvent.UpdateCheckFinished]: UpdateCheckProperties;
};

/** `workspace_load_retried`'s properties: which Retry of this launch, whether it loaded, and how long it took. */
export type WorkspaceRetriedProperties = { attempt: number; succeeded: boolean; elapsed_ms: number };

/** `update_check_finished`'s properties. */
export type UpdateCheckProperties = { status: UpdateCheckStatus | typeof CHECK_CALL_FAILED; duration_ms: number };

/** `app_error_caught`'s properties. */
export type AppErrorProperties = {
  process: ErrorProcess;
  kind: ErrorKind;
  error_type: string;
  fatal: boolean;
  /** 8 hex digits from the top stack frames; null when there is no stack to read. */
  fingerprint: string | null;
};

/** A thrown value's type: a built-in error's name, else "other". */
export function errorType(error: unknown): string {
  const name = error instanceof Error || isNamed(error) ? error.name : null;
  return name && ERROR_TYPES.has(name) ? name : OTHER_TYPE;
}

const isNamed = (value: unknown): value is { name: string } =>
  typeof value === "object" && value !== null && "name" in value && typeof value.name === "string";

/** A frame's place: a file's name with its line and column, everything before the last slash dropped. */
const PLACE = /(?:[a-z][\w+.-]*:\/\/)?(?:[^\s()]*[\\/])?([^\s()\\/?#]+?)(?:[?#][^\s():]*)?:(\d+):(\d+)/gi;

/** The top stack frames, with only file names and positions kept: no folder, no address, no message. */
export function stackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at ") || /@.*:\d+:\d+$/.test(line))
    .slice(0, FINGERPRINT_FRAMES)
    .map((line) => line.replace(PLACE, "$1:$2:$3"));
}

/** FNV-1a over the frames, as 8 hex digits. */
export function fingerprint(frames: readonly string[]): string | null {
  if (frames.length === 0) return null;
  let hash = 0x811c9dc5;
  for (const char of frames.join("\n")) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const stackOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "stack" in error && typeof error.stack === "string"
    ? error.stack
    : undefined;

/** A caught error as `app_error_caught`: its kind, type and fingerprint, never its words. */
export function appErrorProperties(error: unknown, kind: ErrorKind): AppErrorProperties {
  return {
    process: ErrorProcess.Renderer,
    kind,
    error_type: errorType(error),
    fatal: kind === ErrorKind.Render,
    fingerprint: fingerprint(stackFrames(stackOf(error))),
  };
}

/** How many times each error was sent in this window. */
const errorsSent = new Map<string, number>();

/** Send a caught error, each fingerprint at most a few times a launch. */
export function reportError(error: unknown, kind: ErrorKind): void {
  const properties = appErrorProperties(error, kind);
  const key = `${kind}:${properties.fingerprint ?? properties.error_type}`;
  const sent = errorsSent.get(key) ?? 0;
  if (sent >= ERROR_REPEATS_MAX) return;
  errorsSent.set(key, sent + 1);
  track(LaunchEvent.AppErrorCaught, properties);
}

/** `ui_stall_summarized`'s properties. */
export type StallSummaryProperties = { screen: string; long_tasks: number; total_ms: number; max_ms: number };

/** The long tasks seen since the last summary. */
export interface StallTally {
  count: number;
  total: number;
  max: number;
}

/** Nothing seen yet. */
export const NO_STALLS: StallTally = { count: 0, total: 0, max: 0 };

/** One more long task. */
export const stallAdded = (tally: StallTally, duration: number): StallTally => ({
  count: tally.count + 1,
  total: tally.total + duration,
  max: Math.max(tally.max, duration),
});

/** The summary to send, or null when nothing was slow. */
export function stallSummary(tally: StallTally, screen: string): StallSummaryProperties | null {
  if (tally.count === 0) return null;
  return { screen, long_tasks: tally.count, total_ms: Math.round(tally.total), max_ms: Math.round(tally.max) };
}

/** Sum the window's long tasks and send them every `STALL_SUMMARY_MS`; nothing where the page cannot see them. */
function watchStalls(): () => void {
  const supported =
    typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask");
  if (!supported) return () => undefined;
  let tally = NO_STALLS;
  const observer = new PerformanceObserver(
    guarded((list: PerformanceObserverEntryList) => {
      for (const entry of list.getEntries()) tally = stallAdded(tally, entry.duration);
    }),
  );
  observer.observe({ type: "longtask", buffered: true });
  const timer = setInterval(
    guarded(() => {
      const summary = stallSummary(tally, currentScreen());
      tally = NO_STALLS;
      if (summary) track(LaunchEvent.UiStallSummarized, summary);
    }),
    STALL_SUMMARY_MS,
  );
  return () => {
    observer.disconnect();
    clearInterval(timer);
  };
}

/** Errors nothing caught, and rejections nothing handled. An error event with no error object says nothing to group by. */
function watchErrors(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const uncaught = guarded((event: ErrorEvent): void => {
    if (typeof event.error === "object" && event.error !== null) reportError(event.error, ErrorKind.Uncaught);
  });
  const rejected = guarded((event: PromiseRejectionEvent): void => reportError(event.reason, ErrorKind.Rejection));
  window.addEventListener("error", uncaught);
  window.addEventListener("unhandledrejection", rejected);
  return () => {
    window.removeEventListener("error", uncaught);
    window.removeEventListener("unhandledrejection", rejected);
  };
}

/** What this launch learned about itself, for the first screen's measure and the update's wait. */
const launch: { bootstrapMs: number | null; firstScreen: boolean; updateReadyAt: number | null } = {
  bootstrapMs: null,
  firstScreen: false,
  updateReadyAt: null,
};

/** `app_ready_measured`'s properties. */
export type AppReadyProperties = {
  /** From the window's start to its first real screen. */
  window_to_first_screen_ms: number;
  /** From the stores' start to the bootstrap's answer; null when it had not answered. */
  bootstrap_ms: number | null;
  bootstrap_failed: boolean;
  first_launch: boolean;
  games_bucket: CountBucket;
  engines_ready_count: number;
};

/** The first screen's measure, from what the stores hold then. */
export function appReadyProperties(
  state: {
    status: SessionStatus;
    welcoming: boolean;
    firstLaunch: boolean;
    games: number;
    enginesReady: number;
  },
  sinceWindowStart: number,
  bootstrapMs: number | null,
): AppReadyProperties {
  return {
    window_to_first_screen_ms: Math.max(0, Math.round(sinceWindowStart)),
    bootstrap_ms: bootstrapMs,
    bootstrap_failed: state.status === SessionStatus.Failed,
    first_launch: state.firstLaunch || state.welcoming,
    games_bucket: countBucket(state.games),
    engines_ready_count: state.enginesReady,
  };
}

/**
 * The window's first real screen is drawn (`shell/use-shell.ts`, when `firstScreenReady` first
 * holds): sent once a launch. `sinceWindowStart` is the page's own clock.
 */
export function reportFirstScreen(
  app: Pick<Studio, "session" | "library" | "engines">,
  sinceWindowStart: number = performance.now(),
): void {
  if (launch.firstScreen) return;
  launch.firstScreen = true;
  const session = app.session.getState();
  const ready = app.engines.getState().list.filter((engine) => engine.status.code === EngineStatusCode.Ready);
  const state = {
    status: session.status,
    welcoming: session.welcoming,
    firstLaunch: session.firstLaunch,
    games: app.library.getState().games.length,
    enginesReady: ready.length,
  };
  track(LaunchEvent.AppReadyMeasured, appReadyProperties(state, sinceWindowStart, launch.bootstrapMs));
}

/** The bootstrap as it moves: its first answer, and a Retry from its failure until it answers. */
export interface BootstrapWatch {
  status: SessionStatus;
  startedAt: number;
  answered: boolean;
  attempts: number;
  retryingSince: number | null;
}

/** What one move of the session's status means. */
export interface BootstrapStep {
  watch: BootstrapWatch;
  /** The bootstrap answered for the first time, this long after the watch began. */
  answeredMs: number | null;
  retried: WorkspaceRetriedProperties | null;
}

/** One move of the session's status: the watch after it, the first answer's time, and a retry that ended. */
export function bootstrapStep(watch: BootstrapWatch, status: SessionStatus, now: number): BootstrapStep {
  const settled = status !== SessionStatus.Loading;
  const answeredMs = settled && !watch.answered ? elapsedMs(watch.startedAt, now) : null;
  const next = { ...watch, status, answered: watch.answered || settled };
  if (watch.status === SessionStatus.Failed && status === SessionStatus.Loading)
    return { watch: { ...next, attempts: watch.attempts + 1, retryingSince: now }, answeredMs, retried: null };
  if (watch.retryingSince === null || !settled) return { watch: next, answeredMs, retried: null };
  const retried = {
    attempt: watch.attempts,
    succeeded: status === SessionStatus.Ready,
    elapsed_ms: elapsedMs(watch.retryingSince, now),
  };
  return { watch: { ...next, retryingSince: null }, answeredMs, retried };
}

/** Follow the session: when the bootstrap first answered, and each Retry after a failure. */
function followBootstrap(app: Studio, clock: () => number): () => void {
  let watch: BootstrapWatch = {
    status: app.session.getState().status,
    startedAt: clock(),
    answered: false,
    attempts: 0,
    retryingSince: null,
  };
  const step = (status: SessionStatus): void => {
    if (status === watch.status) return;
    const moved = bootstrapStep(watch, status, clock());
    watch = moved.watch;
    if (moved.answeredMs !== null) launch.bootstrapMs = moved.answeredMs;
    if (moved.retried) track(LaunchEvent.WorkspaceLoadRetried, moved.retried);
  };
  step(app.session.getState().status);
  return app.session.subscribe(guarded((state) => step(state.status)));
}

const updateKey = (update: ReadyUpdate): string => `${update.action}\n${update.version ?? ""}`;

/**
 * Follow the waiting update. Main announces one (`update.ready`), or the bootstrap finds one that
 * arrived before this window: the store moves first either way, so it is read a moment later, once
 * the announcement (if any) has been heard.
 */
function followUpdate(
  app: Studio,
  announced: ReadonlySet<string>,
  clock: () => number,
  later: (run: () => void) => void,
): () => void {
  let last: string | null = null;
  return app.update.subscribe(
    guarded((state) => {
      const { ready } = state;
      const key = ready ? updateKey(ready) : null;
      if (key === last) return;
      last = key;
      if (!ready || !key) return;
      later(
        guarded(() => {
          if (announced.has(key)) return;
          launch.updateReadyAt = clock();
          track(LaunchEvent.UpdateReady, { action: ready.action, at_bootstrap: true });
        }),
      );
    }),
  );
}

/** Relaunch to update, pressed: run it, send what it came to, and hand its answer back. */
export async function trackedRestart(
  surface: UpdateSurface,
  run: () => Promise<boolean>,
  clock: () => number = Date.now,
): Promise<boolean> {
  const waited = launch.updateReadyAt === null ? null : elapsedMs(launch.updateReadyAt, clock());
  try {
    const relaunching = await run();
    const outcome = relaunching ? RestartOutcome.Relaunching : RestartOutcome.NotRelaunched;
    track(LaunchEvent.UpdateRestartPressed, { surface, outcome, waited_ms: waited });
    return relaunching;
  } catch (error) {
    track(LaunchEvent.UpdateRestartPressed, { surface, outcome: RestartOutcome.Failed, waited_ms: waited });
    throw error;
  }
}

/** A Check for Updates' answer (null: the call failed) as `update_check_finished`. */
export const updateCheckProperties = (
  result: Pick<UpdateCheckResult, "status"> | null,
  ms: number,
): UpdateCheckProperties => ({
  status: result?.status ?? CHECK_CALL_FAILED,
  duration_ms: Math.max(0, Math.round(ms)),
});

/** What this area hears: main's update announcement, the session, the window's errors and its long tasks. */
export function createLaunchObservers(
  clock: () => number = Date.now,
  later: (run: () => void) => void = (run) => void setTimeout(run, 0),
): AreaObservers {
  const announced = new Set<string>();
  return {
    ui: (event) => {
      if (event.type !== UiEvent.UpdateReady) return;
      announced.add(updateKey(event.payload));
      launch.updateReadyAt = clock();
      track(LaunchEvent.UpdateReady, { action: event.payload.action, at_bootstrap: false });
    },
    start: (app) => {
      const stops = [
        followBootstrap(app, clock),
        followUpdate(app, announced, clock, later),
        watchErrors(),
        watchStalls(),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}
