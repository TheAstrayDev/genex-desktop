/**
 * Which engine a game builds in, as the app records it (`engine` in a game's studio.json, handed to
 * the harness on every `game.list` descriptor). A copy of the app's `shared/game-engine.ts`
 * vocabulary, held equal to it by `seed-contracts.test.ts`. A game with no engine record is a web
 * game; anything that would treat a game as a web page (the brief's template rules, the preview
 * health check, the web Loop) asks this first.
 */
import type { GameProject } from "../types/host-api.d.ts";

/** The engines a game can build in, by their wire names. */
export const GameEngine = { Web: "web", Unreal: "unreal" } as const;
export type GameEngine = (typeof GameEngine)[keyof typeof GameEngine];

/** The engine a game descriptor says it builds in: Unreal only when the app linked it, else the web. */
export function engineOfGame(game: Pick<GameProject, "engine"> | null | undefined): GameEngine {
  return game?.engine?.kind === GameEngine.Unreal ? GameEngine.Unreal : GameEngine.Web;
}
