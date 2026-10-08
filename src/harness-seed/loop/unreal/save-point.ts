/**
 * The lead's save points: the editor saves all, the Unreal log's errors new since the last save
 * point are read, the game folder is snapshotted under the lead's label, the hero cameras (the
 * level's `GX_Shot_*` CameraActors, else the player start's view) are captured as thumbnails, and
 * the graph gets a round. Never during a play session, and never two at once. Between turns, a
 * dirty editor with no save point in the turn gets an autosave from the harness.
 *
 * The hero shots and the editor's activity (a play session, unsaved packages) come from the Unreal
 * plugin's harness tools (`LeadPluginTool`). An editor that can't say whether a play session runs
 * is never saved (the save would end it): `save_point` refuses, and the autosave is skipped and
 * the lead told why. While the run's chat is in Plan mode the save is held back (`lead-steps.ts`),
 * so neither makes a snapshot or a save point. A plugin without hero shots gets the player start's
 * view from a play-check.
 */
import { HostMethod } from "../host-methods.ts";
import { isPlainRecord } from "../json.ts";
import { minutes, SECOND_MS } from "../time.ts";
import {
  HERO_CAMERA_PREFIX,
  MAX_HERO_SHOTS,
  type SavePoint,
  type SavePointShot,
  type ShotTone,
  WHOLE_FRAME,
} from "./lead-contract.ts";
import { savePointRound } from "./lead-graph.ts";
import { type Lead, milestoneNow, oneGitWrite, requiredNow, SNAPSHOT_SCOPE, saveLead, why } from "./lead-journal.ts";
import { heldInPlan, unrealTool, unrealWrite } from "./lead-steps.ts";
import { SAVE_POINT_WORDS } from "./lead-prompts.ts";
import { LiveCamera, PartRunEnd, type PlayShot, UnrealLivePluginTool, UnrealLoopTool } from "./live-contract.ts";
import { EDITOR_ACTIVITY_TOOL, type EditorActivity, editorActivityOf } from "./editor-activity.ts";
import { editorAnswers } from "./restore.ts";

/** A save point takes at most this long. */
export const SAVE_POINT_MS = 90 * SECOND_MS;
/** How often a fallback play-check's state is read. */
const RESULT_POLL_MS = 2 * SECOND_MS;
/** How many new log lines a save point keeps. */
const MAX_LOG_LINES = 20;
/** The tone numbers a capture carries, by their names in the plugin's answer. */
const TONE_FIELDS = ["p2", "p98", "mean", "std", "nearStd", "farStd", "saturation", "clipped"] as const;

/**
 * The Unreal plugin's harness tools a save point asks for, by their agent names: the editor's
 * activity (`{pie, dirty}`: a play session runs, how many packages are unsaved) and the hero shots
 * (`{shots: [{name, file, data, tone}]}`: up to `max` CameraActors named with `prefix`, else the
 * player start's view). Never rename a value.
 */
export const LeadPluginTool = {
  EditorActivity: EDITOR_ACTIVITY_TOOL,
  HeroShots: "unreal__hero-shots",
} as const;
export type LeadPluginTool = (typeof LeadPluginTool)[keyof typeof LeadPluginTool];

/** How many unsaved assets a failed save names. */
const NAMED_UNSAVED = 3;

const MESSAGE = {
  Autosave: "Autosave",
  AutosaveSummary: "Saved by Genex: the lead's turn ended with unsaved work.",
  NotSaved: (dirty: readonly string[]) =>
    `the editor's save left ${dirty.length} assets unsaved${dirty.length ? ` (${dirty.slice(0, NAMED_UNSAVED).join(", ")})` : ""}`,
  SkippedPlaying: "a play session runs in the editor, and saving would end it",
  SkippedUnknown: "Unreal can't tell whether the game is playing, and saving would end a play session",
  SkippedPlan: "the chat is in Plan mode, so saves wait until the plan is approved",
  SaveFailed: (why: string) => `the editor's save failed: ${why}`,
  SnapshotFailed: (why: string) => `the snapshot failed: ${why}`,
} as const;

/** What a save point is asked for: its label and summary, and whether the harness asked (an autosave). */
export type SavePointAsk = { label: string; summary: string; auto: boolean };

/** The harness's autosave: the save point it made, why it saved nothing, or null when nothing needed saving. */
export type Autosaved = { point: SavePoint } | { skipped: string } | null;

/** A shot as the plugin hands it back, with its tone numbers when it measured them. */
type HeroShot = PlayShot & { tone?: unknown };

/** Why no save point was made, and whether the chat's Plan mode held it back. */
type Refusal = { refused: string; inPlan?: true };

/** A save point made, or why none was. */
type Made = { point: SavePoint } | Refusal;

/** What the editor is doing now (a play session, unsaved packages), or null when the plugin can't say. */
export async function editorActivity(lead: Lead): Promise<EditorActivity | null> {
  return editorActivityOf(await unrealTool(lead, LeadPluginTool.EditorActivity).catch(() => null));
}

