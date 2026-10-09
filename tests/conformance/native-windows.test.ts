/** Real Windows native jobs: isolated input/output, no network and bounded process trees. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { windowsBaseEnv } from "../../src/substrate/child-env.ts";
import type { NativeProcessRequest } from "../../src/substrate/plugins/native-process.ts";
import { runNativeProcess } from "../../src/substrate/plugins/native-process.ts";
import {
  BLENDER_RENDER_SIZE,
  BLENDER_WRAPPER_PY,
  STUDIO_BLENDER_RESULT,
  frontRenderPath,
} from "../../src/plugins/blender/wrapper.ts";
import { tmpDir } from "../helpers/tmp.ts";

const exec = promisify(execFile);
const MARKER_POLLS = 500;
const POLL_MS = 20;
const BLENDER = process.env.STUDIO_TEST_BLENDER;
const FBX_HEADER = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "ascii");
// An owned acceptance bundle beside dist/main resolves the helper from shipped resources.
const runProcess: typeof runNativeProcess = process.env.STUDIO_TEST_NATIVE_MODULE
  ? (await import(pathToFileURL(process.env.STUDIO_TEST_NATIVE_MODULE).href)).runNativeProcess
  : runNativeProcess;
const NATIVE_HELPER = process.env.STUDIO_TEST_NATIVE_MODULE
  ? path.resolve(path.dirname(process.env.STUDIO_TEST_NATIVE_MODULE), "../resources/windows-native/windows-native.ps1")
  : fileURLToPath(new URL("../../src/substrate/plugins/windows-native.ps1", import.meta.url));

async function setup() {
  const root = await tmpDir("native-windows-");
  const runtime = path.join(root, "Runtime with spaces");
  const input = path.join(root, "inputs Юникод");
  const output = path.join(root, "output");
  const scratch = path.join(root, "scratch");
  await Promise.all([runtime, input, output, scratch].map((folder) => mkdir(folder)));
  const binary = path.join(runtime, "node.exe");
  await copyFile(process.execPath, binary);
  const run = (code: string, args: string[] = [], patch: Partial<NativeProcessRequest> = {}) =>
    runProcess({
      binary,
      args: ["-e", code, ...args],
      cwd: input,
      scratch,
      reads: [runtime, input],
      writes: [output],
      denyRead: [],
      signal: new AbortController().signal,
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
      ...patch,
    });
  return { root, runtime, input, output, scratch, run };
}

async function marker(file: string) {
  for (let poll = 0; poll < MARKER_POLLS && !existsSync(file); poll++) await delay(POLL_MS);
  assert.ok(existsSync(file), `native child created ${file}`);
}

async function running(pid: number) {
  const { stdout } = await exec("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  return stdout.split("\n").some((line) => line.includes(`"${pid}"`));
}

async function blenderFbxJob(code: string, stagedSource?: string) {
  assert.ok(BLENDER);
  const f = await setup();
  const model = path.join(f.input, "model.py");
  const wrapper = path.join(f.scratch, "wrapper.py");
  const glb = path.join(f.output, "cube.glb");
  const fbx = path.join(f.output, "cube.fbx");
  const png = path.join(f.output, "cube.png");
  await writeFile(model, code);
  await writeFile(wrapper, BLENDER_WRAPPER_PY);
  const input = path.join(f.input, "source.glb");
  if (stagedSource) await copyFile(stagedSource, input);
  const result = await runProcess({
    binary: BLENDER,
    args: [
      "-b",
      "--factory-startup",
      "-noaudio",
      "--python-exit-code",
      "1",
      "--python",
      wrapper,
      "--",
      model,
      glb,
      png,
      "cube",
      ...(stagedSource ? [input] : []),
      "--fbx",
      fbx,
    ],
    cwd: f.input,
    scratch: f.scratch,
    reads: [f.input],
    writes: [f.output],
    denyRead: [],
    gpu: true,
    signal: new AbortController().signal,
    timeoutMs: 60_000,
    maxOutputBytes: 64_000,
  });
  assert.equal(result.code, 0, result.stderr);
  const line = result.stdout.split("\n").find((value) => value.startsWith(STUDIO_BLENDER_RESULT));
  assert.ok(line, result.stdout);
  const info = JSON.parse(line.slice(STUDIO_BLENDER_RESULT.length));
  const bytes = await readFile(fbx);
  assert.equal(info.ok, true);
  assert.equal(info.fbxBytes, bytes.length);
  assert.deepEqual(bytes.subarray(0, FBX_HEADER.length), FBX_HEADER);
  assert.equal((await readFile(glb)).subarray(0, 4).toString("ascii"), "glTF");
  for (const file of [png, frontRenderPath(png)]) {
    const render = await readFile(file);
    assert.equal(render.subarray(1, 4).toString("ascii"), "PNG");
    assert.deepEqual([render.readUInt32BE(16), render.readUInt32BE(20)], [...BLENDER_RENDER_SIZE]);
  }
  return { glb, info };
}

describe("Windows native runtime", { skip: process.platform !== "win32" && "Windows AppContainer only" }, () => {
  it("runs the selected executable with literal spaced arguments and captures both output streams", async () => {
    const f = await setup();
    const before = await exec("icacls.exe", [f.output]);
    const result = await f.run("console.log(process.argv[1]); console.error('stderr-ready')", [
      "a space & literal $value",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /a space & literal \$value/);
    assert.match(result.stderr, /stderr-ready/);
    assert.equal(
      (await exec("icacls.exe", [f.output])).stdout,
      before.stdout,
      "job grants and integrity label are revoked",
    );
    await writeFile(path.join(f.output, "after.txt"), "host-writable");
    assert.equal(await readFile(path.join(f.output, "after.txt"), "utf8"), "host-writable");
  });

  it("reads staged inputs, writes declared outputs, and refuses foreign reads, writes and network", async () => {
    const f = await setup();
    const staged = path.join(f.input, "source.txt");
    const secret = path.join(f.root, "private.txt");
    const foreign = path.join(f.root, "foreign.txt");
    const delivered = path.join(f.output, "asset.txt");
    await writeFile(staged, "input-ready");
    await writeFile(secret, "synthetic-secret");
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.end();
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const code = `
        const fs = require('node:fs');
        const [input, output, secret, foreign, port] = process.argv.slice(1);
        fs.writeFileSync(output, fs.readFileSync(input));
        for (const operation of [() => fs.readFileSync(secret), () => fs.writeFileSync(foreign, 'escaped')]) {
          try { operation(); process.exit(20); } catch (error) { console.log('FILE_DENIED:' + error.code); }
        }
        const socket = require('node:net').createConnection({ host: '127.0.0.1', port: Number(port) });
        socket.on('connect', () => process.exit(21));
        socket.on('error', error => console.log('NETWORK_DENIED:' + error.code));
      `;
      const result = await f.run(code, [staged, delivered, secret, foreign, String(address.port)]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await readFile(delivered, "utf8"), "input-ready");
      assert.equal(existsSync(foreign), false);
      assert.equal((result.stdout.match(/FILE_DENIED:/g) ?? []).length, 2);
      assert.match(result.stdout, /NETWORK_DENIED:EACCES/);
      assert.doesNotMatch(result.stdout, /synthetic-secret/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("two overlapping native jobs cannot use each other's file grants", async () => {
    const first = await setup();
    const second = await setup();
    const secret = path.join(first.input, "source.txt");
    const active = path.join(first.output, "active");
    await writeFile(secret, "first-only");
    const stop = new AbortController();
    const held = first.run(
      "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)",
      [active],
      { signal: stop.signal },
    );
    try {
      await marker(active);
      const result = await second.run(
        "try { require('node:fs').readFileSync(process.argv[1]); process.exit(30); } catch (error) { console.log(error.code); }",
        [secret],
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /EACCES|EPERM/);
    } finally {
      stop.abort();
      assert.equal((await held).reason, "cancelled");
    }
  });

  it("failure to start the executable revokes grants and never retries outside the sandbox", async () => {
    const f = await setup();
    const before = await exec("icacls.exe", [f.output]);
    await assert.rejects(
      f.run("console.log('unexpected')", [], {
        binary: path.join(f.runtime, "missing.exe"),
        binaryRoot: f.runtime,
      }),
      /Start AppContainer native runtime/,
    );
    assert.equal((await exec("icacls.exe", [f.output])).stdout, before.stdout);
    assert.equal((await f.run("console.log('next-job')")).code, 0, "failure leaves the next isolated job usable");
  });

  it("cancellation kills a detached descendant and restores folder permissions", async () => {
    const f = await setup();
    const before = await exec("icacls.exe", [f.output]);
    const pidFile = path.join(f.output, "child.pid");
    const stop = new AbortController();
    const held = f.run(
      `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
      require('node:fs').writeFileSync(process.argv[1], String(child.pid));
      setInterval(() => {}, 1000);
    `,
      [pidFile],
      { signal: stop.signal },
    );
    try {
      await marker(pidFile);
      const pid = Number(await readFile(pidFile, "utf8"));
      assert.ok(await running(pid), "descendant is alive before cancellation");
      stop.abort();
      const result = await held;
      assert.equal(result.reason, "cancelled", result.stderr);
      assert.equal(await running(pid), false, "job object ends even a detached descendant");
      assert.equal((await exec("icacls.exe", [f.output])).stdout, before.stdout);
    } finally {
      stop.abort();
      await held;
    }
  });

  it("a forcibly killed broker restores its exact folder grants and integrity labels", async () => {
    const f = await setup();
    const folders = [f.runtime, f.input, f.output, f.scratch];
    const before = await Promise.all(folders.map(async (folder) => (await exec("icacls.exe", [folder])).stdout));
    const pidFile = path.join(f.output, "broker.json");
    const held = f
      .run(
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,broker:process.ppid})); setInterval(() => {}, 1000)",
        [pidFile],
      )
      .catch((error: unknown) => error);
    await marker(pidFile);
    const { pid, broker } = JSON.parse(await readFile(pidFile, "utf8"));
    const control = (await readdir(f.root)).find((name) => name.startsWith(".native-control-"));
    assert.ok(control);
    const { profile } = JSON.parse(await readFile(path.join(f.root, control, "spec.json"), "utf8"));
    const mappings =
      "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings";
    await exec("reg.exe", ["query", mappings, "/s", "/f", profile, "/d", "/e"]);
    await exec("taskkill.exe", ["/PID", String(broker), "/F"]);
    assert.ok((await held) instanceof Error, "a killed broker cannot report a successful native job");
    assert.equal(await running(pid), false, "kill-on-close stops its native process");
    const after = await Promise.all(folders.map(async (folder) => (await exec("icacls.exe", [folder])).stdout));
    assert.deepEqual(after, before, "abnormal broker exit restores each granted directory");
    assert.equal(
      (await readdir(f.root)).some((name) => name.startsWith(".native-control-")),
      false,
    );
    await assert.rejects(exec("reg.exe", ["query", mappings, "/s", "/f", profile, "/d", "/e"]), { code: 1 });
  });

  it("the native child cannot read the broker specification or forge recovery records", async () => {
    const f = await setup();
    const ready = path.join(f.output, "ready");
    const target = path.join(f.input, "control-path.txt");
    const held = f.run(
      `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[1], 'ready');
      const poll = setInterval(() => {
        if (!fs.existsSync(process.argv[2])) return;
        clearInterval(poll);
        const control = fs.readFileSync(process.argv[2], 'utf8');
        for (const operation of [() => fs.readFileSync(control + '/spec.json'), () => fs.appendFileSync(control + '/grants.log', 'forged')]) {
          try { operation(); process.exit(31); } catch (error) { console.log('CONTROL_DENIED:' + error.code); }
        }
      }, 20);
    `,
      [ready, target],
    );
    await marker(ready);
    const control = (await readdir(f.root)).find((name) => name.startsWith(".native-control-"));
    assert.ok(control);
    await writeFile(target, path.join(f.root, control));
    const result = await held;
    assert.equal(result.code, 0, result.stderr);
    assert.equal((result.stdout.match(/CONTROL_DENIED:EACCES|CONTROL_DENIED:EPERM/g) ?? []).length, 2);
  });

  it("failed broker recovery stays bounded and retains its owned journal for repair", async () => {
    const f = await setup();
    const before = (await exec("icacls.exe", [f.output])).stdout;
    const pidFile = path.join(f.output, "broker.json");
    const held = f
      .run(
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,broker:process.ppid})); setInterval(() => {}, 1000)",
        [pidFile],
      )
      .catch((error: unknown) => error);
    await marker(pidFile);
    const { pid, broker } = JSON.parse(await readFile(pidFile, "utf8"));
    const name = (await readdir(f.root)).find((value) => value.startsWith(".native-control-"));
    assert.ok(name);
    const control = path.join(f.root, name);
    const journal = path.join(control, "grants.log");
    const original = await readFile(journal, "utf8");
    try {
      await writeFile(journal, `${original}invalid-record\n`);
      const started = Date.now();
      await exec("taskkill.exe", ["/PID", String(broker), "/F"]);
      const error = await held;
      assert.ok(error instanceof Error);
      assert.match(error.message, /recovery records are retained/);
      assert.ok(error.message.includes(control));
      assert.ok(Date.now() - started < 10_000, "failed recovery also has a deadline");
      assert.equal(await running(pid), false);
      assert.equal(existsSync(journal), true, "failed recovery does not discard the only original labels");
    } finally {
      await writeFile(journal, original);
      await exec(
        path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          NATIVE_HELPER,
          "-SpecFile",
          path.join(control, "spec.json"),
          "-CleanupOnly",
        ],
        { env: windowsBaseEnv(process.env), timeout: 15_000 },
      );
      assert.equal(
        (await exec("icacls.exe", [f.output])).stdout,
        before,
        "owned failure fixture restores its permissions",
      );
      assert.equal(path.dirname(control), f.root);
      await rm(control, { recursive: true, force: true });
    }
  });

  it("a startup deadline stops an unready broker without launching the runtime or leaving grants", async () => {
    const f = await setup();
    const before = (await exec("icacls.exe", [f.output])).stdout;
    const sideEffect = path.join(f.output, "must-not-run.txt");
    const started = Date.now();
    const timed = await f.run("require('node:fs').writeFileSync(process.argv[1], 'late')", [sideEffect], {
      timeoutMs: 1,
    });
    assert.equal(timed.reason, "timeout");
    assert.equal(timed.pid, null, "no runtime was created before the deadline");
    assert.ok(Date.now() - started < 10_000, "startup timeout also has bounded cleanup");
    assert.equal(existsSync(sideEffect), false, "a cancelled launch cannot run late");
    assert.equal((await exec("icacls.exe", [f.output])).stdout, before, "no temporary grants survive");
    assert.equal(
      (await readdir(f.root)).some((name) => name.startsWith(".native-control-")),
      false,
    );
  });

  it("a timeout is bounded and a normal exit also removes detached descendants", async () => {
    const f = await setup();
    const started = Date.now();
    const timed = await f.run("setInterval(() => {}, 1000)", [], { timeoutMs: 3000 });
    assert.equal(timed.reason, "timeout");
    assert.ok(Date.now() - started < 10_000, "timeout includes bounded sandbox cleanup");
    const result = await f.run(`
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
      console.log(child.pid); child.unref();
    `);
    assert.equal(result.code, 0, result.stderr);
    const pid = Number(result.stdout.trim());
    assert.ok(pid > 0, result.stdout);
    assert.equal(await running(pid), false, "a completed runtime leaves no helper process");
  });

  it("the real Blender wrapper exports GLB and both CPU-rendered thumbnails", {
    skip: !BLENDER && "set STUDIO_TEST_BLENDER to an owned Windows Blender executable",
  }, async () => {
    const f = await setup();
    const model = path.join(f.input, "model.py");
    const wrapper = path.join(f.scratch, "wrapper.py");
    const glb = path.join(f.output, "cube.glb");
    const png = path.join(f.output, "cube.png");
    await writeFile(model, "import bpy\nbpy.ops.mesh.primitive_cube_add()\n");
    await writeFile(wrapper, BLENDER_WRAPPER_PY);
    assert.ok(BLENDER);
    const result = await runProcess({
      binary: BLENDER,
      args: [
        "-b",
        "--factory-startup",
        "-noaudio",
        "--python-exit-code",
        "1",
        "--python",
        wrapper,
        "--",
        model,
        glb,
        png,
        "cube",
      ],
      cwd: f.input,
      scratch: f.scratch,
      reads: [f.input],
      writes: [f.output],
      denyRead: [],
      gpu: true,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      maxOutputBytes: 64_000,
    });
    assert.equal(result.code, 0, result.stderr);
    const line = result.stdout.split("\n").find((value) => value.startsWith(STUDIO_BLENDER_RESULT));
    assert.ok(line, result.stdout);
    const info = JSON.parse(line.slice(STUDIO_BLENDER_RESULT.length));
    assert.equal(info.ok, true);
    assert.equal(info.meshCount, 1);
    assert.equal(info.triangles, 12);
    assert.equal((await readFile(glb)).subarray(0, 4).toString("ascii"), "glTF");
    assert.deepEqual(info.renders, [png, frontRenderPath(png)]);
    for (const file of info.renders) {
      const bytes = await readFile(file);
      assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [...BLENDER_RENDER_SIZE]);
    }
  });

  it("real Blender exports binary FBX and transforms only its staged GLB input inside LPAC", {
    skip: !BLENDER && "set STUDIO_TEST_BLENDER to an owned Windows Blender executable",
  }, async () => {
    const created = await blenderFbxJob("import bpy\nbpy.ops.mesh.primitive_cube_add()\n");
    assert.equal(created.info.meshCount, 1);
    assert.equal(created.info.triangles, 12);
    const transformed = await blenderFbxJob(
      "bpy.ops.import_scene.gltf(filepath=ASSET_INPUTS['model'])\nfor obj in bpy.context.scene.objects:\n    if obj.type == 'MESH': obj.scale = (1, 2, 3)\n",
      created.glb,
    );
    assert.equal(transformed.info.meshCount, 1);
    assert.equal(transformed.info.triangles, 12);
    assert.deepEqual(transformed.info.size, [2, 4, 6]);
  });
});
