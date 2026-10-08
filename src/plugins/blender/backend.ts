import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Activate, PluginContext, PluginScalar } from "../../plugin-sdk/index.d.ts";
import type { PluginNativeResult } from "../../plugin-sdk/index.d.ts";
import { STUDIO_BLENDER_RESULT } from "./wrapper.ts";

/**
 * The host services this plugin calls, by their public SDK names. Kept here rather than imported
 * from Studio, so the example stays SDK-only for authors who copy it.
 */
const HostService = {
  AssetsDeliver: "assets.deliver",
  JobsRead: "jobs.read",
  JobsWrite: "jobs.write",
  NativeRun: "native.run",
  NativeJobs: "native.jobs",
  NativeResult: "native.result",
  ProjectRead: "project.read",
  RuntimeDetect: "runtime.detect",
  RuntimeInstall: "runtime.install",
  RuntimeInstallation: "runtime.installation",
  RuntimeCancelInstall: "runtime.cancelInstall",
} as const;
/** The native job state a finished model run reports. */
const JOB_COMPLETED = "completed";

/** The native runtime every call of this plugin names. */
const BLENDER = { runtime: "blender" } as const;
/** An asset name: lowercase, digits and dashes, so it is safe as a file name and a CLI value. */
const ASSET_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** An asset name as agents write it: also capitals and underscores, which become an {@link ASSET_SLUG}. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** The renders a model job may leave for the agent to inspect. */
const RENDER_FILES = ["render.png", "render-front.png"];
/** Where a script lives when the call names none: `assets/src/<name>.py`. */
const SCRIPT_FOLDER = "assets/src";

/** The most game files one job may read beside its script and model. */
export const MAX_EXTRA_INPUTS = 8;
/** The compose recipe's input slots: a model and every extra input (plugin.json declares as many). */
const INPUT_SLOTS = MAX_EXTRA_INPUTS + 1;
const MIB = 1024 * 1024;
/** The largest one extra input may be. */
const MAX_INPUT_BYTES = 32 * MIB;
/** The largest a job's extra inputs may be together. */
const MAX_INPUTS_BYTES = 64 * MIB;
/** The longest game path an extra input may have, so all of them fit the job's `inputs` value. */
const MAX_INPUT_PATH_CHARS = 120;
/** The folders extra inputs come from, and the one a script's own modules live in. */
const INPUT_ROOTS = ["assets/", "public/assets/"];
const MODULE_ROOT = `${SCRIPT_FOLDER}/`;
const MODULE_EXTENSION = ".py";
/** The kinds of file a script may read: its modules, data, pictures and models. */
const INPUT_EXTENSIONS = new Set([MODULE_EXTENSION, ".json", ".png", ".jpg", ".jpeg", ".glb"]);
/** One plain path segment: no leading dot, space, backslash or other punctuation. */
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
/** Segments a job never reads, whatever the folder: dependencies, agent files and key material. */
const PROTECTED_SEGMENTS = new Set(["node_modules", "AGENTS.md", "CLAUDE.md"]);
const SECRET_NAME = /^(credentials|secrets|id_rsa|id_ed25519)(\.|$)/i;
/** The label the compose job's `inputs` value gives the model's slot. */
const MODEL_SLOT = "model";

/** The setup actions plugin.json declares. */
const BlenderAction = { Status: "status", Install: "install", CancelInstall: "cancel-install" } as const;
/** The agent tools plugin.json declares. */
const BlenderTool = { Status: "status", Retrieve: "retrieve", Model: "model" } as const;
/**
 * The native jobs plugin.json declares: a new model from a script, a transform of an existing one,
 * or either with extra game files the script reads.
 */
const BlenderJob = { Model: "model", Transform: "transform", Compose: "compose" } as const;
/** The job's `rig` value: whether armatures and their actions go into the GLB. */
const RigValue = { On: "1", Off: "0" } as const;
/** The engines a game builds in, as studio.json's `engine.kind` names them (absent: the web). */
const GameEngine = { Web: "web", Unreal: "unreal" } as const;
type GameEngine = (typeof GameEngine)[keyof typeof GameEngine];
/** The game's own record, where a game linked to an engine names it. */
const STUDIO_JSON = "studio.json";

