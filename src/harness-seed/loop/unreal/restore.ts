/**
 * Restores and restarts of the user's Unreal editor for the Unreal lead, always between turns and
 * always cold: an in-place restore (`reset --hard` under a running editor) left stale packages in
 * the open editor, and a hot-reloaded library outlives a rollback. So Genex saves what the editor
 * holds unless it is gone, ends this project's editor, makes sure it no longer answers, restores the
 * save point's snapshot (the host's own rescue snapshot keeps what was there for Rewind), and has
 * the plugin reopen Unreal, which builds the game's C++ module first. A restart (a crash reopened
 * in place, the lead's `rebuild_unreal`) is the same without the restore. Unsaved work is never
 * ended: a save that fails leaves Unreal open, and nothing is restored; an editor that is only busy
 * (its process runs, answering nothing: `editor-life.ts`) is waited for, never ended unsaved.
 * `sourceStamp` is what Unreal was last built from.
 */
import { HostMethod } from "../host-methods.ts";
import { MINUTE_MS, SECOND_MS } from "../time.ts";
import { ReopenEnd, reopenEditor } from "./editor-crash.ts";
import { EditorLife, editorLife } from "./editor-life.ts";
import { UnrealLivePluginTool, UnrealLoopTool } from "./live-contract.ts";
import { type Lead, oneGitWrite, why } from "./lead-journal.ts";
import { unrealTool, unrealWrite } from "./lead-steps.ts";

/**
 * The game's C++ source as one stamp: every file's checksum, size and path, sorted, then their own
 * checksum (POSIX `cksum`); a game without Source has the stamp of nothing.
 */
const SOURCE_STAMP_COMMAND = "{ find unreal/Source -type f -exec cksum {} + 2>/dev/null || true; } | sort | cksum";
/**
 * How long a restart waits for a busy editor to answer again before it gives up, leaving it open: a
 * build script may hold the game thread for four minutes.
 */
const BUSY_WAIT_MS = 5 * MINUTE_MS;
const BUSY_POLL_MS = 15 * SECOND_MS;
/** How many unsaved packages a failed save names. */
const NAMED_UNSAVED = 3;

const MESSAGE = {
  StampLabel: "unreal source stamp",
  NotSaved: (why: string) => `Genex couldn't save Unreal's work (${why}), so it left Unreal open`,
  Busy: "Unreal stayed busy and answered nothing",
  Unsaved: (dirty: readonly string[]) =>
    dirty.length ? `${dirty.slice(0, NAMED_UNSAVED).join(", ")} stayed unsaved` : "the save reported nothing saved",
  NotEnded: (why: string) => `Unreal couldn't be closed for the restore (${why})`,
  StillAnswers: "it still answers after Genex ended it",
  NotRestored: (label: string, why: string) => `'${label}' couldn't be restored (${why})`,
  TimeUp: "the run's time ran out while Unreal reopened",
  NotReopened: (why: string) => `the Unreal plugin didn't reopen Unreal (${why})`,
  NoReason: "no reason given",
} as const;

/** Why a restore or restart failed: the work couldn't be saved (Unreal left open), Unreal didn't close, or the rest. */
export const RestoreFailure = {
  NotSaved: "not-saved",
  NotEnded: "not-ended",
  NotRestored: "not-restored",
  NotReopened: "not-reopened",
} as const;
export type RestoreFailure = (typeof RestoreFailure)[keyof typeof RestoreFailure];

/** How a restore or restart ended: Unreal answers again on the restored folder, or why not. */
export type RestoreOutcome = { ok: true } | { ok: false; failure: RestoreFailure; why: string };

/**
 * What an editor restart needs from the run: its host and game, its clock and last deadline, and
 * where it records what Unreal was built from. The lead is one.
 */
export type EditorRun = Pick<Lead, "ctx" | "run" | "threadId" | "clock" | "finalDeadline"> & {
  journal: { builtStamp: string | null };
};

const failed = (failure: RestoreFailure, reason: string): RestoreOutcome => ({ ok: false, failure, why: reason });

/** What Unreal was last built from: the stamp of `unreal/Source`, or null when it can't be read. */
export async function sourceStamp(lead: EditorRun): Promise<string | null> {
  const { ctx, run } = lead;
  const command = SOURCE_STAMP_COMMAND;
  const answer = await ctx.call(HostMethod.RunExec, { command, project: run.project, label: MESSAGE.StampLabel });
  return answer?.code === 0 ? String(answer.stdout).trim() : null;
}

/** Whether the game's Unreal answers now, as the plugin's `editor-state` says; null when the plugin couldn't say. */
async function editorReading(lead: EditorRun): Promise<boolean | null> {
  const state = await unrealTool(lead, UnrealLoopTool.EditorState).catch(() => null);
  const answering = (state as { answering?: unknown } | null)?.answering;
  return typeof answering === "boolean" ? answering : null;
}

/** Whether the game's Unreal answers now. */
export async function editorAnswers(lead: EditorRun): Promise<boolean> {
  return (await editorReading(lead)) === true;
}

/**
 * Whether the game's Unreal is gone: it answers nothing and no editor process of the project runs,
 * or the plugin can't tell (then nothing could save its work either). One answer, or its process
 * running, says it is there.
 */
export async function editorGone(lead: EditorRun): Promise<boolean> {
  const life = await editorLife(lead);
  return life === EditorLife.Gone || life === EditorLife.Unknown;
}

