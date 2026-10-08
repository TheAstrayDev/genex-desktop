/**
 * `app_look` for the chat's own session, a lead and every worker (readers included), in every
 * permission mode, Plan too: it only looks. Without arguments it lists the windows on screen; with
 * `app` or `window` it answers that window's picture and accessibility tree through the core's port
 * (`substrate/app-look.ts`). While macOS access is missing Genex asks macOS once, tells the agent what
 * the person must turn on, and writes one `app_look_access` line in the chat per app session.
 */
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import type { LiveToolResult, LiveToolSpec } from "../../shared/engine-requests.ts";
import { errorMessage } from "../../shared/errors.ts";
import { AppLookAccessKind } from "../../shared/jobs.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import {
  AccessStep,
  type AppLookProblem,
  AppLookProblemCode,
  type AppWindow,
  accessStep,
  isAppLookProblem,
  pickWindow,
  refusedApp,
  type ScreenAccess,
} from "../../substrate/app-look.ts";
import type { StudioCore } from "../studio-core.ts";
import { APP_LOOK_ANSWER, APP_LOOK_TOOL, type LookedWindow } from "./app-look-tool-prompts.ts";
import { ProjectToolSeat } from "./project-tools.ts";

/** The longest an app's name or a window's title reads in an answer. */
const NAME_MAX_CHARS = 120;

const MESSAGE = {
  notRecorded: (error: unknown) => `[core] the app access line was not recorded in its chat: ${errorMessage(error)}`,
} as const;

/** Whom a look answers to: the game and the chat its access line goes to (none: no line). */
export interface LookCaller {
  project: string;
  chatThreadId: string | null;
}

/** The chats told this app session that access is missing, per core. */
const toldChats = new WeakMap<StudioCore, Set<string>>();

/** `app_look` for a seat: the chat's own session, a lead and any worker the host seated; nobody else. */
export function appLookFor(seat: ProjectToolSeat): LiveToolSpec[] {
  return seat === ProjectToolSeat.None ? [] : [APP_LOOK_TOOL];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** A name as one plain, clipped line. */
function plain(text: string): string {
  const line = text.replace(CONTROL_CHARACTERS, " ").trim();
  return line.length <= NAME_MAX_CHARS ? line : `${line.slice(0, NAME_MAX_CHARS - 1)}…`;
}

/** A window as an answer names it. */
const named = (window: AppWindow): LookedWindow => ({
  id: window.id,
  app: plain(window.app),
  title: plain(window.title),
});

/** A string argument, trimmed; anything else is empty. */
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

/** A tool answer that showed nothing. */
const refusal = (words: string): LiveToolResult => ({ text: words, isError: true });

/** What the person must still allow, after asking macOS once when Genex never has. */
async function missingAccess(access: ScreenAccess | null): Promise<AppLookAccessKind[]> {
  if (!access) return [];
  const first = accessStep(access.status(), await access.asked());
  if (first.step === AccessStep.Look) return [];
  if (first.step === AccessStep.Missing) return first.missing;
  await access.askOnce();
  return accessStep(access.status(), true).missing;
}

/** Tell the agent what is missing, and the chat once this app session. A failed line is logged, never the answer. */
async function accessMissing(
  core: StudioCore,
  caller: LookCaller,
  missing: AppLookAccessKind[],
): Promise<LiveToolResult> {
  const told = toldChats.get(core) ?? new Set<string>();
  toldChats.set(core, told);
  const threadId = caller.chatThreadId;
  if (threadId && !told.has(threadId)) {
    told.add(threadId);
    try {
      await core.append([customEventData(CustomEvent.AppLookAccess, { project: caller.project, missing })], threadId);
      core.emit(UiEvent.ThreadUpdated, { threadId, project: caller.project });
    } catch (error) {
      core.options.onLog?.(MESSAGE.notRecorded(error), "stderr");
    }
  }
  return refusal(APP_LOOK_ANSWER.missing(missing));
}

/** A port's problem, as the agent reads it. */
function problemAnswer(
  core: StudioCore,
  caller: LookCaller,
  found: AppLookProblem,
): Promise<LiveToolResult> | LiveToolResult {
  if (found.problem === AppLookProblemCode.NoScreenAccess)
    return accessMissing(core, caller, [AppLookAccessKind.Screen]);
  if (found.problem === AppLookProblemCode.NoAxAccess)
    return accessMissing(core, caller, [AppLookAccessKind.Accessibility]);
  if (found.problem === AppLookProblemCode.Unsupported) return refusal(APP_LOOK_ANSWER.unsupported);
  if (found.problem === AppLookProblemCode.NotOnScreen) return refusal(APP_LOOK_ANSWER.notOnScreen);
  if (found.problem === AppLookProblemCode.Refused) return refusal(APP_LOOK_ANSWER.refused);
  return refusal(APP_LOOK_ANSWER.failed(found.detail ?? ""));
}

/** One window's look, as the agent reads it. */
async function lookAt(core: StudioCore, caller: LookCaller, window: AppWindow): Promise<LiveToolResult> {
  if (refusedApp(window)) return refusal(APP_LOOK_ANSWER.refused);
  const looked = await core.appLook.look(window);
  if (isAppLookProblem(looked)) return problemAnswer(core, caller, looked);
  const notes = [
    ...(looked.truncated ? [APP_LOOK_ANSWER.truncated] : []),
    ...(looked.image ? [] : [APP_LOOK_ANSWER.noPicture(looked.note ?? "")]),
  ];
  return {
    text: APP_LOOK_ANSWER.looked(named(looked.window), looked.tree, notes),
    images: looked.image ? [looked.image] : [],
  };
}

/**
 * `app_look`: the windows on screen without arguments (a password manager's left out), else the
 * window asked for, looked at. Access missing answers what the person must turn on.
 */
export async function runAppLook(
  core: StudioCore,
  args: Record<string, unknown>,
  caller: LookCaller,
): Promise<LiveToolResult> {
  const missing = await missingAccess(core.screenAccess);
  if (missing.length) return accessMissing(core, caller, missing);
  const windows = await core.appLook.windows();
  if (isAppLookProblem(windows)) return problemAnswer(core, caller, windows);
  const app = text(args.app);
  const window = text(args.window);
  if (!app && !window) return APP_LOOK_ANSWER.windows(windows.filter((shown) => !refusedApp(shown)).map(named));
  const picked = pickWindow(windows, { app, window });
  return picked ? lookAt(core, caller, picked) : refusal(APP_LOOK_ANSWER.noMatch);
}
