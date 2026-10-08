/**
 * What a game's folder holds, as the app lists it (`facts` on every `game.list` descriptor): a copy
 * of the app's `shared/project-facts.ts` vocabulary and reads, held equal to it by
 * `seed-contracts.test.ts`. A fact says what is there (`unreal-project` at the root, `web-game` in
 * `site/`); a folder with no facts and nothing of its own has no kind yet, and its first message
 * decides.
 */
import type { Host } from "../types/harness.d.ts";
import type { GameProject, ProjectFact } from "../types/host-api.d.ts";
import { engineOfGame, GameEngine } from "./game-engine.ts";
import { HostMethod } from "./host-methods.ts";

/** Fact ids Genex itself knows; a plugin's `detect` may add others. Written in records: never rename a value. */
export const CoreFact = {
  WebGame: "web-game",
  UnrealProject: "unreal-project",
  UnrealPlugin: "unreal-plugin",
  GodotProject: "godot-project",
  UnityProject: "unity-project",
  BlenderAssets: "blender-assets",
} as const;
export type CoreFact = (typeof CoreFact)[keyof typeof CoreFact];

/**
 * The starters Genex writes itself into a folder with no kind yet (`game.start`, `game.scaffold`'s
 * `kind`): the app's `ProjectStarter`. Wire values: never rename one.
 */
export const ProjectStarter = { Web: "web" } as const;
export type ProjectStarter = (typeof ProjectStarter)[keyof typeof ProjectStarter];

/**
 * Genex's own project tools, by the name a session calls them: the app's `ProjectTool`. A local
 * model gets them as harness tools (`tools/game-tools.ts`). Called by name: never rename a value.
 */
export const ProjectTool = {
  StartWebGame: "start_web_game",
  PluginsFind: "plugins_find",
  PluginsSuggest: "plugins_suggest",
  /**
   * Shows the person the "Don't wait for me" card; only their click switches it. A delegated
   * session's only: a local model's turns run no workers.
   */
  OfferDontWait: "offer_dont_wait",
} as const;
export type ProjectTool = (typeof ProjectTool)[keyof typeof ProjectTool];

/** The root of a game, as a fact's path spells it. */
export const FACT_ROOT = ".";

/** A fact as these reads take it: what and where. */
export type FactRef = Pick<ProjectFact, "id" | "path">;

/**
 * What a folder with no facts holds besides Genex's bookkeeping (`holds` on a descriptor): the app's
 * `FolderHolds`. Only `nothing` and `notes` have no kind yet. Wire values: never rename one.
 */
export const FolderHolds = {
  Nothing: "nothing",
  Notes: "notes",
  OwnFiles: "own-files",
  Unreadable: "unreadable",
} as const;
export type FolderHolds = (typeof FolderHolds)[keyof typeof FolderHolds];

/**
 * A game descriptor as these reads take it (a brief's own view of the game, whose facts carry no
 * source, included); one from a host that predates facts carries none.
 */
export type FactsOfDescriptor =
  | (Partial<Pick<GameProject, "engine" | "web">> & {
      facts?: readonly FactRef[] | undefined;
      holds?: FolderHolds | null | undefined;
    })
  | null
  | undefined;

const ROOT = FACT_ROOT;

/** The facts an engine of the older vocabulary stands for: its fact at the game's root (the app's `factsOfEngine`). */
export function factsOfEngine(engine: GameEngine): FactRef[] {
  return [{ id: engine === GameEngine.Unreal ? CoreFact.UnrealProject : CoreFact.WebGame, path: ROOT }];
}

/**
 * The facts of a game descriptor: the ones it carries. One from a host that predates facts reads by
 * its older fields: a link is an Unreal project at the root, a folder that said it holds no web
 * game has none, and anything else (no descriptor at all included) is a web game at the root.
 */
export function factsOfGame(game: FactsOfDescriptor): FactRef[] {
  if (Array.isArray(game?.facts)) return game.facts.map(({ id, path }) => ({ id, path }));
  if (engineOfGame(game) === GameEngine.Unreal) return [{ id: CoreFact.UnrealProject, path: ROOT }];
  if (game?.web === false) return [];
  return [{ id: CoreFact.WebGame, path: ROOT }];
}

/** Whether the facts hold `id` (at `path`, when one is named). */
export function hasFact(facts: readonly FactRef[], id: string, path?: string): boolean {
  return facts.some((fact) => fact.id === id && (path === undefined || fact.path === path));
}

/**
 * Whether the game is of a kind Genex can't name: the descriptor carries no facts, and its folder
 * holds files of its own no rule knows, or could not be read. It is never handed a starter.
 */
export function kindUnknown(game: FactsOfDescriptor): boolean {
  if (!Array.isArray(game?.facts) || game.facts.length > 0) return false;
  return game.holds === FolderHolds.OwnFiles || game.holds === FolderHolds.Unreadable;
}

/**
 * Whether the game has no kind yet: the descriptor itself carries no facts and its folder nothing of
 * its own (an older descriptor never is, and one with no `holds` is read by its facts alone).
 */
export function kindPending(game: FactsOfDescriptor): boolean {
  return Array.isArray(game?.facts) && game.facts.length === 0 && !kindUnknown(game);
}

/**
 * The facts a game is served by: its facts; a web game at its root while it has no kind yet
 * (`kindPending`); none for a folder of a kind Genex can't name (`kindUnknown`) or an older one that
 * said it holds no web game, neither of which is ever served as a web game.
 */
export function servedFactsOf(game: FactsOfDescriptor): FactRef[] {
  const facts = factsOfGame(game);
  if (facts.length > 0) return facts;
  return kindPending(game) ? [{ id: CoreFact.WebGame, path: ROOT }] : [];
}

/**
 * The served facts as one comparable key (each `id@path`, sorted): two descriptors with the same key
 * are the same kind of project, so a turn between them changed nothing a session's tools follow.
 */
export function servedFactsKey(game: FactsOfDescriptor): string {
  return servedFactsOf(game)
    .map((fact) => `${fact.id}@${fact.path}`)
    .sort()
    .join("\n");
}

/**
 * Whether briefs, tools and senses serve the game as a web game: it holds one at its root, or it has
 * no kind yet (served as a web game until its first message decides), as the app's `servedFacts`. A
 * folder of a kind Genex can't name never is.
 */
export function servedAsWeb(game: FactsOfDescriptor): boolean {
  return hasFact(servedFactsOf(game), CoreFact.WebGame, ROOT);
}

/** What a Loop says when its game is of a kind Genex can't name. */
const MESSAGE = {
  unknownKind: (project: string) =>
    `A Loop can't start on ${project} yet: its folder holds files of a kind Genex doesn't know. Say in the chat what the project is, or turn on a Genex plugin for it, then start the Loop again.`,
} as const;

/**
 * A Loop on a game with no kind yet is a web Loop: the game takes the web starter first. A game of a
 * kind Genex can't name is never handed one: the Loop stops with a sentence saying it needs a kind.
 * `games` is the library as the caller listed it; a game not in it (one the caller is about to make)
 * is left to its maker.
 */
export async function startWebIfPending(
  host: Pick<Host, "call">,
  project: string,
  games: readonly GameProject[],
): Promise<void> {
  const game = games.find((listed) => listed.name === project);
  if (kindUnknown(game)) throw new Error(MESSAGE.unknownKind(project));
  if (!kindPending(game)) return;
  await host.call(HostMethod.GameStart, { project, starter: ProjectStarter.Web });
}