const MESSAGE = {
  UnknownAction: "Unknown Blender action",
  UnknownOperation: "Unknown Blender operation",
  NoRecordedJob: "No recorded job in this project",
  BadSlug:
    "Use an asset name of letters, digits, dashes or underscores, at most 40, starting with a letter or digit (snake_case and capitals become lowercase with dashes).",
  JobFailed: (id: string, reason: string) => `Blender job ${id}: ${reason}`,
  NoExport: "no completed export",
  InputsNeedGame: "Extra inputs need a game: call this from a game's chat.",
  TooManyInputs: `Pass at most ${MAX_EXTRA_INPUTS} extra inputs.`,
  SameInputName: "Two inputs share a file name; a job takes each file name once.",
  InputsTooLarge: `The extra inputs are more than ${MAX_INPUTS_BYTES / MIB} MiB together.`,
  InputPath: (file: string) =>
    `Input ${file}: name a file by its plain path inside this game (letters, digits, dots, dashes and underscores; no dotfiles or parent folders; at most ${MAX_INPUT_PATH_CHARS} characters).`,
  InputPlace: (file: string) =>
    `Input ${file}: inputs are .py modules in ${MODULE_ROOT}, or .json, .png, .jpg or .glb files under assets/ or public/assets/.`,
  InputProtected: (file: string) => `Input ${file}: dependencies, agent files and key material are never inputs.`,
  InputMissing: (file: string) => `Input ${file} does not exist in this game.`,
  InputLink: (file: string) => `Input ${file} goes through a symbolic link; name the file itself.`,
  InputNotFile: (file: string) => `Input ${file} is not a file.`,
  InputTooLarge: (file: string) => `Input ${file} is more than ${MAX_INPUT_BYTES / MIB} MiB.`,
  Renamed: (name: string, slug: string) => `The asset name ${name} became ${slug}.`,
  WebGuidance:
    "Files are relative to the game workspace. Load model.glb with GLTFLoader at its returned asset path (omit public/ in a built app URL). Inspect these renders, integrate the mesh into the scene, then use the preview to verify visible use. A delivered file alone is not integration proof.",
  UnrealGuidance:
    "Files are relative to the game folder. Inspect these renders first, then import model.glb into Unreal with the editor's import tools: Blender metres become Unreal centimetres (x100), +Z stays up and +X stays forward, so model with the pivot at the base and the front along +X. Look at it in the level from the player's view: a delivered file alone is not integration proof.",
  UnrealJoin: (meshes: number) =>
    `This file holds ${meshes} meshes: Unreal imports one mesh per file best, so join them unless a part must move on its own.`,
  RigLeftOut: (armatures: number) =>
    `The scene's ${armatures === 1 ? "armature was" : `${armatures} armatures were`} left out: pass rig to export armatures with their actions.`,
} as const;

type ToolArgs = Record<string, PluginScalar>;
/** One native job request, as `native.run` takes it. */
type NativeRequest = { job: string; inputs: Record<string, string>; values: Record<string, string> };

// Agents get durable IDs and delivered relative paths. Host output roots/logs belong to setup.
const publicJob = (job: PluginNativeResult) => ({
  id: job.id,
  state: job.state,
  runtime: job.runtime,
  version: job.version,
  createdAt: job.createdAt,
  finishedAt: job.finishedAt,
  files: job.files,
  exitCode: job.exitCode,
});

/** The wrapper's JSON result line from a job's stdout, when it printed one. */
function blenderResult(job: PluginNativeResult) {
  const line = job.stdout?.split("\n").findLast((l) => l.startsWith(STUDIO_BLENDER_RESULT));
  return line ? JSON.parse(line.slice(STUDIO_BLENDER_RESULT.length)) : null;
}

/** The source model a transform started from, recorded with the delivery. */
function derivedFrom(args: ToolArgs, job: PluginNativeResult) {
  return args.model ? { derivedFrom: { file: String(args.model), sha256: job.inputs?.model?.sha256 } } : {};
}

/** The job's renders as inline images for the agent to inspect. */
async function renderImages(job: PluginNativeResult) {
  const images = [];
  for (const file of RENDER_FILES)
    if (job.files.includes(file))
      images.push({
        label: file,
        mimeType: "image/png",
        data: (await readFile(path.join(job.output, file))).toString("base64"),
      });
  return images;
}

/** The asset's name as a slug: `Wall_Panel` becomes `wall-panel`; anything else unusable is refused. */
function assetSlug(name: string): string {
  if (!ASSET_NAME.test(name)) throw new Error(MESSAGE.BadSlug);
  const slug = name.toLowerCase().replace(/_/g, "-").replace(/-+/g, "-").replace(/-$/, "");
  if (!ASSET_SLUG.test(slug)) throw new Error(MESSAGE.BadSlug);
  return slug;
}

