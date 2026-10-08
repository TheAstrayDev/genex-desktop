/** A game's history space, and clearing what Rewind and finished builds left beside it. */
import { PROJECT_NAME_RE } from "../../shared/game-folder-name.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** Why a history request from the renderer is refused. */
const MESSAGE = {
  projectRequired: "A game name is required.",
} as const;

export interface GameHistoryIpcDeps {
  core: Pick<StudioCore, "gameHistory" | "clearGameHistory">;
}

/** The game a payload names, refused unless it is a string spelled as a game's name. */
function gameName(payload: unknown): string {
  const project = (payload as { project?: unknown } | null | undefined)?.project;
  if (typeof project !== "string" || !PROJECT_NAME_RE.test(project)) throw new Error(MESSAGE.projectRequired);
  return project;
}

/** Register the chat ⋯ menu's history calls; the core checks the game is one it lists. */
export function registerGameHistoryIpc(handle: IpcHandle, { core }: GameHistoryIpcDeps): void {
  handle("studio:game.history", async (payload) => core.gameHistory(gameName(payload)));
  handle("studio:game.history.clear", async (payload) => core.clearGameHistory(gameName(payload)));
}
