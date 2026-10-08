import { memo, useMemo, useState } from "react";
import type { AssetDeliveredPayload } from "../../shared/game-assets.ts";
import { usePlugins } from "../state/hooks.ts";
import { FileText } from "../ui/FileText.tsx";
import { PluginIcon } from "../ui/PluginIcon.tsx";
import { ToolRow } from "../ui/ToolChips.tsx";
import { AssetResults } from "./AssetResults.tsx";
import { ChatDisclosure } from "./ChatDisclosure.tsx";
import { ShotStrip } from "./ConnectorShots.tsx";
import {
  ActivityItemKind,
  activitySummary,
  failedToolItem,
  stripShots,
  type ActivityItem,
  workSources,
} from "./conversation-entries.ts";

/**
 * One quiet entry point for the chronological work behind a reply: its heading names the plugins
 * it worked in, with their icons; its play views sit under the heading, and what it delivered
 * under those.
 */
export const WorkLog = memo(function WorkLog({
  items,
  deliveries,
  onOpenAssets,
}: {
  items: ActivityItem[];
  deliveries?: AssetDeliveredPayload[] | undefined;
  onOpenAssets?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const failures = items.filter(failedToolItem).length;
  const strip = useMemo(() => stripShots(items), [items]);
  return (
    <div className="flex min-w-0 flex-col">
      <ChatDisclosure
        data-work-log
        label={activitySummary(items)}
        lead={<SourceIcon items={items} />}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        frame={false}
        suffix={failures > 0 ? <span className="shrink-0 text-orange">· {failures} failed</span> : undefined}
      >
        <WorkLogContent items={items} />
      </ChatDisclosure>
      {strip.length > 0 && <ShotStrip paths={strip} />}
      {deliveries?.length ? (
        <div className="mt-2">
          <AssetResults deliveries={deliveries} onOpenAssets={onOpenAssets} />
        </div>
      ) : null}
    </div>
  );
});

/**
 * The icon of the plugin a work group first ran in, as the Plugins page shows it. One is enough:
 * the heading names every plugin, and a second icon only crowds a narrow chat.
 */
function SourceIcon({ items }: { items: readonly ActivityItem[] }) {
  const [source] = useMemo(() => workSources(items), [items]);
  const icon = usePlugins((s) => s.list.find((plugin) => plugin.manifest.id === source?.id)?.iconUrl);
  if (!source) return null;
  return (
    <span aria-hidden className="flex shrink-0">
      <PluginIcon name={source.name} src={icon} size="menu" />
    </span>
  );
}

export function WorkLogContent({ items }: { items: ActivityItem[] }) {
  const [limit, setLimit] = useState(30);
  const strip = useMemo(() => stripShots(items), [items]);
  return (
    <div data-work-log-items className="chat-tool-frame">
      {items.length > limit && (
        <button type="button" onClick={() => setLimit((value) => value + 30)} className="chat-disclosure mx-1">
          Show {Math.min(30, items.length - limit)} earlier steps
        </button>
      )}
      {items.slice(-limit).map((item) =>
        item.kind === ActivityItemKind.Tool ? (
          <ToolRow key={item.id} row={item.tool} inStrip={strip} />
        ) : (
          <p key={item.id} className="px-3 py-2 text-step whitespace-pre-wrap text-ink-3 [overflow-wrap:anywhere]">
            <FileText text={item.text} />
          </p>
        ),
      )}
    </div>
  );
}
