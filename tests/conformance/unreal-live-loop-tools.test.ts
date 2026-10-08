/**
 * The Unreal plugin's tools for the live builder's checkpoint: `play-check` queues a play of the
 * game with the board's checks, refusing any bad check before anything is queued; `save-all` saves
 * the editor's work; `log-errors` reads the editor log's new error lines since an offset, without
 * Unreal's and Genex's own noise, across a restarted log; `update-helper` updates the project's
 * Genex editor helper only while Unreal is closed; `editor-state` says where the project's helper
 * stands. The editor and the helper update are stand-ins; the logs, projects and helpers are real
 * files.
 */
import assert from "node:assert/strict";
import { appendFile, cp, mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { CppEditorTool } from "../../src/plugins/unreal/cpp-tools.ts";
import { editorLogPath } from "../../src/plugins/unreal/editor-log.ts";
import { LoopTool, PartRunState, type PlayCheckResult } from "../../src/plugins/unreal/editor-queue.ts";
import {
  type AnyLoopTool,
  createLoopTools,
  HeroShotTool,
  LeadLoopToolName,
  LiveLoopToolName,
  LoopEditorTool,
  LoopToolName,
} from "../../src/plugins/unreal/loop-tools.ts";
import { encodePng, type RgbImage } from "../../src/plugins/unreal/tone.ts";
import { type HelperUpdate, HelperState, type SetupEnv, type SetupOptions } from "../../src/plugins/unreal/setup.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { CrashLog, crashLog, playable } from "../helpers/unreal-editor-stand-in.ts";

const NAME = "DirtTrack";
/** The most lines log-errors names, and how long each may be. */
const MAX_LINES = 40;
const MAX_CHARS = 300;

type Options = {
  /** Whether this game's Unreal answers. */
  answering?: boolean;
  unlinked?: boolean;
  /** The editor's answer to save_all. */
  save?: () => unknown;
  /** The stand-in helper update's answer. */
  update?: () => HelperUpdate;
  /** The editor's answer to editor_activity, in place of the stand-in's. */
  activity?: () => unknown;
  /** The build toolset's answers (its hero cameras and stills), by tool. */
  build?: (tool: AnyLoopTool, args: Record<string, unknown>) => Promise<unknown>;
};

function fakeEnv(home: string): SetupEnv {
  return {
    home,
    platform: "darwin",
    programData: path.join(home, "ProgramData"),
    editorRunning: async () => false,
    portListening: async () => false,
    editorAnswers: async () => false,
    xcode: async () => ({ state: XcodeState.Ready }) as never,
    freeBytes: async () => 0,
    totalMemory: () => 0,
  };
}

/** A game linked to a project, its log in a home of its own, a shipped helper, and the Loop's tools over a stand-in editor. */
async function liveWorld(options: Options = {}) {
  const root = await realpath(await tmpDir("studio-unreal-live-tools-"));
  const home = path.join(root, "home");
  const game = path.join(root, "AI Games", "dirt-track");
  const project = path.join(game, "unreal", `${NAME}.uproject`);
  const storage = path.join(root, "storage");
  const shipped = path.join(root, "shipped", "GenexEditorHelper");
  await mkdir(path.dirname(project), { recursive: true });
  await mkdir(storage, { recursive: true });
  await writeFile(project, JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8" }));
  await mkdir(path.join(shipped, "Content", "Python", "genex_build"), { recursive: true });
  await writeFile(
    path.join(shipped, "GenexEditorHelper.uplugin"),
    JSON.stringify({ Version: 5, VersionName: "0.5.0" }),
  );
  await writeFile(path.join(shipped, "Content", "Python", "genex_build", "tools.py"), "# build tools\n");
  const log = editorLogPath({ file: project, directory: path.dirname(project) }, home, "darwin");
  await mkdir(path.dirname(log), { recursive: true });
  await writeFile(log, await crashLog(CrashLog.Open, project));

  const calls: Array<[AnyLoopTool, Record<string, unknown>]> = [];
  const updates: Array<[string, SetupOptions]> = [];
  const state = { answering: options.answering ?? true };
  const editor = playable();
  const setup = (folder: string): SetupOptions => ({ env: fakeEnv(home), helper: shipped, storage: folder });
  const tools = createLoopTools({
    platform: "darwin",
    home,
    setup,
    engine: async () => ({ version: "5.8", directory: path.join(root, "engine") }),
    project: async () => (options.unlinked ? undefined : project),
    xcode: async () => ({ state: XcodeState.Ready }),
    editorCall: async (_storage, _game, tool, args) => {
      calls.push([tool, args]);
      if (tool === LoopEditorTool.ExportReference) throw new Error("not in these tests");
      if (tool === CppEditorTool.SaveAll) return options.save ? options.save() : { saved: true, dirty: [], ms: 640 };
      if (tool === LoopTool.EditorActivity && options.activity) return options.activity();
      if (Object.values(HeroShotTool).includes(tool as HeroShotTool)) return options.build?.(tool, args);
      const answer = await editor.editor.port.call(tool as LoopTool, args);
      if (tool !== LoopTool.CapturePlay) return answer;
      // The queue reads the shot the editor wrote from the project's own Saved folder.
      const shot = path.join(path.dirname(project), "Saved", "Genex", "captures", `${args.name}.png`);
      await mkdir(path.dirname(shot), { recursive: true });
      await writeFile(shot, "PNG");
      return { queued: true, file: shot };
    },
    editorAnswers: async () => state.answering,
    updateHelper: async (file, given) => {
      updates.push([file, given]);
      return options.update?.() ?? { from: "0.4.0", to: "0.5.0", kept: [] };
    },
    restart: { editors: async () => 0, quit: async () => {}, open: async () => {} },
    now: editor.deps.now,
    sleep: editor.deps.sleep,
  });
  const context: PluginContext = {
    project: "dirt-track",
    directory: game,
    signal: new AbortController().signal,
    callId: 1,
    host: (async () => storage) as never,
  };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    tools.call(name as LoopToolName, args, context, storage);
  return { root, home, game, project, storage, shipped, log, calls, updates, state, editor, call, tools };
}

type World = Awaited<ReturnType<typeof liveWorld>>;
type LogErrors = { offset: number; lines: string[]; more: number; rotated: boolean };

const logErrors = async (w: World, since?: number) =>
  (await w.call(LiveLoopToolName.LogErrors, since === undefined ? {} : { since })) as LogErrors;

/** A log line as Unreal writes it, stamped with its time and frame. */
const stamped = (frame: number, line: string) =>
  `[2026.01.01-13.00.${String(frame % 60).padStart(2, "0")}:000][${frame}]${line}`;

describe("play-check", () => {
  it("queues a play of the game with the board's checks, answers its id at once, and part-result reads it", async () => {
    const w = await liveWorld();
    const checks = {
      "feature:track:0": { tag: "genex:track", exists: true },
      "feature:track:1": { player: "routeProgressM", atLeast: 150 },
    };
    const queued = (await w.call(LiveLoopToolName.PlayCheck, { checks })) as { id: string };
    assert.match(queued.id, /play-check/);
    let run: { state: string; part: string; result?: PlayCheckResult; error?: string } | undefined;
    for (let i = 0; i < 5000; i++) {
      run = (await w.call(LoopToolName.PartResult, { id: queued.id })) as typeof run;
      if (run?.state === PartRunState.Done || run?.state === PartRunState.Failed) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(run?.state, PartRunState.Done, run?.error);
    assert.equal(run?.part, "play-check");
    assert.deepEqual(
      run?.result?.checks.map((c) => [c.id, c.passed]),
      [
        ["feature:track:0", true],
        ["feature:track:1", true],
      ],
    );
    assert.equal(run?.result?.frames.length, 4);
    assert.equal(
      w.calls.some(([tool]) => tool === LoopTool.ApplyPart),
      false,
      "nothing is applied",
    );
  });

  const hostile: Array<[string, unknown, RegExp]> = [
    ["no checks at all", undefined, /checks/],
    ["checks as JSON text", '{"feature:a:0":{"tag":"genex:a","exists":true}}', /checks/],
    ["checks as a list", [{ tag: "genex:a", exists: true }], /checks/],
    ["checks as null", null, /checks/],
    [
      "an actor check (a part's, not the board's)",
      { "feature:a:0": { actor: "Lantern_0", exists: true } },
      /feature:a:0/,
    ],
    ["a tag that isn't a genex: tag", { "feature:a:0": { tag: "terrain", exists: true } }, /feature:a:0/],
    ["a tag check with another key", { "feature:a:0": { tag: "genex:a", exists: true, why: "x" } }, /feature:a:0/],
    ["a player check without a bound", { "feature:a:0": { player: "speedKmh" } }, /feature:a:0/],
    ["a player check bound by text", { "feature:a:0": { player: "speedKmh", atLeast: "20" } }, /feature:a:0/],
    ["a check that is text", { "feature:a:0": "genex:a" }, /feature:a:0/],
    ["a board id too long", { [`feature:${"a".repeat(96)}:0`]: { tag: "genex:a", exists: true } }, /board id/],
    ["a board id with a space", { "feature:a b:0": { tag: "genex:a", exists: true } }, /board id/],
    ["a board id with a newline", { "feature:a\n:0": { tag: "genex:a", exists: true } }, /board id/],
    ["an empty board id", { "": { tag: "genex:a", exists: true } }, /board id/],
    [
      "more than 40 checks",
      Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`feature:a:${i}`, { tag: "genex:a", exists: true }])),
      /at most 40/,
    ],
  ];
  for (const [label, checks, why] of hostile) {
    it(`refuses ${label}, queuing nothing and calling no editor tool`, async () => {
      const w = await liveWorld();
      const args = checks === undefined ? {} : { checks };
      await assert.rejects(w.call(LiveLoopToolName.PlayCheck, args), why);
      assert.deepEqual(w.calls, []);
      await assert.rejects(w.call(LoopToolName.PartResult, { id: "dirt-track-play-check-1" }), /no part run/);
    });
  }

  it("names every bad check in one refusal", async () => {
    const w = await liveWorld();
    const checks = {
      "feature:a:0": { tag: "terrain", exists: true },
      "feature:a:1": { tag: "genex:a", exists: true },
      "feature:b:0": { player: "speedKmh" },
    };
    await assert.rejects(w.call(LiveLoopToolName.PlayCheck, { checks }), (error: Error) => {
      assert.match(error.message, /feature:a:0/);
      assert.match(error.message, /feature:b:0/);
      assert.doesNotMatch(error.message, /feature:a:1/);
      return true;
    });
  });
});

