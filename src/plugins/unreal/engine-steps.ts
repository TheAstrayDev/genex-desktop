/**
 * The steps card for Unreal: what the user can still do to make the agent's Unreal work better,
 * read live so the card notices a step done without being told. Xcode is recommended, never
 * required: without it Genex builds in Blueprints only. The card is quiet, not a
 * permission card; it appears in a game's chat when new-game makes its Unreal project while a step
 * is open, and the agent can show it again when C++ would clearly help.
 */
import { type XcodeRange, type XcodeStatus, XcodeState } from "./xcode.ts";

/** Each step's id on the card. Wire values: the renderer keys its rows by them. */
export const UnrealStepId = {
  SetUp: "set-up",
  InstallXcode: "install-xcode",
  OpenXcode: "open-xcode",
  SelectXcode: "select-xcode",
  UpdateXcode: "update-xcode",
  AddXcode: "add-xcode",
} as const;
export type UnrealStepId = (typeof UnrealStepId)[keyof typeof UnrealStepId];

/**
 * What the `get-xcode` action does: open Xcode's App Store page, open Xcode itself, or open Apple's
 * developer downloads for an older Xcode beside one too new for the engine.
 */
export const XcodeStep = { Install: "install", Open: "open", Downloads: "downloads" } as const;
export type XcodeStep = (typeof XcodeStep)[keyof typeof XcodeStep];

/** The plugin action a step's button runs. */
export const GET_XCODE_ACTION = "get-xcode";

/** A step's button: the plugin action it runs with its arguments, and its label. */
export type StepAction = { name: string; args: Record<string, string>; label: string };
/** One row of the card; `command` is a line the user runs in Terminal themselves. */
export type UnrealStep = {
  id: UnrealStepId;
  label: string;
  detail: string;
  done: boolean;
  action?: StepAction;
  command?: string;
};
/** The card: its heading, one line under it, its rows, and whether any step is still open. */
export type UnrealSteps = { title: string; intro: string; steps: UnrealStep[]; open: boolean };

/** How the intro counts the open steps: in words up to three, which is all the card ever holds. */
const COUNT_WORDS = ["", "One", "Two", "Three"] as const;

const WORDS = {
  Title: "Unreal setup",
  Intro: (open: number) =>
    open === 1
      ? "One step left so the agent can add C++ to this game."
      : `${COUNT_WORDS[open] ?? open} steps left so the agent can add C++ to this game.`,
  AllDone: "Everything Unreal needs from you is done.",
  SetUp: (engine: string, project: string) => `Unreal ${engine} is set up for ${project}`,
  SetUpDetail: "Agents can edit and play it from this chat.",
  InstallXcode: "Install Xcode",
  InstallDetail:
    "Recommended. Lets the agent add C++ to this game; without it, it builds in Blueprints. Free from the App Store.",
  GetXcode: "Get Xcode",
  OpenXcode: "Open Xcode once",
  OpenDetail: "It finishes its own setup the first time it opens.",
  OpenButton: "Open Xcode",
  SelectXcode: "Use Xcode for builds",
  SelectDetail: "Xcode is installed but not in use. Run this in Terminal; it asks for your password:",
  UpdateXcode: (version: string | null) => (version ? `Update Xcode (this Mac has ${version})` : "Update Xcode"),
  UpdateDetail: (engine: string, min: string, max: string) => `Unreal ${engine} builds with Xcode ${min} to ${max}.`,
  UpdateButton: "Open App Store",
  AddXcode: (major: string) => `Add Xcode ${major}`,
  AddDetail: (engine: string, range: XcodeRange, version: string | null) =>
    `Unreal ${engine} builds with Xcode ${range.min} to ${range.max}. Keep Xcode ${version ?? ""} and add Xcode ${majorOf(range.max)} from Apple's downloads: put it in Applications beside Xcode ${majorOf(version ?? "")}; this card then shows the one command to select it.`,
  AddButton: "Open Apple's downloads",
  XcodeReady: (version: string | null) => `Xcode${version ? ` ${version}` : ""} is ready`,
  ReadyDetail: "The agent can add C++ to this game.",
} as const;

const getXcode = (step: XcodeStep, label: string): StepAction => ({ name: GET_XCODE_ACTION, args: { step }, label });

/** A version's first number, as people name an Xcode: "27.9" is Xcode 27. */
const majorOf = (version: string): string => version.split(".")[0] ?? version;

/**
 * The row for an Xcode outside the engine's range: too old, update it from the App Store; too new,
 * keep it and add one the engine builds with from Apple's downloads (the App Store has only the newest).
 */
function unsupportedStep(xcode: XcodeStatus, engine: string): UnrealStep {
  const range = xcode.supported;
  if (xcode.tooNew && range)
    return {
      id: UnrealStepId.AddXcode,
      label: WORDS.AddXcode(majorOf(range.max)),
      detail: WORDS.AddDetail(engine, range, xcode.version),
      done: false,
      action: getXcode(XcodeStep.Downloads, WORDS.AddButton),
    };
  return {
    id: UnrealStepId.UpdateXcode,
    label: WORDS.UpdateXcode(xcode.version),
    detail: range ? WORDS.UpdateDetail(engine, range.min, range.max) : "",
    done: false,
    action: getXcode(XcodeStep.Install, WORDS.UpdateButton),
  };
}

/** The Xcode rows for where Xcode stands; none off a Mac. */
function xcodeSteps(xcode: XcodeStatus, engine: string): UnrealStep[] {
  const installed = xcode.state !== XcodeState.Missing;
  const install: UnrealStep = {
    id: UnrealStepId.InstallXcode,
    label: WORDS.InstallXcode,
    detail: WORDS.InstallDetail,
    done: installed,
    ...(installed ? {} : { action: getXcode(XcodeStep.Install, WORDS.GetXcode) }),
  };
  const open: UnrealStep = {
    id: UnrealStepId.OpenXcode,
    label: WORDS.OpenXcode,
    detail: WORDS.OpenDetail,
    done: false,
    ...(installed ? { action: getXcode(XcodeStep.Open, WORDS.OpenButton) } : {}),
  };
  switch (xcode.state) {
    case XcodeState.NotApplicable:
      return [];
    case XcodeState.Missing:
    case XcodeState.FirstLaunch:
      return [install, open];
    case XcodeState.NotSelected:
      return [
        {
          id: UnrealStepId.SelectXcode,
          label: WORDS.SelectXcode,
          detail: WORDS.SelectDetail,
          done: false,
          command: xcode.command ?? "",
        },
      ];
    case XcodeState.Unsupported:
      return [unsupportedStep(xcode, engine)];
    default:
      return [
        {
          id: UnrealStepId.InstallXcode,
          label: WORDS.XcodeReady(xcode.version),
          detail: WORDS.ReadyDetail,
          done: true,
        },
      ];
  }
}

/**
 * The card for a game whose Unreal project is `project` (its name; null before one is set up), on
 * an engine of version `engine`, with Xcode where `xcode` says.
 */
export function unrealSteps(project: string | null, engine: string, xcode: XcodeStatus): UnrealSteps {
  const setUp: UnrealStep[] = project
    ? [{ id: UnrealStepId.SetUp, label: WORDS.SetUp(engine, project), detail: WORDS.SetUpDetail, done: true }]
    : [];
  const steps = [...setUp, ...xcodeSteps(xcode, engine)];
  const open = steps.filter((step) => !step.done).length;
  return { title: WORDS.Title, intro: open ? WORDS.Intro(open) : WORDS.AllDone, steps, open: open > 0 };
}
