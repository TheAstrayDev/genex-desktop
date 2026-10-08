/**
 * Whether a game is a web page, the one place a chat decides it. A module of its own: a seed upgrade
 * keeps an older `game-engine.ts` the agent edited, and the parts that ask this import it from here.
 */
import { CoreFact, type FactsOfDescriptor, factsOfGame, hasFact } from "./folder-facts.ts";
import { engineOfGame, GameEngine } from "./game-engine.ts";

/**
 * Whether a game is a web page: its facts hold a web game at its root (`factsOfGame`, which reads an
 * older descriptor by its `engine` and `web`) and no engine claims it. A game with no kind yet is
 * none: there is no page to look at until its first message picks web. No descriptor at all is a
 * web game, as every game was.
 */
export function holdsWebGame(game: FactsOfDescriptor): boolean {
  return engineOfGame(game) === GameEngine.Web && hasFact(factsOfGame(game), CoreFact.WebGame, ".");
}
