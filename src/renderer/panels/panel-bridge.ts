/**
 * The pure parts of the plugin panel bridge (PluginPanelHost): what a panel is told about where it
 * runs, and how a failed request is answered. Kept apart from the React host so they run in tests.
 */
import { errorMessage, isUserCancelled } from "../../shared/errors.ts";
import { PanelErrorCode, PLUGIN_API_VERSION } from "../../shared/plugins.ts";

/** Reads one CSS custom property, as `getComputedStyle` does. */
export type StyleReader = { getPropertyValue(name: string): string };

/** The answer to a failed panel request: its text, and `code` when the person cancelled. */
export type PanelErrorReply = { error: string; code?: PanelErrorCode };

/** What a panel's frame sits on: the page, or a dialog's card, whose colour its background must match. */
export const PanelSurface = { Page: "page", Card: "card" } as const;
export type PanelSurface = (typeof PanelSurface)[keyof typeof PanelSurface];

/** The theme property each surface is painted with. */
const SURFACE_BACKGROUND = {
  [PanelSurface.Page]: "--background",
  [PanelSurface.Card]: "--card",
} as const satisfies Record<PanelSurface, string>;

/**
 * What a panel is told about where it runs: the project, the theme's colours (its background is
 * the surface it sits on) and the plugin API version. `accent` is the raw accent; `accentFill`,
 * `accentForeground` and `accentHover` are the readable button colours Studio's own primary
 * buttons use.
 */
export function panelContext(
  project: string | null | undefined,
  style: StyleReader,
  surface: PanelSurface = PanelSurface.Page,
) {
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    project: project ?? null,
    theme: {
      background: read(SURFACE_BACKGROUND[surface]),
      foreground: read("--foreground"),
      accent: read("--accent-primary"),
      accentFill: read("--accent-fill"),
      accentForeground: read("--accent-foreground"),
      accentHover: read("--accent-hover"),
    },
    apiVersion: PLUGIN_API_VERSION,
  };
}

/**
 * How a failed request is answered: a cancel the person chose carries `code: cancelled` with its
 * words, so a panel can stay quiet without matching text; any other failure keeps its text as it was.
 */
export function panelErrorReply(error: unknown): PanelErrorReply {
  if (isUserCancelled(error)) return { error: errorMessage(error), code: PanelErrorCode.Cancelled };
  return { error: String(error) };
}
