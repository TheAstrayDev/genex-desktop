/**
 * "Don't wait for me": a worker's question waits for the person by default; only the person can
 * switch that off for a run (the Loop menu, or the one-click card an agent may show), and then a
 * worker's question is refused at once and stays in the chat. The setting is kept on the run, a
 * setting made before a run reaches that run, and the store survives a restart and is never written
 * over when it could not be read. Real core, fake delegated engines, no harness.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { RunSettingsStore } from "../../src/main/run-settings.ts";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { CustomEvent, customEventData, customRecord } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import type { DelegateRequest, PermissionReply } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { closeWorkerChats, RUN_ID, workerAsks, workerChat } from "../helpers/worker-chat.ts";

const OFFER_TOOL = "offer_dont_wait";
const NOT_WAITED = /The person asked not to be waited for in this run, so this was not allowed\. Carry on without it/;
/** A case that would hang on a regression fails within this instead; each case has its own. */
const CASE_TIMEOUT_MS = 60_000;

after(closeWorkerChats);

/** A thread's records of one custom event, payloads only. */
async function recordsOf(core: Awaited<ReturnType<typeof workerChat>>["core"], threadId: string, type: string) {
  return (await core.store.listEvents(threadId)).flatMap((event) => {
    const custom = customRecord(event.data);
    return custom?.event_type === type ? [custom.payload as Record<string, unknown>] : [];
  });
}

