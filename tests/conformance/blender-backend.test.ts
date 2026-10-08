/**
 * The Local Blender backend through its plugin interface, with a recording host: how a tool call
 * becomes a native job (the asset name, the script, a model and extra game files), what it refuses
 * before anything runs, and the guidance it returns for the game's engine.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { activate } from "../../src/plugins/blender/backend.ts";
import { STUDIO_BLENDER_RESULT } from "../../src/plugins/blender/wrapper.ts";
import type { PluginContext, PluginScalar } from "../../src/plugin-sdk/index.d.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MIB = 1024 * 1024;
const PNG = Buffer.from("\x89PNG\r\n\x1a\nfixture", "latin1");
/** A finished job's result line, as the wrapper prints it. */
const MADE = {
  ok: true,
  meshes: [{ name: "Panel", polygons: 6, triangles: 12, materials: ["Steel"] }],
  meshCount: 1,
  polygons: 6,
  triangles: 12,
  size: [4, 0.4, 4],
  framedSize: [4, 0.4, 4],
  materials: ["Steel"],
  armatures: [],
  actions: [],
  glbBytes: 2048,
  renders: ["render.png", "render-front.png"],
  seconds: 0.4,
};

type Call = { method: string; args: Record<string, unknown> };

/** A game folder with a script, a shared module, an image and a model. */
async function game(): Promise<string> {
  const dir = await tmpDir("blender-backend-game-");
  await mkdir(path.join(dir, "assets", "src"), { recursive: true });
  await mkdir(path.join(dir, "assets", "genex", "job-a"), { recursive: true });
  await writeFile(path.join(dir, "assets", "src", "panel.py"), "import bpy\n");
  await writeFile(path.join(dir, "assets", "src", "kit_common.py"), "SIZE = 4\n");
  await writeFile(path.join(dir, "assets", "genex", "job-a", "rust.png"), PNG);
  await writeFile(path.join(dir, "assets", "genex", "job-a", "bike.glb"), "glTF");
  return dir;
}

/** A host that records every call and answers like Studio's for one completed job. */
async function recordingHost(options: { studio?: unknown; made?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const output = await tmpDir("blender-backend-output-");
  for (const file of ["render.png", "render-front.png"]) await writeFile(path.join(output, file), PNG);
  const host = async (method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    if (method === "native.run")
      return {
        id: "job-1",
        recipe: String(args.job),
        runtime: "blender",
        version: "5.2.1",
        state: "completed",
        project: "game",
        output,
        files: ["model.glb", "render.png", "render-front.png"],
        stdout: `${STUDIO_BLENDER_RESULT}${JSON.stringify({ ...MADE, ...options.made })}\n`,
        createdAt: new Date(0).toISOString(),
      };
    if (method === "assets.deliver") return ["assets/blender/job-1/model.glb", "assets/blender/job-1/render.png"];
    if (method === "jobs.write") return true;
    if (method === "project.read" && args.path === "studio.json" && options.studio !== undefined)
      return JSON.stringify(options.studio);
    throw new Error(`No ${method} here`);
  };
  return { calls, host };
}

/** Call `blender__model` the way Studio does, in `directory`. */
async function callModel(
  directory: string,
  args: Record<string, PluginScalar>,
  options: Parameters<typeof recordingHost>[0] = {},
) {
  const { calls, host } = await recordingHost(options);
  const activation = await activate({ call: host as never });
  const ctx = { project: "game", directory, signal: new AbortController().signal, callId: 1, host } as PluginContext;
  const run = activation.tool?.("model", args, ctx) as Promise<Record<string, any>>;
  return { calls, run };
}

const nativeRun = (calls: Call[]) => calls.find((c) => c.method === "native.run")?.args as Record<string, any>;

/** Every path under `dir`, so a refusal can be shown to leave the game as it was. */
async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).map(String).sort();
}