/** Where Unreal stands once a busy editor answers again, or {@link BUSY_WAIT_MS} has gone by. */
async function lifeAfterBusy(lead: EditorRun): Promise<EditorLife> {
  const ends = lead.clock.now() + BUSY_WAIT_MS;
  let life = await editorLife(lead);
  while (life === EditorLife.Busy && lead.clock.now() < ends && !lead.ctx.cancelled) {
    await lead.clock.sleep(BUSY_POLL_MS);
    life = await editorLife(lead);
  }
  return life;
}

/**
 * Why the editor's work isn't all saved, or null when it is: the save was refused or failed, said
 * it saved nothing, or left packages unsaved. The plugin's `save-all` stops a play session first.
 */
export async function unsavedWork(lead: EditorRun): Promise<string | null> {
  try {
    const saved = (await unrealWrite(lead, UnrealLivePluginTool.SaveAll)) as { saved?: unknown; dirty?: unknown };
    const dirty = Array.isArray(saved?.dirty) ? saved.dirty.map(String) : [];
    return saved?.saved === false || dirty.length > 0 ? MESSAGE.Unsaved(dirty) : null;
  } catch (err) {
    return why(err);
  }
}

/**
 * Closes the game's Unreal for a restart: its work saved unless it is gone (a save that fails leaves
 * it open), the editor ended, and then no longer answering. A busy editor is waited for, and one
 * that stays busy is left open with its work: nothing ends an editor it couldn't save unless its
 * process is gone. An editor that still answers was never closed (no process of it found, or
 * another way in), and nothing may be restored under it.
 */
export async function closeEditor(lead: EditorRun): Promise<RestoreOutcome> {
  const life = await lifeAfterBusy(lead);
  if (life === EditorLife.Busy) return failed(RestoreFailure.NotSaved, MESSAGE.NotSaved(MESSAGE.Busy));
  if (life === EditorLife.Answers) {
    const unsaved = await unsavedWork(lead);
    if (unsaved) return failed(RestoreFailure.NotSaved, MESSAGE.NotSaved(unsaved));
  }
  try {
    await unrealWrite(lead, UnrealLivePluginTool.EndEditor);
  } catch (err) {
    return failed(RestoreFailure.NotEnded, MESSAGE.NotEnded(why(err)));
  }
  if (await editorAnswers(lead)) return failed(RestoreFailure.NotEnded, MESSAGE.NotEnded(MESSAGE.StillAnswers));
  return { ok: true };
}

/** Whether `reopen-editor` answered as the plugin does: it started reopening, or Unreal already answers. */
function reopening(answer: unknown): boolean {
  const said = (answer ?? {}) as { started?: unknown; answering?: unknown };
  return said.started === true || said.answering === true;
}

/** Has the plugin reopen Unreal and waits until it answers (unless `wait` is off: a stop does not wait). */
async function reopen(lead: EditorRun, wait: boolean): Promise<RestoreOutcome> {
  let started: unknown;
  try {
    started = await unrealWrite(lead, UnrealLoopTool.ReopenEditor);
  } catch (err) {
    return failed(RestoreFailure.NotReopened, MESSAGE.NotReopened(why(err)));
  }
  if (!reopening(started)) return failed(RestoreFailure.NotReopened, MESSAGE.NotReopened(MESSAGE.NoReason));
  const reopened = await reopenEditor({
    reopen: async () => started,
    state: () => unrealTool(lead, UnrealLoopTool.EditorState),
    now: () => lead.clock.now(),
    sleep: (ms) => lead.clock.sleep(ms),
    stopped: () => !wait,
    deadline: lead.finalDeadline,
  });
  if (reopened.end === ReopenEnd.Failed) return failed(RestoreFailure.NotReopened, reopened.why);
  if (reopened.end === ReopenEnd.TimeUp) return failed(RestoreFailure.NotReopened, MESSAGE.TimeUp);
  return { ok: true };
}

/** Restores the game folder to a kept snapshot while Unreal is closed. */
async function restoreSnapshot(lead: EditorRun, snapshot: { id: string; label: string }): Promise<RestoreOutcome> {
  const { ctx, run } = lead;
  const params = { snapshotId: snapshot.id, project: run.project, reason: snapshot.label };
  const restored = await oneGitWrite(lead, () => ctx.call(HostMethod.SnapshotRestore, params)).catch((err: unknown) =>
    why(err),
  );
  if (restored === true) return { ok: true };
  const reason = typeof restored === "string" ? restored : "";
  return failed(RestoreFailure.NotRestored, MESSAGE.NotRestored(snapshot.label, reason));
}

/**
 * The editor's cold restart: the editor closed (`closeEditor`: nothing more happens when its work
 * couldn't be saved or it still answers), the folder restored to `snapshot` when one is given, and
 * Unreal reopened (and built) on it. Records what it was built from. Never under a running turn:
 * the caller runs it between turns.
 */
export async function coldRestore(
  lead: EditorRun,
  options: { snapshot: { id: string; label: string } | null; wait?: boolean },
): Promise<RestoreOutcome> {
  const closed = await closeEditor(lead);
  if (!closed.ok) return closed;
  const restored = options.snapshot ? await restoreSnapshot(lead, options.snapshot) : { ok: true as const };
  const reopened = await reopen(lead, options.wait !== false);
  lead.journal.builtStamp = await sourceStamp(lead).catch(() => null);
  return restored.ok ? reopened : restored;
}
