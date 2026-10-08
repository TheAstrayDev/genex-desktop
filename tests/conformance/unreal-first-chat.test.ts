/**
 * A new game's first Unreal chat. The turn that makes the game's Unreal project ends while Unreal
 * still opens it (a first start prepares shaders for minutes); a chat once went quiet there for
 * most of an hour, the builder's "I'll start as soon as the editor is ready" kept by nobody. Now
 * the chat says it waits, waits for the editor to answer through the Unreal plugin's `wait-editor`,
 * and the same session goes on by itself. Before the engine question, the plugin's `engine-status`
 * says whether Unreal is installed at all, so Unreal is offered honestly.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import {
  EditorWait,
  EngineReadiness,
  UNREAL_START_WAIT_MS,
  UnrealChatTool,
  WAIT_MESSAGE,
} from "../../src/harness-seed/loop/unreal/editor-wait.ts";
import { unrealReadyPrompt } from "../../src/harness-seed/loop/unreal/editor-wait-prompts.ts";
import { UNREAL_NEW_GAME_TOOL } from "../../src/harness-seed/loop/unreal-prompts.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const CLAUDE = "claude-code";
const NAME = "lantern-run";
const UPROJECT = "/Users/me/AI Games/lantern-run/unreal/Lantern.uproject";
const TURN = {
  threadId: "thread-1",
  turnId: "turn-1",
  text: "Unreal Engine",
  engine: CLAUDE,
  engineLabel: "Claude Code",
};
const FIRST = "Made the Unreal project; next I'll lay out the first street.";
const AFTER = "Laid out the first street in the editor.";

/** What the host lists a game linked to its Unreal project as holding: the link's project, in `unreal/`. */
const LINKED_FACTS = [{ id: "unreal-project", path: "unreal", source: "link" }];
/** What it lists the web game it was before as holding. */
const WEB_FACTS = [{ id: "web-game", path: ".", source: "core" }];

/**
 * A descriptor as `game.list` answers it, linked to Unreal or not, with the facts the host lists
 * for it; `legacy` is one from a host that lists no facts (read by its link).
 */
function game(unreal: boolean, extra: Record<string, unknown> = {}, legacy = false) {
  return {
    name: NAME,
    title: NAME,
    dir: `/games/${NAME}`,
    shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
    built: false,
    ...(unreal ? { engine: { kind: GameEngine.Unreal, project: UPROJECT, linkedAt: "" } } : {}),
    ...(legacy ? {} : { facts: unreal ? LINKED_FACTS : WEB_FACTS }),
    ...extra,
  };
}

/** The game once it is linked to another Unreal project, outside its folder. */
function relinked(project: string) {
  const folder = project.slice(0, project.lastIndexOf("/"));
  return game(true, {
    engine: { kind: GameEngine.Unreal, project, linkedAt: "" },
    facts: [{ id: "unreal-project", path: folder, source: "link" }],
  });
}

/**
 * One turn on the game. It is linked to Unreal `before` the builder runs and `after` it; the
 * editor answers `waits` in order to `wait-editor` (the last one repeats); `stopOnWait` raises Stop
 * on that call.
 */
async function turnOn(options: {
  before?: boolean;
  after?: boolean;
  waits?: string[];
  turn?: Record<string, unknown>;
  stopOnWait?: number;
  /** Packages the editor holds unsaved once the session went on in Unreal (none before). */
  dirtyAfter?: number;
  /** Runs at each `wait-editor` call, as a clock moving on while Unreal starts. */
  onWait?: () => void;
  /** The host lists no facts (an older host): the game is read by its link. */
  legacy?: boolean;
  /** Once the builder ran, the game is linked to this other project instead (a switch with use-project). */
  relinkTo?: string;
}) {
  let built = false;
  const waits = [...(options.waits ?? [EditorWait.Starting, EditorWait.Ready])];
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => [{ role: "user", content: TURN.text }],
      "game.contentStamp": () => ({ all: "a", source: "a" }),
      "game.list": () => [
        built && options.relinkTo
          ? relinked(options.relinkTo)
          : game(built ? options.after !== false : options.before === true, {}, options.legacy),
      ],
      "plugins.tools": () => ({ tools: [], guidance: "", revision: 1 }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: false }),
      "engine.delegate": (p) => {
        const first = !built;
        built = true;
        return {
          ok: true,
          engine: CLAUDE,
          turns: 1,
          usage: {},
          sessionId: first ? "s1" : String(p.resume ?? "s2"),
          summary: first ? FIRST : AFTER,
        };
      },
      "plugins.invoke": (p) => {
        const wentOn = recorder.paramsOf("engine.delegate").length > 1;
        if (p.name === "unreal__editor-activity") return { pie: false, dirty: wentOn ? (options.dirtyAfter ?? 0) : 0 };
        if (p.name === "unreal__save-all") return { saved: true, dirty: [], ms: 40 };
        if (p.name !== UnrealChatTool.WaitEditor) return null;
        options.onWait?.();
        const state = waits.length > 1 ? waits.shift() : waits[0];
        return { state, project: "Lantern" };
      },
    },
  });
  if (options.stopOnWait !== undefined) recorder.cancelAfter("plugins.invoke", options.stopOnWait);
  const outcome = await runDelegatedTurn(recorder.ctx as never, { ...TURN, project: NAME, ...options.turn } as never);
  const delegated = recorder.paramsOf("engine.delegate");
  const waitCalls = recorder.paramsOf("plugins.invoke").filter((p) => p.name === UnrealChatTool.WaitEditor);
  const said = recorder.notifications
    .filter((n) => n.type === "chat.message")
    .map((n) => String((n.payload as { content?: unknown }).content));
  return { outcome, delegated, waitCalls, said };
}