/** A store on its own file, with a clock the test moves. */
async function storeAt(name = "run-settings.json") {
  const file = path.join(await tmpDir("dont-wait-store-"), name);
  let now = 0;
  return {
    file,
    store: (clock = () => now) => new RunSettingsStore(file, clock),
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe("don't wait for me", () => {
  it("a worker's question waits by default, and is refused at once once the person switched on don't wait for me, staying in the chat", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, threadId, asking, runWorker, rows } = await workerChat();
    await core.setPermissionMode(threadId, PermissionMode.Manual);
    const bash = { tool: "Bash", input: { command: "npm install" }, always: [] };
    const waits = await asking(bash, runWorker(), workerAsks);
    assert.equal(waits.card.state, "pending", "by default the question waits");
    assert.equal(core.answerPermission(waits.card.requestId, { decision: "allow" }), true);
    await waits.done();

    assert.deepEqual(await core.setDontWait(threadId, true), { on: true, scope: "run" }, "the running run's");
    const set = await recordsOf(core, threadId, "dont_wait_set");
    assert.deepEqual(set, [{ threadId, runId: RUN_ID, on: true }], "the person's act is on the record");

    const refused = await asking(bash, runWorker(), workerAsks);
    const answer = (await refused.done()) as PermissionReply & { message?: string };
    assert.equal(answer.decision, "deny");
    assert.match(answer.message ?? "", NOT_WAITED);
    const kept = (await rows()).filter((row) => row.requestId === refused.card.requestId);
    assert.deepEqual(
      kept.map((row) => [row.state, row.by ?? null]),
      [
        ["pending", null],
        ["denied", "not_waited"],
      ],
      "the question stays in the chat, settled",
    );
    for (const row of kept) assert.deepEqual(row.worker, { id: "w1", title: "Worker w1" }, "naming the worker");

    assert.deepEqual(await core.setDontWait(threadId, false), { on: false, scope: "run" });
    const again = await asking(bash, runWorker(), workerAsks);
    assert.equal(again.card.state, "pending", "switched off, it waits again");
    assert.equal(core.answerPermission(again.card.requestId, { decision: "deny" }), true);
    await again.done();
  });

  it("only the person's act switches it: the harness cannot write its record, and the agent's card only offers it", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, api, threadId, seen, delegate, personSays, runWorker, whileRunning } = await workerChat();
    for (const type of ["dont_wait_set", "dont_wait_offer"]) {
      const payload = { threadId, runId: RUN_ID, on: true, offerId: "forged", project: "x" };
      await assert.rejects(
        api["events.append"]!({ threadId, batch: [{ type: "custom", event_type: type, payload }] }),
        `the harness cannot write ${type}`,
      );
    }
    let said: unknown;
    whileRunning(async (request: DelegateRequest) => {
      said = await request.onLiveTool?.(OFFER_TOOL, { on: true });
    });
    await delegate({ chatTurn: { messageId: await personSays() } });
    const chatsOwn = seen.at(-1)!;
    assert.ok(
      chatsOwn.liveTools?.some((tool) => tool.name === OFFER_TOOL),
      "the chat's own session is offered the card",
    );
    assert.match(String(said), /only the person's click turns it on/);
    const offers = await recordsOf(core, threadId, "dont_wait_offer");
    assert.equal(offers.length, 1, "the card is in the chat");
    assert.equal(offers[0]?.threadId, threadId);
    assert.deepEqual(await core.dontWaitState(threadId), { on: false, scope: "run" }, "the setting stays off");
    assert.deepEqual(await recordsOf(core, threadId, "dont_wait_set"), [], "nothing switched");

    whileRunning(async () => {});
    await delegate(runWorker());
    assert.ok(
      !(seen.at(-1)!.liveTools ?? []).some((tool) => tool.name === OFFER_TOOL),
      "a worker is not offered the card",
    );

    const offerId = String(offers[0]?.offerId);
    assert.deepEqual(await core.setDontWait(threadId, true, offerId), { on: true, scope: "run" }, "the person's click");
    assert.deepEqual((await recordsOf(core, threadId, "dont_wait_set")).at(-1), {
      threadId,
      runId: RUN_ID,
      on: true,
      offerId,
    });
    await core.setDontWait(threadId, true, "an-offer-of-no-card");
    assert.equal((await recordsOf(core, threadId, "dont_wait_set")).at(-1)?.offerId, undefined, "settles no card");

    const studio = String(await api["thread.create"]!({ title: "x" }));
    const hostile: Array<[string, unknown, unknown]> = [
      ["a thread that is no game chat", studio, true],
      ["no thread", undefined, true],
      ["a value that is not a switch", threadId, "yes"],
    ];
    const before = (await recordsOf(core, threadId, "dont_wait_set")).length;
    for (const [label, thread, on] of hostile)
      await assert.rejects(core.setDontWait(thread as string, on as boolean), label);
    assert.equal((await recordsOf(core, threadId, "dont_wait_set")).length, before, "nothing recorded");
  });

  it("a setting made before the run reaches that run, and is kept on the run", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { store, at } = await storeAt();
    const settings = store();
    at(100);
    await settings.setForNextRun("chat-a", true);
    assert.equal(await settings.dontWait("run-old", "chat-a", 50), false, "a run started before the setting");
    assert.equal(await settings.dontWait("run-b", "chat-b", 200), false, "another chat's run");
    assert.equal(await settings.dontWait("run-new", "chat-a", 200), true, "the next run in the chat");
    assert.equal(await settings.dontWait("run-new", "chat-a", 200), true, "kept on that run");
    assert.equal(await settings.dontWait("run-later", "chat-a", 300), false, "and on no later run");
    assert.equal(await settings.nextRun("chat-a"), false, "the next run took it");
    assert.equal(await settings.dontWait("run-new", "chat-b", 200), false, "a run is its own chat's");

    // Through the core: no run going in the chat, so the person's switch is for the next run.
    const { core, game, threadId, startRun } = await workerChat();
    await core.append(
      [{ type: "custom", event_type: "run_finished", payload: { runId: RUN_ID, project: game } }] as never,
      threadId,
    );
    assert.deepEqual(await core.setDontWait(threadId, true), { on: true, scope: "next_run" });
    assert.deepEqual((await recordsOf(core, threadId, "dont_wait_set")).at(-1), { threadId, runId: null, on: true });
    await startRun("run_next");
    assert.deepEqual(await core.dontWaitState(threadId), { on: true, scope: "run" }, "the next run has it");
  });

  it("keeps the setting across a restart, and never writes over a store it could not read", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { file, store, at } = await storeAt();
    at(10);
    await store().setForRun("run-1", "chat-a", true);
    await store().setForNextRun("chat-b", true);
    const restarted = store();
    assert.equal(await restarted.dontWait("run-1", "chat-a", 0), true, "the run's own value");
    assert.equal(await restarted.nextRun("chat-b"), true, "the next run's");

    const saved = await readFile(file, "utf8");
    await chmod(file, 0o000);
    try {
      const blind = store();
      await assert.rejects(blind.setForNextRun("chat-c", true), "an unreadable store is not written");
      await assert.rejects(blind.dontWait("run-1", "chat-a", 0), "nor answered as if empty");
    } finally {
      await chmod(file, 0o600);
    }
    assert.equal(await readFile(file, "utf8"), saved, "unchanged");
    assert.equal(await store().dontWait("run-1", "chat-a", 0), true, "read again once it can be");

    const damaged = "{ not json";
    await writeFile(file, damaged);
    await assert.rejects(store().setForRun("run-2", "chat-a", true), "a damaged store is not written over");
    assert.equal(await readFile(file, "utf8"), damaged);

    const fresh = await storeAt("missing.json");
    assert.equal(await fresh.store().dontWait("run-1", "chat-a", 0), false, "no store: wait, the default");
  });

  it("a worker the chat's own turn started waits for the person even with don't wait for me on", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, project, threadId, delegate, personSays, whileRunning, untilSeen, nextCard, rows } =
      await workerChat();
    await core.setPermissionMode(threadId, PermissionMode.Manual);
    assert.deepEqual(await core.setDontWait(threadId, true), { on: true, scope: "run" });
    const said = await personSays();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answered: Promise<PermissionReply> | undefined;
    whileRunning(async (request) => {
      if (request.permissions) return released;
      answered = workerAsks(request)?.ask(
        { toolUseId: "tu-turn", tool: "Bash", input: { command: "npm install" }, always: [] },
        new AbortController().signal,
      );
      await answered;
    });
    const chat = delegate({ chatTurn: { messageId: said } }).catch(() => null);
    try {
      await untilSeen(1);
      const known = new Set((await rows()).map((row) => row.requestId));
      const worker = delegate({ cwd: project.dir, worker: { id: "t1", title: "Turn worker", turn: said } });
      const card = await nextCard(known);
      assert.equal(card.state, "pending", "it waits: don't wait for me is a run's");
      assert.equal(card.by, undefined);
      assert.equal(core.answerPermission(card.requestId, { decision: "deny" }), true);
      await worker;
      assert.equal((await answered)?.decision, "deny");
    } finally {
      release();
      await chat;
    }
  });

  it("a run worker's question waits when the run settings cannot be read or are damaged", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, threadId, asking, runWorker } = await workerChat();
    await core.setPermissionMode(threadId, PermissionMode.Manual);
    // The person's "don't wait" for this run, on file before the store is first read.
    const file = path.join(core.layout.engineHomes, "run-settings.json");
    const on = JSON.stringify({ version: 1, runs: { [RUN_ID]: { threadId, on: true } }, nextRun: {} });
    await mkdir(path.dirname(file), { recursive: true });
    const bash = { tool: "Bash", input: { command: "npm install" }, always: [] };
    const broken: Array<[string, () => Promise<void>]> = [
      [
        "unreadable",
        async () => {
          await writeFile(file, on);
          await chmod(file, 0o000);
        },
      ],
      [
        "damaged",
        async () => {
          await chmod(file, 0o600);
          await writeFile(file, "{ not json");
        },
      ],
    ];
    try {
      for (const [label, breakIt] of broken) {
        await breakIt();
        const question = await asking(bash, runWorker(), workerAsks);
        assert.equal(question.card.state, "pending", `${label}: the question waits, the default`);
        assert.equal(question.card.by, undefined, `${label}: not refused`);
        assert.equal(core.answerPermission(question.card.requestId, { decision: "deny" }), true, label);
        await question.done();
      }
    } finally {
      await chmod(file, 0o600);
    }
    // Readable again, the person's setting holds: the question is refused at once.
    await writeFile(file, on);
    const refused = await asking(bash, runWorker(), workerAsks);
    assert.equal((await refused.done())?.decision, "deny", "read again, it is the person's word");
  });

  it("a worker seated in Bypass is screened first once its chat moved to a stricter mode; the run settings file is never edited", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, threadId, delegate, runWorker, whileRunning, seen } = await workerChat();
    await core.setPermissionMode(threadId, PermissionMode.Bypass);
    let screened: unknown;
    whileRunning(async (request) => {
      await core.setPermissionMode(threadId, PermissionMode.Manual);
      screened = await request.worker?.asks?.screen({
        tool: "Bash",
        input: { command: "rm -rf build" },
        toolUseId: "tu-s",
      });
    });
    await delegate(runWorker());
    const asks = seen.at(-1)?.worker?.asks;
    assert.equal(asks?.mode, PermissionMode.Bypass, "it runs in the mode it was seated in");
    assert.equal((screened as { askFirst?: boolean } | null)?.askFirst, true, "the chat's stricter mode asks first");
    const files = (asks?.protectWrites ?? []).map((file) => path.basename(file));
    for (const name of ["permissions.json", "run-settings.json"])
      assert.ok(files.includes(name), `${name}: ${files.join(", ")}`);
  });

  it("the card says On once the person's click on it switched it, and each switch is a line in the chat", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    let clock = 0;
    const envelope = (data: EventData): EventEnvelope => {
      clock += 1;
      const at = new Date(clock * 1000).toISOString();
      return { id: String(clock), thread_id: "chat", turn_id: "turn", session_id: null, created_at: at, data };
    };
    const offer = { offerId: "wait_1", threadId: "chat", project: "lantern" };
    const entries = toEntries([
      envelope(customEventData(CustomEvent.DontWaitOffer, offer)),
      // An old or partial record draws nothing.
      envelope(customEventData(CustomEvent.DontWaitOffer, { offerId: "wait_2" })),
      envelope(
        customEventData(CustomEvent.DontWaitSet, { threadId: "chat", runId: "run_1", on: true, offerId: "wait_1" }),
      ),
      envelope(customEventData(CustomEvent.DontWaitSet, { threadId: "chat", runId: null, on: false })),
      envelope(customEventData(CustomEvent.DontWaitSet, { threadId: "chat" })),
    ]);
    const cards = entries.filter((entry) => entry.kind === EntryKind.DontWaitOffer);
    assert.deepEqual(
      cards.map((card) => card.kind === EntryKind.DontWaitOffer && [card.offer, card.on]),
      [[offer, true]],
    );
    const lines = entries.flatMap((entry) => (entry.kind === EntryKind.System ? [entry.text] : []));
    assert.deepEqual(lines, [
      "You turned on Don't wait for me for this run",
      "You turned off Don't wait for me for the next run",
    ]);
  });
});
