import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import {
  NativeJobState,
  NativeRuntimeState,
  PluginService,
  type PluginManifest,
  type PluginNativeResult,
} from "../../src/shared/plugins.ts";
import type { NativeProcessRequest, NativeProcessResult } from "../../src/substrate/plugins/native-process.ts";
import { tmpDir } from "../helpers/tmp.ts";

function manifest(): PluginManifest {
  return {
    apiVersion: 3,
    id: "background-test",
    name: "Background test",
    version: "1.0.0",
    publisher: "Test",
    description: "Synthetic native worker",
    backend: "backend.mjs",
    capabilities: ["native-runtime"],
    tools: [],
    actions: [],
    panels: [],
    skills: [],
    settings: [],
    nativeRuntimes: [
      {
        id: "worker",
        label: "Worker",
        candidates: ["/worker"],
        version: { args: [], pattern: "(1.0.0)", minimum: "1.0.0" },
      },
    ],
    nativeJobs: [
      {
        id: "make",
        runtime: "worker",
        args: [{ source: "output", name: "result.txt" }],
        inputs: [],
        values: {},
        outputs: ["result.txt"],
        timeoutMs: 2100000,
        maxOutputBytes: 1000,
        maxAssetBytes: 4096,
        gpu: true,
      },
    ],
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await tmpDir("native-background-");
  const game = path.join(root, "game");
  await mkdir(game);
  const started = deferred<NativeProcessRequest>();
  const ended = deferred<NativeProcessResult>();
  const finished = deferred<void>();
  const run = async (request: NativeProcessRequest) => {
    started.resolve(request);
    return ended.promise;
  };
  const service = new PluginNativeServices(root, [], run);
  service.detect = async () => ({
    state: NativeRuntimeState.Ready,
    path: "/worker",
    version: "1.0.0",
    detail: "Ready",
  });
  const storage = path.join(root, "storage");
  const binding = { project: "game", directory: game };
  const controller = new AbortController();
  const spec = manifest();
  const events: PluginNativeResult[] = [];
  const call = (method: string, args: unknown, own = binding) =>
    service.call(
      spec,
      root,
      storage,
      method,
      args,
      own,
      { method: "tool", name: "make", signal: controller.signal },
      (event) => {
        const record = event as PluginNativeResult;
        events.push(record);
        if (record.state !== NativeJobState.Running) finished.resolve();
      },
    );
  t.after(async () => {
    ended.resolve({ code: null, signal: null, stdout: "", stderr: "", reason: "cancelled", pid: null });
    await service.stop();
  });
  return { root, storage, spec, service, started, ended, finished, binding, controller, call, events };
}

test("native manifests allow the uniform 35-minute ceiling and reject any excess", () => {
  const spec = manifest();
  assert.equal(validateManifest(spec).nativeJobs?.[0]?.timeoutMs, 2100000);
  const job = spec.nativeJobs?.[0];
  assert.ok(job);
  for (const timeout of [2100001, 0, 999, NaN, Infinity, 1000.5]) {
    job.timeoutMs = timeout;
    assert.throws(() => validateManifest(spec), /timeoutMs/);
  }
});

test("background run returns its durable id, survives the invocation, and uses existing result records", async (t) => {
  const f = await fixture(t);
  const answer = (await f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {}, background: true })) as {
    id: string;
  };
  assert.deepEqual(Object.keys(answer), ["id"]);
  const request = await f.started.promise;
  assert.equal(request.timeoutMs, 2100000);
  assert.equal(request.gpu, true);
  const recordFile = path.join(f.storage, "native-jobs", answer.id, "job.json");
  const initial = JSON.parse(await readFile(recordFile, "utf8"));
  assert.equal(initial.state, NativeJobState.Running);
  f.controller.abort();
  assert.equal(request.signal.aborted, false, "the tool ending does not cancel a background job");
  await writeFile(request.args[0], "asset");
  f.ended.resolve({ code: 0, signal: null, stdout: "ok", stderr: "", reason: "exit", pid: null });
  await f.finished.promise;
  const result = (await f.call(PluginService.NativeResult, { id: answer.id })) as PluginNativeResult;
  assert.equal(result.state, NativeJobState.Completed);
  assert.deepEqual(result.files, ["result.txt"]);
  assert.equal(await readFile(path.join(result.output, "result.txt"), "utf8"), "asset");
  assert.deepEqual(await f.call(PluginService.NativeJobs, {}), [result]);
});

test("foreground execution stays capped at five minutes", async (t) => {
  const f = await fixture(t);
  const pending = f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {} });
  const request = await f.started.promise;
  assert.equal(request.timeoutMs, 300000);
  f.controller.abort();
  assert.equal(request.signal.aborted, true);
  f.ended.resolve({ code: null, signal: "SIGKILL", stdout: "", stderr: "", reason: "cancelled", pid: null });
  assert.equal(((await pending) as PluginNativeResult).state, NativeJobState.Cancelled);
});

test("cancel respects plugin and project ownership, is idempotent, and stops only its job", async (t) => {
  const f = await fixture(t);
  const answer = (await f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {}, background: true })) as {
    id: string;
  };
  const request = await f.started.promise;
  assert.equal(await f.call(PluginService.NativeCancel, { id: answer.id }, { ...f.binding, project: "other" }), false);
  assert.equal(request.signal.aborted, false);
  assert.equal(await f.service.cancelJob(path.join(f.root, "other-plugin"), answer.id), false);
  assert.equal(request.signal.aborted, false);
  await assert.rejects(f.call(PluginService.NativeCancel, { id: "../outside" }), /Invalid job id/);
  assert.equal(await f.call(PluginService.NativeCancel, { id: answer.id }), true);
  assert.equal(request.signal.aborted, true);
  f.ended.resolve({ code: null, signal: "SIGKILL", stdout: "", stderr: "", reason: "cancelled", pid: null });
  await f.finished.promise;
  assert.equal(
    ((await f.call(PluginService.NativeResult, answer)) as PluginNativeResult).state,
    NativeJobState.Cancelled,
  );
  assert.equal(await f.call(PluginService.NativeCancel, answer), false);
});

test("a restarted host marks running records interrupted without launching anything", async (t) => {
  const f = await fixture(t);
  const id = "12345678-1234-1234-1234-123456789abc";
  const directory = path.join(f.storage, "native-jobs", id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "job.json"),
    JSON.stringify({
      id,
      state: NativeJobState.Running,
      project: "game",
      recipe: "make",
      runtime: "worker",
      output: directory,
      files: [],
      createdAt: new Date().toISOString(),
    }),
  );
  const result = (await f.call(PluginService.NativeResult, { id })) as PluginNativeResult;
  assert.equal(result.state, NativeJobState.Interrupted);
  assert.match(result.reason ?? "", /not replayed/);
  assert.equal(JSON.parse(await readFile(path.join(directory, "job.json"), "utf8")).state, NativeJobState.Interrupted);
});
