/**
 * A fake host for the Unreal Loop's lead (`runUnrealLead`): a third-person game linked to the Unreal
 * project inside its folder, and an editor that answers the Unreal plugin's harness tools from a
 * small model (whether it answers, whether it is dirty or playing, its log, its C++ source; a
 * snapshot holds the level's marks and a restore puts them back). A test may stall `editor-state`,
 * make a reopen fail, take away the plugin's newer tools, or answer any plugin tool itself. The
 * lead's session is a script of turns: each `engine.delegate` runs the next one, which calls the run
 * tools through the studio's own `director_tool` dispatch (`directorTool`), as the host forwards
 * them, and may wait while the harness watches it. The clock is the test's: a wait moves it and
 * yields once.
 */
import { setImmediate as tick } from "node:timers/promises";
import { directorTool } from "../../src/harness-seed/loop/director/tool-specs.ts";
import { buildRunGraph } from "../../src/renderer/run-graph.ts";
import { PluginCallBlocker } from "../../src/shared/plugins.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import { WorkerIsolation, type WorkerType } from "../../src/shared/workers.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { type CtxRecorder, ctxRecorder } from "./ctx-recorder.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The host's answer, never an error, to a checkpoint's call while the chat plans. */
const PLAN_ANSWER = {
  consent: "declined",
  blocker: PluginCallBlocker.PlanMode,
  message: "The chat is in Plan mode, so this action did not run.",
} as const;

/** A worker type in copies, as `plugins.workerTypes` lists it. */
const inCopies = (pluginId: string, id: string, tools: string[]): WorkerType => ({
  pluginId,
  id,
  description: id,
  tools,
  isolation: WorkerIsolation.Copy,
});

/**
 * The worker types the bundled plugins declare for an Unreal game with Local Blender and Genex on,
 * as `plugins.workerTypes` lists them (each type's tools as agent names).
 */
export const BUNDLED_WORKER_TYPES: readonly WorkerType[] = [
  inCopies("blender", "blender_model", ["blender__model", "blender__retrieve", "blender__status"]),
  inCopies("blender", "blender_prep", ["blender__model", "blender__retrieve", "blender__status"]),
  inCopies("genex", "genex_cast", ["genex__asset", "blender__"]),
  inCopies("genex", "sound", ["genex__asset"]),
  inCopies("genex", "texture", ["genex__asset", "blender__"]),
  inCopies("unreal", "cpp", ["unreal__check-part"]),
];

/** The game the lead builds: linked to the Unreal project inside its folder. */
export const GAME = {
  name: "tower-climb",
  dir: "/games/tower-climb",
  title: "Tower Climb",
  engine: {
    kind: "unreal",
    project: "/games/tower-climb/unreal/TowerClimb.uproject",
    linkedAt: "2026-10-06T08:00:00.000Z",
  },
};

/** A three-hour lead run on it. */
export const RUN = {
  runId: "run-lead",
  goal: "A third-person climb up an endless concrete tower in fog, with a sword.",
  project: GAME.name,
  mode: "autopilot",
  engine: "claude-code",
  budgets: { wallClockMs: 3 * HOUR, completionPolicy: "duration", outageDelays: [] },
};

/** What the Genex editor helper exported about the template: the third-person template. */
export const TEMPLATE = {
  map: "/Game/ThirdPerson/Maps/Lvl_ThirdPerson",
  gameMode: { path: "/Game/ThirdPerson/Blueprints/BP_ThirdPersonGameMode", defaultPawn: "BP_ThirdPersonCharacter" },
  blueprints: [
    {
      name: "BP_ThirdPersonCharacter",
      path: "/Game/ThirdPerson/Blueprints/BP_ThirdPersonCharacter",
      parent: "Character",
      components: [{ name: "FollowCamera", class: "CameraComponent" }],
    },
  ],
  inputActions: ["Jump", "Move", "Look"],
};

