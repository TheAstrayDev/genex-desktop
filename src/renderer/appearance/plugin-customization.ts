/** Translate validated customization data through Studio's native theme and host-slot contracts. */
import type { PluginCustomization } from "../../shared/plugin-customization.ts";
import {
  CustomizationBackgroundKind,
  CustomizationSlot,
  type CustomizationBackground,
  type CustomizationLayout,
} from "../../shared/plugin-customization-layout.ts";
import type { Appearance } from "./themes.ts";

/** Compose an enabled provider over the user's appearance without modifying the saved value. */
export function customizedAppearance(base: Appearance, profile: PluginCustomization | null): Appearance {
  if (!profile) return base;
  return {
    ...base,
    ...(profile.mode ? { mode: profile.mode } : {}),
    ...profile.fonts,
    light: { ...base.light, overrides: { ...base.light.overrides, ...profile.light } },
    dark: { ...base.dark, overrides: { ...base.dark.overrides, ...profile.dark } },
  };
}
/** Select a documented, host-owned anchor; plugins never submit a selector. */
export function customizationSelector(target: CustomizationSlot): string {
  return `[data-customization-slot="${target}"]`;
}
function backgroundCss(value: CustomizationBackground): string {
  if (value.kind === CustomizationBackgroundKind.Solid) return `background:${value.color};`;
  const fill =
    value.kind === CustomizationBackgroundKind.Image
      ? `url("${value.data}") center / cover no-repeat`
      : gradientCss(value);
  const motion = value.animated
    ? "background-size:200% 200%;animation:studio-customization-background 24s ease-in-out infinite alternate;"
    : "";
  return `background:${fill};${motion}`;
}
function gradientCss(value: Extract<CustomizationBackground, { colors: string[] }>): string {
  if (value.kind === CustomizationBackgroundKind.Gradient)
    return `linear-gradient(${value.angle}deg,${value.colors.join(",")})`;
  const spots = value.colors.map(
    (color, index) =>
      `radial-gradient(ellipse at ${20 + index * 20}% ${30 + index * 10}%,color-mix(in oklab,${color} 65%,transparent),transparent 65%)`,
  );
  return `${spots.join(",")},var(--background)`;
}
function geometryCss(profile: PluginCustomization): string {
  const { textSize, buttonRadius, cardRadius } = profile.geometry;
  const rules: string[] = [];
  if (textSize !== undefined)
    rules.push(`--t-sm:${textSize}px;--t-xs:${Math.max(11, textSize - 2)}px;--t-md:${Math.max(12, textSize - 1)}px;`);
  if (buttonRadius !== undefined) rules.push(`--radius-button:${buttonRadius}px;--radius-control:${buttonRadius}px;`);
  if (cardRadius !== undefined) rules.push(`--radius-card:${cardRadius}px;`);
  return `:root{${rules.join("")}}`;
}
function navigationCss(grid: CustomizationLayout): string[] {
  if (grid.target !== CustomizationSlot.Navigation) return [];
  const selector = customizationSelector(grid.target);
  const rules = [
    `${selector}{display:grid;grid-template-columns:repeat(${grid.columns},minmax(0,1fr));gap:${grid.gap}px;}`,
  ];
  for (const [id, item] of Object.entries(grid.items)) {
    if (!item) continue;
    const height = item.height === undefined ? "" : `height:${item.height}px;`;
    rules.push(
      `${selector}>[data-customization-item="${id}"]{grid-column:${item.column}/span ${item.columnSpan};grid-row:${item.row}/span ${item.rowSpan};${height}}`,
    );
  }
  return rules;
}
/** Generate only validated declarations. Removing this sheet restores the ordinary cascade. */
export function customizationCss(profile: PluginCustomization): string {
  const rules = [geometryCss(profile)];
  const positioned = [CustomizationSlot.App, CustomizationSlot.Sidebar, CustomizationSlot.Navigation];
  for (const target of positioned)
    if (profile.widgets.some((widget) => widget.target === target))
      rules.push(`${customizationSelector(target)}{position:relative;}`);
  for (const target of Object.values(CustomizationSlot)) {
    const surface = profile.surfaces[target];
    if (surface) {
      const size = target === CustomizationSlot.Profile ? "min-height:160px;border-radius:var(--radius-card);" : "";
      rules.push(`${customizationSelector(target)}{${backgroundCss(surface)}${size}}`);
    }
  }
  for (const grid of profile.layout) {
    rules.push(...navigationCss(grid));
  }
  rules.push(
    "@keyframes studio-customization-background{from{background-position:0% 50%}to{background-position:100% 50%}}",
  );
  const anchors = Object.values(CustomizationSlot)
    .filter((target) => {
      const surface = profile.surfaces[target];
      return surface && surface.kind !== CustomizationBackgroundKind.Solid && surface.animated;
    })
    .map(customizationSelector)
    .join(",");
  if (anchors) rules.push(`@media(prefers-reduced-motion:reduce){${anchors}{animation:none !important;}}`);
  return rules.join("\n");
}
