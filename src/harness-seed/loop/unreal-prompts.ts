/**
 * What a chat build of a game with an Unreal project is told (chat-session.ts `buildContractorBrief`).
 * The game lives in the user's open Unreal Editor and its project, and is built through the Unreal
 * tools: never as a web page (no page contract, no seeded randomness), and never through file or exec
 * bridges between the folder and the editor. It also holds the question a new project's brief asks first while an
 * engine plugin is on: the web or that engine (`engineChoiceRule`).
 */
import type { PluginKindOffer } from "../types/host-api.d.ts";
import { ProjectTool } from "./folder-facts.ts";
import { askUser } from "./interview-question.ts";
import { toolCall } from "./model-roles.ts";
import { EngineReadiness, type UnrealOnComputer } from "./unreal/editor-wait.ts";

/** The Unreal Editor connector's tools, as the studio names them (the Unreal plugin's `unreal-editor` server). */
const UnrealTool = {
  ListToolsets: "unreal-editor__list_toolsets",
  DescribeToolset: "unreal-editor__describe_toolset",
  CallTool: "unreal-editor__call_tool",
} as const;

/**
 * The Unreal plugin's tool that makes a game's Unreal project inside its folder, as the host serves
 * it (`<plugin>__<tool>`). It is in the host's tool list exactly while the plugin is on, which is
 * how a brief knows to offer Unreal at all. The plugin declares it (`src/plugins/unreal/plugin.json`).
 */
export const UNREAL_NEW_GAME_TOOL = "unreal__new-game";

/** The Unreal plugin's tool that links this game to an Unreal project the person already has. */
const UNREAL_USE_PROJECT_TOOL = "unreal__use-project";

/** Whether the host's plugin tools offer a new Unreal game: the Unreal plugin is on. */
export function offersUnrealGame(tools: ReadonlyArray<{ name?: unknown }> | null | undefined): boolean {
  return Array.isArray(tools) && tools.some((tool) => tool?.name === UNREAL_NEW_GAME_TOOL);
}

/** What to do when the user picks Unreal before Genex can make its project: never new-game, the Unreal button instead. */
const toUnrealButton = (newGame: string, how: string) =>
  `If the user picks it, don't call ${newGame}, which would refuse: tell them to press the Unreal button above the game, which shows how to ${how} and notices when it's installed, and to send a message once it is.`;

/**
 * How the engine question offers Unreal, by what this computer has (`unreal/editor-wait.ts`
 * `unrealOnComputer`): ready to make a project with; only a newer or only an older Unreal than the
 * 5.8 Genex makes projects with; or none at all. Unless it is ready, the option says what it needs
 * and the user is pointed to the Unreal button instead of new-game, which would refuse.
 */
function unrealOffer(newGame: string, unreal: UnrealOnComputer | null | undefined): string {
  const option = `"Unreal Engine: plays in the Unreal editor on this computer"`;
  const beside = (version: string) =>
    `offer it as "Unreal Engine 5.8" with the description "Needs 5.8 installed beside your ${version}, about 45 GB".`;
  if (unreal?.engine === EngineReadiness.None)
    return `Unreal Engine isn't installed on this computer yet, so offer it as "Unreal Engine" with the description "Plays in Epic's free editor on this computer; needs a 45 GB install first". ${toUnrealButton(newGame, "get Unreal 5.8 free from Epic")}`;
  const version = unreal?.version ?? "";
  if (unreal?.engine === EngineReadiness.NewerOnly)
    return `This computer has Unreal ${version}, and Genex makes new Unreal projects with 5.8 only, so ${beside(version)} ${toUnrealButton(newGame, `install 5.8 beside ${version} in the Epic Games Launcher`)}`;
  if (unreal?.engine === EngineReadiness.OlderOnly)
    return `This computer has Unreal ${version}, older than the 5.8 Genex makes Unreal games with, so ${beside(version)} ${toUnrealButton(newGame, "get 5.8 free from Epic")}`;
  return `Offer ${option}; when the answer (or the request) is Unreal Engine, call ${newGame} with a template and a name: it makes the game's Unreal project in this folder, links this game to it and opens it in Unreal; then build the game there through the Unreal tools, never as a web page.`;
}

/** The engine plugins the kinds on offer come from, one offer each, the Unreal plugin's not among them. */
function otherKinds(kinds: readonly PluginKindOffer[]): PluginKindOffer[] {
  const unreal = kinds.find((kind) => kind.tool === UNREAL_NEW_GAME_TOOL)?.plugin;
  const seen = new Set<string>();
  return kinds.filter((kind) => {
    if (kind.plugin === unreal || seen.has(kind.plugin)) return false;
    seen.add(kind.plugin);
    return true;
  });
}

/**
 * The first rule of a new game's brief while an engine plugin is on: which kind it builds is the
 * user's one question before the first build, unless the ask already names it. The web answer starts
 * Genex's web starter (`start_web_game`); Unreal goes through the plugin's new-game tool, which makes
 * the project inside the game folder and links it; another engine plugin through its own kind tool.
 * `unreal` says what this computer has (none known: offered as installed); `kinds` are the kind
 * tools on offer (absent: the Unreal plugin's alone).
 */