/** A source stamp that doesn't build: reopening Unreal on it fails as the plugin's does. */
export const BROKEN_SOURCE = "src-broken";

/** One turn of the lead's session: what it was asked, its run tools, and the host. */
export type TurnCall = {
  params: Record<string, unknown>;
  tool: (name: string, args?: Record<string, string>) => Promise<unknown>;
  host: LeadHost;
  /** The turn's number, from 1. */
  n: number;
};
/** What a scripted turn does; it may answer its own result (or throw, as an engine does). */
export type Turn = (
  call: TurnCall,
) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

/** A run tool's answer as text. */
export const textOf = (answer: unknown): string => (typeof answer === "string" ? answer : JSON.stringify(answer));

/** A turn that builds for ten minutes and saves. */
export const buildsAndSaves: Turn = async ({ tool, host, n }) => {
  host.work(`turn-${n}`);
  await tool("save_point", { label: `Turn ${n}`, summary: "built more of the tower" });
  return undefined;
};

/** A turn that builds and ends without a save point. */
export const buildsOnly: Turn = ({ host, n }) => {
  host.work(`turn-${n}`);
  return undefined;
};

/** The editor: whether it answers, its helper, the stalls before it answers again, a reopen's state. */
export type Editor = {
  answering: boolean;
  /**
   * Whether the project's editor process runs, as `editor-state` says (null: the plugin can't
   * tell); unset, it runs while it answers: a crashed editor's process is gone.
   */
  running?: boolean | null;
  helper: string | null;
  misses: number;
  reopening: Record<string, unknown>;
  /** Unsaved packages (null: the plugin has no `editor-activity` tool), and whether a play session runs. */
  dirty: number | null;
  playing: boolean;
  /** How many reopens fail before one works. */
  reopenFails: number;
  /**
   * How many `editor-state` reads still find the editor's process running after `end-editor` (it
   * stopped answering but is still exiting); a helper update refuses while it runs, as setup does.
   */
  exitLag?: number;
};

export type LeadHost = {
  rec: CtxRecorder;
  clock: { now: number };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  editor: Editor;
  /** What the level holds (what the lead built), and the C++ source's stamp. */
  level: { marks: Set<string>; source: string };
  /** Whether the plugin has the hero-shots tool, which answers these cameras. */
  heroCameras: string[] | null;
  /**
   * Whether the run's chat is in Plan mode: a call that is part of a checkpoint (`checkpoint: true`)
   * gets the host's Plan answer, and the rest run.
   */
  planning: boolean;
  /** A plugin tool's own answer, in place of the stand-in's, by its name (a throw is a refusal). */
  answers: Map<string, (args: Record<string, unknown>) => unknown>;
  /** New error lines the editor's log gives the next `log-errors` read. */
  logLines: string[];
  /** Run artifacts by id (the journal is one), as `artifact.write` keeps them. */
  artifacts: Map<string, unknown>;
  /** How many lead turns are under way now, and the most at once. */
  inFlight: { now: number; most: number };
  /** The plugin tools and host methods called while a lead turn was under way, in order. */
  duringTurn: string[];
  /** Whether the session takes a steer mid-turn. */
  takesSteers: boolean;
  /** What each turn lasts on the clock, by default. */
  turnMs: number;
  /** The worker types `plugins.workerTypes` lists (the bundled plugins', unless a test says). */
  workerTypes: readonly WorkerType[];
  /** Builds something into the level: the editor is dirty. */
  work: (mark: string) => void;
  /** Lets the harness's watch run (each look waits 15 seconds on the clock) until `done` holds; whether it did. */
  until: (done: () => boolean, maxTicks?: number) => Promise<boolean>;
  turns: Turn[];
  /** The events the runner appended, as the log keeps them, oldest first. */
  events: () => EventEnvelope[];
  appended: (eventType: string) => Array<Record<string, unknown>>;
  /** The Unreal plugin tools the runner called, by name, in order. */
  tools: () => string[];
  /** The calls in order, as the method or, for a plugin call, `tool:<name>`. */
  trail: () => string[];
  /** The lead turns' prompts, in order. */
  prompts: () => string[];
  /** The steered texts, in order, and the snapshots' reasons. */
  steered: () => string[];
  snapshotReasons: () => string[];
};

