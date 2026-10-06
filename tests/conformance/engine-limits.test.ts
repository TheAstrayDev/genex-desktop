/**
 * Limits as the run must see them (director follow-up, 2026-09-07): the CLI names a session
 * limit only in result text — "You've hit your session limit · resets 9:50pm" — and a run once
 * ended as a plain "error" because that text was never read. The engine classifies the text
 * and reads the reset time; the harness decides between waiting, pausing and landing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { limitKind, limitResetMs } from "../../src/substrate/engines/claude-code.ts";
import { classifyHttpFailure } from "../../src/substrate/engines/types.ts";
import { consoleProblems } from "../../src/harness-seed/loop/gauntlet.ts";

describe("engine limits", () => {
  it("classifies session, usage and rate limits by their text, and nothing else", () => {
    assert.equal(limitKind("You've hit your session limit · resets 9:50pm (Europe/Belgrade)"), "rate_limit");
    assert.equal(limitKind("Rate limit reached, retry in 30s"), "rate_limit");
    assert.equal(limitKind("429 Too Many Requests"), "rate_limit");
    assert.equal(limitKind("You've hit your weekly limit · resets Sep 9, 3pm"), "usage_limit");
    assert.equal(limitKind("Your monthly limit is exhausted"), "usage_limit");
    assert.equal(limitKind("TypeError: x is not a function"), null);
    assert.equal(limitKind(""), null);
  });

  it("reads the reset time against the machine's clock", () => {
    const now = new Date("2026-09-07T19:56:00").getTime(); // local wall clock of the test machine
    const ms = limitResetMs("You've hit your session limit · resets 9:50pm (Europe/Belgrade)", now)!;
    assert.ok(ms > 0, "a reset later today is positive");
    assert.equal(Math.round(ms / 60_000), 114, "9:50pm is 114 minutes after 7:56pm");
    const tomorrow = limitResetMs("resets 9:50am", now)!;
    assert.ok(
      tomorrow > 12 * 3_600_000 && tomorrow < 24 * 3_600_000,
      `a clock time already behind is tomorrow's: ${tomorrow}`,
    );
    assert.equal(limitResetMs("resets in 3 hours", now), 3 * 3_600_000);
    assert.equal(limitResetMs("resets in 45 min", now), 45 * 60_000);
    assert.equal(limitResetMs("no reset named here", now), null);
  });
});

describe("HTTP failures of an API engine", () => {
  it("classifies each status by its code, never by the body's words", () => {
    const rows: Array<[number, string, string]> = [
      [429, "slow down", "rate_limit"],
      [401, "bad key", "auth"],
      [403, "forbidden", "auth"],
      // A metered account out of credits: no in-run wait refills it, so the run ends rather than retrying.
      [402, "Insufficient credits", "usage_limit"],
      [500, "boom", "unavailable"],
      [503, "overloaded", "unavailable"],
      [400, "rate limit exceeded", "other"],
    ];
    for (const [status, body, kind] of rows)
      assert.equal(classifyHttpFailure("openrouter", status, body).kind, kind, `${status}`);
    assert.equal(classifyHttpFailure("openrouter", 429, "retry-after: 7").retryAfterMs, 7000);
  });
});

describe("console errors as evidence", () => {
  it("voids a build only for the errors it introduced; inherited ones become a warning", () => {
    const shader = "THREE.WebGLProgram: shader error: vColor vec3 vs vec4";
    const errors = [
      { level: "error", message: shader },
      { level: "error", message: "ReferenceError: foo is not defined" },
    ];
    const fresh = consoleProblems(errors, []);
    assert.deepEqual(fresh.problems, ["2 console error(s)"]);
    assert.deepEqual(fresh.warnings, []);
    const inherited = consoleProblems(errors, [shader]);
    assert.deepEqual(inherited.problems, ["1 console error(s)"]);
    assert.equal(inherited.warnings.length, 1);
    assert.match(inherited.warnings[0]!, /1 console error\(s\) inherited/);
    assert.match(inherited.warnings[0]!, /vColor/);
    const all = consoleProblems([errors[0]], [shader]);
    assert.deepEqual(all.problems, [], "a build that only carries the base's error is judgeable");
    assert.equal(all.warnings.length, 1);
    assert.deepEqual(consoleProblems([], [shader]), { problems: [], warnings: [] });
  });
});
