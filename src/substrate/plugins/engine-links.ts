/**
 * Each game's link to an engine project, kept by the host for a `game-engine` plugin. The record
 * that routes the plugin's calls lives in the plugin's own storage (`links/<game>.json`), where its
 * MCP servers read it and agents can't write; the game's studio.json gets a mirror for the brief,
 * the UI and the harness (`substrate/game-engine-binding.ts`). A link is made by real path, the
 * chat it came from (the game's own chat for a link made in the panel) gets one line with Undo, and
 * a refused link changes nothing on disk.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, type CustomEventRecord, customEventData } from "../../shared/custom-events.ts";
import { type EngineBinding, GameEngine, parseEngineBinding, projectName } from "../../shared/game-engine.ts";
import { ENGINE_LINKS_FOLDER, type PluginBinding } from "../../shared/plugins.ts";
import { atomicWriteJson, readJsonIfExists } from "../fsx.ts";
import { projectFileOf, restoreEngineBinding, writeEngineBinding } from "../game-engine-binding.ts";

/** A game id as it names a link file: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;

const MESSAGE = {
  GameRequired: "Project required",
  InvalidGame: "Invalid game",
  Stale: "This link already changed, so there is nothing to undo.",
} as const;

/** A game's link as a plugin reads it: the binding plus the project's name. */
export type EngineLink = EngineBinding & { name: string };

/** Undo was asked for a link that is no longer the game's current one. */
export class EngineLinkStale extends Error {
  constructor() {
    super(MESSAGE.Stale);
    this.name = "EngineLinkStale";
  }
}

/** What a link file holds: the current link and the one it replaced, or when Undo left the game with none. */
type LinkRecord = { link?: EngineBinding; previous?: EngineBinding; unlinkedAt?: string };

/** What the link service needs from the host: storage, game folders, the chat log, a change signal, the time. */
export type EngineLinkDeps = {
  root(pluginId: string): string;
  gameDir(project: string): string;
  append(record: CustomEventRecord, threadId: string): Promise<void>;
  changed(project: string): void;
  /** The game's own chat: where a link made outside a chat (the panel) is told. */
  gameThread(project: string): Promise<string>;
  now(): Date;
};

/** The services a `game-engine` plugin calls (`game.engine.*`); the host answers them through this. */
export type EngineLinkHost = {
  link(pluginId: string, binding: PluginBinding | undefined, args: unknown): Promise<EngineLink>;
  read(pluginId: string, binding: PluginBinding | undefined): Promise<EngineLink | null>;
  steps(pluginId: string, binding: PluginBinding | undefined): Promise<boolean>;
};

function gameOf(project: string | undefined): string {
  if (project === undefined) throw new Error(MESSAGE.GameRequired);
  if (!GAME_ID.test(project)) throw new Error(MESSAGE.InvalidGame);
  return project;
}

const linkFile = (root: string, game: string) => path.join(root, ENGINE_LINKS_FOLDER, `${game}.json`);

/** The game's link record, or undefined when the plugin never linked it. */
async function readRecord(root: string, game: string): Promise<LinkRecord | undefined> {
  const raw = await readJsonIfExists<Record<string, unknown>>(linkFile(root, game)).catch(() => null);
  if (!raw || typeof raw !== "object") return undefined;
  const link = parseEngineBinding(raw);
  const previous = parseEngineBinding(raw.previous);
  const unlinkedAt = typeof raw.unlinkedAt === "string" ? raw.unlinkedAt : undefined;
  if (!link && !unlinkedAt) return undefined;
  return { ...(link ? { link } : {}), ...(previous ? { previous } : {}), ...(unlinkedAt ? { unlinkedAt } : {}) };
}

async function writeRecord(root: string, game: string, record: LinkRecord): Promise<void> {
  await mkdir(path.join(root, ENGINE_LINKS_FOLDER), { recursive: true, mode: 0o700 });
  const body = record.link
    ? { ...record.link, ...(record.previous ? { previous: record.previous } : {}) }
    : { unlinkedAt: record.unlinkedAt };
  await atomicWriteJson(linkFile(root, game), body);
}

/** The recorded binding while its project is still a regular `.uproject` at exactly that real path. */
async function holding(binding: EngineBinding | undefined): Promise<EngineBinding | undefined> {
  if (!binding) return undefined;
  const real = await projectFileOf(binding.project).catch(() => undefined);
  return real === binding.project ? binding : undefined;
}