type Internals = LeadHost & { snapshots: Map<string, { marks: Set<string>; source: string }>; plays: number };

/** `editor-state`: a stall misses the answer once (its process runs on), else whether Unreal answers and runs. */
function editorState(host: LeadHost) {
  const { editor } = host;
  const stalled = editor.misses > 0;
  if (stalled) editor.misses -= 1;
  const exiting = (editor.exitLag ?? 0) > 0 && !editor.answering;
  if (exiting) editor.exitLag = (editor.exitLag ?? 0) - 1;
  const running = exiting || (editor.running === undefined ? editor.answering : editor.running);
  return {
    answering: editor.answering && !stalled,
    running,
    reopening: { ...editor.reopening },
    helper: editor.helper,
  };
}

/** `reopen-editor`: Unreal opens, unless reopens are to fail or its source doesn't build. */
function reopenEditor(host: LeadHost) {
  const { editor } = host;
  if (editor.reopenFails > 0 || host.level.source === BROKEN_SOURCE) {
    editor.reopenFails = Math.max(0, editor.reopenFails - 1);
    editor.reopening = { state: "failed", error: "Unreal didn't open the project" };
    return { started: true };
  }
  editor.answering = true;
  editor.reopening = { state: "idle" };
  return { answering: true };
}

/** A PNG shot as the plugin hands it back. */
const shot = (name: string, tone?: Record<string, number>) => ({
  name,
  file: `/u/Saved/Genex/${name}.png`,
  data: `PNG:${name}`,
  ...(tone ? { tone } : {}),
});

/** A tone a capture passing the gates reads. */
export const GOOD_TONE = {
  p2: 0.03,
  p98: 0.92,
  mean: 0.31,
  std: 0.22,
  nearStd: 0.2,
  farStd: 0.11,
  saturation: 0.18,
  clipped: 0.001,
};

/** The stand-in plugin's answer to one tool call, from the editor and the level. */
function standInAnswer(host: Internals, name: string, args: Record<string, unknown>) {
  const { editor } = host;
  switch (name) {
    case "unreal__editor-state":
      return editorState(host);
    case "unreal__editor-activity":
      if (editor.dirty === null) throw new Error("Unknown tool: editor-activity");
      return { pie: editor.playing, dirty: editor.dirty };
    case "unreal__save-all":
      if (!editor.answering) throw new Error("Unreal doesn't answer");
      editor.playing = false;
      if (editor.dirty !== null) editor.dirty = 0;
      return { saved: true, dirty: [], ms: 5 };
    case "unreal__end-editor":
      editor.answering = false;
      return { ended: 1 };
    case "unreal__reopen-editor":
      return reopenEditor(host);
    case "unreal__log-errors":
      return args.since === undefined
        ? { offset: 100, lines: [], more: 0, rotated: false }
        : { offset: 200 + host.logLines.length, lines: host.logLines.splice(0), more: 0, rotated: false };
    case "unreal__hero-shots":
      if (!host.heroCameras) throw new Error("Unknown tool: hero-shots");
      return { shots: host.heroCameras.map((camera) => shot(camera, GOOD_TONE)) };
    case "unreal__play-check":
      host.plays += 1;
      return { id: `pc-${host.plays}` };
    case "unreal__part-result":
      return { id: args.id, state: "done", result: { shots: [shot("spawn"), shot("ride")], frames: [] } };
    case "unreal__cpp-status":
      return { canCompile: false, xcode: "missing", platform: "darwin", module: null, adding: { state: "idle" } };
    case "unreal__update-helper":
      if ((editor.exitLag ?? 0) > 0) throw new Error("Quit Unreal Editor first.");
      editor.helper = "current";
      return { from: "0.4.0", to: "0.5.0", kept: [] };
    default:
      return { ok: true };
  }
}

