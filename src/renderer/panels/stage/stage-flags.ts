/**
 * Which surface the stage shows, and why the running game is or is not on it: pure, so the rules
 * are tested without React (`PreviewPanel` reads them each render).
 */
import type { BesideTarget } from "../../open-beside.ts";
import type { RunGraph as RunGraphModel } from "../../run-graph.ts";
import { StageView } from "../../stage.ts";
import type { LiveLoad } from "./live-load.ts";

/** What the live page reported, and the load Live waits on, as the flags read them (`useLiveLoad`). */
export interface LiveFlagsInput {
  state: Record<string, unknown> | null;
  liveLoad: LiveLoad | null;
  stopped: boolean;
}

/**
 * The view the stage shows. The user's stored choice is honoured, but Builds can only be shown
 * once there is a build to draw: a remembered "builds" on a game that has never run used to leave
 * the stage on the empty black scene with no copy on it and no Live/Builds control to escape with.
 */
export function resolveStageView(
  view: StageView,
  has: { beside: boolean; builds: boolean; project: boolean },
): StageView {
  if (view === StageView.File && has.beside) return StageView.File;
  if (view === StageView.Builds && has.builds) return StageView.Builds;
  if (view === StageView.Assets && has.project) return StageView.Assets;
  return StageView.Live;
}

/**
 * Which surface the stage shows, and why the running game is or is not on it. An Unreal game's
 * Live is its Unreal card: no web page loads, empties or waits there. A game with no kind yet
 * (`pending`) has no page: Live shows the first-idea state and waits for nothing.
 */
export function stageFlags({
  view,
  beside,
  graph,
  planning,
  project,
  unreal,
  pending,
  live,
}: {
  view: StageView;
  beside: BesideTarget | null;
  graph: RunGraphModel | null;
  planning: boolean;
  project: string | null;
  unreal: boolean;
  pending: boolean;
  live: LiveFlagsInput;
}) {
  const stageView = resolveStageView(view, {
    beside: Boolean(beside),
    builds: graph !== null || planning,
    project: Boolean(project),
  });
  const onLive = Boolean(project) && stageView === StageView.Live;
  const webLive = onLive && !unreal;
  const emptyScene = live.state?.phase === "empty" && live.state?.drawCalls === 0;
  const showEmpty = webLive && (emptyScene || pending);
  const liveLoading = webLive && live.liveLoad?.project === project && !showEmpty;
  return {
    stageView,
    /** The game has nothing in it yet, whichever view is open. */
    emptyScene: Boolean(project && (emptyScene || pending)),
    showEmpty,
    liveLoading,
    engineCard: onLive && unreal,
    /** The person stopped the game: its view holds no page until Play. */
    stopped: live.stopped,
    /** …and Live says so, with no load of it under way. */
    gameStopped: webLive && live.stopped && !liveLoading && !showEmpty,
    buildsOpen: stageView === StageView.Builds,
    /** Assets is a full-stage surface like Builds: the native game view has to give the rectangle back. */
    assetsOpen: stageView === StageView.Assets,
    fileOpen: stageView === StageView.File,
  };
}