export function engineChoiceRule(
  engine: string | undefined,
  unreal?: UnrealOnComputer | null,
  kinds?: readonly PluginKindOffer[] | null,
): string {
  const ask = toolCall(engine, askUser.name);
  const newGame = toolCall(engine, UNREAL_NEW_GAME_TOOL);
  const web = `When it is the web, call ${toolCall(engine, ProjectTool.StartWebGame)} first, then build it here on its starter as the rules below say.`;
  const others = otherKinds(kinds ?? []);
  if (others.length === 0)
    return `FIRST, THE ENGINE: the user has the Unreal Editor plugin on, so this new game can be built for the web, here, or in Unreal Engine. Unless the request already names one, ask the user that one question with ${ask} before you build anything, with the options "Web: plays right here in Genex" and Unreal Engine, and end your reply. ${unrealOffer(newGame, unreal)} ${web}`;
  const unrealOn = !kinds || kinds.some((kind) => kind.tool === UNREAL_NEW_GAME_TOOL);
  const names = [...(unrealOn ? ["Unreal Engine"] : []), ...others.map((kind) => `"${kind.name}"`)];
  const makers = others.map(
    (kind) =>
      `When the answer (or the request) is ${kind.name}, call ${toolCall(engine, kind.tool)}: it makes the game's ${kind.name} project in this folder; then build it with that plugin's tools.`,
  );
  return [
    `FIRST, THE ENGINE: the user has engine plugins on, so this new game can be built for the web, here, or with ${names.join(" or ")}. Unless the request already names one, ask the user that one question with ${ask} before you build anything, with the options "Web: plays right here in Genex" and ${names.join(", ")}, and end your reply.`,
    ...(unrealOn ? [unrealOffer(newGame, unreal)] : []),
    ...makers,
    web,
  ].join(" ");
}

/** The project as a brief names it: its file, the folder it was found in, or what it is when neither is known. */
function projectWords(project: string | null | undefined, found?: string): string {
  if (project) return `\`${project}\``;
  if (found) return found === "." ? "in this game's folder" : `in \`${found}/\``;
  return "linked to this game";
}

/**
 * The rules that describe an Unreal game, in place of the web template's: where it is built,
 * where its changes land, how Blueprint text is written, and the bridges never to build. Its
 * tools are spelled the way `engine` calls them. A session that also writes files of its own in the
 * game folder (the Unreal Loop's lead: ART.md, build scripts, deliveries) is told `ownFiles`, and
 * never that the folder holds only notes. A project found in the folder but not linked (`found`, the
 * folder it was found in) is not built through the Unreal tools at all: until the plugin's use-project
 * links it (once the person has set it up), those tools work on the project chosen in the Unreal
 * panel, which can be another game's (`unlinkedUnrealRules`).
 */
export function unrealRules(
  engine: string | undefined,
  project: string | null | undefined,
  { ownFiles = false, found }: { ownFiles?: boolean; found?: string } = {},
): string[] {
  const list = toolCall(engine, UnrealTool.ListToolsets);
  const describe = toolCall(engine, UnrealTool.DescribeToolset);
  const call = toolCall(engine, UnrealTool.CallTool);
  const notes = ownFiles
    ? "Keep NOTES.md in this game folder current with what you built in Unreal and why."
    : "This Genex game folder holds only the game's notes: keep NOTES.md in it current with what you built in Unreal and why.";
  if (!project && found !== undefined) return unlinkedUnrealRules(engine, found, notes);
  return [
    `This game is built in Unreal Engine, in the user's open Unreal Editor, through the Unreal tools: find a toolset with ${list}, read its tools and input schemas with ${describe}, then run them with ${call}.`,
    `Your changes land in the Unreal project ${projectWords(project, found)}. ${notes}`,
    "Before you write Blueprint text, look up every node it uses through the Unreal tools — its exact name and pins — and never write a node from memory.",
    "Never build file watchers, polling scripts or exec bridges between this folder and Unreal: the Unreal tools are the way in.",
  ];
}

/**
 * The rules of an Unreal project in the folder that is not linked to the game: until the plugin's
 * use-project links it, the Unreal tools work on the project chosen in the Unreal panel (which can be
 * another game's), so none of them is called before; the work goes on with the project's files.
 */
function unlinkedUnrealRules(engine: string | undefined, found: string, notes: string): string[] {
  const tools = [UnrealTool.ListToolsets, UnrealTool.DescribeToolset, UnrealTool.CallTool]
    .map((tool) => toolCall(engine, tool))
    .join(", ");
  return [
    `This folder holds an Unreal Engine project ${projectWords(null, found)} that is not linked to this game yet. Until it is, the Unreal tools (${tools}) work on the project chosen in Genex's Unreal panel, which can be another game's: never call them before ${toolCall(engine, UNREAL_USE_PROJECT_TOOL)} links this folder's project, once the person has set it up from the Unreal button. Until then, work with the project's files.`,
    notes,
    "Never build file watchers, polling scripts or exec bridges between this folder and Unreal: the Unreal tools are the way in once the project is linked.",
  ];
}

/** Where an Unreal game's work happens, in place of the web brief's "this workspace" rule. */
export function unrealWorkspaceRule(project: string | null | undefined, found?: string): string {
  return `The game's work happens in its Unreal project ${projectWords(project, found)} and in this workspace's notes: never in another copy of this game, in another game's folder or in another Unreal project, and a path the user named is a stills folder to look at, not a parent to walk. When the user asks about something elsewhere on their Mac (another folder, their Downloads, their disk), that is the ask: what you may reach is your session's permissions, not this brief.`;
}

/** The brief's closing line for an Unreal game: where its work lands, and the folder of its notes. */
export function unrealWorkHere(project: string | null | undefined, folderLabel: string, found?: string): string {
  const notes = folderLabel ? `this workspace (folder \`${folderLabel}\`)` : "this workspace";
  // An unlinked project is worked on through its files, not the tools (`unlinkedUnrealRules`).
  const through = project || found === undefined ? " through the Unreal tools" : "";
  return `The game's work lands in its Unreal project ${projectWords(project, found)}${through}; its notes stay in ${notes}.`;
}
