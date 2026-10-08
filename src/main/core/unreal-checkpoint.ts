/**
 * The studio's checkpoint tool on an Unreal game. On a web game the session's note lights the
 * user's Reload; an Unreal game lives in its editor, where the note alone kept nothing (a long chat
 * turn once ended with hundreds of unsaved levels and assets while its checkpoint answered "Shown
 * to the user."). Here the editor's unsaved work is saved, never during a play session, and the
 * game folder is snapshotted under the note; the session is told plainly what happened.
 *
 * The editor's activity and the save come from the Unreal plugin's harness tools, which the host
 * runs for the game itself. An editor that can't say what it is doing is never saved (the save
 * would end a play session the person may be in): only what is on disk is snapshotted.
 */
import { errorMessage } from "../../shared/errors.ts";
import { CHECKPOINT_TOOL } from "../../substrate/engines/studio-tool-prompts.ts";
import { isJsonObject } from "../../substrate/fsx.ts";

/**
 * The Unreal plugin's harness tools a checkpoint runs, by their agent names: the editor's activity
 * (`{pie, dirty}`: a play session runs, how many packages are unsaved) and saving all. The harness
 * names them alike (its `LeadPluginTool.EditorActivity`, `UnrealLivePluginTool.SaveAll`). Never
 * rename a value.
 */
export const UnrealCheckpointTool = {
  EditorActivity: "unreal__editor-activity",
  SaveAll: "unreal__save-all",
} as const;
export type UnrealCheckpointTool = (typeof UnrealCheckpointTool)[keyof typeof UnrealCheckpointTool];

/** What a checkpoint needs from the host, for the one game it checkpoints. */
export interface UnrealCheckpointHost {
  /** Runs one of the Unreal plugin's harness tools for the game. */
  tool(name: UnrealCheckpointTool): Promise<unknown>;
  /** Snapshots the game folder, named for `reason`. */
  snapshot(reason: string): Promise<{ snapshot_id: string }>;
  /** Whether the chat is in Plan mode, where a checkpoint changes nothing. */
  planning(): Promise<boolean>;
}

/** How many of the names left unsaved an answer lists. */
const MAX_NAMED_UNSAVED = 3;

/** What the session reads back. Model-facing: it reads these as written. */
const MESSAGE = {
  planning: "The chat is in Plan mode, so nothing was saved and no snapshot was taken.",
  playing:
    "The game is playing in the Unreal editor, so nothing was saved and no snapshot was taken. Stop the play session, then call checkpoint again.",
  clean: "Unreal had nothing unsaved.",
  unknown: "Genex couldn't tell whether the game is playing in Unreal, so nothing was saved there.",
  saved: (count: number) => `Saved ${count} unsaved ${count === 1 ? "file" : "files"} in Unreal.`,
  notSaved: (why: string) => `Unreal's work was not saved: ${why}`,
  leftUnsaved: (names: readonly string[]) =>
    `${names.length} ${names.length === 1 ? "file" : "files"} stayed unsaved in Unreal (${names.slice(0, MAX_NAMED_UNSAVED).join(", ")}).`,
  noSaveAnswer: "the editor didn't say what it saved.",
  snapshot: (id: string) => `Took snapshot ${id} of the game folder.`,
  noSnapshot: (why: string) => `No snapshot was taken: ${why}`,
  reason: (note: string) => `checkpoint: ${note}`,
} as const;

/** What the editor is doing: a play session runs, and how many packages are unsaved. */
type EditorActivity = { playing: boolean; dirty: number };

/** The editor's activity, or null when the plugin can't say both. */
async function activityOf(host: UnrealCheckpointHost): Promise<EditorActivity | null> {
  const read = await host.tool(UnrealCheckpointTool.EditorActivity).catch(() => null);
  if (!isJsonObject(read) || typeof read.pie !== "boolean") return null;
  if (typeof read.dirty !== "number" || !Number.isFinite(read.dirty)) return null;
  return { playing: read.pie, dirty: read.dirty };
}

/** A failure's message, ending as a sentence does. */
function sentence(err: unknown): string {
  const text = String(errorMessage(err)).trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Saves the editor's work: what the session is told about the save. */
async function save(host: UnrealCheckpointHost, dirty: number): Promise<string> {
  if (dirty === 0) return MESSAGE.clean;
  let answer: unknown;
  try {
    answer = await host.tool(UnrealCheckpointTool.SaveAll);
  } catch (err) {
    return MESSAGE.notSaved(sentence(err));
  }
  if (!isJsonObject(answer) || typeof answer.saved !== "boolean") return MESSAGE.notSaved(MESSAGE.noSaveAnswer);
  const left = Array.isArray(answer.dirty) ? answer.dirty.map(String) : [];
  if (!answer.saved || left.length) return MESSAGE.leftUnsaved(left);
  return MESSAGE.saved(dirty);
}

/** Snapshots the game folder: what the session is told about the snapshot. */
async function snapshot(host: UnrealCheckpointHost, note: string): Promise<string> {
  try {
    return MESSAGE.snapshot((await host.snapshot(MESSAGE.reason(note))).snapshot_id);
  } catch (err) {
    return MESSAGE.noSnapshot(sentence(err));
  }
}

/**
 * The checkpoint on an Unreal game: its editor's work saved and its folder snapshotted under the
 * note, answered as the session reads it. A failed save, or an editor that can't say what it is
 * doing, still snapshots what is on disk; nothing here throws.
 */
export async function unrealCheckpoint(host: UnrealCheckpointHost, note: string): Promise<string> {
  if (await host.planning().catch(() => false)) return MESSAGE.planning;
  const activity = await activityOf(host);
  if (activity?.playing) return MESSAGE.playing;
  const saved = activity ? await save(host, activity.dirty) : MESSAGE.unknown;
  return [saved, await snapshot(host, note), CHECKPOINT_TOOL.reply].join(" ");
}
