/**
 * Which engine a game builds in. A game is a web game unless Genex linked it to an engine project;
 * `studio.json` then records `engine`, and everything that would treat the game as a web page (the
 * chat brief, the preview health check, the Live tab, the Loop) asks this record first. Words
 * never decide it: a game asked for "in Unreal" in a web-template folder is still a web game until
 * linked.
 *
 * studio.json sits in the folder agents write, so this module only checks the record's shape;
 * `substrate/game-engine-binding.ts` checks the project file itself by its real path.
 */

/** The engines a game can build in, by their wire names. */
export const GameEngine = { Web: "web", Unreal: "unreal" } as const;
export type GameEngine = (typeof GameEngine)[keyof typeof GameEngine];

/** Whether `value` names an engine Genex knows. */
export const isGameEngine = (value: unknown): value is GameEngine =>
  value === GameEngine.Web || value === GameEngine.Unreal;

/** The extension of an Unreal project file. */
export const UPROJECT_EXTENSION = ".uproject";

/** A game linked to an Unreal project: its `.uproject` (absolute, real path) and when Genex linked it. */
export type EngineBinding = {
  kind: typeof GameEngine.Unreal;
  project: string;
  linkedAt: string;
};

/** The longest project path Genex records; Unreal itself refuses far shorter ones. */
const MAX_PROJECT_PATH = 1024;

const isAbsolute = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const CONTROL = /[\0-\x1f\x7f]/;

/** Whether `value` is an absolute `.uproject` path spelled plainly: no `..` part, no control characters. */
export function isProjectPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_PROJECT_PATH) return false;
  if (!isAbsolute(value) || CONTROL.test(value)) return false;
  if (!value.toLowerCase().endsWith(UPROJECT_EXTENSION)) return false;
  return !value.split(/[\\/]/).some((part) => part === "..");
}

/**
 * The binding a studio.json records, by shape only: the Unreal kind, a plain absolute `.uproject`
 * path and a date. Anything else, including a record for an engine Genex does not know, is no
 * binding: the game stays a web game.
 */
export function parseEngineBinding(raw: unknown): EngineBinding | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.kind !== GameEngine.Unreal || !isProjectPath(record.project)) return undefined;
  const linkedAt =
    typeof record.linkedAt === "string" && !Number.isNaN(Date.parse(record.linkedAt)) ? record.linkedAt : "";
  return { kind: GameEngine.Unreal, project: record.project, linkedAt };
}

/** The engine a game builds in: its binding's, else the web. */
export const engineOf = (binding: EngineBinding | undefined | null): GameEngine => binding?.kind ?? GameEngine.Web;

/** The project's name as Unreal shows it: the `.uproject` file name without its extension. */
export function projectName(project: string): string {
  const file = project.split(/[\\/]/).pop() ?? project;
  return file.slice(0, file.length - UPROJECT_EXTENSION.length);
}

/**
 * The chat's record that a game now builds in an engine project ("Lantern now builds in Unreal ·
 * Lantern", with Undo): the plugin that linked it, the game, the project file and its
 * name, when, and the project it replaced. `auto` marks a link the plugin made by itself rather
 * than at the person's word (older hosts linked a game at its first call; none does now).
 */
export type EngineLinkedPayload = {
  pluginId?: string;
  project?: string;
  /** The game's title as studio.json named it then. */
  title?: string;
  engine?: GameEngine;
  file?: string;
  name?: string;
  linkedAt?: string;
  previous?: string;
  auto?: boolean;
};

/** The chat's record that Undo took a link back: the link it undid, and the project it restored (none: a web game again). */
export type EngineLinkUndonePayload = { pluginId?: string; project?: string; linkedAt?: string; restored?: string };

/** The chat line's Undo: which plugin's link of which game, made when, asked from which chat. */
export type EngineLinkUndo = { project: string; pluginId: string; linkedAt: string; threadId?: string };

/** The chat's record that an engine plugin offers its steps card here (its steps are read live from the plugin). */
export type EngineStepsPayload = { pluginId?: string; project?: string };
