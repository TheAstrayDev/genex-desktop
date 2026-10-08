/**
 * The Publish dialog's view of Genex's publish record: where the game is (not online, draft only,
 * public), the running attempt's steps, and the one press the next step needs. What Publish asks
 * for first (Genex installed and on, then an account), whether Studio puts Publish on the strip
 * itself and which games get none (an Unreal game) are decided here too. Pure, so the dialog only
 * draws it.
 */
import {
  GENEX_PLUGIN_ID,
  GENEX_PUBLISH_PANEL,
  GenexAction,
  GenexHostedStatus,
  GenexPublishJobState,
  GenexPublishKind,
  GenexPublishPhase,
  GenexPublishStatusOperation,
  type GenexPublishJob,
  type GenexPublishState,
} from "../../../../shared/genex.ts";
import { type PluginToolbarEntry, toolbarItems } from "../../../../shared/plugin-toolbar.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import { type FactRef, type FolderHolds, servedAsWebGame } from "../../../../shared/project-facts.ts";
import { GENEX_WORDS } from "../../../words.ts";

const WORDS = GENEX_WORDS.publish;

/** Where the game is on Genex. */
export const PublishStage = { None: "none", Draft: "draft", Public: "public" } as const;
export type PublishStage = (typeof PublishStage)[keyof typeof PublishStage];

/** A step of a publish attempt as the progress bar names it. */
export const GenexPublishStep = {
  Export: "export",
  Create: "create",
  Upload: "upload",
  Public: "public",
  List: "list",
  Check: "check",
} as const;
export type GenexPublishStep = (typeof GenexPublishStep)[keyof typeof GenexPublishStep];

/** Which step each phase belongs to; the finished phases belong to none. */
const PHASE_STEP: Partial<Record<GenexPublishPhase, GenexPublishStep>> = {
  [GenexPublishPhase.Checking]: GenexPublishStep.Export,
  [GenexPublishPhase.Exporting]: GenexPublishStep.Export,
  [GenexPublishPhase.CreatingProject]: GenexPublishStep.Create,
  [GenexPublishPhase.Uploading]: GenexPublishStep.Upload,
  [GenexPublishPhase.Promoting]: GenexPublishStep.Public,
  [GenexPublishPhase.Listing]: GenexPublishStep.List,
  [GenexPublishPhase.VerifyingDeployment]: GenexPublishStep.Check,
};

/** Where a step stands on the progress bar. */
export const StepState = { Done: "done", Current: "current", Next: "next" } as const;
export type StepState = (typeof StepState)[keyof typeof StepState];

/** One step on the progress bar. */
export interface StepView {
  step: GenexPublishStep;
  label: string;
  state: StepState;
}

/** A button the dialog offers: its words, the action it runs, and its aria-label (kept for smoke checks). */
export interface PublishButton {
  label: string;
  action: string;
  args?: Record<string, unknown>;
  ariaLabel: string;
}

/** Everything the dialog draws. */
export interface PublishView {
  stage: PublishStage;
  intro: string;
  running: boolean;
  unresolved: boolean;
  phase: string;
  startedAt: string | null;
  steps: StepView[];
  primary: PublishButton;
  /** Check again, allow a new upload, review terms: only when that is what is needed. */
  extra: PublishButton[];
  canPublish: boolean;
  problems: string[];
  notes: string[];
}

export const isListed = (state: GenexPublishState): boolean => state.status === GenexHostedStatus.Published;

/** Whether an attempt is still going, including one whose upload outcome is not known yet. */
export const isLive = (job: GenexPublishJob | undefined): boolean =>
  job?.state === GenexPublishJobState.Running || job?.state === GenexPublishJobState.Unresolved;

/** The steps an attempt of this kind takes from where the game is: listed games update and promote, new ones list once. */
export function publishSteps(job: GenexPublishJob, state: GenexPublishState): GenexPublishStep[] {
  const created = job.phase !== GenexPublishPhase.CreatingProject && Boolean(state.slug);
  const first = created ? [GenexPublishStep.Export] : [GenexPublishStep.Export, GenexPublishStep.Create];
  const checks = job.kind === GenexPublishKind.Draft || job.deployment !== undefined;
  const upload = uploadSteps(job, state);
  return [...first, ...upload, ...(checks ? [GenexPublishStep.Check] : [])];
}

function uploadSteps(job: GenexPublishJob, state: GenexPublishState): GenexPublishStep[] {
  if (job.kind === GenexPublishKind.Draft) return [GenexPublishStep.Upload];
  return isListed(state) || job.phase === GenexPublishPhase.Promoting
    ? [GenexPublishStep.Upload, GenexPublishStep.Public]
    : [GenexPublishStep.List];
}

/** The progress bar: the steps before the running one done, the running one current. */
function stepViews(job: GenexPublishJob | undefined, state: GenexPublishState, running: boolean): StepView[] {
  if (!job || !running) return [];
  const steps = publishSteps(job, state);
  const current = PHASE_STEP[job.phase];
  const at = current ? steps.indexOf(current) : -1;
  return steps.map((step, index) => ({
    step,
    label: WORDS.step[step],
    state: (index < at && StepState.Done) || (index === at && StepState.Current) || StepState.Next,
  }));
}

