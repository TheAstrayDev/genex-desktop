/** What Genex's own project tools say to a model: their descriptions and their answers. Model-facing text. */
import type { LiveToolSpec } from "../../shared/engine-requests.ts";
import { FindNext, ProjectTool } from "../../shared/project-tools.ts";

/** `start_web_game`: the web starter, written into a folder with no kind yet. Takes no parameters. */
export const START_WEB_GAME_TOOL: LiveToolSpec = {
  name: ProjectTool.StartWebGame,
  description:
    "Make this game a web game: Genex writes its three.js starter here, which Live shows beside the chat. Only while the folder has no kind yet.",
  parameters: { type: "object", properties: {} },
};

/** What a project tool answers. */
export const PROJECT_TOOL_ANSWER = {
  webStarted: "The web starter is in the folder; build on it.",
  inPlan:
    "The chat is in Plan mode, so the web starter was not written: it waits until the plan is approved. Put it in your plan instead.",
} as const;

/** What a Genex plugin is, told with every search: an engine's own plugins are not one. */
const GENEX_PLUGINS =
  "These are Genex plugins (Plugins in Genex's sidebar), which add tools and know-how to Genex. An engine's own plugins and add-ons are files in the project, not Genex plugins.";

/** `plugins_find`: read-only, so it runs in Plan mode too. */
export const PLUGINS_FIND_TOOL: LiveToolSpec = {
  name: ProjectTool.PluginsFind,
  description:
    "Find a Genex plugin for a kind of project or a tool the person named. Read-only: it lists the plugins that are on, those installed but off, and those in Genex's catalog, and says what to do next. Give `fact` (a kind of project, e.g. godot-project or unreal-project) or `text` (words such as an engine's name), or both.",
  parameters: {
    type: "object",
    properties: {
      fact: { type: "string", description: "A kind of project, e.g. godot-project, unreal-project, blender-assets." },
      text: { type: "string", description: "Words to look for in a plugin's name or description, e.g. Unreal." },
    },
  },
};

/** `plugins_suggest`: shows the person a card; it never turns a plugin on. */
export const PLUGINS_SUGGEST_TOOL: LiveToolSpec = {
  name: ProjectTool.PluginsSuggest,
  description:
    "Show the person a card to turn on, or install, a Genex plugin that plugins_find listed as off or in the catalog. Only the person's click turns it on: end your reply after calling this.",
  parameters: {
    type: "object",
    properties: {
      plugin: { type: "string", description: "The plugin's id, as plugins_find listed it." },
      reason: {
        type: "string",
        description: "One sentence for the person: why this plugin helps with what they asked.",
      },
    },
    required: ["plugin", "reason"],
  },
};

/** The note `plugins_find` answers with, by what it says to do next. */
export const PLUGINS_FIND_NOTE = {
  [FindNext.Suggest]: `${GENEX_PLUGINS} To offer one that is off or not installed, call plugins_suggest with its id and why it helps, then end your reply: only the person turns a plugin on.`,
  [FindNext.Use]: `${GENEX_PLUGINS} The ones found are on already: use their tools; those for another kind of project arrive once the project is that kind.`,
  [FindNext.WritePlugin]: `${GENEX_PLUGINS} None fits. You may offer to write one (a local Genex plugin the person loads and turns on in Plugins), or go on with your own tools (the project's files and the shell) once the person says so.`,
} as const satisfies Record<FindNext, string>;

/** What `plugins_suggest` answers. */
export const PLUGINS_SUGGEST_ANSWER = {
  shown: "Shown to the person as a card. End your reply now; they turn it on, or tell you to go on without it.",
  refused: (plugin: string) =>
    `No card was shown: "${plugin}" is not a Genex plugin that is off or in Genex's catalog. Call plugins_find to see which are.`,
  noChat: "No card was shown: there is no chat to show it in.",
} as const;

/** `offer_dont_wait`: shows the person a card; it never switches the setting. Takes no parameters. */
export const OFFER_DONT_WAIT_TOOL: LiveToolSpec = {
  name: ProjectTool.OfferDontWait,
  description:
    "Show the person a card offering \"Don't wait for me\": with it on, a worker's question no longer waits for them; it is refused at once, the worker carries on, and the question stays in the chat. Offer it when the person says they will be away while workers run. Only the person's click turns it on.",
  parameters: { type: "object", properties: {} },
};

/** What `offer_dont_wait` answers. */
export const DONT_WAIT_ANSWER = {
  shown: "The card is in the chat; only the person's click turns it on. Until then a worker's question waits for them.",
  noChat: "No card was shown: there is no chat to show it in.",
} as const;
