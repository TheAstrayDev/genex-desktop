/**
 * The studio's checkpoint tool on an Unreal game makes a real checkpoint. On a web game it lights
 * the user's Reload with the session's note; on an Unreal game the note alone kept nothing: a long
 * chat turn once ended with hundreds of unsaved levels and assets while its checkpoint answered
 * "Shown to the user." There the host saves the editor's work (never during a play session) and
 * snapshots the game folder, and the tool answers with what it did. Both engines' tools answer the
 * host's words; only the chat's own session on an Unreal game, in its folder, gets them.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { LeadPluginTool } from "../../src/harness-seed/loop/unreal/save-point.ts";
import { UnrealLivePluginTool } from "../../src/harness-seed/loop/unreal/live-contract.ts";
import { UnrealCheckpointTool, unrealCheckpoint } from "../../src/main/core/unreal-checkpoint.ts";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { PluginToolAudience } from "../../src/shared/plugins.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { CodexEngine } from "../../src/substrate/engines/codex.ts";
import { writeEngineBinding } from "../../src/substrate/game-engine-binding.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { scriptedClaude } from "../helpers/scripted-claude.ts";
import { scriptedCodex } from "../helpers/scripted-codex.ts";
import { tmpDir } from "../helpers/tmp.ts";

// An engine resolves its login homes the moment it is built: these get tmp homes of their own.
delete process.env.CLAUDE_CONFIG_DIR;

const NOTE = "first light on the rails";
const HOST_ANSWER = "Saved 3 unsaved files in Unreal. Took snapshot snap_1 of the game folder. Shown to the user.";

/** A host checkpoint that keeps each note it is handed and answers {@link HOST_ANSWER}. */
function answering(notes: string[]): (note: string) => Promise<string> {
  return async (note) => {
    notes.push(note);
    return HOST_ANSWER;
  };
}

describe("the checkpoint tool", () => {
  async function claude(queryFn: never): Promise<ClaudeCodeEngine> {
    const root = await tmpDir("checkpoint-claude-");
    const home = path.join(root, "claude-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    return new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "none"),
      queryFn,
    });
  }

  async function codex(execFn: never): Promise<CodexEngine> {
    const root = await tmpDir("checkpoint-codex-");
    const home = path.join(root, "codex-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "auth.json"), "{}");
    return new CodexEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "none"),
      executable: "/fake/codex",
      authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
      execFn,
    });
  }

  it("on Claude Code answers what the host's checkpoint answers, and only shows the note without one", async () => {
    const notes: string[] = [];
    const script = scriptedClaude([{ tool: "checkpoint", args: { note: NOTE } }]);
    const engine = await claude(script.queryFn);
    const cwd = await tmpDir("checkpoint-claude-run-");
    await engine.delegate({ prompt: "build", cwd, onCheckpoint: answering(notes) });
    assert.deepEqual(notes, [NOTE]);
    assert.equal(script.calls[0]?.text, HOST_ANSWER);
    assert.equal(script.calls[0]?.isError, false);

    const plain = scriptedClaude([{ tool: "checkpoint", args: { note: NOTE } }]);
    await (await claude(plain.queryFn)).delegate({ prompt: "build", cwd });
    assert.equal(plain.calls[0]?.text, "Shown to the user.");
  });

  it("on Claude Code reports a checkpoint that failed as failed, and the session goes on", async () => {
    const script = scriptedClaude([{ tool: "checkpoint", args: { note: NOTE } }]);
    const engine = await claude(script.queryFn);
    const result = await engine.delegate({
      prompt: "build",
      cwd: await tmpDir("checkpoint-claude-run-"),
      onCheckpoint: async () => {
        throw new Error("the game folder is gone");
      },
    });
    assert.equal(script.calls[0]?.isError, true);
    assert.match(script.calls[0]?.text ?? "", /the game folder is gone/);
    assert.equal(result.ok, true);
  });

  it("on Codex answers what the host's checkpoint answers", async () => {
    const notes: string[] = [];
    const script = scriptedCodex([{ tool: "checkpoint", args: { note: NOTE } }]);
    const engine = await codex(script.fn as never);
    await engine.delegate({
      prompt: "build",
      cwd: await tmpDir("checkpoint-codex-run-"),
      onCheckpoint: answering(notes),
    });
    assert.deepEqual(notes, [NOTE]);
    assert.match(script.seen[0]?.stdout ?? "", /Took snapshot snap_1/);
  });
});