/** One lead turn: the next scripted one (or one that builds and saves), on the test's clock. */
async function delegate(host: LeadHost, params: Record<string, unknown>, n: number) {
  const turn = host.turns.shift() ?? buildsAndSaves;
  const runId = String((params.director as { runId?: string } | undefined)?.runId ?? "");
  const tool = (name: string, args: Record<string, string> = {}) => directorTool({ runId, name, args });
  host.inFlight.now += 1;
  host.inFlight.most = Math.max(host.inFlight.most, host.inFlight.now);
  try {
    host.clock.now += host.turnMs;
    const own = await turn({ params, tool, host, n });
    await tick();
    const sessionId = String(params.resume ?? `session-${n}`);
    return { ok: true, engine: "claude-code", summary: "worked", usage: {}, turns: 3, sessionId, ...own };
  } finally {
    host.inFlight.now -= 1;
  }
}

/** The run's events as the log keeps them, oldest first. */
function loggedEvents(rec: CtxRecorder): EventEnvelope[] {
  let n = 0;
  return rec.paramsOf("events.append").flatMap((p) =>
    (p.batch as Array<{ event_type: string; payload: Record<string, unknown> }>).map((e) => {
      n += 1;
      return {
        id: `e${String(n).padStart(4, "0")}`,
        thread_id: "t1",
        session_id: null,
        turn_id: null,
        created_at: new Date(Date.UTC(2026, 9, 6, 12, 0, 0, n)).toISOString(),
        data: { type: "custom", event_type: e.event_type, payload: e.payload },
      } as EventEnvelope;
    }),
  );
}

/** Notes a call made while a lead turn was under way. */
function watched(host: LeadHost, what: string): void {
  if (host.inFlight.now > 0) host.duringTurn.push(what);
}

/** The steer's answer: the session takes it while it reads steers mid-turn. */
function steerAnswer(host: LeadHost, params: Record<string, unknown>) {
  const ids = (params.messages as Array<{ id: string }>).map((m) => m.id);
  const taken = host.takesSteers && host.inFlight.now > 0;
  return { how: taken ? "mid-turn" : null, accepted: taken ? ids : [] };
}

