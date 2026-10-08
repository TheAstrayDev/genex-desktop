/**
 * The agent's own search for a Genex plugin (`plugins_find`) and the check `plugins_suggest` makes
 * before it shows a card. Pure: it reads the installed plugins and Genex's catalog it is handed,
 * and nothing else is ever a source (an outside index or a web search never is). Matching the
 * agent's words is the agent's search, not Genex deciding anything: only the person's click on the
 * card turns a plugin on.
 */
import type { PluginCatalogEntry, PluginInfo, PluginManifest } from "../../shared/plugins.ts";
import { skillScope } from "../../shared/plugins.ts";
import { FindNext, PluginOffer, type PluginFound, type PluginsFindAnswer } from "../../shared/project-tools.ts";
import { PLUGINS_FIND_NOTE } from "./project-tools-prompts.ts";

/** An installed plugin as the registry lists it (`registry.list()`). */
export type ListedPlugin = Pick<PluginInfo, "manifest" | "enabled" | "removed" | "unlisted">;

/** What the agent looks for: a fact id, words, or both; neither lists every plugin. */
export interface PluginQuery {
  fact?: string;
  text?: string;
}

/** Words of a search, lowercased: letters and digits only. */
const words = (text: string | undefined): string[] => (text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Every fact a plugin detects, scopes its tools, skills and connectors to, or makes; sorted, each once. */
export function pluginFacts(manifest: PluginManifest): string[] {
  const facts = [
    ...(manifest.detect ?? []).map((rule) => rule.fact),
    ...manifest.tools.flatMap((tool) => [...(tool.facts ?? []), ...(tool.makes ?? [])]),
    ...manifest.skills.flatMap((skill) => skillScope(skill) ?? []),
    ...(manifest.mcpServers ?? []).flatMap((server) => server.facts ?? []),
  ];
  return [...new Set(facts)].sort();
}

/** Whether a plugin answers the query: it knows the fact, and every word is in its id, name or description. */
function matches(manifest: PluginManifest, query: PluginQuery): boolean {
  if (query.fact && !pluginFacts(manifest).includes(query.fact)) return false;
  const haystack = `${manifest.id} ${manifest.name} ${manifest.description}`.toLowerCase();
  return words(query.text).every((word) => haystack.includes(word));
}

/** A plugin as found: what it is, and how the person can have it (none: it is on). */
function found(manifest: PluginManifest, offer: PluginOffer | undefined): PluginFound {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    ...(offer ? { offer } : {}),
    facts: pluginFacts(manifest),
  };
}

/** Whether an installed plugin is on now. */
const isOn = (plugin: ListedPlugin) => plugin.enabled && !plugin.removed;

/** How an installed plugin can be had: on (none), off (turn it on), or removed (install it again). */
const offerOf = (plugin: ListedPlugin): PluginOffer | undefined => {
  if (plugin.removed) return PluginOffer.Install;
  return plugin.enabled ? undefined : PluginOffer.TurnOn;
};

/**
 * Every plugin the person could have, in the order the search lists them: installed ones on, then
 * off (and removed), then Genex's catalog entries not installed. Code found without an install
 * record is never one of them.
 */
function candidates(installed: readonly ListedPlugin[], catalog: readonly PluginCatalogEntry[]): PluginFound[] {
  const listed = installed.filter((plugin) => !plugin.unlisted);
  const ids = new Set(listed.map((plugin) => plugin.manifest.id));
  return [
    ...listed.filter(isOn).map((plugin) => found(plugin.manifest, undefined)),
    ...listed.filter((plugin) => !isOn(plugin)).map((plugin) => found(plugin.manifest, offerOf(plugin))),
    ...catalog
      .filter((entry) => !ids.has(entry.manifest.id))
      .map((entry) => found(entry.manifest, PluginOffer.Install)),
  ];
}

/** What to do next with what was found: suggest one that is off, use one that is on, or offer to write one. */
function nextFor(plugins: readonly PluginFound[]): FindNext {
  if (plugins.some((plugin) => plugin.offer)) return FindNext.Suggest;
  return plugins.length ? FindNext.Use : FindNext.WritePlugin;
}

/** `plugins_find`: the installed plugins and Genex's catalog entries that answer the query, and what to do next. */
export function findPlugins(
  installed: readonly ListedPlugin[],
  catalog: readonly PluginCatalogEntry[],
  query: PluginQuery,
): PluginsFindAnswer {
  const manifests = new Map<string, PluginManifest>();
  for (const plugin of installed) manifests.set(plugin.manifest.id, plugin.manifest);
  for (const entry of catalog) if (!manifests.has(entry.manifest.id)) manifests.set(entry.manifest.id, entry.manifest);
  const plugins = candidates(installed, catalog).filter((plugin) => {
    const manifest = manifests.get(plugin.id);
    return manifest !== undefined && matches(manifest, query);
  });
  const next = nextFor(plugins);
  return { plugins, next, note: PLUGINS_FIND_NOTE[next] };
}

/**
 * The plugin `plugins_suggest` may show a card for: installed but off (or removed), or in Genex's
 * catalog and not installed; null for one that is on, unknown, or anything that is not a plugin id.
 */
export function suggestable(
  installed: readonly ListedPlugin[],
  catalog: readonly PluginCatalogEntry[],
  id: unknown,
): (PluginFound & { offer: PluginOffer }) | null {
  if (typeof id !== "string" || !id) return null;
  const plugin = candidates(installed, catalog).find((candidate) => candidate.id === id);
  return plugin?.offer ? { ...plugin, offer: plugin.offer } : null;
}