/** What a checkpoint did: the plugin tools it ran and the snapshots it took. */
interface Done {
  answer: string;
  ran: string[];
  snapshots: string[];
}

/** One checkpoint against a stand-in plugin answering `answers` (a thrown Error is a failed tool). */
async function checkpointWith(
  answers: Partial<Record<UnrealCheckpointTool, unknown>>,
  options: { planning?: boolean; snapshotFails?: boolean } = {},
): Promise<Done> {
  const ran: string[] = [];
  const snapshots: string[] = [];
  const answer = await unrealCheckpoint(
    {
      tool: async (name) => {
        ran.push(name);
        const value = answers[name];
        if (value instanceof Error) throw value;
        return value;
      },
      snapshot: async (reason) => {
        if (options.snapshotFails) throw new Error("git is busy");
        snapshots.push(reason);
        return { snapshot_id: `snap_${snapshots.length}` };
      },
      planning: async () => options.planning === true,
    },
    NOTE,
  );
  return { answer, ran, snapshots };
}

describe("an Unreal game's checkpoint", () => {
  const { EditorActivity, SaveAll } = UnrealCheckpointTool;
  const SAVED = { saved: true, dirty: [], ms: 40 };

  it("names the Unreal plugin's own tools, as the harness names them", () => {
    assert.equal(EditorActivity, LeadPluginTool.EditorActivity);
    assert.equal(SaveAll, UnrealLivePluginTool.SaveAll);
  });

  it("saves the editor's unsaved work, then snapshots the game folder named for the note", async () => {
    const done = await checkpointWith({ [EditorActivity]: { pie: false, dirty: 3 }, [SaveAll]: SAVED });
    assert.deepEqual(done.ran, [EditorActivity, SaveAll]);
    assert.equal(done.snapshots.length, 1);
    assert.match(done.snapshots[0] ?? "", new RegExp(NOTE));
    assert.match(done.answer, /Saved 3 unsaved files in Unreal/);
    assert.match(done.answer, /snap_1/);
    assert.match(done.answer, /Shown to the user\.$/);
  });

  it("never saves during a play session, and takes no snapshot then", async () => {
    const done = await checkpointWith({ [EditorActivity]: { pie: true, dirty: 3 }, [SaveAll]: SAVED });
    assert.deepEqual(done.ran, [EditorActivity]);
    assert.deepEqual(done.snapshots, []);
    assert.match(done.answer, /playing/);
    assert.match(done.answer, /call checkpoint again/);
  });

  it("with nothing unsaved, saves nothing and still snapshots", async () => {
    const done = await checkpointWith({ [EditorActivity]: { pie: false, dirty: 0 } });
    assert.deepEqual(done.ran, [EditorActivity]);
    assert.equal(done.snapshots.length, 1);
    assert.match(done.answer, /nothing unsaved/);
  });

  it("never saves an editor that can't say what it is doing, and snapshots what is on disk", async () => {
    for (const activity of [null, "busy", { pie: "no", dirty: 2 }, { pie: false }, new Error("no such tool")]) {
      const done = await checkpointWith({ [EditorActivity]: activity, [SaveAll]: SAVED });
      const label = JSON.stringify(activity);
      assert.deepEqual(done.ran, [EditorActivity], label);
      assert.equal(done.snapshots.length, 1, label);
      assert.match(done.answer, /couldn't tell whether the game is playing/, label);
    }
  });

  it("still snapshots what is on disk when the save fails or leaves work unsaved, and says so", async () => {
    const failed = await checkpointWith({
      [EditorActivity]: { pie: false, dirty: 2 },
      [SaveAll]: new Error("This game's Unreal isn't answering, so Genex saved nothing."),
    });
    assert.equal(failed.snapshots.length, 1);
    assert.match(failed.answer, /not saved: This game's Unreal isn't answering/);
    const partial = await checkpointWith({
      [EditorActivity]: { pie: false, dirty: 2 },
      [SaveAll]: { saved: false, dirty: ["/Game/Maps/Yard", "/Game/Kit/Rail"], ms: 10 },
    });
    assert.equal(partial.snapshots.length, 1);
    assert.match(partial.answer, /2 files stayed unsaved in Unreal \(\/Game\/Maps\/Yard, \/Game\/Kit\/Rail\)/);
  });

  it("answers a snapshot that failed instead of throwing", async () => {
    const done = await checkpointWith(
      { [EditorActivity]: { pie: false, dirty: 1 }, [SaveAll]: SAVED },
      { snapshotFails: true },
    );
    assert.match(done.answer, /No snapshot was taken: git is busy/);
  });

  it("does nothing while the chat is in Plan mode", async () => {
    const done = await checkpointWith(
      { [EditorActivity]: { pie: false, dirty: 3 }, [SaveAll]: SAVED },
      { planning: true },
    );
    assert.deepEqual(done.ran, []);
    assert.deepEqual(done.snapshots, []);
    assert.match(done.answer, /Plan mode/);
  });
});

describe("which sessions get the real checkpoint", () => {
  const lites: CoreLite[] = [];
  after(async () => {
    for (const lite of lites) await lite.close();
  });

  /** A core with an Unreal game (linked to a real `.uproject`) and a web game; the engine checkpoints once. */
  async function world() {
    const lite = await coreLite({ gamesRoot: await realpath(await tmpDir("checkpoint-games-")) });
    lites.push(lite);
    const { core } = lite;
    const seen: Array<{ request: DelegateRequest; answer: string | null }> = [];
    core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        const answer = request.onCheckpoint ? await request.onCheckpoint(NOTE) : null;
        seen.push({ request, answer });
        return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    const ran: string[] = [];
    const callers: unknown[] = [];
    core.plugins.tool = (async (name: string, _args: unknown, _binding: unknown, _signal: unknown, caller: unknown) => {
      ran.push(name);
      callers.push(caller);
      if (name === UnrealCheckpointTool.EditorActivity) return { pie: false, dirty: 2 };
      return { saved: true, dirty: [], ms: 5 };
    }) as typeof core.plugins.tool;
    const unreal = await core.games.scaffold("rail-yard");
    const web = await core.games.scaffold("pond");
    const projects = await realpath(await tmpDir("checkpoint-projects-"));
    await mkdir(path.join(projects, "RailYard"));
    const uproject = path.join(projects, "RailYard", "RailYard.uproject");
    await writeFile(uproject, '{"FileVersion":3}\n');
    await writeEngineBinding(unreal.dir, uproject);
    const api = core.api() as unknown as Record<"engine.delegate", (params: unknown) => Promise<unknown>>;
    const turn = async (game: { name: string }, extra: Record<string, unknown> = {}) => {
      const threadId = await core.threadForGame(game.name);
      await api["engine.delegate"]({ engine: "claude-code", prompt: "Build", project: game.name, threadId, ...extra });
      const last = seen.at(-1);
      assert.ok(last);
      return last;
    };
    return { core, unreal, web, turn, ran, callers };
  }

  it("the chat's own session on an Unreal game saves and snapshots its game", async () => {
    const { core, unreal, turn, ran, callers } = await world();
    const { answer } = await turn(unreal);
    assert.deepEqual(ran, [UnrealCheckpointTool.EditorActivity, UnrealCheckpointTool.SaveAll]);
    // Both are tools the plugin keeps for the harness: the registry runs them for no other caller.
    assert.deepEqual(callers, [PluginToolAudience.Harness, PluginToolAudience.Harness]);
    assert.match(answer ?? "", /Saved 2 unsaved files in Unreal/);
    const snapshot = core.snapshotIndex.all().find((s) => s.reason.includes(NOTE));
    assert.ok(snapshot, "a snapshot names the note");
    assert.equal(snapshot.scope, SnapshotScope.Game);
    const log = await readFile(path.join(unreal.dir, ".git", "logs", "HEAD"), "utf8");
    assert.match(log, new RegExp(snapshot.snapshot_id), "the game folder holds the snapshot's commit");
  });

  it("a web game's, a worktree's and a run's sessions only show the note", async () => {
    const { core, unreal, web, turn, ran } = await world();
    const worktree = path.join(core.layout.scratch, "autopilot", "run_x", "agent-1");
    await mkdir(worktree, { recursive: true });
    for (const [label, game, extra] of [
      ["a web game", web, {}],
      ["a sub-agent's worktree", unreal, { cwd: worktree }],
      ["a run's builder", unreal, { selfCapture: { project: unreal.name, root: unreal.dir, runId: "run_x" } }],
    ] as const) {
      const { request } = await turn(game, extra);
      assert.equal(request.onCheckpoint, undefined, label);
    }
    assert.deepEqual(ran, []);
  });
});