/** Unreal's log since `since` (a byte offset): its new error lines, and where it ends now (null when it can't be read). */
async function readLog(lead: Lead, since: number | null): Promise<{ lines: string[]; offset: number | null }> {
  const args = since === null ? {} : { since };
  const read = await unrealTool(lead, UnrealLivePluginTool.LogErrors, args).catch(() => null);
  if (!isPlainRecord(read)) return { lines: [], offset: null };
  const lines = Array.isArray(read.lines) ? read.lines.filter((line): line is string => typeof line === "string") : [];
  return { lines: since === null ? [] : lines, offset: typeof read.offset === "number" ? read.offset : null };
}

/** Notes where Unreal's log ends now, so the first save point names only the errors the run brought. */
export async function markLog(lead: Lead): Promise<void> {
  lead.journal.logOffset ??= (await readLog(lead, null)).offset;
}

/**
 * Saves the editor's work: why no save point may follow (the chat's Plan mode held the save back,
 * or it failed or left work unsaved), else null.
 */
async function saveAll(lead: Lead): Promise<Refusal | null> {
  try {
    const saved = (await unrealWrite(lead, UnrealLivePluginTool.SaveAll)) as { saved?: unknown; dirty?: unknown };
    const dirty = Array.isArray(saved?.dirty) ? saved.dirty.map(String) : [];
    return saved?.saved === false ? { refused: SAVE_POINT_WORDS.NotSaved(MESSAGE.NotSaved(dirty)) } : null;
  } catch (err) {
    if (heldInPlan(err)) return { refused: SAVE_POINT_WORDS.InPlan, inPlan: true };
    return { refused: SAVE_POINT_WORDS.NotSaved(MESSAGE.SaveFailed(why(err))) };
  }
}

/** A capture's tone numbers when it carries all of them, else null. */
function toneOf(value: unknown): ShotTone | null {
  if (!isPlainRecord(value)) return null;
  const numbers = TONE_FIELDS.map((field) => value[field]);
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return Object.fromEntries(TONE_FIELDS.map((field) => [field, value[field]])) as ShotTone;
}

/** The shots in a plugin answer's list, each with a name and PNG data. */
function shotsIn(list: unknown): HeroShot[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (shot): shot is HeroShot =>
      isPlainRecord(shot) && typeof shot.name === "string" && typeof shot.data === "string" && shot.data !== "",
  );
}

/** The hero cameras' shots from the plugin's own tool, or null when the plugin has none. */
async function pluginHeroShots(lead: Lead): Promise<HeroShot[] | null> {
  try {
    const answer = await unrealWrite(lead, LeadPluginTool.HeroShots, {
      prefix: HERO_CAMERA_PREFIX,
      max: MAX_HERO_SHOTS,
    });
    return isPlainRecord(answer) ? shotsIn(answer.shots) : [];
  } catch {
    return null;
  }
}

/** Waits for a queued play-check until it ends, the save point's time is up or the run stops; its answer, or null. */
async function playedAnswer(lead: Lead, id: string, deadline: number): Promise<unknown> {
  while (lead.clock.now() < deadline && !lead.ctx.cancelled) {
    const run = await unrealTool(lead, UnrealLoopTool.PartResult, { id }).catch(() => null);
    if (isPlainRecord(run) && run.state === PartRunEnd.Done) return run.result;
    if (isPlainRecord(run) && run.state === PartRunEnd.Failed) return null;
    await lead.clock.sleep(RESULT_POLL_MS);
  }
  return null;
}

/** The player start's view from a play of the game, applying nothing: the shot every play-check takes where play starts. */
async function playStartShot(lead: Lead, deadline: number): Promise<HeroShot[]> {
  const queued = await unrealWrite(lead, UnrealLivePluginTool.PlayCheck, { checks: {} }).catch(() => null);
  const id = isPlainRecord(queued) && typeof queued.id === "string" ? queued.id : "";
  const answer = id ? await playedAnswer(lead, id, deadline) : null;
  return isPlainRecord(answer) ? shotsIn(answer.shots).filter((shot) => shot.name === LiveCamera.Spawn) : [];
}

/** One shot as a JPEG run artefact: the PNG saved in the run's folder, then re-encoded whole; its path. */
async function jpegOf(lead: Lead, shot: PlayShot, label: string): Promise<string | null> {
  const { ctx, run } = lead;
  const png = await ctx
    .call(HostMethod.RunArtifact, { runId: run.runId, name: `${label}.png`, base64: shot.data })
    .catch(() => null);
  if (typeof png !== "string") return null;
  const crop = await ctx
    .call(HostMethod.PreviewCrop, { runId: run.runId, path: png, crop: WHOLE_FRAME, label })
    .catch(() => null);
  return crop?.path ? crop.path : null;
}

