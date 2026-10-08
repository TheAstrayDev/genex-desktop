/**
 * The chat ⋯ menu's history item: how much space the game's history takes, read each time the menu
 * opens, and clearing Rewind history and finished builds' side tracks, one clear at a time.
 */
import { useRef, useState } from "react";
import type { GameHistorySpace } from "../../shared/game-history.ts";
import { type Notify, notifyProblem, ToastTone } from "../state/toasts.ts";
import { historyClearedWords } from "../words.ts";

/** The header's view of a game's history space. */
export interface GameHistoryMenu {
  /** The space as last read; null while it loads or when it could not be read. */
  space: GameHistorySpace | null;
  /** A clear is running. */
  clearing: boolean;
  /** Read the space again (the menu opened). */
  refresh(): void;
  /** Clear the game's Rewind history and say what it freed; a second call while one runs does nothing. */
  clear(): void;
}

export function useGameHistory(project: string | null, onNotice: Notify): GameHistoryMenu {
  const [space, setSpace] = useState<GameHistorySpace | null>(null);
  const [clearing, setClearing] = useState(false);
  // Only the newest read may set the space: an older answer for another game arrives late.
  const reads = useRef(0);
  const pending = useRef(false);
  const refresh = (): void => {
    const read = ++reads.current;
    setSpace(null);
    if (!project) return;
    void window.studio
      .gameHistory(project)
      .then((next) => {
        if (read === reads.current) setSpace(next);
      })
      .catch(() => {});
  };
  const clear = (): void => {
    if (!project || pending.current) return;
    pending.current = true;
    setClearing(true);
    void window.studio
      .clearGameHistory(project)
      .then((cleared) => onNotice(historyClearedWords(cleared), ToastTone.Ok))
      .catch(notifyProblem(onNotice))
      .finally(() => {
        pending.current = false;
        setClearing(false);
      });
  };
  return { space, clearing, refresh, clear };
}
