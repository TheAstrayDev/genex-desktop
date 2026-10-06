/**
 * The scope contract (loop/scope.ts, loop/scope-prompts.ts): the user's literal ask, what a build
 * delivers, what it cut, and how scope changes — only with the user's own words, each used once.
 * A Midnight Apex night grew police, traffic and a pursuit meter out of "an NFS-inspired racing
 * game" because nothing kept what the user asked apart from what the contractor wrote.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addToScope,
  ASKED_CHARS,
  createScope,
  isBeyondScope,
  MoveScope,
  restoreScope,
  SCOPE_ITEM_CHARS,
  SCOPE_ITEMS,
  scopeItems,
} from "../../src/harness-seed/loop/scope.ts";
import { DIRECTOR_SCOPE_RULE, SCOPE_RULE, scopeLines } from "../../src/harness-seed/loop/scope-prompts.ts";

const ASK = "Create a hyper-realistic NFS-inspired racing game";

describe("the scope contract", () => {
  it("keeps the user's words verbatim, what is in scope and what is cut, and round-trips through a journal", () => {
    const scope = createScope({ asked: [ASK], inScope: ["one race", "  one hero car "], cut: ["police pursuit"] });
    assert.deepEqual(scope, {
      version: 1,
      asked: [ASK],
      inScope: ["one race", "one hero car"],
      cut: ["police pursuit"],
      added: [],
      revisions: [],
    });
    assert.deepEqual(restoreScope(JSON.parse(JSON.stringify(scope))), scope);
  });

  it("bounds every list and every item, and the ask keeps its first message and its newest", () => {
    const many = Array.from({ length: SCOPE_ITEMS + 5 }, (_, i) => `item ${i}`);
    const scope = createScope({ asked: [ASK], inScope: [...many, "x".repeat(SCOPE_ITEM_CHARS * 2)], cut: many });
    assert.equal(scope.inScope.length, SCOPE_ITEMS);
    assert.equal(scope.cut.length, SCOPE_ITEMS);
    assert.ok(scope.inScope.every((item) => item.length <= SCOPE_ITEM_CHARS));

    const long = Array.from({ length: 40 }, (_, i) => `message ${i} ${"words ".repeat(60)}`);
    const asked = createScope({ asked: [ASK, ...long], inScope: [], cut: [] }).asked;
    assert.equal(asked[0], ASK, "the first ask stays");
    assert.equal(asked.at(-1), long.at(-1)?.trim(), "and the newest");
    assert.ok(asked.join("").length <= ASKED_CHARS, `bounded: ${asked.join("").length}`);
  });

  it("drops what is not words, and a duplicate", () => {
    const scope = createScope({ asked: [ASK, "", 7 as never], inScope: ["race", "race", " ", null as never], cut: [] });
    assert.deepEqual(scope.asked, [ASK]);
    assert.deepEqual(scope.inScope, ["race"]);
  });

  it("restores only the versioned shape; anything else is no scope", () => {
    const hostile: unknown[] = [
      null,
      "scope",
      [],
      { asked: [ASK] },
      { version: 2, asked: [ASK], inScope: [], cut: [], added: [], revisions: [] },
      { version: 1, asked: "not a list", inScope: [], cut: [] },
      { version: 1, asked: [{ text: ASK }], inScope: [], cut: [] },
    ];
    for (const value of hostile) assert.equal(restoreScope(value), undefined, JSON.stringify(value));
    const partial = restoreScope({ version: 1, asked: [ASK], inScope: "x", cut: [1, "traffic"] });
    assert.deepEqual(partial, { version: 1, asked: [ASK], inScope: [], cut: ["traffic"], added: [], revisions: [] });
  });

  it("reads a tool's list as an array, a JSON array or lines", () => {
    assert.deepEqual(scopeItems(["a", " b "]), ["a", "b"]);
    assert.deepEqual(scopeItems('["police", "open world"]'), ["police", "open world"]);
    assert.deepEqual(scopeItems("police\nopen world\n"), ["police", "open world"]);
    assert.deepEqual(scopeItems(undefined), []);
    assert.deepEqual(scopeItems({ police: true }), []);
  });
});

describe("changing scope", () => {
  const scope = createScope({ asked: [ASK], inScope: ["one race"], cut: ["police pursuit", "open world"] });

  it("needs a user steer quoted exactly, and refuses one replayed", () => {
    const steer = "actually, add a police chase";
    assert.equal(addToScope(scope, ["police pursuit"], steer, []), null, "no steer from the user");
    assert.equal(addToScope(scope, ["police pursuit"], "add police", [steer]), null, "a paraphrase is not their words");
    assert.equal(addToScope(scope, ["police pursuit"], "", [""]), null, "nothing quoted");

    const added = addToScope(scope, ["police pursuit"], steer, [ASK, steer]);
    assert.ok(added);
    assert.deepEqual(added.inScope, ["one race", "police pursuit"]);
    assert.deepEqual(added.cut, ["open world"], "what the user asked for is no longer cut");
    assert.deepEqual(added.asked, [ASK, steer], "their words join the ask");
    assert.deepEqual(added.revisions, [steer]);
    assert.deepEqual(scope.inScope, ["one race"], "the scope it was given is unchanged");

    assert.equal(addToScope(added, ["open world"], steer, [ASK, steer]), null, "a steer revises scope once");
  });

  it("a reopening message joins the ask with nothing else added", () => {
    const reopen = "make the rain heavier";
    const next = addToScope(scope, [], reopen, [reopen]);
    assert.ok(next);
    assert.deepEqual(next.asked, [ASK, reopen]);
    assert.deepEqual(next.inScope, scope.inScope);
    assert.deepEqual(next.cut, scope.cut);
  });
});

describe("a proposal beyond scope", () => {
  it("is decided by its typed field only; a missing field deepens (legacy)", () => {
    const proposal = (fields: Record<string, unknown>) => fields as { scope?: unknown };
    assert.equal(isBeyondScope(proposal({ what: "a police chase", scope: MoveScope.Adds })), true);
    assert.equal(isBeyondScope(proposal({ what: "a police chase", scope: MoveScope.Deepens })), false);
    assert.equal(isBeyondScope(proposal({ what: "adds a police chase beyond the ask" })), false, "never its words");
    assert.equal(isBeyondScope(proposal({ what: "x", scope: "ADDS" })), false);
    assert.equal(isBeyondScope(null), false);
    assert.equal(isBeyondScope(undefined), false);
  });
});

describe("the scope as agents read it", () => {
  it("renders the user's words, what is in scope, what is cut and the reference bar", () => {
    const run = {
      goal: "a night race with police",
      scope: createScope({ asked: [ASK, "at night\nin the rain"], inScope: ["one race"], cut: ["police pursuit"] }),
    };
    const lines = scopeLines(run);
    assert.match(lines, /THE USER ASKED \(verbatim\):/);
    assert.ok(lines.includes(ASK), lines);
    assert.ok(lines.includes("at night\n  in the rain"), "a message of several lines stays together");
    assert.match(lines, /IN SCOPE: one race/);
    assert.match(lines, /CUT — not this build; never build or propose it: police pursuit/);
    assert.match(lines, /The reference is a look-and-feel bar, not a feature list/);
  });

  it("says what was added beyond the ask apart from what is in scope", () => {
    const scope = { ...createScope({ asked: [ASK], inScope: [], cut: [] }), added: ["pursuit meter"] };
    const lines = scopeLines({ scope });
    assert.match(lines, /pursuit meter/);
    assert.doesNotMatch(lines, /IN SCOPE: .*pursuit meter/);
  });

  it("renders nothing for a run without scope, so every older prompt stays byte-identical", () => {
    const older = { goal: "g" } as { scope?: unknown };
    assert.equal(scopeLines(older), "");
    assert.equal(scopeLines({ scope: { asked: "x" } }), "");
    assert.equal(scopeLines(null), "");
    assert.equal(scopeLines(undefined), "");
  });

  it("gives judges and the director one rule each", () => {
    assert.match(SCOPE_RULE, /scope:"adds"/);
    assert.match(DIRECTOR_SCOPE_RULE, /Decide what to cut, not what to add/);
    assert.match(DIRECTOR_SCOPE_RULE, /decision card/);
  });
});