/** The save point's thumbnails: the hero cameras' shots (else the player start's view), as JPEG run artefacts with their tone numbers. */
async function thumbnailsOf(lead: Lead, round: number, deadline: number): Promise<SavePointShot[]> {
  // A stopped run plays nothing more: without the plugin's hero shots, its last save has none.
  const fallback = () => (lead.ctx.cancelled ? Promise.resolve([]) : playStartShot(lead, deadline));
  const shots = (await pluginHeroShots(lead)) ?? (await fallback());
  const made: SavePointShot[] = [];
  for (const shot of shots.slice(0, MAX_HERO_SHOTS)) {
    const label = `unreal/save-${round}/${shot.name.replace(/[^a-z0-9-]+/gi, "-")}`;
    const path = await jpegOf(lead, shot, label);
    if (path) made.push({ camera: shot.name, path, tone: toneOf(shot.tone) });
  }
  return made;
}

/** A snapshot of the game folder under the save point's label; its id, or why none was made. */
async function snapshotOf(lead: Lead, label: string): Promise<{ id: string } | { refused: string }> {
  const { ctx, run } = lead;
  try {
    const made = await oneGitWrite(lead, () =>
      ctx.call(HostMethod.SnapshotCreate, { scope: SNAPSHOT_SCOPE, reason: label, project: run.project }),
    );
    return { id: made.snapshot_id };
  } catch (err) {
    return { refused: MESSAGE.SnapshotFailed(why(err)) };
  }
}

/** Why no save point can be made now (Unreal doesn't answer, the game plays or can't say), or null when one can. */
async function refusalNow(lead: Lead): Promise<string | null> {
  if (!(await editorAnswers(lead))) return SAVE_POINT_WORDS.NoEditor;
  const activity = await editorActivity(lead);
  if (!activity) return SAVE_POINT_WORDS.CantTell;
  return activity.playing ? SAVE_POINT_WORDS.Playing : null;
}

/** One save point, start to record: save, log, snapshot, thumbnails, the journal and the graph. */
async function makeSavePoint(lead: Lead, ask: SavePointAsk): Promise<Made> {
  const deadline = lead.clock.now() + SAVE_POINT_MS;
  const refused = await refusalNow(lead);
  if (refused) return { refused };
  const unsaved = await saveAll(lead);
  if (unsaved) return unsaved;
  const log = await readLog(lead, lead.journal.logOffset);
  if (log.offset !== null) lead.journal.logOffset = log.offset;
  const snapshot = await snapshotOf(lead, ask.label);
  if ("refused" in snapshot) return snapshot;
  const milestone = milestoneNow(lead.journal);
  const round = milestone.rounds + 1;
  const thumbnails = await thumbnailsOf(lead, lead.journal.savePoints.length + 1, deadline);
  const point: SavePoint = {
    label: ask.label,
    snapshotId: snapshot.id,
    at: lead.clock.now(),
    summary: ask.summary,
    thumbnails,
    milestoneId: milestone.id,
    round,
    auto: ask.auto,
    logErrors: log.lines.slice(0, MAX_LOG_LINES),
  };
  milestone.rounds = round;
  lead.journal.savePoints.push(point);
  await savePointRound(lead, point).catch(() => {});
  await saveLead(lead);
  return { point };
}

/** One save point at a time: another asked while one is under way is refused. */
async function savingOnce(lead: Lead, ask: SavePointAsk): Promise<Made> {
  if (lead.saving) return { refused: SAVE_POINT_WORDS.Busy };
  const running = makeSavePoint(lead, ask);
  lead.saving = running;
  try {
    return await running;
  } finally {
    lead.saving = null;
  }
}

/**
 * One save point, as `save_point` answers it: its snapshot id, the new log errors and the
 * thumbnails' tone numbers, or why none was made (a play session runs or can't be ruled out, or
 * the save failed or the chat is in Plan mode).
 */
export async function savePoint(lead: Lead, ask: SavePointAsk): Promise<string> {
  const made = await savingOnce(lead, ask);
  if ("refused" in made) return SAVE_POINT_WORDS.Refused(made.refused);
  const left = minutes(Math.max(0, lead.softDeadline - lead.clock.now()));
  return SAVE_POINT_WORDS.Answer(made.point, left, requiredNow(lead.journal));
}

/**
 * The harness's save point when the editor holds unsaved work (between turns, at the close): null
 * when Unreal doesn't answer or nothing is unsaved, and skipped with why while a play session runs
 * or the editor can't say whether one does.
 */
export async function autosave(lead: Lead): Promise<Autosaved> {
  if (!(await editorAnswers(lead))) return null;
  const activity = await editorActivity(lead);
  if (activity?.dirty === 0) return null;
  if (!activity) return { skipped: MESSAGE.SkippedUnknown };
  if (activity.playing) return { skipped: MESSAGE.SkippedPlaying };
  const made = await savingOnce(lead, { label: MESSAGE.Autosave, summary: MESSAGE.AutosaveSummary, auto: true });
  if ("point" in made) return made;
  return { skipped: made.inPlan ? MESSAGE.SkippedPlan : made.refused };
}
