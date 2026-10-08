/**
 * How much space a game's version history takes, and clearing Rewind history and finished runs'
 * side tracks (`../../substrate/history-space.ts`). Clearing waits for the game's work: it never
 * runs while a contractor builds in the game or a run of it is going, and it takes the folder's
 * checkpoint queue, so no chat checkpoint interleaves with it.
 */
import type { GameHistoryCleared, GameHistorySpace } from "../../shared/game-history.ts";
import { outcomeEnded } from "../../shared/run-summary.ts";
import { clearSideTracks, historySpace } from "../../substrate/history-space.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

const MESSAGE = {
  busy: "Wait for this game's work to finish, then clear its history.",
  unknownGame: (project: string) => `There is no game named "${project}".`,
} as const;

/** A game's history space, and clearing what Rewind and finished runs left beside it. */
export class HistorySpaceService {
  readonly #core: StudioCore;
  readonly #x: CoreInternals;

  constructor(core: StudioCore, x: CoreInternals) {
    this.#core = core;
    this.#x = x;
  }

  /** How much space `project`'s history takes, and how much of it clearing would free. */
  async space(project: string): Promise<GameHistorySpace> {
    const dir = await this.#gameDir(project);
    return historySpace(dir, await this.#finishedRuns(project));
  }

  /** Clear `project`'s Rewind history and its finished runs' side tracks; refused while it works. */
  async clear(project: string): Promise<GameHistoryCleared> {
    const dir = await this.#gameDir(project);
    if (await this.#busy(project)) throw new Error(MESSAGE.busy);
    return this.#x.rewind.checkpoints.exclusive(dir, async () => {
      if (await this.#busy(project)) throw new Error(MESSAGE.busy);
      return clearSideTracks(dir, await this.#finishedRuns(project), { scratch: this.#core.layout.scratch });
    });
  }

  /** The folder of a game the library lists, inside the folders the studio may change. */
  async #gameDir(project: string): Promise<string> {
    const listed = (await this.#core.games.list()).some((game) => game.name === project);
    if (!listed) throw new Error(MESSAGE.unknownGame(project));
    const dir = this.#core.games.dirFor(project);
    await this.#core.assertProjectAllowed(dir);
    return dir;
  }

  /** The runs of `project` that ended and are not going any more, by id. */
  async #finishedRuns(project: string): Promise<Set<string>> {
    const finished = new Set<string>();
    for (const { project: game, runId, runOutcome } of await this.#core.activityItems()) {
      if (game !== project || !runId || !runOutcome) continue;
      if (outcomeEnded(runOutcome) && !this.#x.activeRunIds.has(runId)) finished.add(runId);
    }
    return finished;
  }

  /**
   * Whether a contractor builds in `project` now, or a run is going that is its own or that no
   * record ties to a game yet.
   */
  async #busy(project: string): Promise<boolean> {
    if ([...this.#x.activeDelegations.values()].some((work) => work.project === project)) return true;
    if (this.#x.activeRunIds.size === 0) return false;
    const gameOfRun = new Map<string, string | undefined>();
    for (const item of await this.#core.activityItems()) if (item.runId) gameOfRun.set(item.runId, item.project);
    return [...this.#x.activeRunIds].some((runId) => {
      const game = gameOfRun.get(runId);
      return game === undefined || game === project;
    });
  }
}