describe("Local Blender model calls", () => {
  it("converts a snake_case or capitalised asset name instead of refusing it, and finds its script", async () => {
    const dir = await game();
    await writeFile(path.join(dir, "assets", "src", "Wall_Panel_4x4.py"), "import bpy\n");
    await writeFile(path.join(dir, "assets", "src", "crate-a.py"), "import bpy\n");
    const rows: Array<[string, string, string]> = [
      ["Wall_Panel_4x4", "wall-panel-4x4", "assets/src/Wall_Panel_4x4.py"],
      ["crate_a", "crate-a", "assets/src/crate-a.py"],
      ["panel", "panel", "assets/src/panel.py"],
      ["dirtbike__front_56", "dirtbike-front-56", "assets/src/dirtbike__front_56.py"],
    ];
    for (const [name, slug, script] of rows) {
      const { calls, run } = await callModel(dir, { name });
      const result = await run;
      assert.equal(nativeRun(calls).values.name, slug, name);
      assert.equal(nativeRun(calls).inputs.script, script, name);
      assert.equal(result.name, slug, `${name}: the result names the asset as it was made`);
    }
  });

  it("still refuses a name that cannot become an asset name, before anything runs", async () => {
    const dir = await game();
    for (const name of ["Dog!", "-lead", "_lead", "", "a".repeat(41), "wall panel", "../x"]) {
      const { calls, run } = await callModel(dir, { name });
      await assert.rejects(run, /asset name/, JSON.stringify(name));
      assert.deepEqual(calls, [], `${JSON.stringify(name)}: no host call`);
    }
  });

  it("runs a model job, a transform job, or a compose job that hands the script extra game files", async () => {
    const dir = await game();
    const model = await callModel(dir, { name: "panel" });
    await model.run;
    assert.deepEqual(nativeRun(model.calls), {
      job: "model",
      inputs: { script: "assets/src/panel.py" },
      values: { name: "panel", rig: "0" },
    });

    const transform = await callModel(dir, {
      name: "bike",
      script: "assets/src/panel.py",
      model: "assets/genex/job-a/bike.glb",
      rig: true,
    });
    await transform.run;
    assert.deepEqual(nativeRun(transform.calls), {
      job: "transform",
      inputs: { script: "assets/src/panel.py", model: "assets/genex/job-a/bike.glb" },
      values: { name: "bike", rig: "1" },
    });

    const compose = await callModel(dir, {
      name: "panel",
      inputs: " assets/src/kit_common.py, assets/genex/job-a/rust.png ",
    });
    await compose.run;
    const composed = nativeRun(compose.calls);
    assert.equal(composed.job, "compose");
    assert.equal(composed.values.inputs, "assets/src/kit_common.py,assets/genex/job-a/rust.png");
    assert.equal(composed.inputs.input1, "assets/src/kit_common.py");
    assert.equal(composed.inputs.input2, "assets/genex/job-a/rust.png");
    for (let slot = 3; slot <= 9; slot++)
      assert.equal(composed.inputs[`input${slot}`], "assets/src/panel.py", "an unused slot carries the script again");

    const both = await callModel(dir, {
      name: "bike",
      script: "assets/src/panel.py",
      model: "assets/genex/job-a/bike.glb",
      inputs: "assets/genex/job-a/rust.png",
    });
    await both.run;
    const withModel = nativeRun(both.calls);
    assert.equal(withModel.values.inputs, "model,assets/genex/job-a/rust.png");
    assert.equal(withModel.inputs.input1, "assets/genex/job-a/bike.glb");
    assert.equal(withModel.inputs.input2, "assets/genex/job-a/rust.png");
  });

  it("refuses an extra input outside the game's assets, through a link, protected or too large, with no side effect", async () => {
    const dir = await game();
    const outside = await tmpDir("blender-backend-outside-");
    await writeFile(path.join(outside, "secret.png"), PNG);
    await mkdir(path.join(outside, "dir"));
    await writeFile(path.join(outside, "dir", "x.png"), PNG);
    await symlink(path.join(outside, "secret.png"), path.join(dir, "assets", "link.png"));
    await symlink(path.join(outside, "dir"), path.join(dir, "assets", "linked"));
    await symlink(path.join(dir, "assets", "genex", "job-a", "rust.png"), path.join(dir, "assets", "inner-link.png"));
    await mkdir(path.join(dir, "assets", "folder.png"));
    await mkdir(path.join(dir, "assets", "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(dir, "assets", "node_modules", "pkg", "x.png"), PNG);
    await writeFile(path.join(dir, "assets", ".hidden.png"), PNG);
    await writeFile(path.join(dir, "assets", "credentials.json"), "{}");
    await writeFile(path.join(dir, "assets", "tool.sh"), "echo\n");
    await mkdir(path.join(dir, "assets", "images"));
    await writeFile(path.join(dir, "assets", "images", "x.py"), "x = 1\n");
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "helper.py"), "x = 1\n");
    await writeFile(path.join(dir, "src", "main.png"), PNG);
    await mkdir(path.join(dir, "assets", "big"));
    await writeFile(path.join(dir, "assets", "big", "huge.png"), "");
    await truncate(path.join(dir, "assets", "big", "huge.png"), 33 * MIB);
    for (const n of [1, 2, 3]) {
      await writeFile(path.join(dir, "assets", "big", `part${n}.png`), "");
      await truncate(path.join(dir, "assets", "big", `part${n}.png`), 30 * MIB);
    }
    await mkdir(path.join(dir, "assets", "a"));
    await mkdir(path.join(dir, "assets", "b"));
    await writeFile(path.join(dir, "assets", "a", "x.png"), PNG);
    await writeFile(path.join(dir, "assets", "b", "x.png"), PNG);
    const many = Array.from({ length: 9 }, (_, i) => `assets/m${i}.png`);
    for (const file of many) await writeFile(path.join(dir, file), PNG);
    const long = `assets/${"l".repeat(110)}.png`;
    await writeFile(path.join(dir, long), PNG);
    const before = await listing(dir);
    const rows: Array<[string, string]> = [
      ["a parent folder", "../outside.png"],
      ["an absolute path", path.join(outside, "secret.png")],
      ["a climb out of assets", "assets/../../outside.png"],
      ["a dot segment", "assets/./genex/job-a/rust.png"],
      ["a backslash", "assets\\genex\\job-a\\rust.png"],
      ["a space", "assets/genex/job-a/rust copy.png"],
      ["a link to a file outside", "assets/link.png"],
      ["a linked folder", "assets/linked/x.png"],
      ["a link inside the game", "assets/inner-link.png"],
      ["a folder", "assets/folder.png"],
      ["dependencies", "assets/node_modules/pkg/x.png"],
      ["a dotfile", "assets/.hidden.png"],
      ["key material", "assets/credentials.json"],
      ["another kind of file", "assets/tool.sh"],
      ["a module outside assets/src", "assets/images/x.py"],
      ["code outside assets", "src/helper.py"],
      ["a picture outside assets", "src/main.png"],
      ["a missing file", "assets/missing.png"],
      ["a file past the size cap", "assets/big/huge.png"],
      ["files past the total cap", "assets/big/part1.png,assets/big/part2.png,assets/big/part3.png"],
      ["two files of one name", "assets/a/x.png,assets/b/x.png"],
      ["too many files", many.join(",")],
      ["a path past the length cap", long],
    ];
    for (const [label, inputs] of rows) {
      const { calls, run } = await callModel(dir, { name: "panel", inputs });
      await assert.rejects(run, /input/i, label);
      assert.deepEqual(calls, [], `${label}: nothing ran and nothing was read through the host`);
    }
    assert.deepEqual(await listing(dir), before, "the game folder is as it was");
  });

  it("guides a web game to its loader, and an Unreal game to Unreal's units, one mesh and its rig", async () => {
    const dir = await game();
    const web = await callModel(dir, { name: "panel" });
    assert.match((await web.run).guidance, /GLTFLoader/);

    const unreal = {
      engine: { kind: "unreal", project: "/Projects/Game/Game.uproject", linkedAt: "2026-10-01T00:00:00Z" },
    };
    const single = await callModel(dir, { name: "panel" }, { studio: unreal });
    const guidance = String((await single.run).guidance);
    assert.doesNotMatch(guidance, /GLTFLoader/);
    assert.match(guidance, /centimetres/);
    assert.match(guidance, /\+X/);
    assert.doesNotMatch(guidance, /join/i, "one mesh needs no joining");

    const parts = await callModel(
      dir,
      { name: "panel" },
      {
        studio: unreal,
        made: { meshCount: 2, armatures: [{ name: "Armature", bones: 3 }], actions: ["Swing"] },
      },
    );
    const notes = String((await parts.run).guidance);
    assert.match(notes, /join/i, "several meshes: join them for Unreal");
    assert.match(notes, /rig/, "an armature left out: say how to export it");
  });
});
