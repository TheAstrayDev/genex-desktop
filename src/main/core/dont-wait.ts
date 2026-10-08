/**
 * "Don't wait for me", the host's half (`shared/dont-wait.ts`): the person's switch from the Loop
 * menu or an agent's card (Studio UI over IPC only, never an RPC method), what the menu reads, and
 * `offer_dont_wait`, the project tool that only shows the card. The setting is kept by the run
 * settings store; a worker's question reads it in `chat-permissions.ts`.
 */
import { CustomEvent, customEventData, customPayload } from "../../shared/custom-events.ts";
import { type DontWaitSetPayload, DontWaitScope, type DontWaitState } from "../../shared/dont-wait.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { shortId } from "../../substrate/ids.ts";
import type { RunSettingsStore } from "../run-settings.ts";
import type { StudioCore } from "../studio-core.ts";
import { DONT_WAIT_ANSWER } from "./project-tools-prompts.ts";

/** The longest card id a click may name. */
const OFFER_ID_MAX = 100;

/** Why a switch is refused before anything is recorded. */
const MESSAGE = {
  notGameChat: "Don't wait for me is set in a game chat.",
  invalidSwitch: "Don't wait for me is on or off.",
} as const;

/** The run going in a chat now, as the delegation service finds it (`runOfChatNow`), or null. */
export type ChatRun = { runId: string; startedAt: number } | null;

/** This game chat's project, when the thread is an open game chat; null otherwise. */
async function gameChatProject(core: StudioCore, threadId: unknown): Promise<string | null> {
  if (typeof threadId !== "string" || !threadId) return null;
  const meta = (await core.store.getRecord(threadId).catch(() => null))?.metadata;
  const open = meta?.kind === ThreadKind.Game && meta.archived !== true;
  return open && typeof meta.project === "string" ? meta.project : null;
}

/** Whether `offerId` names a card an agent showed in this chat: only then does the click settle it. */
async function shownOffer(core: StudioCore, threadId: string, offerId: unknown): Promise<string | null> {
  if (typeof offerId !== "string" || !offerId || offerId.length > OFFER_ID_MAX) return null;
  const events = await core.store.listEvents(threadId);
  const shown = events.some((event) => customPayload(event.data, CustomEvent.DontWaitOffer)?.offerId === offerId);
  return shown ? offerId : null;
}

/**
 * The person's switch, for the run started in this chat that is going now, else for the chat's
 * next run; recorded in the chat as `dont_wait_set` (with the card it came from, when it names one
 * this chat showed). Refused, with nothing recorded, for anything but an open game chat.
 */
export async function setDontWait(
  core: StudioCore,
  settings: RunSettingsStore,
  input: { threadId: unknown; on: unknown; offerId?: unknown },
  run: (threadId: string) => Promise<ChatRun>,
): Promise<DontWaitState> {
  const { threadId, on } = input;
  if (typeof on !== "boolean") throw new Error(MESSAGE.invalidSwitch);
  if (!(await gameChatProject(core, threadId))) throw new Error(MESSAGE.notGameChat);
  const chat = threadId as string;
  const going = await run(chat);
  if (going) await settings.setForRun(going.runId, chat, on, going.startedAt);
  else await settings.setForNextRun(chat, on);
  const offerId = await shownOffer(core, chat, input.offerId);
  const payload: DontWaitSetPayload = {
    threadId: chat,
    runId: going?.runId ?? null,
    on,
    ...(offerId ? { offerId } : {}),
  };
  await core.append([customEventData(CustomEvent.DontWaitSet, { ...payload })], chat);
  core.emit(UiEvent.PermissionsChanged, { threadId: chat });
  return { on, scope: going ? DontWaitScope.Run : DontWaitScope.NextRun };
}

/** What the Loop menu shows for a chat: the running run's setting, else the chat's next run's. */
export async function dontWaitState(
  core: StudioCore,
  settings: RunSettingsStore,
  threadId: unknown,
  run: (threadId: string) => Promise<ChatRun>,
): Promise<DontWaitState> {
  if (!(await gameChatProject(core, threadId))) throw new Error(MESSAGE.notGameChat);
  const chat = threadId as string;
  const going = await run(chat);
  if (!going) return { on: await settings.nextRun(chat), scope: DontWaitScope.NextRun };
  return { on: await settings.dontWait(going.runId, chat, going.startedAt), scope: DontWaitScope.Run };
}

/**
 * `offer_dont_wait`: shows the person the card in this game's chat, and nothing else. It never
 * switches the setting (only the person's click does) and writes no file, so Plan mode lets it run.
 */
export async function offerDontWait(core: StudioCore, call: { project: string; threadId?: string }): Promise<string> {
  const { project, threadId } = call;
  if (!threadId || (await gameChatProject(core, threadId)) !== project) return DONT_WAIT_ANSWER.noChat;
  const offer = { offerId: shortId("wait"), threadId, project };
  await core.append([customEventData(CustomEvent.DontWaitOffer, offer)], threadId);
  return DONT_WAIT_ANSWER.shown;
}
