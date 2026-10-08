/**
 * An Unreal game's chat turn that ends with unsaved work in its editor: Genex saves it and
 * snapshots the game folder, and the chat says so plainly. A long chat turn once ended with
 * hundreds of unsaved levels and assets and no snapshot since the last Loop step. Never during a
 * play session (the person may be playing it), never for a web game, a run's turn or a stopped
 * turn, and a plugin that can't say what the editor is doing leaves it alone.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { LeadPluginTool } from "../../src/harness-seed/loop/unreal/save-point.ts";
import { UnrealLivePluginTool } from "../../src/harness-seed/loop/unreal/live-contract.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const CLAUDE = "claude-code";
const NAME = "rail-yard";
const UPROJECT = "/Users/me/AI Games/rail-yard/unreal/RailYard.uproject";
const REPORT = "Laid the rails and the first gantry.";
const TURN = {
  threadId: "thread-1",
  turnId: "turn-1",
  text: "add a gantry",
  engine: CLAUDE,
  engineLabel: "Claude Code",
};

/** A descriptor as `game.list` answers it. */
function game(engine: boolean) {
  return {
    name: NAME,
    title: NAME,
    dir: `/games/${NAME}`,
    shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
    built: true,
    ...(engine ? { engine: { kind: GameEngine.Unreal, project: UPROJECT, linkedAt: "" } } : {}),
  };
}

/** What the turn did with the editor and the folder, and what the chat was told. */
interface Ended {
  plugin: Array<{
    name: unknown;
    args: unknown;
    project: unknown;
    threadId: unknown;
    step: unknown;
    checkpoint: unknown;
  }>;
  snapshots: Array<Record<string, unknown>>;
  said: string;
  order: string[];
}

/**
 * One chat turn on the game: the editor reports `activity` (a thrown Error: the plugin can't say),
 * `save-all` answers `saved`, and the builder answers `answer`.
 */
async function turnOn(options: {
  unreal?: boolean;
  activity?: unknown;
  saved?: unknown;
  answer?: Record<string, unknown>;
  turn?: Record<string, unknown>;
}): Promise<Ended> {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => [{ role: "user", content: TURN.text }],
      "game.contentStamp": () => ({ all: "a", source: "a" }),
      "game.list": () => [game(options.unreal !== false)],
      "plugins.tools": () => ({ tools: [], guidance: "", revision: 1 }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: false }),
      "engine.delegate": () => ({
        ok: true,
        engine: CLAUDE,
        turns: 1,
        usage: {},
        sessionId: "s",
        summary: REPORT,
        ...options.answer,
      }),
      "plugins.invoke": (p) => {
        const answer = p.name === LeadPluginTool.EditorActivity ? options.activity : options.saved;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  });
  await runDelegatedTurn(recorder.ctx as never, { ...TURN, project: NAME, ...options.turn } as never);
  const said = recorder.notifications
    .filter((n) => n.type === "chat.message")
    .map((n) => String((n.payload as { content?: unknown }).content))
    .join("\n");
  const plugin = recorder.paramsOf("plugins.invoke").map((p) => ({
    name: p.name,
    args: p.args,
    project: p.project,
    threadId: p.threadId,
    step: p.step,
    checkpoint: p.checkpoint,
  }));
  const order = recorder.sequence((m) => m === "plugins.invoke" || m === "snapshot.create" || m === "turn.append");
  return { plugin, snapshots: recorder.paramsOf("snapshot.create"), said, order };
}

const SAVED = { saved: true, dirty: [], ms: 30 };
const DIRTY = { pie: false, dirty: 412 };

describe("an Unreal chat turn that ends with unsaved editor work", () => {
  it("is saved, the game folder snapshotted, and the chat told after the builder's report", async () => {
    const ended = await turnOn({ activity: DIRTY, saved: SAVED });
    assert.deepEqual(
      ended.plugin.map((c) => c.name),
      [LeadPluginTool.EditorActivity, UnrealLivePluginTool.SaveAll],
    );
    for (const call of ended.plugin) {
      assert.equal(call.project, NAME);
      assert.equal(call.threadId, TURN.threadId);
    }
    assert.equal(ended.snapshots.length, 1);
    assert.equal(ended.snapshots[0]?.scope, "game");
    assert.equal(ended.snapshots[0]?.project, NAME);
    assert.ok(ended.said.includes(REPORT), "the builder's report still reaches the chat");
    assert.match(ended.said, /412 unsaved files in Unreal, so Genex saved them and took a snapshot of the game\./);
    assert.ok(ended.said.indexOf(REPORT) < ended.said.indexOf("412 unsaved"), "the line follows the report");
    assert.ok(
      ended.order.indexOf("snapshot.create") > ended.order.lastIndexOf("plugins.invoke"),
      "saved, then snapshotted",
    );
  });

  it("the chat's save is a checkpoint the harness takes as its own step", async () => {
    const ended = await turnOn({ activity: DIRTY, saved: SAVED });
    assert.deepEqual(
      ended.plugin.map((c) => [c.name, c.step, c.checkpoint]),
      [
        [LeadPluginTool.EditorActivity, true, true],
        [UnrealLivePluginTool.SaveAll, true, true],
      ],
    );
  });

  it("is left alone while the game is playing in the editor, and the chat says it is still unsaved", async () => {
    const ended = await turnOn({ activity: { pie: true, dirty: 3 }, saved: SAVED });
    assert.deepEqual(
      ended.plugin.map((c) => c.name),
      [LeadPluginTool.EditorActivity],
    );
    assert.deepEqual(ended.snapshots, []);
    assert.match(ended.said, /3 unsaved files in Unreal, but the game is playing there, so Genex didn't save them\./);
  });

  it("says a save that failed, or left work unsaved, and takes no snapshot of a failed one", async () => {
    const failed = await turnOn({ activity: DIRTY, saved: new Error("This game's Unreal isn't answering.") });
    assert.deepEqual(failed.snapshots, []);
    assert.match(failed.said, /Genex couldn't save it: This game's Unreal isn't answering\./);
    const partial = await turnOn({ activity: DIRTY, saved: { saved: false, dirty: ["/Game/Maps/Yard"], ms: 9 } });
    assert.equal(partial.snapshots.length, 1);
    assert.match(partial.said, /but 1 file stayed unsaved/);
  });
});

describe("a chat turn that leaves Unreal alone", () => {
  it("with nothing unsaved, or an editor that can't say, saves nothing and says nothing", async () => {
    const unknown = [null, { pie: false }, { dirty: 3 }, { pie: "no", dirty: 3 }, "busy", new Error("no such tool")];
    for (const activity of [{ pie: false, dirty: 0 }, ...unknown]) {
      const ended = await turnOn({ activity, saved: SAVED });
      const label = JSON.stringify(activity);
      assert.deepEqual(
        ended.plugin.map((c) => c.name),
        [LeadPluginTool.EditorActivity],
        label,
      );
      assert.deepEqual(ended.snapshots, [], label);
      assert.doesNotMatch(ended.said, /unsaved/, label);
    }
  });

  it("on a web game, a run's turn or a stopped turn, never asks the editor", async () => {
    const cases: Record<string, Parameters<typeof turnOn>[0]> = {
      "a web game": { unreal: false },
      "a run's turn": { turn: { runId: "run_1" } },
      "a stopped turn": { answer: { ok: false, stopReason: "stopped" } },
    };
    for (const [label, options] of Object.entries(cases)) {
      const ended = await turnOn({ activity: DIRTY, saved: SAVED, ...options });
      assert.deepEqual(ended.plugin, [], label);
      assert.deepEqual(ended.snapshots, [], label);
    }
  });
});
