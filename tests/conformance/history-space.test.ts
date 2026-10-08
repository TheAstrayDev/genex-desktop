/**
 * How much space a game's history takes, and clearing only what Rewind and finished runs left
 * beside it.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { clearSideTracks, historySpace } from "../../src/substrate/history-space.ts";
import { ChatCheckpoints } from "../../src/main/chat-checkpoints.ts";
import { HistorySpaceService } from "../../src/main/core/history-space.ts";
import { type OutcomeView, outcomeEnded } from "../../src/shared/run-summary.ts";
import { git, gitOrNull } from "../../src/substrate/snapshots.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { HISTORY_WORDS, historyClearedWords, historyMenuSize, historySpaceWords } from "../../src/renderer/words.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** Every ref of the repository with the commit it names, as `for-each-ref` lists them. */
const refs = async (dir: string): Promise<string> => git(dir, ["for-each-ref", "--format=%(objectname) %(refname)"]);
const resolves = async (dir: string, ref: string): Promise<string | null> =>
  (await gitOrNull(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))?.trim() ?? null;
const exists = async (dir: string, object: string): Promise<boolean> =>
  (await gitOrNull(dir, ["cat-file", "-e", object])) !== null;

/** A commit holding one file of `bytes` random bytes, on no branch: what only its ref reaches. */
async function looseCommit(dir: string, name: string, bytes: number): Promise<{ commit: string; blob: string }> {
  const file = path.join(dir, ".git", `${name}.tmp`);
  await writeFile(file, randomBytes(bytes));
  const blob = (await git(dir, ["hash-object", "-w", file])).trim();
  const index = { GIT_INDEX_FILE: path.join(dir, ".git", `${name}.index`) };
  await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${name}.bin`], index);
  const tree = (await git(dir, ["write-tree"], index)).trim();
  const commit = (await git(dir, ["commit-tree", tree, "-m", name])).trim();
  return { commit, blob };
}

/** Make every loose object of the repository two hours old: written long before a clear. */
async function ageObjects(dir: string): Promise<void> {
  const objects = path.join(dir, ".git", "objects");
  const then = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const folder of await readdir(objects)) {
    if (!/^[0-9a-f]{2}$/.test(folder)) continue;
    for (const file of await readdir(path.join(objects, folder)))
      await utimes(path.join(objects, folder, file), then, then);
  }
}

/** A repository with the person's history and the studio's side tracks beside it. */
async function gameRepository() {
  const dir = await tmpDir("history-space-");
  await git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(dir, "game.js"), "one\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "first"]);
  await writeFile(path.join(dir, "game.js"), "two\n");
  await git(dir, ["commit", "-q", "-am", "second"]);
  await git(dir, ["branch", "mine", "HEAD~1"]);
  await git(dir, ["tag", "v1", "HEAD~1"]);
  await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const save = await looseCommit(dir, "save", 4096);
  await git(dir, ["update-ref", "refs/studio/snap/s1", save.commit]);
  const run = async (id: string) => {
    const made = await looseCommit(dir, `run-${id}`, 4096);
    await git(dir, ["update-ref", `refs/studio/runs/${id}/integration`, made.commit]);
    return made;
  };
  return { dir, save, done: await run("done"), paused: await run("paused"), unknown: await run("unknown") };
}

describe("a game's history space", () => {
  it("clears Rewind history and finished runs' side tracks, and nothing else", async () => {
    const repo = await gameRepository();
    const { dir } = repo;
    const chat = await looseCommit(dir, "chat", MB);
    await git(dir, ["update-ref", "refs/studio/chat/t/before/m1", chat.commit]);
    await git(dir, ["update-ref", "refs/studio/chat/t/rewound/x", chat.commit]);
    const kept = [
      "refs/heads/main",
      "refs/heads/mine",
      "refs/tags/v1",
      "refs/remotes/origin/main",
      "refs/studio/snap/s1",
      "refs/studio/runs/paused/integration",
      "refs/studio/runs/unknown/integration",
    ];
    const before = new Map(await Promise.all(kept.map(async (ref) => [ref, await resolves(dir, ref)] as const)));
    const reflog = await git(dir, ["reflog", "show", "--format=%H %gs", "HEAD"]);

    await ageObjects(dir);
    const space = await historySpace(dir, new Set(["done"]));
    assert.ok(space.clearableBytes >= MB, `clearable ${space.clearableBytes}`);
    assert.ok(space.totalBytes >= space.clearableBytes);
    assert.equal(space.rewindTracks, 2);
    assert.equal(space.finishedRunTracks, 1);

    const cleared = await clearSideTracks(dir, new Set(["done"]));
    assert.equal(cleared.removedTracks, 3);
    assert.ok(cleared.freedBytes > 0, `freed ${cleared.freedBytes}`);
    for (const ref of kept) assert.equal(await resolves(dir, ref), before.get(ref), `${ref} is kept as it was`);
    for (const ref of [
      "refs/studio/chat/t/before/m1",
      "refs/studio/chat/t/rewound/x",
      "refs/studio/runs/done/integration",
    ])
      assert.equal(await resolves(dir, ref), null, `${ref} is cleared`);
    assert.equal(await exists(dir, chat.blob), false, "what only Rewind reached is gone");
    assert.equal(await exists(dir, repo.done.blob), false, "and what only a finished run reached");
    for (const blob of [repo.save.blob, repo.paused.blob, repo.unknown.blob]) assert.ok(await exists(dir, blob));
    assert.equal(await git(dir, ["reflog", "show", "--format=%H %gs", "HEAD"]), reflog, "reflogs stay");
    assert.deepEqual(await historySpace(dir, new Set(["done"])), {
      ...(await historySpace(dir, new Set())),
      clearableBytes: 0,
      rewindTracks: 0,
      finishedRunTracks: 0,
    });
  });

  it("keeps what was written just before a clear: another git command may still be using it", async () => {
    const { dir } = await gameRepository();
    const old = await looseCommit(dir, "old-chat", 4096);
    await git(dir, ["update-ref", "refs/studio/chat/t/before/m1", old.commit]);
    await ageObjects(dir);
    // A blob a save point or the person's own commit has written and not yet committed.
    const fresh = await looseCommit(dir, "fresh", 4096);
    const cleared = await clearSideTracks(dir, new Set());
    assert.equal(cleared.removedTracks, 1);
    assert.equal(await exists(dir, old.blob), false, "what only the cleared track reached, long ago, is gone");
    assert.equal(await exists(dir, fresh.blob), true, "a fresh object nothing reaches yet is kept");
  });

  it("says what a clear frees now, and frees later what was too recent to free", async () => {
    const { dir } = await gameRepository();
    await ageObjects(dir);
    const fresh = await looseCommit(dir, "fresh-chat", MB);
    await git(dir, ["update-ref", "refs/studio/chat/t/before/m1", fresh.commit]);

    const space = await historySpace(dir, new Set());
    assert.equal(space.rewindTracks, 1);
    assert.ok(space.clearableBytes < MB / 2, `a fresh copy is not counted as freed now: ${space.clearableBytes}`);
    assert.ok(space.recentBytes >= MB, `it is counted as recent: ${space.recentBytes}`);
    const first = await clearSideTracks(dir, new Set());
    assert.equal(first.removedTracks, 1);
    assert.ok(first.freedBytes < MB / 2, `freed ${first.freedBytes}`);
    assert.equal(await exists(dir, fresh.blob), true, "a fresh copy is kept by the clear");
    const between = await historySpace(dir, new Set());
    assert.equal(between.rewindTracks, 0);
    assert.ok(between.recentBytes >= MB, `what the clear kept still shows as recent: ${between.recentBytes}`);

    // An hour later the copy nothing reaches is what a clear frees, though no side track is left.
    await ageObjects(dir);
    const later = await historySpace(dir, new Set());
    assert.ok(later.clearableBytes >= MB, `clearable ${later.clearableBytes}`);
    assert.equal(later.recentBytes, 0);
    const second = await clearSideTracks(dir, new Set());
    assert.equal(second.removedTracks, 0);
    assert.ok(second.freedBytes >= MB / 2, `freed ${second.freedBytes}`);
    assert.equal(await exists(dir, fresh.blob), false);
    const after = await historySpace(dir, new Set());
    assert.equal(after.clearableBytes, 0);
    assert.equal(after.recentBytes, 0);
  });

  it("keeps a worktree of the person's whose folder is missing, and the commits only it holds", async () => {
    const { dir } = await gameRepository();
    const drive = path.join(await tmpDir("history-space-drive-"), "drive");
    const scratch = await tmpDir("history-space-scratch-");
    await git(dir, ["worktree", "add", "-q", "--detach", path.join(drive, "wt"), "HEAD"]);
    await writeFile(path.join(drive, "wt", "detached.txt"), randomBytes(4096).toString("hex"));
    await git(path.join(drive, "wt"), ["add", "-A"]);
    await git(path.join(drive, "wt"), ["commit", "-q", "-m", "detached work"]);
    const detached = (await git(path.join(drive, "wt"), ["rev-parse", "HEAD"])).trim();
    // A Genex copy under the scratch folder, removed without telling git.
    const copy = path.join(scratch, "autopilot", "run_done", "w1");
    await git(dir, ["worktree", "add", "-q", "--detach", copy, "HEAD"]);
    await writeFile(path.join(copy, "copy.txt"), randomBytes(4096).toString("hex"));
    await git(copy, ["add", "-A"]);
    await git(copy, ["commit", "-q", "-m", "copy work"]);
    const copied = (await git(copy, ["rev-parse", "HEAD"])).trim();
    await rm(copy, { recursive: true, force: true });
    // The person's drive is unmounted while the clear runs.
    const unmounted = `${drive}-away`;
    await rename(drive, unmounted);
    await git(dir, ["update-ref", "refs/studio/chat/t/before/m1", "HEAD"]);
    await ageObjects(dir);

    const cleared = await clearSideTracks(dir, new Set(), { scratch });
    assert.equal(cleared.removedTracks, 1);
    const admin = await readdir(path.join(dir, ".git", "worktrees"));
    assert.deepEqual(admin, ["wt"], "only Genex's own missing copy is forgotten");
    assert.equal(await exists(dir, detached), true, "the person's detached commit stays");
    assert.equal(await exists(dir, copied), false, "what only Genex's removed copy held is gone");
    await rename(unmounted, drive);
    assert.match(await git(path.join(drive, "wt"), ["status", "--porcelain=v1", "--branch"]), /no branch|HEAD/);
  });

  it("clears nothing in a linked worktree, whose refs and objects its main repository shares", async () => {
    const main = await gameRepository();
    await git(main.dir, ["update-ref", "refs/studio/chat/t/before/m1", "HEAD"]);
    const linked = path.join(await tmpDir("history-space-linked-"), "linked");
    await git(main.dir, ["worktree", "add", "-q", "-b", "side", linked]);
    const before = await refs(main.dir);
    assert.deepEqual(await historySpace(linked, new Set(["done"])), {
      totalBytes: 0,
      clearableBytes: 0,
      recentBytes: 0,
      rewindTracks: 0,
      finishedRunTracks: 0,
    });
    assert.deepEqual(await clearSideTracks(linked, new Set(["done"])), { removedTracks: 0, freedBytes: 0 });
    assert.equal(await refs(main.dir), before, "the main repository's refs are untouched");
  });

  it("never deletes a ref outside Rewind's and runs' tracks", async () => {
    const { dir } = await gameRepository();
    const before = await refs(dir);
    for (const finished of ["../heads/main", "*", "", "paused/../../heads/main", "refs/heads/main", "unknown/"]) {
      const space = await historySpace(dir, new Set([finished]));
      assert.equal(space.finishedRunTracks, 0, finished);
      assert.equal(space.clearableBytes, 0, finished);
      const cleared = await clearSideTracks(dir, new Set([finished]));
      assert.equal(cleared.removedTracks, 0, finished);
      assert.equal(await refs(dir), before, `${JSON.stringify(finished)} changed no ref`);
    }
  });

  it("reads nothing and clears nothing in a folder that is not a repository of its own", async () => {
    const parent = await gameRepository();
    const inner = path.join(parent.dir, "inner");
    await mkdir(inner);
    await git(parent.dir, ["update-ref", "refs/studio/chat/t/before/m1", "HEAD"]);
    const before = await refs(parent.dir);
    assert.deepEqual(await historySpace(inner, new Set(["done"])), {
      totalBytes: 0,
      clearableBytes: 0,
      recentBytes: 0,
      rewindTracks: 0,
      finishedRunTracks: 0,
    });
    assert.deepEqual(await clearSideTracks(inner, new Set(["done"])), { removedTracks: 0, freedBytes: 0 });
    assert.equal(await refs(parent.dir), before, "the enclosing repository is untouched");
  });
});

describe("a clear in a folder's checkpoint queue", () => {
  it("a checkpoint asked for while a clear runs waits for it", async () => {
    const { dir } = await gameRepository();
    const checkpoints = new ChatCheckpoints(await tmpDir("history-space-indexes-"));
    const order: string[] = [];
    let release: () => void = () => {};
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clearing = checkpoints.exclusive(dir, async () => {
      order.push("clear started");
      await latch;
      order.push("clear ended");
    });
    const taking = checkpoints.take(dir, "t", "m1").then((commit) => {
      order.push("checkpoint taken");
      return commit;
    });
    await sleep(200);
    assert.deepEqual(order, ["clear started"], "the checkpoint waits while the clear runs");
    release();
    await clearing;
    assert.ok(await taking);
    assert.deepEqual(order, ["clear started", "clear ended", "checkpoint taken"]);
  });

  it("after a clear removed what a checkpoint's private index named, the next checkpoint starts afresh", async () => {
    const { dir } = await gameRepository();
    const indexes = await tmpDir("history-space-indexes-");
    const checkpoints = new ChatCheckpoints(indexes);
    await writeFile(path.join(dir, "notes.txt"), randomBytes(2048).toString("hex"));
    const first = await checkpoints.take(dir, "t", "m1");
    assert.ok(first);
    const notes = (await git(dir, ["rev-parse", `${first}:notes.txt`])).trim();
    assert.ok(
      (await readdir(indexes)).some((file) => file.endsWith(".index")),
      "the checkpoint keeps a private index",
    );
    await ageObjects(dir);

    await checkpoints.exclusive(dir, () => clearSideTracks(dir, new Set()));
    assert.equal(await exists(dir, notes), false, "the clear removed the blob only the checkpoint held");
    assert.deepEqual(
      (await readdir(indexes)).filter((file) => file.endsWith(".index")),
      [],
      "and the private index that named it",
    );
    const next = await checkpoints.take(dir, "t", "m2");
    assert.ok(next);
    assert.ok((await git(dir, ["ls-tree", "-r", "--name-only", next])).split("\n").includes("notes.txt"));
    assert.equal(await exists(dir, notes), true, "the next checkpoint wrote it again");
  });
});

/** Poll until `predicate` holds. */
async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("clearing a game's history through the studio", () => {
  let lite: CoreLite;
  let api: Record<string, (input: unknown) => Promise<unknown>>;
  let threadId: string;
  let dir: string;
  const project = "history";
  /** Released to let the test's one delegated session answer. */
  let release: () => void = () => {};

  before(async () => {
    lite = await coreLite();
    api = lite.api() as unknown as typeof api;
    await lite.core.games.scaffold(project);
    dir = lite.core.games.dirFor(project);
    threadId = await lite.core.createGameThread(project);
    lite.core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (_request: DelegateRequest) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {}, sessionId: "s1" };
      },
    } as never);
  });

  after(async () => {
    release();
    await lite.close();
  });

  const call = (method: string, input: unknown): Promise<unknown> => {
    const handler = api[method];
    assert.ok(handler, method);
    return handler(input);
  };
  /** The chat's queue starts answering `messageId`: its checkpoint is taken. */
  const checkpoint = async (messageId: string) => {
    await call("events.append", {
      threadId,
      batch: [customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId })],
    });
    const ref = `refs/studio/chat/${threadId}/before/${messageId}`;
    await until(async () => (await resolves(dir, ref)) !== null, `the checkpoint of ${messageId}`);
    return ref;
  };

  it("clearing waits for the game's work and never races a checkpoint", async () => {
    const working = call("engine.delegate", { engine: "claude-code", project, threadId, prompt: "Build it" });
    await until(async () => (lite.core.activeBuilders()[project] ?? 0) > 0, "the delegation");
    await git(dir, ["update-ref", "refs/studio/chat/t/before/m0", "HEAD"]);
    const held = await refs(dir);
    await assert.rejects(lite.core.clearGameHistory(project), /Wait for this game's work to finish/);
    assert.equal(await refs(dir), held, "no ref changed while the game was busy");
    release();
    await working;
    await until(async () => (lite.core.activeBuilders()[project] ?? 0) === 0, "the delegation's end");

    // A file only a checkpoint holds: once cleared, a next checkpoint must not lean on its blob.
    await writeFile(path.join(dir, "notes.txt"), randomBytes(2048).toString("hex"));
    const first = await checkpoint("msg_one");
    assert.ok((await lite.core.gameHistory(project)).rewindTracks >= 2);
    const cleared = await lite.core.clearGameHistory(project);
    assert.ok(cleared.removedTracks >= 2);
    assert.equal(await resolves(dir, first), null);
    const next = await checkpoint("msg_two");
    const files = await git(dir, ["ls-tree", "-r", "--name-only", next]);
    assert.ok(files.split("\n").includes("notes.txt"), files);
    assert.equal((await lite.core.gameHistory(project)).rewindTracks, 1);
  });

  it("keeps a paused or unknown run's tracks and clears a finished one's", async () => {
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    for (const id of ["run_done", "run_paused", "run_unknown"])
      await git(dir, ["update-ref", `refs/studio/runs/${id}/integration`, head]);
    await lite.core.append(
      [
        customEventData(CustomEvent.RunStarted, { runId: "run_done", project, goal: "a" }),
        customEventData(CustomEvent.RunFinished, { runId: "run_done", project, landed: false }),
        customEventData(CustomEvent.RunStarted, { runId: "run_paused", project, goal: "b" }),
        customEventData(CustomEvent.RunFinished, { runId: "run_paused", project, executionStatus: "paused" }),
      ],
      threadId,
    );
    const space = await lite.core.gameHistory(project);
    assert.equal(space.finishedRunTracks, 1);
    await lite.core.clearGameHistory(project);
    assert.equal(await resolves(dir, "refs/studio/runs/run_done/integration"), null);
    assert.equal(await resolves(dir, "refs/studio/runs/run_paused/integration"), head);
    assert.equal(await resolves(dir, "refs/studio/runs/run_unknown/integration"), head);
  });

  it("answers only for a game it lists", async () => {
    for (const name of ["nope", "../x", "", "HISTORY"]) {
      await assert.rejects(lite.core.gameHistory(name), name);
      await assert.rejects(lite.core.clearGameHistory(name), name);
    }
  });
});

describe("which runs a clear counts as ended", () => {
  const outcome = (state: OutcomeView["state"]): OutcomeView => ({
    state,
    delivered: "none",
    verification: "incomplete",
  });

  it("a run that finished, was cancelled or failed has ended; one running, paused or unknown has not", () => {
    const table: Array<[OutcomeView["state"], boolean]> = [
      ["finished", true],
      ["cancelled", true],
      ["failed", true],
      ["running", false],
      ["paused", false],
      ["unknown", false],
    ];
    for (const [state, ended] of table) assert.equal(outcomeEnded(outcome(state)), ended, state);
  });

  /** A history service over a real repository, with the runs and the work the test names. */
  async function service(items: Array<{ project?: string; runId: string; state: OutcomeView["state"] }>) {
    const repo = await gameRepository();
    const head = (await git(repo.dir, ["rev-parse", "HEAD"])).trim();
    for (const { runId } of items) await git(repo.dir, ["update-ref", `refs/studio/runs/${runId}/integration`, head]);
    const activeRunIds = new Set<string>();
    const core = {
      games: { list: async () => [{ name: "g" }], dirFor: () => repo.dir },
      layout: { scratch: await tmpDir("history-space-scratch-") },
      assertProjectAllowed: async () => {},
      activityItems: async () =>
        items.map(({ project = "g", runId, state }) => ({ project, runId, runOutcome: outcome(state) })),
    };
    const internals = {
      activeDelegations: new Map(),
      activeRunIds,
      rewind: { checkpoints: { exclusive: <T>(_dir: string, work: () => Promise<T>) => work() } },
    };
    return { dir: repo.dir, activeRunIds, history: new HistorySpaceService(core as never, internals as never) };
  }

  it("counts cancelled and failed runs as cleared, and not a finished run that is still going", async () => {
    const { dir, activeRunIds, history } = await service([
      { runId: "run_cancelled", state: "cancelled" },
      { runId: "run_failed", state: "failed" },
      { runId: "run_settling", state: "finished" },
      { runId: "run_paused", state: "paused" },
    ]);
    activeRunIds.add("run_settling");
    assert.equal((await history.space("g")).finishedRunTracks, 2, "the run still going is not counted");
    activeRunIds.clear();
    const cleared = await history.clear("g");
    assert.equal(cleared.removedTracks, 3);
    for (const runId of ["run_cancelled", "run_failed", "run_settling"])
      assert.equal(await resolves(dir, `refs/studio/runs/${runId}/integration`), null, runId);
    assert.ok(await resolves(dir, "refs/studio/runs/run_paused/integration"), "a paused run keeps its track");
  });

  it("refuses while a run of the game, or a run tied to no game yet, is going, and changes no ref", async () => {
    const { dir, activeRunIds, history } = await service([
      { runId: "run_mine", state: "running" },
      { project: "other", runId: "run_other", state: "running" },
      { runId: "run_done", state: "finished" },
    ]);
    const before = await refs(dir);
    activeRunIds.add("run_mine");
    await assert.rejects(history.clear("g"), /Wait for this game's work to finish/, "a run of the game");
    activeRunIds.clear();
    activeRunIds.add("run_untied");
    await assert.rejects(history.clear("g"), /Wait for this game's work to finish/, "a run no record ties to a game");
    assert.equal(await refs(dir), before, "no ref changed");
    activeRunIds.clear();
    activeRunIds.add("run_other");
    const cleared = await history.clear("g");
    assert.equal(cleared.removedTracks, 1, "another game's run does not hold this one");
    assert.equal(await resolves(dir, "refs/studio/runs/run_done/integration"), null);
  });
});

describe("the words for a game's history space", () => {
  it("say the sizes in the largest unit they reach", () => {
    const space = (totalBytes: number, clearableBytes: number, recentBytes = 0) => ({
      totalBytes,
      clearableBytes,
      recentBytes,
      rewindTracks: clearableBytes ? 3 : 0,
      finishedRunTracks: 0,
    });
    assert.match(historySpaceWords(space(3.4 * GB, 1.2 * GB)), /^Version history takes 3\.4 GB\. .*about 1\.2 GB/);
    assert.match(historySpaceWords(space(40 * MB, 12 * MB)), /takes 40 MB\. .*about 12 MB/);
    assert.match(historySpaceWords(space(900 * 1024, 80 * 1024)), /takes 900 KB\. .*about 80 KB/);
    assert.match(historySpaceWords(space(20 * MB, 0)), /^Version history takes 20 MB\. Nothing beside it to clear\./);
    assert.match(
      historySpaceWords(space(40 * MB, 12 * MB, 3 * MB)),
      /Clearing them frees that space\. About 3 MB from the last hour stays until a later clear\./,
    );
    assert.match(
      historySpaceWords({ ...space(40 * MB, 0, 3 * MB), rewindTracks: 0 }),
      /^Version history takes 40 MB\. Nothing beside it to clear now; about 3 MB from the last hour goes at a later clear\.$/,
    );
    assert.match(
      historySpaceWords({ ...space(40 * MB, 12 * MB), rewindTracks: 0 }),
      /^Version history takes 40 MB\. Copies cleared earlier still take about 12 MB of it\. Clearing frees that space\./,
    );
    assert.equal(historyClearedWords({ removedTracks: 4, freedBytes: 1.2 * GB }), "Cleared 1.2 GB.");
    assert.equal(historyClearedWords({ removedTracks: 0, freedBytes: 0 }), HISTORY_WORDS.nothingCleared);
  });

  it("the menu carries the size only once it is known", () => {
    assert.equal(historyMenuSize(null), null);
    assert.equal(
      historyMenuSize({
        totalBytes: GB,
        clearableBytes: 12 * MB,
        recentBytes: 0,
        rewindTracks: 1,
        finishedRunTracks: 0,
      }),
      "12 MB",
    );
  });
});
