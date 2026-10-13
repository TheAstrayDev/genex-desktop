/** Host integration only: a customization plugin supplies profiles through the panel API. */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  customizationOwner,
  parsePluginCustomization,
  type PluginCustomization,
} from "../../shared/plugin-customization.ts";
import {
  CustomizationSlot,
  CustomizationWidgetKind,
  type CustomizationWidget,
} from "../../shared/plugin-customization-layout.ts";
import { usePlugins } from "../state/hooks.ts";
import { customizationCss, customizationSelector } from "./plugin-customization.ts";
import { setPluginCustomization } from "./store.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { CustomizationPanel } from "./CustomizationPanel.tsx";

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return <time dateTime={now.toISOString()}>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>;
}
function Widget({ widget, owner }: { widget: CustomizationWidget; owner: string }) {
  const { kind, label, text, image } = widget;
  return (
    <div
      data-customization-widget={widget.id}
      style={{
        gridColumn: `${widget.column}/span ${widget.columnSpan}`,
        gridRow: `${widget.row}/span ${widget.rowSpan}`,
        minWidth: 0,
        overflow: "hidden",
        borderRadius: "var(--radius-card)",
        background: "var(--surface)",
        color: "var(--foreground)",
        padding: 8,
        pointerEvents: kind === CustomizationWidgetKind.Panel ? "auto" : "none",
      }}
    >
      {label && <div>{label}</div>}
      {kind === CustomizationWidgetKind.Clock ? <Clock /> : null}
      {kind === CustomizationWidgetKind.Image ? (
        <img src={image} alt={label} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : null}
      {text && <div>{text}</div>}
      {widget.panel ? <CustomizationPanel id={owner} panel={widget.panel} /> : null}
    </div>
  );
}
const ANCHOR_SELECTOR = "[data-customization-slot]";
function containsAnchor(node: Node): boolean {
  return node instanceof HTMLElement && (node.matches(ANCHOR_SELECTOR) || node.querySelector(ANCHOR_SELECTOR) !== null);
}
/** Observe anchor mounting only while a profile has widgets. No polling or global per-frame updates. */
function useAnchors(active: boolean): Map<CustomizationSlot, HTMLElement> {
  const [anchors, setAnchors] = useState(() => new Map<CustomizationSlot, HTMLElement>());
  useEffect(() => {
    if (!active) {
      setAnchors(new Map());
      return;
    }
    let frame = 0;
    const refresh = () => {
      frame = 0;
      const next = new Map<CustomizationSlot, HTMLElement>();
      for (const target of Object.values(CustomizationSlot)) {
        const anchor = document.querySelector<HTMLElement>(customizationSelector(target));
        if (anchor) next.set(target, anchor);
      }
      setAnchors((previous) =>
        previous.size === next.size && [...next].every(([key, value]) => previous.get(key) === value) ? previous : next,
      );
    };
    refresh();
    const observer = new MutationObserver((records) => {
      if (frame) return;
      const changed = records.some((record) => [...record.addedNodes, ...record.removedNodes].some(containsAnchor));
      if (changed) frame = requestAnimationFrame(refresh);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active]);
  return anchors;
}
function Widgets({ profile, owner }: { profile: PluginCustomization | null; owner: string }) {
  const anchors = useAnchors(Boolean(profile?.widgets.length));
  if (!profile) return null;
  return [...anchors].map(([target, anchor]) => {
    const widgets = profile.widgets.filter((entry) => entry.target === target);
    if (!widgets.length) return null;
    const grid = profile.layout.find((entry) => entry.target === target);
    const inProfile = target === CustomizationSlot.Profile;
    return createPortal(
      <div
        data-customization-widgets={target}
        aria-live="off"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${grid?.columns ?? 12},minmax(0,1fr))`,
          gridTemplateRows: "repeat(24,minmax(0,1fr))",
          gap: grid?.gap ?? 8,
          pointerEvents: "none",
          position: inProfile ? "relative" : "absolute",
          inset: inProfile ? undefined : "64px 16px 16px",
          height: inProfile ? 160 : undefined,
          zIndex: 1,
        }}
      >
        {widgets.map((widget) => (
          <Widget key={`${owner}/${widget.id}`} owner={owner} widget={widget} />
        ))}
      </div>,
      anchor,
      target,
    );
  });
}
/** Apply one permitted provider; withdrawal removes styles, widgets and the appearance overlay. */
export function PluginCustomizationHost() {
  const data = usePlugins((state) => {
    const owner = customizationOwner(state.list);
    return owner?.customization ? JSON.stringify({ id: owner.manifest.id, profile: owner.customization }) : "";
  });
  const provider = useMemo(() => {
    if (!data) return null;
    const saved = JSON.parse(data);
    return { id: saved.id as string, profile: parsePluginCustomization(saved.profile) };
  }, [data]);
  const profile = provider?.profile ?? null;
  useEffect(() => {
    setPluginCustomization(profile);
    if (!profile) return;
    const sheet = document.createElement("style");
    sheet.dataset.pluginCustomization = "";
    sheet.textContent = customizationCss(profile);
    document.head.append(sheet);
    return () => {
      sheet.remove();
      setPluginCustomization(null);
    };
  }, [profile]);
  return <Widgets profile={profile} owner={provider?.id ?? ""} />;
}