/** Where the game is: public once listed, a draft once it has a page, else not online. */
function stageOf(state: GenexPublishState): PublishStage {
  if (isListed(state)) return PublishStage.Public;
  return state.slug ? PublishStage.Draft : PublishStage.None;
}

const INTRO: Record<PublishStage, string> = {
  none: WORDS.intro,
  draft: WORDS.draftOnly,
  public: WORDS.published,
};

/** Check again, allow a new upload, and review terms, when each is what the attempt or the account needs. */
function extraButtons(state: GenexPublishState, job: GenexPublishJob | undefined): PublishButton[] {
  const unresolved = job?.phase === GenexPublishPhase.Unresolved;
  const extra: PublishButton[] = [];
  if (unresolved) {
    extra.push({
      label: WORDS.checkAgain,
      action: GenexAction.PublishStatus,
      args: { operation: GenexPublishStatusOperation.Check },
      ariaLabel: "Check deployment availability without uploading",
    });
    extra.push({
      label: WORDS.allowUpload,
      action: GenexAction.PublishAllowUpload,
      args: { jobId: job?.id },
      ariaLabel: "Allow a new upload after checking the deployment page",
    });
  }
  if (state.terms?.accepted === false)
    extra.push({ label: WORDS.reviewTerms, action: GenexAction.Terms, ariaLabel: WORDS.reviewTerms });
  return extra;
}

/** What went wrong and what else to know, in the order a person should read it. */
function messages(state: GenexPublishState, job: GenexPublishJob | undefined) {
  const problems: string[] = [];
  if (state.terms?.accepted === false) problems.push(WORDS.termsNote);
  const failure = job?.error ?? state.lastError;
  if (failure) problems.push(failure);
  const unknown = job?.phase === GenexPublishPhase.Unresolved && !job.uploadedAt;
  const notes = [...(state.warnings ?? []), ...(unknown ? [WORDS.unknownUpload] : [])];
  if (job?.checkError) notes.push(job.checkError);
  return { problems, notes };
}

/** The dialog's view of a publish record. */
export function publishView(state: GenexPublishState): PublishView {
  const job = state.job;
  const live = isLive(job);
  const unresolved = job?.phase === GenexPublishPhase.Unresolved;
  const running = live && !unresolved;
  const stage = stageOf(state);
  const listed = stage === PublishStage.Public;
  return {
    stage,
    intro: INTRO[stage],
    running,
    unresolved,
    phase: job && live ? WORDS.phase[job.phase] : "",
    startedAt: running && job ? job.startedAt : null,
    steps: stepViews(job, state, running),
    primary: {
      label: listed ? WORDS.updatePublic : WORDS.publish,
      action: GenexAction.PublishGallery,
      ariaLabel: "Publish this game on Genex",
    },
    extra: extraButtons(state, job),
    canPublish: state.connected && !live,
    ...messages(state, job),
  };
}

/** What Publish asks for before it can publish, in this order. */
export const PublishGate = { Install: "install", TurnOn: "turn-on", Connect: "connect", Ready: "ready" } as const;
export type PublishGate = (typeof PublishGate)[keyof typeof PublishGate];

/**
 * What stands between the person and Publish: Genex installed (`genex` missing or removed), turned
 * on, then a connected account. A record not read yet asks for nothing.
 */
export function publishGate(
  genex: Pick<PluginInfo, "enabled" | "removed"> | undefined,
  connected: boolean | undefined,
): PublishGate {
  if (!genex || genex.removed) return PublishGate.Install;
  if (!genex.enabled) return PublishGate.TurnOn;
  return connected === false ? PublishGate.Connect : PublishGate.Ready;
}

/** Whether a stage-strip button is Genex's Publish. */
export const isGenexPublish = (entry: PluginToolbarEntry): boolean =>
  entry.plugin.manifest.id === GENEX_PLUGIN_ID &&
  entry.item.target.kind === "panel" &&
  entry.item.target.id === GENEX_PUBLISH_PANEL;

/**
 * Whether Publish can put a game holding these facts (and, with none, `holds`) on Genex. Publish uploads the game folder as a
 * web game, so only a game served as one at its root has Publish; an Unreal game's folder holds an
 * Unreal project and no web build, and any other kind of project none either. The host refuses the
 * same games (`main/core/genex-publish.ts`).
 */
const publishable = (facts: readonly FactRef[], holds: FolderHolds | undefined): boolean =>
  servedAsWebGame({ facts, holds });

/**
 * The plugin buttons on the open game's stage strip: every enabled plugin's, less Genex's Publish
 * for a game Publish can't put online (`publishable`).
 */
export function stripEntries(
  plugins: readonly PluginInfo[],
  project: string | null,
  facts: readonly FactRef[],
  holds?: FolderHolds,
): PluginToolbarEntry[] {
  const entries = toolbarItems(plugins, project);
  return publishable(facts, holds) ? entries : entries.filter((entry) => !isGenexPublish(entry));
}

/**
 * Whether Studio puts Publish on the strip itself: a web game is open and Genex, off or gone, adds
 * none.
 */
export function studioPublishButton(
  plugins: readonly PluginInfo[],
  project: string | null,
  facts: readonly FactRef[],
  holds?: FolderHolds,
): boolean {
  return Boolean(project) && publishable(facts, holds) && !toolbarItems(plugins, project).some(isGenexPublish);
}