/** The host's answers, by method. */
function handlers(host: Internals) {
  let turns = 0;
  let crops = 0;
  return {
    "events.append": () => ({ ids: [] }),
    "events.messages": () => [],
    "game.list": () => [GAME],
    "engine.describe": () => [{ id: "claude-code", kind: "delegated", supportsSessions: true }],
    "plugins.tools": () => ({
      tools: [{ name: "blender__model" }, { name: "genex__asset" }],
      guidance: "",
      revision: 1,
    }),
    "plugins.workerTypes": () => [...host.workerTypes],
    "engine.delegate": (params: Record<string, unknown>) => {
      watched(host, "engine.delegate");
      return delegate(host, params, ++turns);
    },
    "engine.steer": (params: Record<string, unknown>) => steerAnswer(host, params),
    "engine.abort": () => ({ aborted: 1 }),
    "artifact.write": (params: Record<string, unknown>) => {
      host.artifacts.set(String(params.artifactId), structuredClone(params.value));
      return true;
    },
    "artifact.read": (params: Record<string, unknown>) => host.artifacts.get(String(params.artifactId)) ?? null,
    "run.artifact": (params: Record<string, unknown>) => `/runs/${String(params.runId)}/${String(params.name)}`,
    "preview.crop": (params: Record<string, unknown>) => {
      crops += 1;
      return { path: `/runs/${String(params.runId)}/${String(params.label)}.jpg`, base64: `JPEG:${crops}` };
    },
    "snapshot.create": (params: Record<string, unknown>) => {
      watched(host, "snapshot.create");
      const id = `snap-${host.snapshots.size + 1}`;
      host.snapshots.set(id, { marks: new Set(host.level.marks), source: host.level.source });
      return { snapshot_id: id, scope: "game", git: {}, created_at: new Date(0).toISOString(), reason: params.reason };
    },
    "snapshot.restore": (params: Record<string, unknown>) => {
      watched(host, "snapshot.restore");
      const held = host.snapshots.get(String(params.snapshotId));
      if (held) host.level = { marks: new Set(held.marks), source: held.source };
      return true;
    },
    "run.exec": (params: Record<string, unknown>) => {
      const command = String(params.command);
      if (command.includes("unreal/Source")) return { code: 0, stdout: `${host.level.source}\n`, stderr: "" };
      if (command.includes("project.json")) return { code: 0, stdout: JSON.stringify(TEMPLATE), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    "plugins.invoke": (params: Record<string, unknown>) => {
      const name = String(params.name);
      watched(host, name);
      if (host.planning && params.checkpoint === true) return { ...PLAN_ANSWER };
      const own = host.answers.get(name);
      const args = (params.args ?? {}) as Record<string, unknown>;
      return own ? own(args) : standInAnswer(host, name, args);
    },
  };
}

/** A fake host for one or more lead runs on the tower game; `options.turns` scripts the lead's turns. */
export function leadHost(options: { turns?: Turn[]; workerTypes?: readonly WorkerType[] } = {}): LeadHost {
  const host = {
    clock: { now: Date.UTC(2026, 9, 6, 12) },
    editor: {
      answering: true,
      helper: "current",
      misses: 0,
      reopening: { state: "idle" },
      dirty: 0,
      playing: false,
      reopenFails: 0,
    },
    level: { marks: new Set<string>(), source: "src-1" },
    heroCameras: ["GX_Shot_Ant", "GX_Shot_Well"],
    planning: false,
    answers: new Map(),
    logLines: [],
    artifacts: new Map<string, unknown>(),
    inFlight: { now: 0, most: 0 },
    duringTurn: [],
    takesSteers: true,
    turnMs: 10 * MINUTE,
    turns: [...(options.turns ?? [])],
    workerTypes: options.workerTypes ?? BUNDLED_WORKER_TYPES,
    snapshots: new Map(),
    plays: 0,
  } as unknown as Internals;
  host.now = () => host.clock.now;
  host.sleep = async (ms: number) => {
    host.clock.now += ms;
    await tick();
  };
  host.work = (mark) => {
    host.level.marks.add(mark);
    if (host.editor.dirty !== null) host.editor.dirty += 1;
  };
  host.until = async (done, maxTicks = 2_000) => {
    for (let i = 0; i < maxTicks && !done(); i++) await tick();
    return done();
  };
  host.rec = ctxRecorder({ threadId: "t1", handlers: handlers(host) });
  host.events = () => loggedEvents(host.rec);
  host.appended = (eventType) =>
    host.rec
      .paramsOf("events.append")
      .flatMap((p) => p.batch as Array<{ event_type: string; payload: Record<string, unknown> }>)
      .filter((e) => e.event_type === eventType)
      .map((e) => e.payload);
  host.tools = () => host.rec.paramsOf("plugins.invoke").map((p) => String(p.name));
  host.trail = () =>
    host.rec.calls.map((c) => (c.method === "plugins.invoke" ? `tool:${String(c.params.name)}` : c.method));
  host.prompts = () => host.rec.paramsOf("engine.delegate").map((p) => String(p.prompt));
  host.steered = () =>
    host.rec.paramsOf("engine.steer").flatMap((p) => (p.messages as Array<{ text: string }>).map((m) => m.text));
  host.snapshotReasons = () => host.rec.paramsOf("snapshot.create").map((p) => String(p.reason));
  return host;
}

/** The run graph and summary of what a host's runs appended. */
export function graphOf(host: LeadHost) {
  const events = host.events();
  return { graph: buildRunGraph(events), summary: summarizeRun(events, RUN.project, RUN.runId) };
}
