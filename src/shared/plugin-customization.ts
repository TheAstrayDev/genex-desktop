/** Versioned appearance data shared by the panel bridge and registry. Never executable CSS. */
import type { PluginInfo } from "./plugins.ts";
import { parseCustomizationComposition, type CustomizationComposition } from "./plugin-customization-layout.ts";

/** Independent feature version, additive to plugin API 3. */
export const PLUGIN_CUSTOMIZATION_VERSION = 1;
/** Install/update permission required before a plugin controls host presentation. */
export const PLUGIN_CUSTOMIZATION_CAPABILITY = "ui.customization";
/** Named operations accepted by the opaque panel bridge. */
export const CustomizationMethod = {
  Read: "customization.read",
  Set: "customization.set",
  Reset: "customization.reset",
} as const;
/** Native semantic roles; a behavior test holds this table to the Studio palette. */
export const PLUGIN_COLOR_ROLES = [
  "background",
  "foreground",
  "sidebar",
  "surface",
  "popover",
  "field",
  "hover",
  "muted",
  "border",
  "controlBorder",
  "accent",
  "success",
  "warning",
  "danger",
  "accentFill",
  "accentHover",
  "accentText",
  "icon",
  "iconSelected",
  "logo",
  "logoShade",
  "graph",
  "art",
  "artPaper",
  "artMark",
  "artButton",
  "controlFill",
  "promptChipFill",
  "controlHover",
  "controlText",
  "controlTextHover",
  "chipHover",
  "sidebarSelected",
  "sidebarHover",
  "well",
  "thumb",
  "meterTrack",
  "meterFill",
  "meterHigh",
  "meterFull",
  "promptEdge",
  "viewSwitch",
  "wireArt",
  "hatch",
  "hatchGround",
  "settingsTab",
] as const;
/** One native palette role rather than an arbitrary CSS variable. */
export type PluginColorRole = (typeof PLUGIN_COLOR_ROLES)[number];
/** Pixel limits that keep native controls usable. */
export const PLUGIN_GEOMETRY = {
  textSize: { min: 12, max: 18 },
  buttonRadius: { min: 0, max: 24 },
  cardRadius: { min: 0, max: 32 },
} as const;
/** Optional bounded overrides for native type size and radii. */
export type PluginGeometry = Partial<Record<keyof typeof PLUGIN_GEOMETRY, number>>;
/** Existing local font stacks, without plugin-supplied font URLs. */
export const PLUGIN_FONTS = {
  uiFont: ["studio", "system"],
  contentFont: ["inherit", "system", "serif", "mono"],
  codeFont: ["geist", "system"],
} as const;
/** Optional mode override; absent, the person's mode remains in charge. */
export const PLUGIN_APPEARANCE_MODES = ["system", "light", "dark"] as const;
/** Font choices interpreted by the native appearance painter. */
export type PluginFonts = { [K in keyof typeof PLUGIN_FONTS]?: (typeof PLUGIN_FONTS)[K][number] };
/** Canonical persisted profile, with omitted sections normalized to empty values. */
export interface PluginCustomization extends CustomizationComposition {
  version: 1;
  mode?: (typeof PLUGIN_APPEARANCE_MODES)[number];
  light: Partial<Record<PluginColorRole, string>>;
  dark: Partial<Record<PluginColorRole, string>>;
  geometry: PluginGeometry;
  fonts: PluginFonts;
}
function fonts(value: unknown): PluginFonts {
  const raw = value === undefined ? {} : object(value);
  onlyKeys(raw, Object.keys(PLUGIN_FONTS));
  const result: Record<string, string> = {};
  for (const [key, choices] of Object.entries(PLUGIN_FONTS)) {
    if (!Object.hasOwn(raw, key)) continue;
    const selected = choices.find((choice) => choice === raw[key]);
    if (!selected) throw new Error(MESSAGE.Invalid);
    result[key] = selected;
  }
  return result;
}
const MESSAGE = {
  Invalid: "Invalid UI customization profile",
  Version: "Unsupported UI customization profile version",
} as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(MESSAGE.Invalid);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(MESSAGE.Invalid);
  return value as Record<string, unknown>;
}
function onlyKeys(raw: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(raw).some((key) => !keys.includes(key))) throw new Error(MESSAGE.Invalid);
}
function colors(value: unknown): PluginCustomization["light"] {
  const raw = value === undefined ? {} : object(value);
  onlyKeys(raw, PLUGIN_COLOR_ROLES);
  const result: PluginCustomization["light"] = {};
  for (const role of PLUGIN_COLOR_ROLES) {
    if (!Object.hasOwn(raw, role)) continue;
    const color = raw[role];
    if (typeof color !== "string" || color.length !== 7 || !/^#[0-9a-f]{6}$/i.test(color))
      throw new Error(MESSAGE.Invalid);
    result[role] = color.toLowerCase();
  }
  return result;
}
function geometry(value: unknown): PluginGeometry {
  const raw = value === undefined ? {} : object(value);
  onlyKeys(raw, Object.keys(PLUGIN_GEOMETRY));
  const result: PluginGeometry = {};
  for (const key of Object.keys(PLUGIN_GEOMETRY) as (keyof PluginGeometry)[]) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key],
      bounds = PLUGIN_GEOMETRY[key];
    const valid = typeof value === "number" && Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
    if (!valid) throw new Error(MESSAGE.Invalid);
    result[key] = value;
  }
  return result;
}
/** Strictly validate a whole replacement before saving; omitted sections mean no overrides. */
export function parsePluginCustomization(value: unknown): PluginCustomization {
  const raw = object(value);
  onlyKeys(raw, ["version", "mode", "light", "dark", "geometry", "fonts", "surfaces", "layout", "widgets"]);
  if (raw.version !== PLUGIN_CUSTOMIZATION_VERSION) throw new Error(MESSAGE.Version);
  const mode = PLUGIN_APPEARANCE_MODES.find((choice) => choice === raw.mode);
  if (raw.mode !== undefined && !mode) throw new Error(MESSAGE.Invalid);
  return {
    version: PLUGIN_CUSTOMIZATION_VERSION,
    ...(mode ? { mode } : {}),
    light: colors(raw.light),
    dark: colors(raw.dark),
    geometry: geometry(raw.geometry),
    fonts: fonts(raw.fonts),
    ...parseCustomizationComposition(raw),
  };
}
type Provider = Pick<PluginInfo, "enabled" | "removed" | "unlisted" | "customization"> & {
  manifest: Pick<PluginInfo["manifest"], "id" | "capabilities">;
};
/** Resolve one provider independent of list order; disabled, removed and unpermitted plugins never apply. */
export function customizationOwner<T extends Provider>(plugins: readonly T[]): T | null {
  const candidates = plugins.filter(
    (p) =>
      p.enabled &&
      !p.removed &&
      !p.unlisted &&
      p.customization &&
      p.manifest.capabilities.includes(PLUGIN_CUSTOMIZATION_CAPABILITY),
  );
  return (
    candidates.sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : Number(a.manifest.id > b.manifest.id)))[0] ?? null
  );
}
