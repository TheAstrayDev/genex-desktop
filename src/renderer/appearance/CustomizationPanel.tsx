/** Mount a plugin's declared panel inside the New Chat box without file pickers or action approvals. */
import { useEffect, useState } from "react";
import type { PluginPanelDocument } from "../../shared/plugins.ts";
import { usePlugins } from "../state/hooks.ts";
import { PluginPanelHost } from "../panels/PluginPanelHost.tsx";
import { Button } from "../ui/Button.tsx";
const MESSAGE = {
  Failed: "The plugin panel could not be loaded.",
  Loading: "Loading plugin panel…",
  Retry: "Try again",
} as const;
/** Only host-reviewed settings panels can be selected by a saved customization profile. */
export function CustomizationPanel({ id, panel }: { id: string; panel: string }) {
  const plugin = usePlugins((state) => state.list.find((entry) => entry.manifest.id === id) ?? null);
  const [document, setDocument] = useState<PluginPanelDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setDocument(null);
    setFailed(false);
    void window.studio
      .pluginPanel(id, panel)
      .then((next) => {
        if (!disposed) setDocument(next);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [id, panel, attempt]);
  const allowed = plugin?.manifest.panels.some((entry) => entry.id === panel && entry.placement === "settings");
  if (!plugin || !allowed) return null;
  if (failed)
    return (
      <div className="new-chat-plugin-status">
        <p role="alert">{MESSAGE.Failed}</p>
        <Button variant="outline" onClick={() => setAttempt((previous) => previous + 1)}>
          {MESSAGE.Retry}
        </Button>
      </div>
    );
  if (!document)
    return (
      <p className="new-chat-plugin-status" role="status" aria-busy="true">
        {MESSAGE.Loading}
      </p>
    );
  return (
    <PluginPanelHost
      plugin={plugin}
      document={document}
      project={null}
      allowPrompts={false}
      className="h-full w-full border-0"
    />
  );
}
