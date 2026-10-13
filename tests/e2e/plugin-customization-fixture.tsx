/** Disposable browser fixture: real host integration and SDK bridge, no provider or native account. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PluginCustomizationHost } from "../../src/renderer/appearance/PluginCustomizationHost.tsx";
import { initializeAppearance } from "../../src/renderer/appearance/store.ts";
import { PluginPanelHost } from "../../src/renderer/panels/PluginPanelHost.tsx";
import { GenexAccount } from "../../src/renderer/panels/plugins/genex/GenexAccount.tsx";
import { Button } from "../../src/renderer/ui/Button.tsx";
import { studio } from "../../src/renderer/state/studio.ts";
import { parsePluginCustomization, type PluginCustomization } from "../../src/shared/plugin-customization.ts";
import { PluginCapability, PluginSourceKind, PluginHealth, type PluginInfo } from "../../src/shared/plugins.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

let saved: PluginCustomization | null = null;
let enabled = true;
let showAccount = true;
const plugin = (): PluginInfo => ({
  manifest: {
    apiVersion: 3,
    id: "theme",
    version: "1.0.0",
    name: "Fixture theme",
    publisher: "Fixture",
    description: "Disposable API fixture",
    backend: "backend.mjs",
    tools: [],
    actions: [],
    skills: [],
    settings: [],
    panels: [{ id: "widget", title: "Fixture widget", file: "widget.html", placement: "settings" }],
    capabilities: [PluginCapability.UiCustomization],
  },
  enabled,
  removed: false,
  state: "enabled",
  health: PluginHealth.Ready,
  source: PluginSourceKind.Local,
  ...(saved ? { customization: saved } : {}),
});
let redraw = () => {};
const fake = fakeStudioApi({
  pluginPanel: async (id, panel) => {
    if (id !== "theme" || panel !== "widget" || !enabled) throw new Error("Undeclared panel");
    return { url: "studio-plugin://theme/widget", title: "Custom widget", html: "" };
  },
  pluginsList: async () => [plugin()],
  pluginCustomization: async (id) => {
    if (id !== "theme" || !enabled) throw new Error("UI customization capability required");
    return saved;
  },
  pluginSetCustomization: async (id, value) => {
    if (id !== "theme" || !enabled) throw new Error("UI customization capability required");
    saved = value === null ? null : parsePluginCustomization(value);
    await studio().plugins.refresh();
    redraw();
  },
});
window.studio = fake.api;
initializeAppearance();
await studio().plugins.refresh();
function Fixture() {
  const [, update] = useState(0);
  redraw = () => update((previous) => previous + 1);
  return (
    <div data-customization-slot="app" style={{ padding: 24 }}>
      <nav data-customization-slot="navigation" style={{ width: 320 }}>
        <Button id="native-control" data-customization-item="newGame" variant="default">
          New game
        </Button>
        <Button id="plugins-control" data-customization-item="plugins">
          Plugins
        </Button>
        <Button id="settings-control" data-customization-item="settings">
          Settings
        </Button>
      </nav>
      <section
        data-customization-slot="newChat"
        id="new-chat"
        style={{ position: "relative", height: 180, margin: "24px 0", borderRadius: 16 }}
      />
      {showAccount ? (
        <GenexAccount
          live={{
            status: null,
            error: "",
            running: null,
            act: async () => {},
            refresh: async () => {},
            review: null,
            closeReview: () => {},
          }}
        />
      ) : null}
      <PluginPanelHost
        plugin={plugin()}
        document={{ url: "studio-plugin://theme/editor", title: "Test plugin", html: "" }}
        project={null}
        className="w-full h-[220px] border border-line"
      />
      <PluginCustomizationHost />
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
Object.assign(window, {
  customizationFixture: {
    account: (next: boolean) => {
      showAccount = next;
      redraw();
    },
    enable: async (next: boolean) => {
      enabled = next;
      await studio().plugins.refresh();
      redraw();
    },
    refresh: () => studio().plugins.refresh(),
    profile: () => saved,
  },
});