describe("save-all", () => {
  it("saves the editor's work and answers the helper's report", async () => {
    const w = await liveWorld();
    assert.deepEqual(await w.call(LiveLoopToolName.SaveAll), { saved: true, dirty: [], ms: 640 });
    assert.deepEqual(w.calls, [
      [LoopTool.PlayState, {}],
      [CppEditorTool.SaveAll, {}],
    ]);
  });

  it("stops a play session the builder left running, waits for it to end, then saves", async () => {
    const box: { world?: World } = {};
    const refused = { error: "A play session is running; stop it first (stop_play)." };
    const w = await liveWorld({
      save: () => (box.world?.editor.editor.state.pie ? refused : { saved: true, dirty: [], ms: 640 }),
    });
    box.world = w;
    w.editor.editor.state.pie = true;
    assert.deepEqual(await w.call(LiveLoopToolName.SaveAll), { saved: true, dirty: [], ms: 640 });
    const tools = w.calls.map(([tool]) => tool);
    const stopped = tools.indexOf(LoopTool.StopPlay);
    assert.ok(stopped >= 0 && stopped < tools.indexOf(CppEditorTool.SaveAll), tools.join(", "));
  });

  it("throws the helper's refusal during play", async () => {
    const w = await liveWorld({ save: () => ({ error: "A play session is running; stop it before saving." }) });
    await assert.rejects(w.call(LiveLoopToolName.SaveAll), /play session is running/);
  });

  it("throws when what the editor answered isn't the helper's report", async () => {
    const w = await liveWorld({ save: () => "Traceback (most recent call last)" });
    await assert.rejects(w.call(LiveLoopToolName.SaveAll), /didn't answer/);
  });

  it("throws, calling nothing, when Unreal doesn't answer", async () => {
    const w = await liveWorld({ answering: false });
    await assert.rejects(w.call(LiveLoopToolName.SaveAll), /isn't answering/);
    assert.deepEqual(w.calls, []);
  });
});

/** Error lines an editor writes while a step is saved and played, with Unreal's and Genex's own noise among them. */
const STEP_LOG = [
  stamped(
    100,
    "LogBlueprint: Error: [AssetLog] /Game/Track/BP_Track.BP_Track: [Compiler] Accessed None reading Spline",
  ),
  stamped(
    101,
    "LogBlueprint: Error: [AssetLog] /Game/Track/BP_Track.BP_Track: [Compiler] Accessed None reading Spline",
  ),
  stamped(102, "LogPython: Error: Traceback (most recent call last):"),
  stamped(
    103,
    'LogPython: Error:   File "/Users/owner/AI Games/dirt-track/unreal/Content/Python/genex_build/tools.py", line 42, in track_terrain',
  ),
  stamped(104, "LogHttpConnection: Error: errors.com.epicgames.httpserver.socket_send_failure"),
  stamped(
    105,
    "LogModelContextProtocol: Error: Unknown session id 'ab12' for 'notifications/initialized'; client should reinitialize",
  ),
  stamped(106, "LogToolsetRegistry: Error: Toolset 'ObjectTools' not found"),
  stamped(107, "LogEOSMessageService: Error: Unable to find port."),
  stamped(108, "LogClass: Error: ByteProperty FStepSettings::TraceChannel is not initialized properly"),
  stamped(109, "LogTemp: Error test: UE::UnifiedErrorTest::Empty: [Empty error]"),
  stamped(110, "LogAudioMixerAudioUnit: Warning: Error querying Sample Rate: 2003332927"),
  stamped(111, "LogOutputDevice: Error: Ensure condition failed: Bike != nullptr"),
  stamped(112, "LogOutputDevice: Error: [Callstack] 0x0e3e90f0 libUnrealEditor-Engine.dylib!USceneComponent::Tick()"),
  stamped(113, "LogOutputDevice: Error: "),
  stamped(114, "LogScript: Fatal: Script call stack: BP_Track.ReceiveTick"),
].join("\n");

/** What log-errors names of {@link STEP_LOG}: each error once, without its stamp, the owner's path cut to its file. */
const STEP_ERRORS = [
  "LogBlueprint: Error: [AssetLog] /Game/Track/BP_Track.BP_Track: [Compiler] Accessed None reading Spline",
  "LogPython: Error: Traceback (most recent call last):",
  'LogPython: Error: File "tools.py", line 42, in track_terrain',
  "LogOutputDevice: Error: Ensure condition failed: Bike != nullptr",
  "LogScript: Fatal: Script call stack: BP_Track.ReceiveTick",
];

describe("log-errors", () => {
  it("answers where the log ends now, and no lines, without since", async () => {
    const w = await liveWorld();
    const size = (await readFile(w.log)).length;
    assert.deepEqual(await logErrors(w), { offset: size, lines: [], more: 0, rotated: false });
  });

  it("names the error lines written since the offset, once each, without noise, stamps or the owner's paths", async () => {
    const w = await liveWorld();
    await appendFile(w.log, `${stamped(90, "LogBlueprint: Error: an error from before the step")}\n`);
    const { offset } = await logErrors(w);
    await appendFile(w.log, `${STEP_LOG}\n`);
    const read = await logErrors(w, offset);
    assert.deepEqual(read.lines, STEP_ERRORS);
    assert.equal(read.more, 0);
    assert.equal(read.rotated, false);
    assert.equal(read.offset, (await readFile(w.log)).length);
    assert.doesNotMatch(read.lines.join("\n"), /\/Users|AI Games|owner/);
    assert.deepEqual(await logErrors(w, read.offset), { offset: read.offset, lines: [], more: 0, rotated: false });
  });

  it("leaves a line Unreal is still writing for the next read", async () => {
    const w = await liveWorld();
    const { offset } = await logErrors(w);
    await appendFile(w.log, `${stamped(1, "LogBlueprint: Error: first")}\n${stamped(2, "LogBlueprint: Error: sec")}`);
    const first = await logErrors(w, offset);
    assert.deepEqual(first.lines, ["LogBlueprint: Error: first"]);
    await appendFile(w.log, "ond\n");
    assert.deepEqual((await logErrors(w, first.offset)).lines, ["LogBlueprint: Error: second"]);
  });

  it("names at most 40 lines of at most 300 characters, and counts the rest", async () => {
    const w = await liveWorld();
    const { offset } = await logErrors(w);
    const lines = Array.from({ length: 45 }, (_, i) => stamped(i, `LogBlueprint: Error: ${i} ${"x".repeat(400)}`));
    await appendFile(w.log, `${lines.join("\n")}\n`);
    const read = await logErrors(w, offset);
    assert.equal(read.lines.length, MAX_LINES);
    assert.equal(read.more, 5);
    for (const line of read.lines) assert.ok(line.length <= MAX_CHARS, `${line.length} characters`);
  });

  it("reads a restarted Unreal's new log from its start, as rotated", async () => {
    const w = await liveWorld();
    await appendFile(w.log, `${STEP_LOG}\n`);
    const { offset } = await logErrors(w);
    // Unreal keeps the old log as a backup and starts a new one: a new file at the same path.
    await rename(w.log, `${w.log.replace(/\.log$/, "")}-backup-2026.01.01-13.10.00.log`);
    const fresh = `${await crashLog(CrashLog.Open, w.project)}${stamped(5, "LogBlueprint: Error: after the restart")}\n`;
    await writeFile(w.log, fresh + "x".repeat(offset));
    const read = await logErrors(w, offset);
    assert.equal(read.rotated, true, "longer than the offset, yet another log");
    assert.deepEqual(read.lines, ["LogBlueprint: Error: after the restart"]);
  });

  it("reads the log from its start, as rotated, when the offset is past its end", async () => {
    const w = await liveWorld();
    await appendFile(w.log, `${stamped(5, "LogBlueprint: Error: in a short new log")}\n`);
    const read = await logErrors(w, 10_000_000);
    assert.equal(read.rotated, true);
    assert.deepEqual(read.lines, ["LogBlueprint: Error: in a short new log"]);
  });

  const unreadable: Array<[string, (w: World) => Promise<void>]> = [
    [
      "a link to another log",
      async (w) => {
        const other = path.join(w.root, "elsewhere.log");
        await writeFile(other, `${await crashLog(CrashLog.Open, w.project)}${STEP_LOG}\n`);
        await rename(w.log, `${w.log}.old`);
        await symlink(other, w.log);
      },
    ],
    [
      "another project's log",
      async (w) => {
        await writeFile(w.log, `${await crashLog(CrashLog.Open, "/Users/owner/Other/Other.uproject")}${STEP_LOG}\n`);
      },
    ],
    ["a missing log", async (w) => rename(w.log, `${w.log}.gone`)],
    [
      "a folder where the log goes",
      async (w) => {
        await rename(w.log, `${w.log}.gone`);
        await mkdir(w.log);
      },
    ],
  ];
  for (const [label, make] of unreadable) {
    it(`names nothing from ${label}`, async () => {
      const w = await liveWorld();
      await make(w);
      assert.deepEqual(await logErrors(w), { offset: 0, lines: [], more: 0, rotated: false });
      assert.deepEqual((await logErrors(w, 0)).lines, []);
    });
  }

  const badSince: unknown[] = [-1, 1.5, "12", Number.POSITIVE_INFINITY, 2 ** 60, null, true, { offset: 3 }];
  for (const since of badSince) {
    it(`refuses since ${typeof since === "number" ? since : JSON.stringify(since)}`, async () => {
      const w = await liveWorld();
      await assert.rejects(w.call(LiveLoopToolName.LogErrors, { since }), /since/);
    });
  }

  it("refuses a game without a linked project", async () => {
    const w = await liveWorld({ unlinked: true });
    await assert.rejects(logErrors(w), /isn't linked to an Unreal project/);
  });
});

describe("update-helper", () => {
  it("updates the project's helper while Unreal is closed, and answers what changed", async () => {
    const w = await liveWorld({
      answering: false,
      update: () => ({ from: "0.4.0", to: "0.5.0", kept: ["Plugins/GenexEditorHelper/Content/Python/x.py.mine"] }),
    });
    assert.deepEqual(await w.call(LiveLoopToolName.UpdateHelper), {
      from: "0.4.0",
      to: "0.5.0",
      kept: ["Plugins/GenexEditorHelper/Content/Python/x.py.mine"],
    });
    assert.equal(w.updates.length, 1);
    const [file, options] = w.updates[0] ?? [];
    assert.equal(file, w.project);
    assert.deepEqual([options?.helper, options?.storage], [w.shipped, w.storage]);
  });

  it("refuses, updating nothing, while this game's Unreal answers", async () => {
    const w = await liveWorld({ answering: true });
    await assert.rejects(w.call(LiveLoopToolName.UpdateHelper), /Unreal is open/);
    assert.deepEqual(w.updates, []);
  });

  it("refuses a game without a linked project", async () => {
    const w = await liveWorld({ answering: false, unlinked: true });
    await assert.rejects(w.call(LiveLoopToolName.UpdateHelper), /isn't linked to an Unreal project/);
    assert.deepEqual(w.updates, []);
  });
});

describe("editor-state names where the project's helper stands", () => {
  const helperIn = (w: World) => path.join(path.dirname(w.project), "Plugins", "GenexEditorHelper");
  const cases: Array<[string, (w: World) => Promise<void>, string]> = [
    ["missing", async () => {}, HelperState.Missing],
    ["the shipped one", (w) => cp(w.shipped, helperIn(w), { recursive: true }), HelperState.Current],
    [
      "an older one",
      async (w) => {
        await cp(w.shipped, helperIn(w), { recursive: true });
        await writeFile(path.join(helperIn(w), "GenexEditorHelper.uplugin"), JSON.stringify({ Version: 4 }));
      },
      HelperState.Outdated,
    ],
  ];
  for (const [label, make, helper] of cases) {
    it(`reads ${helper} for ${label}`, async () => {
      const w = await liveWorld();
      await make(w);
      const state = (await w.call(LoopToolName.EditorState)) as { helper: string | null; answering: boolean };
      assert.equal(state.helper, helper);
      assert.equal(state.answering, true);
    });
  }

  it("reads null for a game without a linked project", async () => {
    const w = await liveWorld({ unlinked: true });
    assert.equal(((await w.call(LoopToolName.EditorState)) as { helper: unknown }).helper, null);
  });
});

describe("editor-activity", () => {
  it("answers whether a play session runs and how many packages are unsaved", async () => {
    const w = await liveWorld({
      activity: () => ({ camera: [0, 0, 0], selection: [], dirty: ["/Game/Maps/Hall", "/Game/Kit/SM_Rib"], pie: true }),
    });
    assert.deepEqual(await w.call(LeadLoopToolName.EditorActivity), { pie: true, dirty: 2 });
  });

  it("throws, calling nothing, when Unreal doesn't answer", async () => {
    const w = await liveWorld({ answering: false });
    await assert.rejects(w.call(LeadLoopToolName.EditorActivity), /isn't answering/);
    assert.deepEqual(w.calls, []);
  });

  const odd: Array<[string, unknown]> = [
    ["a traceback", "Traceback (most recent call last)"],
    ["no play state", { dirty: [] }],
    ["a count for dirty", { dirty: 3, pie: false }],
    ["a refusal", { error: "The editor is busy." }],
  ];
  for (const [label, answer] of odd)
    it(`throws when the editor answers ${label}, so nobody reads it as idle`, async () => {
      const w = await liveWorld({ activity: () => answer });
      await assert.rejects(w.call(LeadLoopToolName.EditorActivity));
    });
});

/** A small picture: a dark frame with a bright band, as a PNG. */
function picture(): Buffer {
  const image: RgbImage = { width: 64, height: 36, rgb: new Uint8Array(64 * 36 * 3) };
  for (let i = 0; i < image.rgb.length; i += 1) image.rgb[i] = Math.floor(i / 3) % 64 < 16 ? 220 : 12;
  return encodePng(image);
}

/** A level with these hero cameras whose stills land in `folder` (the project's captures folder unless a test moves them). */
async function heroWorld(cameras: string[], where?: (w: World, camera: string) => Promise<string>) {
  const box: { world?: World } = {};
  const w = await liveWorld({
    build: async (tool, args) => {
      const world = box.world as World;
      if (tool === HeroShotTool.ShotCameras) return { cameras };
      const camera = String(args.camera);
      const file = where
        ? await where(world, camera)
        : path.join(path.dirname(world.project), "Saved", "Genex", "captures", `shot-${camera}.png`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, picture());
      return { queued: true, file, camera, width: args.width, height: args.height, delayS: args.delay_s };
    },
  });
  box.world = w;
  return w;
}

type HeroShots = { shots: Array<{ name: string; file: string; data: string; tone: Record<string, number> }> };

describe("hero-shots", () => {
  it("captures each hero camera with the prefix, up to max, as PNG data with its tone numbers", async () => {
    const w = await heroWorld(["GX_Shot_Atrium", "GX_Shot_Hall", "GX_Shot_Roof", "SomeCamera"]);
    const answer = (await w.call(LeadLoopToolName.HeroShots, { prefix: "GX_Shot_", max: 2 })) as HeroShots;
    assert.deepEqual(
      answer.shots.map((shot) => shot.name),
      ["GX_Shot_Atrium", "GX_Shot_Hall"],
    );
    const [first] = answer.shots;
    assert.equal(Buffer.from(first?.data ?? "", "base64").equals(picture()), true, "the PNG as it landed");
    assert.equal(typeof first?.tone.p2, "number");
    assert.equal(typeof first?.tone.farStd, "number");
    const asked = w.calls.filter(([tool]) => tool === HeroShotTool.CaptureShot).map(([, args]) => args.camera);
    assert.deepEqual(asked, ["GX_Shot_Atrium", "GX_Shot_Hall"], "one still per camera, no more than max");
  });

  it("answers no shots, capturing nothing, for a level without hero cameras", async () => {
    const w = await heroWorld([]);
    assert.deepEqual(await w.call(LeadLoopToolName.HeroShots, { prefix: "GX_Shot_", max: 4 }), { shots: [] });
    assert.equal(w.calls.filter(([tool]) => tool === HeroShotTool.CaptureShot).length, 0);
  });

  it("refuses a bad prefix or max, asking the editor nothing", async () => {
    const w = await heroWorld(["GX_Shot_Hall"]);
    const bad: Array<Record<string, unknown>> = [
      {},
      { prefix: "", max: 2 },
      { prefix: "../GX", max: 2 },
      { prefix: "GX_Shot_", max: 0 },
      { prefix: "GX_Shot_", max: 2.5 },
      { prefix: "GX_Shot_", max: 99 },
      { prefix: "GX_Shot_", max: "4" },
    ];
    for (const args of bad) await assert.rejects(w.call(LeadLoopToolName.HeroShots, args), JSON.stringify(args));
    assert.deepEqual(w.calls, []);
  });

  it("reads no still from outside the project's captures folder", async () => {
    const outside: Array<[string, (w: World, camera: string) => Promise<string>]> = [
      ["another folder", async (w, camera) => path.join(w.root, "elsewhere", `${camera}.png`)],
      [
        "a path that climbs out",
        async (w, camera) =>
          path.join(path.dirname(w.project), "Saved", "Genex", "captures", "..", "..", `${camera}.png`),
      ],
      [
        "a captures folder that is a link",
        async (w, camera) => {
          const real = path.join(w.root, "real-captures");
          await mkdir(real, { recursive: true });
          const link = path.join(path.dirname(w.project), "Saved", "Genex", "captures");
          await mkdir(path.dirname(link), { recursive: true });
          await symlink(real, link).catch(() => {});
          return path.join(link, `${camera}.png`);
        },
      ],
    ];
    for (const [label, where] of outside) {
      const w = await heroWorld(["GX_Shot_Hall"], where);
      const answer = (await w.call(LeadLoopToolName.HeroShots, { prefix: "GX_Shot_", max: 4 })) as HeroShots;
      assert.deepEqual(answer.shots, [], label);
    }
  });
});

describe("the live tools beside the part tools", () => {
  it("are tools of the Loop's, called by name", async () => {
    const w = await liveWorld();
    for (const name of Object.values(LiveLoopToolName)) assert.ok(w.tools.has(name), name);
    for (const name of Object.values(LeadLoopToolName)) assert.ok(w.tools.has(name), name);
    for (const name of Object.values(LoopToolName)) assert.ok(w.tools.has(name), name);
    assert.equal(w.tools.has("apply-part"), false);
  });
});
