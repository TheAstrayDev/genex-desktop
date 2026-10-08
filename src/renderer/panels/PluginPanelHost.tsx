/**
 * A plugin panel on screen: a sandboxed frame and the one bridge it may talk over. The frame
 * gets `context`, its plugin's `settings`, its declared `action`s — a confirmed action runs
 * the same review → ticket → native approval sequence a toolbar press does — and `chooseFile`,
 * Studio's own file picker. Nothing else crosses; the panel never sees `window.studio`.
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { pluginFileRequest } from "../../shared/plugin-file-request.ts";
import type { PluginInfo, PluginPanelDocument } from "../../shared/plugins.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { runPluginAction, type PluginReviewRequest } from "../plugin-actions.ts";
import { type PanelErrorReply, PanelSurface, panelContext, panelErrorReply } from "./panel-bridge.ts";
import { PluginApproval } from "./PluginApproval.tsx";

/** The longest request id a panel may use, and how many requests it may have in flight. */
const REQUEST_ID_MAX = 80;
const MAX_PENDING_REQUESTS = 16;

/** The bridge's message types, as the plugin SDK (src/plugin-sdk/panel.js) spells them. Wire values: never rename. */
const PanelMessage = {
  Request: "studio-plugin-request",
  Result: "studio-plugin-result",
  ContextChanged: "studio-plugin-context-changed",
} as const;

/** What a panel may ask for over the bridge. Wire values: never rename. */
const PanelMethod = { Context: "context", Settings: "settings", Action: "action", ChooseFile: "chooseFile" } as const;

/** A panel's request over the bridge, as it arrives: unchecked. */
type PanelRequest = { type?: unknown; id?: unknown; method?: unknown; name?: unknown; args?: unknown } | null;

/** Whether a message is a bridge request this host takes: well formed, not a repeat, and within the in-flight cap. */
function takesRequest(
  m: PanelRequest,
  active: Set<string>,
): m is { id: string; method?: unknown; name?: unknown; args?: unknown } {
  if (m?.type !== PanelMessage.Request || typeof m.id !== "string") return false;
  return m.id.length <= REQUEST_ID_MAX && !active.has(m.id) && active.size < MAX_PENDING_REQUESTS;
}

/** Answer one bridge request: the panel's context, its plugin's settings, one of its declared actions, or a chosen file. */
async function answerRequest(
  m: { method?: unknown; name?: unknown; args?: unknown },
  host: {
    id: string;
    project: string | null | undefined;
    plugin: PluginInfo;
    surface: PanelSurface;
    review: (request: PluginReviewRequest) => void;
  },
): Promise<unknown> {
  if (m.method === PanelMethod.Context)
    return panelContext(host.project, getComputedStyle(window.document.documentElement), host.surface);
  if (m.method === PanelMethod.Settings) return await window.studio.pluginSettings(host.id);
  // Checked here before it leaves the renderer, and again in main before the picker opens.
  if (m.method === PanelMethod.ChooseFile)
    return await window.studio.pluginChooseFile(host.id, pluginFileRequest(m.args));
  if (m.method !== PanelMethod.Action) throw new Error("Unsupported panel operation");
  // Only a declared action runs, and every declared action has a name.
  if (typeof m.name !== "string") throw new Error("Undeclared action");
  return await runPluginAction({
    plugin: host.plugin,
    name: m.name,
    args: m.args,
    project: host.project,
    review: host.review,
  });
}

interface Props {
  plugin: PluginInfo;
  document: PluginPanelDocument;
  project: string | null | undefined;
  className?: string;
  /** What the frame sits on, so the panel paints its background to match (a dialog's card, else the page). */
  surface?: PanelSurface;
}

export function PluginPanelHost({
  plugin,
  document,
  project,
  className = "h-[65vh] w-full border border-line",
  surface = PanelSurface.Page,
}: Props): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  // Declarations are looked up on the plugin as it is now, without re-subscribing per refresh.
  const pluginRef = useRef(plugin);
  pluginRef.current = plugin;
  const [review, setReview] = useState<PluginReviewRequest | null>(null);
  const id = plugin.manifest.id;
  useEffect(() => {
    let disposed = false;
    const active = new Set<string>();
    const handle = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const m = event.data;
      if (!takesRequest(m, active)) return;
      active.add(m.id);
      const reply = (body: { result: unknown } | PanelErrorReply): void => {
        if (!disposed) frame.current?.contentWindow?.postMessage({ type: PanelMessage.Result, id: m.id, ...body }, "*");
      };
      try {
        const result = await answerRequest(m, {
          id,
          project,
          plugin: pluginRef.current,
          surface,
          // A review answered after this host is gone is a cancel: the action must not run.
          review: (r) => setReview({ ...r, resolve: (yes) => r.resolve(yes && !disposed) }),
        });
        reply({ result });
      } catch (e) {
        reply(panelErrorReply(e));
      } finally {
        active.delete(m.id);
      }
    };
    const notifyContext = () => {
      if (!disposed) frame.current?.contentWindow?.postMessage({ type: PanelMessage.ContextChanged }, "*");
    };
    window.addEventListener("focus", notifyContext);
    const unsubscribe = window.studio.onEvent((event) => {
      const ownPluginChanged = event.type === UiEvent.PluginsChanged && event.payload?.id === id;
      if (ownPluginChanged && !disposed) notifyContext();
    });
    window.addEventListener("message", handle);
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener("focus", notifyContext);
      window.removeEventListener("message", handle);
      setReview((r) => {
        r?.resolve(false);
        return null;
      });
    };
  }, [id, project, surface]);
  return (
    <>
      <iframe ref={frame} title={document.title} sandbox="allow-scripts" className={className} src={document.url} />
      {review ? <PluginApproval review={review} onClose={() => setReview(null)} /> : null}
    </>
  );
}