/** Whether `relative` names a regular file in the game, without following a link. */
async function isGameFile(directory: string | undefined, relative: string): Promise<boolean> {
  if (!directory) return false;
  const info = await lstat(path.join(directory, relative)).catch(() => null);
  return Boolean(info?.isFile());
}

/**
 * The script to run: the one named, else `assets/src/<name>.py` with the name as written, else with
 * its slug when only that file exists. A missing script is reported by the name as written.
 */
async function scriptFor(args: ToolArgs, name: string, slug: string, directory: string | undefined): Promise<string> {
  if (args.script) return String(args.script);
  const written = `${SCRIPT_FOLDER}/${name}.py`;
  const slugged = `${SCRIPT_FOLDER}/${slug}.py`;
  if (slugged === written || (await isGameFile(directory, written))) return written;
  return (await isGameFile(directory, slugged)) ? slugged : written;
}

/** A plain relative path of plain segments, short enough to label a job slot. */
function isPlainPath(relative: string): boolean {
  return relative.length <= MAX_INPUT_PATH_CHARS && relative.split("/").every((s) => PATH_SEGMENT.test(s));
}

/** A module under `assets/src/`, or data, a picture or a model under the game's asset folders. */
function isInputPlace(relative: string): boolean {
  const extension = path.posix.extname(relative).toLowerCase();
  if (!INPUT_EXTENSIONS.has(extension)) return false;
  if (extension === MODULE_EXTENSION) return relative.startsWith(MODULE_ROOT);
  return INPUT_ROOTS.some((root) => relative.startsWith(root));
}

const isProtectedSegment = (segment: string) => PROTECTED_SEGMENTS.has(segment) || SECRET_NAME.test(segment);

/**
 * One extra input's size, after checking it is a regular file inside the game reached through no
 * symbolic link at all. The host checks it again when it stages the file; this check only reads.
 */
async function gameInputBytes(directory: string, relative: string): Promise<number> {
  if (!isPlainPath(relative)) throw new Error(MESSAGE.InputPath(relative));
  if (!isInputPlace(relative)) throw new Error(MESSAGE.InputPlace(relative));
  const segments = relative.split("/");
  if (segments.some(isProtectedSegment)) throw new Error(MESSAGE.InputProtected(relative));
  let at = await realpath(directory);
  for (const segment of segments) {
    at = path.join(at, segment);
    const info = await lstat(at).catch(() => null);
    if (!info) throw new Error(MESSAGE.InputMissing(relative));
    if (info.isSymbolicLink()) throw new Error(MESSAGE.InputLink(relative));
  }
  const file = await lstat(at);
  if (!file.isFile()) throw new Error(MESSAGE.InputNotFile(relative));
  if (file.size > MAX_INPUT_BYTES) throw new Error(MESSAGE.InputTooLarge(relative));
  return file.size;
}

/** The comma-separated extra inputs a call names, each checked; any refusal refuses the call. */
async function extraInputs(raw: PluginScalar | undefined, directory: string | undefined): Promise<string[]> {
  const files = String(raw ?? "")
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean);
  if (!files.length) return [];
  if (!directory) throw new Error(MESSAGE.InputsNeedGame);
  if (files.length > MAX_EXTRA_INPUTS) throw new Error(MESSAGE.TooManyInputs);
  if (new Set(files.map((file) => path.posix.basename(file))).size !== files.length)
    throw new Error(MESSAGE.SameInputName);
  let total = 0;
  for (const file of files) total += await gameInputBytes(directory, file);
  if (total > MAX_INPUTS_BYTES) throw new Error(MESSAGE.InputsTooLarge);
  return files;
}

/**
 * The native job for a call. With extra inputs it is the compose recipe, whose fixed slots take the
 * model (if any) and the inputs; the host stages every declared slot, so an unused one carries the
 * script again, and the `inputs` value names the slots that are real, in order.
 */
function nativeRequest(args: ToolArgs, script: string, slug: string, extras: string[]): NativeRequest {
  const values = { name: slug, rig: args.rig === true ? RigValue.On : RigValue.Off };
  const model = args.model ? String(args.model) : "";
  if (!extras.length && !model) return { job: BlenderJob.Model, inputs: { script }, values };
  if (!extras.length) return { job: BlenderJob.Transform, inputs: { script, model }, values };
  const real = model ? [model, ...extras] : extras;
  const inputs: Record<string, string> = { script };
  for (let slot = 0; slot < INPUT_SLOTS; slot++) inputs[`input${slot + 1}`] = real[slot] ?? script;
  const labels = model ? [MODEL_SLOT, ...extras] : extras;
  return { job: BlenderJob.Compose, inputs, values: { ...values, inputs: labels.join(",") } };
}