describe("the turn that makes a game's Unreal project", () => {
  it("says it waits, waits for Unreal to answer, then the same session goes on by itself", async () => {
    const t = await turnOn({});
    assert.equal(t.delegated.length, 2, "one build, then one continuation");
    assert.deepEqual([t.delegated[1]?.resume, t.delegated[1]?.prompt], ["s1", unrealReadyPrompt("Lantern")]);
    assert.ok(t.said.includes(WAIT_MESSAGE.waiting("Lantern")), "the chat says it waits");
    assert.ok(t.said.some((line) => line.includes(FIRST)) && t.said.some((line) => line.includes(AFTER)));
    assert.ok(t.waitCalls.length >= 2, "it asked, then waited");
    assert.ok(
      t.waitCalls.every((p) => p.project === NAME && p.threadId === TURN.threadId),
      "only this game's own editor, for this chat",
    );
  });

  it("a turn that switches a linked game to another Unreal project waits for that project's editor too", async () => {
    const t = await turnOn({ before: true, relinkTo: "/Users/me/Unreal Projects/Moth/Moth.uproject" });
    assert.equal(t.delegated.length, 2, "one build, then one continuation");
    assert.ok(t.waitCalls.length >= 1, "it waited for the editor");
    assert.deepEqual([t.delegated[1]?.resume, t.delegated[1]?.prompt], ["s1", unrealReadyPrompt("Lantern")]);
    const unchanged = await turnOn({ before: true, after: true });
    assert.equal(unchanged.delegated.length, 1, "a turn on the same link ends as it did");
    assert.equal(unchanged.waitCalls.length, 0);
  });

  it("goes on the same way for a host that lists no facts, by the game's link", async () => {
    const t = await turnOn({ legacy: true });
    assert.equal(t.delegated.length, 2);
    assert.deepEqual([t.delegated[1]?.resume, t.delegated[1]?.prompt], ["s1", unrealReadyPrompt("Lantern")]);
  });

  it("waiting for the editor is the harness's own step", async () => {
    const t = await turnOn({});
    assert.ok(t.waitCalls.length >= 2);
    for (const call of t.waitCalls) {
      assert.equal(call.step, true);
      assert.equal(Object.hasOwn(call, "checkpoint"), false, "a wait is no checkpoint");
    }
  });

  it("saves what the session left unsaved in Unreal after it went on, and says so after its report", async () => {
    const t = await turnOn({ waits: [EditorWait.Ready], dirtyAfter: 3 });
    assert.equal(t.delegated.length, 2);
    const report = t.said.findIndex((line) => line.includes(AFTER));
    const saved = t.said.findIndex((line) => /left 3 unsaved files in Unreal, so Genex saved them/.test(line));
    assert.ok(saved > report && report >= 0, t.said.join(" | "));
  });

  it("goes on at once when Unreal already answers, saying nothing about waiting", async () => {
    const t = await turnOn({ waits: [EditorWait.Ready] });
    assert.equal(t.delegated.length, 2);
    assert.ok(!t.said.includes(WAIT_MESSAGE.waiting("Lantern")));
  });

  it("says plainly when Unreal stops opening without answering, and doesn't go on", async () => {
    for (const end of [EditorWait.NotStarting, EditorWait.PortBlocked]) {
      const t = await turnOn({ waits: [EditorWait.Starting, EditorWait.Starting, end] });
      assert.equal(t.delegated.length, 1, end);
      assert.ok(t.said.includes(WAIT_MESSAGE.notReady("Lantern")), end);
    }
  });

  it("says Unreal is still opening when the wait's cap passes while it starts, never that it didn't open", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 6, 9) });
    const waited = await turnOn({
      waits: [EditorWait.Starting],
      onWait: () => t.mock.timers.tick(UNREAL_START_WAIT_MS),
    });
    assert.equal(waited.delegated.length, 1, "nothing goes on without Unreal");
    assert.ok(waited.said.includes(WAIT_MESSAGE.stillOpening("Lantern")), waited.said.join(" | "));
    assert.ok(!waited.said.includes(WAIT_MESSAGE.notReady("Lantern")));
  });

  it("Stop during the wait ends it: nothing goes on, and the chat says how to pick up", async () => {
    const t = await turnOn({ waits: [EditorWait.Starting], stopOnWait: 2 });
    assert.equal(t.delegated.length, 1);
    assert.ok(t.said.includes(WAIT_MESSAGE.stopped));
  });

  it("never waits for a game that was Unreal before the turn, stays a web game, has no project yet, or a run's turn", async () => {
    const cases: Record<string, Parameters<typeof turnOn>[0]> = {
      "linked before the turn": { before: true, after: true },
      "still a web game": { before: false, after: false },
      "no project to wait for": { waits: [EditorWait.NoProject] },
      "Unreal not opening it": { waits: [EditorWait.NotStarting] },
      "a run's turn": { turn: { runId: "run-1" } },
    };
    for (const [label, options] of Object.entries(cases)) {
      const t = await turnOn(options);
      assert.equal(t.delegated.length, 1, label);
      assert.ok(!t.said.includes(WAIT_MESSAGE.waiting("Lantern")), label);
    }
  });
});

