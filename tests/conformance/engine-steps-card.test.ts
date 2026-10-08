/**
 * The steps card an engine plugin offers in a game's chat ("Steps for Unreal"): the newest offer in
 * the chat shows until the person says Not now, and a later offer (the agent's show-steps) shows it
 * again. Its rows come from the plugin, read live, so anything malformed is dropped, not drawn.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSteps, stepsOffer, stepsShown } from "../../src/renderer/chat/engine-steps.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: "turn",
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const offer = (id: number, payload: Record<string, unknown> = { pluginId: "unreal", project: "valley" }) =>
  event(id, { type: "custom", event_type: "engine_steps", payload });
const said = (id: number) =>
  event(id, { type: "messages", messages: [{ role: "assistant", content: "hi" }] } as EventData);

describe("the steps card's offer", () => {
  it("is the newest offer in the chat, by the plugin and game it names", () => {
    assert.equal(stepsOffer([said(1)]), null);
    assert.deepEqual(stepsOffer([offer(1), said(2), offer(3)]), {
      id: "000003",
      pluginId: "unreal",
      project: "valley",
    });
    assert.equal(stepsOffer([offer(1, { project: "valley" })]), null, "no plugin: nothing to ask");
  });

  it("shows until Not now, and a later offer shows again", () => {
    const first = stepsOffer([offer(1)]);
    assert.equal(stepsShown(first, null), true);
    assert.equal(stepsShown(first, "000001"), false, "Not now on this offer");
    const again = stepsOffer([offer(1), offer(5)]);
    assert.equal(stepsShown(again, "000001"), true, "the agent showed it again");
    assert.equal(stepsShown(null, null), false);
  });
});

describe("the plugin's steps", () => {
  const good = {
    title: "Steps for Unreal",
    intro: "Two steps from you make the agent's Unreal work better.",
    open: true,
    steps: [
      { id: "set-up", label: "Unreal 5.8 is set up for Valley", detail: "", done: true },
      {
        id: "install-xcode",
        label: "Install Xcode",
        detail: "Recommended.",
        done: false,
        action: { name: "get-xcode", args: { step: "install" }, label: "Get Xcode" },
      },
      { id: "select-xcode", label: "Use Xcode", detail: "Run this:", done: false, command: "sudo xcode-select -s X" },
    ],
  };

  it("keeps a well-formed answer as it is", () => {
    assert.deepEqual(parseSteps(good), good);
  });

  it("drops what isn't a step, and a card with no open step is not shown", () => {
    const messy = {
      ...good,
      steps: [
        ...good.steps,
        null,
        { id: 7 },
        { id: "x", label: "L", detail: "", done: "no" },
        { ...good.steps[1], action: { name: 3 } },
      ],
    };
    const parsed = parseSteps(messy);
    assert.equal(parsed?.steps.length, 4);
    assert.equal(parsed?.steps[3]?.action, undefined, "a malformed button is dropped, the row kept");
    assert.equal(parseSteps({ ...good, open: false })?.open, false);
    for (const bad of [null, "steps", [], { title: 1 }, { ...good, steps: "x" }]) assert.equal(parseSteps(bad), null);
  });
});
