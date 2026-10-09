/**
 * Words another surface leaves for this chat's composer (`compose-in-chat.ts`): taken only when
 * they are for the game this chat is open on, put in front of its draft, and never sent.
 */
import { type RefObject, useEffect, useRef } from "react";
import { COMPOSE_IN_CHAT_EVENT, type ComposeInChat } from "../compose-in-chat.ts";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";

export function useComposeInChat(
  threadId: string | undefined,
  project: string | null,
  putBack: (threadId: string, text: string) => void,
  composer: RefObject<PromptBarHandle | null>,
): void {
  const open = useRef({ threadId, project, putBack });
  open.current = { threadId, project, putBack };
  useEffect(() => {
    const compose = (event: Event): void => {
      const request = (event as CustomEvent<ComposeInChat>).detail;
      const chat = open.current;
      if (!request?.text || !chat.threadId || !chat.project || request.project !== chat.project) return;
      chat.putBack(chat.threadId, request.text);
      // Once the words are in, the cursor goes after them; compose only places it when the draft is set.
      requestAnimationFrame(() => composer.current?.compose(request.text));
    };
    window.addEventListener(COMPOSE_IN_CHAT_EVENT, compose);
    return () => window.removeEventListener(COMPOSE_IN_CHAT_EVENT, compose);
  }, [composer]);
}
