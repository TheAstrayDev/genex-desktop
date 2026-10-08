import type { PluginCallBlocker } from "./plugins.ts";

/**
 * Genex's own project tools, by the name a session calls them: the chat's own session is handed
 * them beside the cover tool (`main/core/project-tools.ts`), and a local model gets the same names
 * as harness tools. The seed's copy is in `harness-seed/loop/folder-facts.ts`
 * (`seed-contracts.test.ts`). Called by name: never rename a value.
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

/**
 * How a found plugin can be had: turned on (installed but off) or installed (Genex's catalog, or
 * one the person removed). Only the person's click on the card does either. Persisted in
 * `plugin_suggested` records: never rename a value.
 */
export const PluginOffer = {
  TurnOn: "turn-on",
  Install: "install",
} as const;
export type PluginOffer = (typeof PluginOffer)[keyof typeof PluginOffer];

/**
 * What `plugins_find` says to do next: suggest a plugin that is off or not installed, use the tools
 * of one that is on, or, with none at all, offer to write a Genex plugin (or go on with the
 * session's own tools on the person's word).
 */
export const FindNext = {
  Suggest: "suggest",
  Use: "use",
  WritePlugin: "write-plugin",
} as const;
export type FindNext = (typeof FindNext)[keyof typeof FindNext];

/** One Genex plugin `plugins_find` found: `offer` absent when it is on already; `facts` it detects, serves or makes. */
export interface PluginFound {
  id: string;
  name: string;
  description: string;
  offer?: PluginOffer;
  facts: string[];
}

/** What `plugins_find` answers: the plugins found (on, then off, then Genex's catalog), what to do next, and a note. */
export interface PluginsFindAnswer {
  plugins: PluginFound[];
  next: FindNext;
  note: string;
}

/** What `plugins_suggest` answers: whether the card was shown, and what the session is told. */
export interface PluginsSuggestAnswer {
  shown: boolean;
  message: string;
}

/**
 * What a start of the web starter answers instead of writing it while its chat is in Plan mode: the
 * chat's own `start_web_game` (as JSON) and the harness's `game.start` for a local model's.
 */
export interface StartHeldInPlan {
  blocker: PluginCallBlocker;
  message: string;
}

/** A `plugin_suggested` record: the turn-it-on card a session showed in the chat, for `project`. */
export interface PluginSuggestedPayload {
  pluginId: string;
  name: string;
  description: string;
  offer: PluginOffer;
  reason: string;
  project: string;
}
