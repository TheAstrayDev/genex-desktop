/**
 * `app_look` as the agents get it: who is offered it (the chat's own session, a lead and every
 * worker, readers included, in every mode, Plan too), what it answers (the windows on screen, or one
 * window's picture and tree), and what happens while macOS access is missing (the agent is told what
 * the person must turn on, macOS is asked once, and the chat gets one line only the app writes).
 * Real core, fake delegated engines, and the stub port: nothing looks at this Mac's screen.
 */
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { after, describe, it } from "node:test";
import { APP_LOOK_TOOL } from "../../src/main/core/app-look-tool-prompts.ts";
import { customRecord } from "../../src/shared/custom-events.ts";
import type { LiveToolResult } from "../../src/shared/engine-requests.ts";
import { APP_LOOK_TOOL_NAME, type AppLookAccessPayload, AppLookAccessKind } from "../../src/shared/jobs.ts";
import { PERMISSION_MODES, PermissionMode } from "../../src/shared/permissions.ts";
import {
  type AppLookAccessStatus,
  type ScreenAccess,
  ScreenAccessState,
  stubAppLook,
} from "../../src/substrate/app-look.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { CLAUDE, closeWorkerChats, LOCAL, RUN_ID, workerChat } from "../helpers/worker-chat.ts";

/** A case that would hang on a regression fails within this instead. */
const CASE_TIMEOUT_MS = 60_000;
const APP_LOOK_ACCESS = "app_look_access";

after(closeWorkerChats);

/** macOS access as the test sets it, counting Genex's asks. */
function recordingAccess(status: AppLookAccessStatus) {
  let asked = false;
  const asks: number[] = [];
  const access: ScreenAccess = {
    status: () => status,
    asked: async () => asked,
    askOnce: async () => {
      if (asked) return;
      asked = true;
      asks.push(asks.length + 1);
    },
  };
  return { access, asks };
}

/** A game chat whose core looks through the stub, with the access given. */
async function lookChat(access?: ScreenAccess) {
  const chat = await workerChat({ appLook: stubAppLook(), ...(access ? { screenAccess: access } : {}) });
  return { ...chat, gameDir: await realpath(chat.project.dir) };
}
type Chat = Awaited<ReturnType<typeof lookChat>>;

/** The tools a session was handed, by name. */
const toolsOf = (request: DelegateRequest | undefined) => (request?.liveTools ?? []).map((tool) => tool.name).sort();

/** A session briefed with `extra` calls app_look with each of `calls` while its turn runs. */
async function looksIn(
  chat: Chat,
  extra: Record<string, unknown>,
  calls: Array<Record<string, unknown>>,
  engine = CLAUDE,
) {
  const answers: LiveToolResult[] = [];
  let seen: DelegateRequest | undefined;
  chat.whileRunning(async (request) => {
    seen = request;
    for (const args of calls) {
      const answer = await request.onLiveTool?.(APP_LOOK_TOOL_NAME, args);
      if (answer !== undefined) answers.push(answer);
    }
  });
  try {
    await chat.delegate(extra, engine);
  } finally {
    chat.whileRunning(async () => {});
  }
  return { answers, request: seen };
}

const textOf = (answer: LiveToolResult | undefined) => (typeof answer === "string" ? answer : (answer?.text ?? ""));
const imagesOf = (answer: LiveToolResult | undefined) => (typeof answer === "string" ? [] : (answer?.images ?? []));

/** The chat's own session answering a message the person sent now. */
const ownTurn = async (chat: Chat) => ({ chatTurn: { messageId: await chat.personSays() } });

/** A lead of the chat's run that sits in the game folder and leads a build of its own (a web lead). */
async function webLead(chat: Chat) {
  const root = await chat.copyOf(RUN_ID, `integration-${Math.random().toString(16).slice(2)}`);
  return {
    readOnly: true,
    director: {
      runId: RUN_ID,
      threadId: chat.threadId,
      project: chat.game,
      root,
      setup: null,
      tools: [],
      chatSession: true,
    },
  };
}

/** The chat's access rows. */
async function accessRows(chat: Chat): Promise<AppLookAccessPayload[]> {
  return (await chat.core.store.listEvents(chat.threadId)).flatMap((event) => {
    const custom = customRecord(event.data);
    return custom?.event_type === APP_LOOK_ACCESS ? [custom.payload as unknown as AppLookAccessPayload] : [];
  });
}

