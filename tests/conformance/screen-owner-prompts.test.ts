/**
 * Builders hear who owns the screen. The screen-owner rule (loop/screen-owner.ts) turns a non-owner's
 * call into the contract HUD into a code-review finding, but nothing a builder read said the screen
 * had an owner: in the Midnight Apex run the race part drew a pursuit meter beside the HUD part's
 * readouts and only learnt the rule from the review. The brief and the opening prompt now say it,
 * from the spec's typed `ownsScreen` / `screenOwner` fields; a run with no owner reads as before.
 *
 * And the chat that launches a build narrows it without cutting the game's own front-end: "a
 * system they did not name goes in cut" once read a title screen and a start key as systems.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderBrief } from "../../src/harness-seed/loop/library.ts";
import { facetPrompt } from "../../src/harness-seed/loop/facet/prompt.ts";
import { launchRules } from "../../src/harness-seed/loop/launch-prompts.ts";
import { turnBriefing } from "../../src/harness-seed/loop/turn-prompts.ts";

const RUN = { runId: "r1", goal: "a night racer", project: "/games/apex" };
const BASE = { id: "race", title: "Race", intent: "the pursuit", checks: [], owns: ["src/race.js"] };
const OWNER = { ...BASE, id: "hud", owns: ["src/hud-ui.js"], ownsScreen: true, screenOwner: "hud" };
const NON_OWNER = { ...BASE, screenOwner: "hud" };

function brief(spec: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return renderBrief({ run: RUN, spec, iteration: 1, board: {}, ...extra } as never);
}

function prompt(spec: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return facetPrompt({
    run: RUN,
    spec,
    iteration: 1,
    resumed: false,
    briefFile: ".studio/BRIEF.md",
    briefText: null,
    worktree: "/w",
    ownsMain: false,
    ...extra,
  });
}

/** The text with every line that names the screen's owner taken out, its blank lines collapsed as the renderers do. */
function withoutOwnerLines(text: string, owner: string): string {
  return text
    .split("\n")
    .filter((line) => !line.includes(`screen owner ${owner}`) && !line.startsWith("- YOU OWN THE SCREEN"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

const RENDERERS: Array<[string, (spec: Record<string, unknown>) => string]> = [
  ["the brief", (spec) => brief(spec)],
  ["the opening prompt that points at the brief", (spec) => prompt(spec)],
  ["a direct engine's opening prompt", (spec) => prompt(spec, { briefFile: null })],
];

describe("who owns the screen, as a builder reads it", () => {
  for (const [where, render] of RENDERERS) {
    it(`tells the owner in ${where} that the HUD, the menus and the layout are its`, () => {
      const text = render(OWNER);
      const line = text.split("\n").find((each) => each.startsWith("- YOU OWN THE SCREEN"));
      assert.ok(line, text);
      assert.match(line, /the HUD, the menus and the layout/);
      assert.ok(!text.includes("the screen owner hud draws them"), "the owner is not told to keep off its own screen");
    });

    it(`tells every other part in ${where} to publish its values for the owner to draw`, () => {
      const text = render(NON_OWNER);
      const line = text.split("\n").find((each) => each.includes("the screen owner hud draws them"));
      assert.ok(line, text);
      assert.match(line, /publish .*state\(\).*module's API/);
      assert.match(line, /code-review finding/, "the rule is enforced, and the line says how");
      assert.ok(!text.includes("YOU OWN THE SCREEN"));
    });

    it(`renders ${where} as before when no part owns the screen: only the owner's line differs`, () => {
      const none = render(BASE);
      assert.equal(withoutOwnerLines(render(NON_OWNER), "hud"), none);
      // A field that is not the typed shape is no owner (screen-owner.ts reads it the same way).
      for (const fields of [
        { ownsScreen: false },
        { screenOwner: "" },
        { screenOwner: 7 },
        { ownsScreen: "true" },
        { screenOwner: null },
      ])
        assert.equal(render({ ...BASE, ...fields }), none, JSON.stringify(fields));
    });
  }

  it("says nothing of an owner in a game of its own shape, where the rule is inert", () => {
    const own = { screen: false, template: false };
    assert.equal(brief(NON_OWNER, own), brief(BASE, own));
    assert.equal(brief(OWNER, own), brief({ ...OWNER, ownsScreen: undefined, screenOwner: undefined }, own));
    const shaped = { ownShape: true, shape: { main: "src/index.ts", entry: "index.html" } };
    assert.equal(prompt(NON_OWNER, shaped), prompt(BASE, shaped));
  });
});

describe("narrowing a build keeps the game's own front-end", () => {
  const sentences = (text: string) => text.split(/(?<=[.:])\s+/);
  const cutSentences = (text: string) => sentences(text).filter((each) => each.includes("goes in cut"));

  const BRIEFINGS: Array<[string, string]> = [
    ["a delegated Loop chat", launchRules("claude-code", { toolName: "start_unattended_run" }).join("\n")],
    ["a direct Autopilot briefing", turnBriefing({ autopilot: {} }) ?? ""],
    ["a direct Loop briefing", turnBriefing({ loop: { hours: 2 } }) ?? ""],
  ];
  for (const [who, text] of BRIEFINGS) {
    it(`never lets ${who} cut the title, the start on a key or the results`, () => {
      const said = cutSentences(text);
      assert.ok(said.length, text);
      for (const sentence of said) {
        assert.match(sentence, /title/, sentence);
        assert.match(sentence, /start on a key/, sentence);
        assert.match(sentence, /results/, sentence);
        assert.match(sentence, /template requires/, sentence);
      }
    });
  }
});