/** The engine the game builds in, from its studio.json; a game without a readable one is a web game. */
async function gameEngine(ctx: PluginContext): Promise<GameEngine> {
  try {
    const record = JSON.parse(await ctx.host(HostService.ProjectRead, { path: STUDIO_JSON }));
    return record?.engine?.kind === GameEngine.Unreal ? GameEngine.Unreal : GameEngine.Web;
  } catch {
    return GameEngine.Web;
  }
}

/** What to do with the delivery in this engine, and what the file holds that needs a word. */
function guidanceFor(engine: GameEngine, stats: { meshCount?: number; armatures?: unknown[] }, rig: boolean): string {
  const notes: string[] = [engine === GameEngine.Unreal ? MESSAGE.UnrealGuidance : MESSAGE.WebGuidance];
  const meshes = stats.meshCount ?? 0;
  if (engine === GameEngine.Unreal && meshes > 1) notes.push(MESSAGE.UnrealJoin(meshes));
  const armatures = stats.armatures?.length ?? 0;
  if (!rig && armatures) notes.push(MESSAGE.RigLeftOut(armatures));
  return notes.join(" ");
}

/** Run a model, transform or compose job, deliver its files into the game and record the delivery. */
async function model(args: ToolArgs, ctx: PluginContext) {
  const name = String(args.name ?? "");
  const slug = assetSlug(name);
  const extras = await extraInputs(args.inputs, ctx.directory);
  const script = await scriptFor(args, name, slug, ctx.directory);
  const job = await ctx.host(HostService.NativeRun, nativeRequest(args, script, slug, extras));
  const result = blenderResult(job);
  if (job.state !== JOB_COMPLETED || !result?.ok)
    throw new Error(MESSAGE.JobFailed(job.id, result?.error || job.stderr || job.reason || MESSAGE.NoExport));
  const files = await ctx.host(HostService.AssetsDeliver, { output: job.output, jobId: job.id });
  await ctx.host(HostService.JobsWrite, {
    id: job.id,
    value: { id: job.id, files, ...derivedFrom(args, job), deliveredAt: new Date().toISOString() },
  });
  const images = await renderImages(job);
  const { renders: _privateRenderPaths, ...stats } = result;
  const guidance = guidanceFor(await gameEngine(ctx), stats, args.rig === true);
  return {
    jobId: job.id,
    provider: "Local Blender",
    runtimeVersion: job.version,
    status: "downloaded",
    name: slug,
    ...(slug === name ? {} : { renamed: MESSAGE.Renamed(name, slug) }),
    files,
    stats,
    images,
    ...derivedFrom(args, job),
    guidance,
  };
}

/** Local modeling uses only public SDK services; no import from Studio core. */
export const activate: Activate = () => ({
  async action(name, _args, ctx) {
    if (name === BlenderAction.Status)
      return {
        runtime: await ctx.host(HostService.RuntimeDetect, BLENDER),
        installation: await ctx.host(HostService.RuntimeInstallation, BLENDER),
        jobs: await ctx.host(HostService.NativeJobs),
      };
    if (name === BlenderAction.Install) return ctx.host(HostService.RuntimeInstall, BLENDER);
    if (name === BlenderAction.CancelInstall) return ctx.host(HostService.RuntimeCancelInstall, BLENDER);
    throw new Error(MESSAGE.UnknownAction);
  },
  async tool(name, args, ctx) {
    if (name === BlenderTool.Status)
      return {
        runtime: await ctx.host(HostService.RuntimeDetect, BLENDER),
        jobs: (await ctx.host(HostService.NativeJobs)).map(publicJob),
      };
    if (name === BlenderTool.Retrieve) {
      const job = await ctx.host(HostService.NativeResult, { id: String(args.id) });
      if (!job) throw new Error(MESSAGE.NoRecordedJob);
      return { ...publicJob(job), delivery: await ctx.host(HostService.JobsRead, { id: job.id }) };
    }
    if (name !== BlenderTool.Model) throw new Error(MESSAGE.UnknownOperation);
    return model(args, ctx);
  },
});
