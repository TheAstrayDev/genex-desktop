/** The Builds tab's bar of the chat's builds, its Play button, and the zoom pill in the canvas corner. */
import type { JSX, KeyboardEvent, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { RunState } from "../../../shared/run-state.ts";
import { type HistoryEntry, historyLabel, isNewestBuild } from "../../build-progress.ts";
import type { statusLine } from "../../run-steps.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";
import { Elapsed } from "../../ui/LoadingState.tsx";
import { isRovingKey, RovingAxis, rovingTarget } from "../../ui/roving-focus.ts";
import { StatusOrb } from "../../ui/StatusOrb.tsx";
import { BUILD_TABS_WORDS as WORDS } from "../../words.ts";

/** The chat's builds as the bar's tabs: which one is on show, and the way to show another. */
export interface BuildTabs {
  /** Oldest first, as `buildHistory` reads them. */
  builds: readonly HistoryEntry[];
  /** The build on show: its key in the history. */
  open: string | null;
  onOpen: (runId: string) => void;
}

/** A tab's name: what the person asked for it, else what the history calls it ("This Loop"). */
function tabName(builds: readonly HistoryEntry[], build: HistoryEntry): string {
  return build.ask || historyLabel(build, { newest: isNewestBuild(builds, build) });
}

/** How a build stands, before its name: the status line's loader while it works, a bare ✓ once done, a dot while paused. */
function TabMark({ state }: { state: string }): JSX.Element {
  if (state === RunState.Running) return <StatusOrb />;
  if (state === RunState.Finished) return <Icon name="check" size={12} strokeWidth={2.6} className="shrink-0" />;
  return <span aria-hidden="true" className="build-tab-dot" />;
}

/** Arrow keys, Home and End move along the tabs and open the tab they land on. */
function moveTab(
  event: KeyboardEvent<HTMLButtonElement>,
  builds: readonly HistoryEntry[],
  index: number,
  onOpen: (runId: string) => void,
): void {
  if (!isRovingKey(event.key, RovingAxis.Horizontal)) return;
  event.preventDefault();
  const next = rovingTarget(event.key, index, builds.length, RovingAxis.Horizontal) ?? index;
  const target = builds[next];
  if (target) onOpen(target.runId);
  const tabs = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  tabs?.[next]?.focus();
}

/** One build's tab: its mark, its name, and while it works its clock, shimmering as the chat's does. */
function BuildTab({
  build,
  name,
  open,
  title,
  onOpen,
  onKeyDown,
}: {
  build: HistoryEntry;
  name: string;
  open: boolean;
  title: string;
  onOpen: (runId: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={open}
      tabIndex={open ? 0 : -1}
      data-build-tab={build.runId}
      title={title}
      onClick={() => onOpen(build.runId)}
      onKeyDown={onKeyDown}
      className="build-tab"
    >
      <TabMark state={build.state} />
      <span className="min-w-0 truncate">{name}</span>
      {build.state === RunState.Running && build.since !== null ? (
        <span className="build-tab-clock chat-status-shimmer">
          <Elapsed since={build.since} />
        </span>
      ) : null}
    </button>
  );
}

/** The tabs on one track; the open one is kept in view when the row outgrows the bar. */
function BuildTabTrack({ tabs, said }: { tabs: BuildTabs; said: string }): JSX.Element {
  const { builds, open, onOpen } = tabs;
  const track = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = track.current;
    const tab = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row || !tab) return;
    const end = tab.offsetLeft + tab.offsetWidth;
    if (tab.offsetLeft < row.scrollLeft) row.scrollLeft = tab.offsetLeft;
    else if (end > row.scrollLeft + row.clientWidth) row.scrollLeft = end - row.clientWidth;
  }, [open, builds.length]);
  return (
    <div ref={track} role="tablist" aria-label={WORDS.tabs} className="build-tabs surface-glass">
      {builds.map((build, index) => {
        const name = tabName(builds, build);
        const isOpen = build.runId === open;
        return (
          <BuildTab
            key={build.runId}
            build={build}
            name={name}
            open={isOpen}
            title={isOpen ? `${name}\n${said}` : name}
            onOpen={onOpen}
            onKeyDown={(event) => moveTab(event, builds, index, onOpen)}
          />
        );
      })}
    </div>
  );
}

/**
 * The bar over the graph: the chat's builds as tabs on one track, the newest on the right, and
 * Play. The open build's status ("Building · 9 of 30 min · 2 parts working") is its tab's tooltip
 * and what a screen reader hears; a working build's tab shows only the loader and its clock.
 */
export function BuildStatus({
  status,
  tabs,
  action,
}: {
  status: ReturnType<typeof statusLine>;
  tabs: BuildTabs;
  action: ReactNode;
}): JSX.Element {
  const said = status.rest ? `${status.strong} · ${status.rest}` : status.strong;
  return (
    <div data-testid="build-status" className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-2">
      <BuildTabTrack tabs={tabs} said={said} />
      <span className="min-w-0 flex-1" />
      {action}
      <p role="status" className="sr-only">
        {said}
      </p>
    </div>
  );
}

/** Play the run's build in Live; it says Opening… until Live has it. */
export function PlayButton({
  label,
  quiet = false,
  onPlay,
}: {
  label: string;
  quiet?: boolean;
  onPlay: () => Promise<void> | void;
}): JSX.Element {
  const [opening, setOpening] = useState(false);
  return (
    <Button
      variant={quiet ? "secondary" : "default"}
      disabled={opening}
      onClick={async () => {
        setOpening(true);
        try {
          await onPlay();
        } finally {
          setOpening(false);
        }
      }}
    >
      <Icon name="play" size={13} />
      {opening ? "Opening…" : label}
    </Button>
  );
}

const ICON_BUTTON =
  "inline-flex size-[26px] cursor-pointer items-center justify-center rounded-[7px] text-ink-3 hover:bg-control-hover hover:text-control-text-hover focus-visible:outline-2 focus-visible:outline-accent";
const TEXT_BUTTON =
  "h-[26px] cursor-pointer rounded-[7px] px-2.5 font-mono text-xs text-ink-2 hover:bg-control-hover hover:text-control-text-hover focus-visible:outline-2 focus-visible:outline-accent";

/** Zoom out, the zoom level, zoom in, fit everything, and — while a run is live — jump back to its work. */
export function ZoomPill({
  pct,
  onOut,
  onIn,
  onFit,
  onNow,
}: {
  pct: number;
  onOut: () => void;
  onIn: () => void;
  onFit: () => void;
  onNow: (() => void) | null;
}): JSX.Element {
  return (
    <div
      className="absolute bottom-3 left-3 z-[3] flex h-8 items-center gap-0.5 rounded-[11px] bg-surface px-[3px] shadow-card"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" aria-label="Zoom out" title="Zoom out" className={ICON_BUTTON} onClick={onOut}>
        <Icon name="minus" size={13} />
      </button>
      <span className="w-10 text-center font-mono text-xs text-ink-3 tabular-nums" aria-label={`Zoom ${pct}%`}>
        {pct}%
      </span>
      <button type="button" aria-label="Zoom in" title="Zoom in" className={ICON_BUTTON} onClick={onIn}>
        <Icon name="plus" size={13} />
      </button>
      <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-line-strong" />
      <button type="button" title="Fit everything (0)" className={TEXT_BUTTON} onClick={onFit}>
        Fit
      </button>
      {onNow ? (
        <button type="button" className={`${TEXT_BUTTON} text-accent-ink`} onClick={onNow}>
          Jump to now
        </button>
      ) : null}
    </div>
  );
}