/** The game's title as its studio.json names it, for the chat line. */
async function gameTitle(dir: string): Promise<string | undefined> {
  const meta = await readJsonIfExists<{ title?: unknown }>(path.join(dir, "studio.json")).catch(() => null);
  return typeof meta?.title === "string" && meta.title.trim() ? meta.title.trim() : undefined;
}

const asLink = (binding: EngineBinding): EngineLink => ({ ...binding, name: projectName(binding.project) });

/** What a link call asks for: the project file (checked by real path) and whether the first call made it. */
async function linkArgs(args: unknown): Promise<{ project: string; auto: boolean }> {
  const fields = args && typeof args === "object" ? (args as { project?: unknown; auto?: unknown }) : {};
  const project = await projectFileOf(typeof fields.project === "string" ? fields.project : "");
  return { project, auto: fields.auto === true };
}

/** The chat's line for a new link: the game, the project, and the one it replaced. */
function linkedRecord(
  pluginId: string,
  game: string,
  linked: EngineBinding,
  context: { title?: string; previous?: EngineBinding; auto: boolean },
): CustomEventRecord {
  const { title, previous, auto } = context;
  return customEventData(CustomEvent.EngineLinked, {
    pluginId,
    project: game,
    ...(title ? { title } : {}),
    engine: GameEngine.Unreal,
    file: linked.project,
    name: projectName(linked.project),
    linkedAt: linked.linkedAt,
    ...(previous ? { previous: projectName(previous.project) } : {}),
    ...(auto ? { auto } : {}),
  });
}

/** The link service a host wires to `game.engine.*`, plus Undo. */
export function createEngineLinks(deps: EngineLinkDeps) {
  const record = (pluginId: string, game: string) => readRecord(deps.root(pluginId), game);

  async function link(pluginId: string, binding: PluginBinding | undefined, args: unknown): Promise<EngineLink> {
    const game = gameOf(binding?.project);
    const { project, auto } = await linkArgs(args);
    const previous = (await record(pluginId, game))?.link;
    const same = previous?.project === project ? await holding(previous) : undefined;
    if (same) return asLink(same);
    const title = await gameTitle(deps.gameDir(game));
    const { binding: linked } = await writeEngineBinding(deps.gameDir(game), project, deps.now);
    await writeRecord(deps.root(pluginId), game, { link: linked, ...(previous ? { previous } : {}) });
    await deps.append(
      linkedRecord(pluginId, game, linked, { ...(title ? { title } : {}), ...(previous ? { previous } : {}), auto }),
      binding?.threadId ?? (await deps.gameThread(game)),
    );
    deps.changed(game);
    return asLink(linked);
  }

  async function read(pluginId: string, binding: PluginBinding | undefined): Promise<EngineLink | null> {
    const current = await holding((await record(pluginId, gameOf(binding?.project)))?.link);
    return current ? asLink(current) : null;
  }

  /**
   * Takes back the link made at `linkedAt`: the project it replaced comes back (when it still
   * holds), else the game is left with no link. A link that has changed since is refused.
   */
  async function undo(pluginId: string, project: string, linkedAt: string, threadId?: string): Promise<void> {
    const game = gameOf(project);
    const current = await record(pluginId, game);
    if (!current?.link || current.link.linkedAt !== linkedAt) throw new EngineLinkStale();
    const restored = await holding(current.previous);
    await restoreEngineBinding(deps.gameDir(game), restored);
    const next: LinkRecord = restored ? { link: restored } : { unlinkedAt: deps.now().toISOString() };
    await writeRecord(deps.root(pluginId), game, next);
    if (threadId)
      await deps.append(
        customEventData(CustomEvent.EngineLinkUndone, {
          pluginId,
          project: game,
          linkedAt,
          ...(restored ? { restored: projectName(restored.project) } : {}),
        }),
        threadId,
      );
    deps.changed(game);
  }

  /** Puts the plugin's steps card in the chat the call came from; false without a chat. */
  async function steps(pluginId: string, binding: PluginBinding | undefined): Promise<boolean> {
    const game = gameOf(binding?.project);
    if (!binding?.threadId) return false;
    await deps.append(customEventData(CustomEvent.EngineSteps, { pluginId, project: game }), binding.threadId);
    return true;
  }

  return { link, read, steps, undo };
}

/** The link service a host keeps. */
export type EngineLinks = ReturnType<typeof createEngineLinks>;