const NEW_GAME_TOOL = { name: UNREAL_NEW_GAME_TOOL, description: "Make the game's Unreal project.", parameters: {} };

/** A new game's first turn with the Unreal plugin on; `engine-status` answers `status` (an Error: the plugin can't say). */
async function engineQuestion(status: unknown) {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => [{ role: "user", content: "make a lantern-lit city game" }],
      "game.contentStamp": () => ({ all: null, source: null }),
      "game.list": () => [],
      // A game Genex just made has no kind yet.
      "game.scaffold": (p) => game(false, { name: String(p.name), facts: [] }),
      "plugins.tools": () => ({ tools: [NEW_GAME_TOOL], guidance: "", revision: 1 }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: false }),
      "engine.delegate": () => ({ ok: true, engine: CLAUDE, turns: 1, usage: {}, sessionId: "s", summary: "ok" }),
      "plugins.invoke": (p) => {
        if (p.name !== UnrealChatTool.EngineStatus) return null;
        if (status instanceof Error) throw status;
        return status;
      },
    },
  });
  await runDelegatedTurn(
    recorder.ctx as never,
    { ...TURN, text: "make a lantern-lit city game", newProject: true } as never,
  );
  const [delegated] = recorder.paramsOf("engine.delegate");
  return String(delegated?.prompt ?? "");
}

describe("the engine question, told what this computer has", () => {
  it("offers Unreal as ready to make with 5.8 installed, without web or Unreal jargon", async () => {
    const prompt = await engineQuestion({ engine: EngineReadiness.Ready, version: "5.8" });
    assert.match(prompt, /plays in the Unreal editor on this computer/);
    assert.match(prompt, /When it is the web, call [^ ]*start_web_game first/, "the web answer starts the web starter");
    assert.doesNotMatch(prompt, /isn't installed|newer/);
    assert.doesNotMatch(prompt, /Three\.js/);
  });

  it("with no Unreal, offers it with its install first and points to the Unreal button instead of new-game", async () => {
    const prompt = await engineQuestion({ engine: EngineReadiness.None, version: null });
    assert.match(prompt, /isn't installed on this computer/);
    assert.match(
      prompt,
      /offer it as "Unreal Engine" with the description "Plays in Epic's free editor on this computer; needs a 45 GB install first"/,
    );
    assert.match(prompt, /Unreal button/);
  });

  it("with only a newer Unreal, offers 5.8 beside it and never tries new-game, which would refuse", async () => {
    const prompt = await engineQuestion({ engine: EngineReadiness.NewerOnly, version: "5.9" });
    assert.match(
      prompt,
      /"Unreal Engine 5\.8" with the description "Needs 5\.8 installed beside your 5\.9, about 45 GB"/,
    );
    assert.match(prompt, /don't call claude-code:unreal__new-game|don't call [^ ]*unreal__new-game/);
    assert.doesNotMatch(prompt, /try [^ ]*unreal__new-game/);
    assert.match(prompt, /Unreal button/);
  });

  it("with only an older Unreal, says games here need 5.8 beside it, never that Unreal isn't installed", async () => {
    const prompt = await engineQuestion({ engine: EngineReadiness.OlderOnly, version: "5.4" });
    assert.match(prompt, /Unreal 5\.4/);
    assert.match(prompt, /5\.8 installed beside your 5\.4/);
    assert.doesNotMatch(prompt, /isn't installed/);
    assert.match(prompt, /Unreal button/);
  });

  it("a plugin that can't say keeps the question as it was", async () => {
    const prompt = await engineQuestion(new Error("older plugin"));
    assert.match(prompt, /plays in the Unreal editor on this computer/);
  });
});