describe("app_look", () => {
  it("app_look is offered to the chat's own session, a lead and every worker, readers included, in every mode, Plan too", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await lookChat();
    for (const mode of PERMISSION_MODES) {
      await chat.core.setPermissionMode(chat.threadId, mode);
      const seats: Array<[string, Record<string, unknown>]> = [
        ["the chat's own session", await ownTurn(chat)],
        ["a lead", await webLead(chat)],
        ["a writing worker", chat.runWorker()],
        ["a reader worker", chat.runWorker("r1", chat.worktree, { readOnly: true })],
      ];
      for (const [label, brief] of seats) {
        const { request } = await looksIn(chat, brief, []);
        assert.ok(toolsOf(request).includes(APP_LOOK_TOOL_NAME), `${mode}: ${label}`);
      }
    }
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const reader = await looksIn(chat, chat.runWorker("r1", chat.worktree, { readOnly: true }), []);
    assert.deepEqual(toolsOf(reader.request), [APP_LOOK_TOOL_NAME], "a reader gets no other host tool");
    const none: Array<[string, Record<string, unknown>, string?]> = [
      ["an unseated builder", { cwd: chat.worktree }],
      ["the coordinator", { coordinator: { runId: RUN_ID }, readOnly: true }],
      ["the chat's own session on a local model", await ownTurn(chat), LOCAL],
    ];
    for (const [label, brief, engine] of none) {
      const { request } = await looksIn(chat, brief, [], engine);
      assert.ok(!toolsOf(request).includes(APP_LOOK_TOOL_NAME), label);
    }
  });

  it("answers a picture and a tree, and lists windows when asked for none", { timeout: CASE_TIMEOUT_MS }, async () => {
    const chat = await lookChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Plan);
    const { answers } = await looksIn(chat, chat.runWorker("r1", chat.worktree, { readOnly: true }), [
      {},
      { app: "Fixture App" },
      { window: "1" },
      { app: "Nothing Here" },
    ]);
    const [listed, byApp, byId, missing] = answers;
    assert.match(textOf(listed), /1 · Fixture App — Fixture Window/);
    assert.deepEqual(imagesOf(listed), [], "a list has no picture");
    for (const looked of [byApp, byId]) {
      assert.match(textOf(looked), /^Fixture App — Fixture Window \(window 1\)\nAXWindow "Fixture Window"/);
      assert.deepEqual(
        imagesOf(looked).map((image) => image.mimeType),
        ["image/jpeg"],
      );
    }
    assert.match(textOf(missing), /No window on screen matches/);
    assert.equal(typeof missing === "object" && missing.isError, true);
  });

  it("with access missing it tells the agent what the person must turn on, and the chat gets one line", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { access, asks } = recordingAccess({ screen: ScreenAccessState.NotDetermined, accessibility: false });
    const chat = await lookChat(access);
    const { answers } = await looksIn(chat, await ownTurn(chat), [{ app: "Fixture App" }, {}]);
    for (const answer of answers) {
      assert.match(textOf(answer), /Screen Recording and Accessibility for Genex in System Settings/);
      assert.match(textOf(answer), /do not retry until they say it is on/);
      assert.deepEqual(imagesOf(answer), [], "no picture");
    }
    assert.deepEqual(asks, [1], "macOS is asked once");
    assert.deepEqual(await accessRows(chat), [
      { project: chat.game, missing: [AppLookAccessKind.Screen, AppLookAccessKind.Accessibility] },
    ]);
    await looksIn(chat, chat.runWorker(), [{}]);
    assert.equal((await accessRows(chat)).length, 1, "one line per chat");
    const append = chat.api["events.append"];
    assert.ok(append, "the harness's append");
    await assert.rejects(
      append({
        threadId: chat.threadId,
        batch: [{ type: "custom", event_type: APP_LOOK_ACCESS, payload: { project: chat.game, missing: [] } }],
      }),
      "the harness cannot write it",
    );
  });

  it("its spec takes only which window to look at", () => {
    assert.equal(APP_LOOK_TOOL.name, APP_LOOK_TOOL_NAME);
    assert.deepEqual(Object.keys(APP_LOOK_TOOL.parameters.properties ?? {}).sort(), ["app", "window"]);
    assert.deepEqual(APP_LOOK_TOOL.parameters.required ?? [], [], "both are optional");
    assert.match(APP_LOOK_TOOL.description, /cannot click or type/);
  });
});
