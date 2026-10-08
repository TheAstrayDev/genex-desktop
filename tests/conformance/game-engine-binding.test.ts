/**
 * A game's engine record (studio.json `engine`) is what makes Genex treat a game as an Unreal game:
 * the brief, the health check, the Live tab and the Loop all ask it. studio.json sits in the folder
 * agents write, so the record is only believed while its project file is still a regular
 * `.uproject` at exactly the recorded real path, and a refused link changes nothing on disk.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { engineOf, GameEngine, parseEngineBinding, projectName } from "../../src/shared/game-engine.ts";
import {
  EngineLinkError,
  EngineLinkErrorCode,
  readEngineBinding,
  restoreEngineBinding,
  writeEngineBinding,
} from "../../src/substrate/game-engine-binding.ts";
import { tmpDir } from "../helpers/tmp.ts";

const NOW = () => new Date("2026-10-04T12:00:00.000Z");

async function world() {
  const root = await realpath(await tmpDir("studio-engine-"));
  const game = path.join(root, "games", "valley");
  const projects = path.join(root, "Unreal Projects", "Valley");
  await mkdir(game, { recursive: true });
  await mkdir(projects, { recursive: true });
  const project = path.join(projects, "Valley.uproject");
  await writeFile(project, '{"FileVersion":3}\n');
  const studio = path.join(game, "studio.json");
  await writeFile(studio, `${JSON.stringify({ name: "valley", title: "Fog Valley", contractVersion: 1 }, null, 2)}\n`);
  return { root, game, project, studio };
}

test("linking records the project's real path beside everything studio.json already held", async () => {
  const { game, project, studio } = await world();
  const { binding, previous } = await writeEngineBinding(game, project, NOW);
  assert.deepEqual(binding, { kind: GameEngine.Unreal, project, linkedAt: "2026-10-04T12:00:00.000Z" });
  assert.equal(previous, undefined);
  const saved = JSON.parse(await readFile(studio, "utf8"));
  assert.equal(saved.title, "Fog Valley");
  assert.equal(saved.contractVersion, 1);
  assert.deepEqual(await readEngineBinding(game), binding);
  assert.equal(engineOf(binding), GameEngine.Unreal);
  assert.equal(engineOf(undefined), GameEngine.Web);
  assert.equal(projectName(project), "Valley");
});

test("a link through a symbolic link records where it really points", async () => {
  const { root, game, project } = await world();
  const alias = path.join(root, "Alias.uproject");
  await symlink(project, alias);
  const { binding } = await writeEngineBinding(game, alias, NOW);
  assert.equal(binding.project, project);
});

test("hostile project paths are refused and leave studio.json byte-identical", async () => {
  const { root, game, project, studio } = await world();
  const before = await readFile(studio, "utf8");
  const notProject = path.join(root, "notes.txt");
  await writeFile(notProject, "hi");
  const folderNamedProject = path.join(root, "Folder.uproject");
  await mkdir(folderNamedProject);
  const linkToText = path.join(root, "Fake.uproject");
  await symlink(notProject, linkToText);
  const cases: [string, string, EngineLinkErrorCode][] = [
    ["relative", "Unreal Projects/Valley/Valley.uproject", EngineLinkErrorCode.NotProject],
    ["dot-dot", `${path.dirname(project)}/../Valley/Valley.uproject`, EngineLinkErrorCode.NotProject],
    ["not a project", notProject, EngineLinkErrorCode.NotProject],
    ["missing", path.join(root, "Gone.uproject"), EngineLinkErrorCode.Missing],
    ["a folder", folderNamedProject, EngineLinkErrorCode.NotFile],
    ["a link to a text file", linkToText, EngineLinkErrorCode.NotProject],
    ["control characters", `${root}/Bad\nName.uproject`, EngineLinkErrorCode.NotProject],
    ["empty", "", EngineLinkErrorCode.NotProject],
  ];
  for (const [label, file, code] of cases) {
    await assert.rejects(writeEngineBinding(game, file, NOW), (error: unknown) => {
      assert.ok(error instanceof EngineLinkError, label);
      assert.equal(error.code, code, label);
      return true;
    });
    assert.equal(await readFile(studio, "utf8"), before, `${label}: studio.json unchanged`);
  }
});

test("a studio.json that does not parse is never replaced by a link", async () => {
  const { game, project, studio } = await world();
  await writeFile(studio, "{ not json");
  await assert.rejects(writeEngineBinding(game, project, NOW));
  assert.equal(await readFile(studio, "utf8"), "{ not json");
});

test("a record stops holding when its project file is swapped for a link, moved, or deleted", async () => {
  const { root, game, project } = await world();
  await writeEngineBinding(game, project, NOW);
  const elsewhere = path.join(root, "Elsewhere.uproject");
  await writeFile(elsewhere, "{}");

  await rename(project, `${project}.bak`);
  await symlink(elsewhere, project);
  assert.equal(await readEngineBinding(game), undefined, "a link in place of the file");

  await rm(project);
  assert.equal(await readEngineBinding(game), undefined, "deleted");

  await rename(`${project}.bak`, project);
  assert.equal((await readEngineBinding(game))?.project, project, "back where it was");

  const folder = path.dirname(project);
  await rename(folder, `${folder}-real`);
  await symlink(`${folder}-real`, folder);
  assert.equal(await readEngineBinding(game), undefined, "a link in place of a folder on the way");
});

test("records an agent wrote by hand only count when their shape is right", () => {
  const cases: unknown[] = [
    null,
    "unreal",
    [],
    { kind: "godot", project: "/a/b.uproject" },
    { kind: "unreal" },
    { kind: "unreal", project: "b.uproject" },
    { kind: "unreal", project: "/a/../b.uproject" },
    { kind: "unreal", project: "/a/b.umap" },
    { kind: "unreal", project: 42 },
  ];
  for (const raw of cases) assert.equal(parseEngineBinding(raw), undefined, JSON.stringify(raw));
  assert.deepEqual(parseEngineBinding({ kind: "unreal", project: "/a/B.uproject", linkedAt: "nonsense" }), {
    kind: GameEngine.Unreal,
    project: "/a/B.uproject",
    linkedAt: "",
  });
});

test("Undo puts back the record a link replaced, or none", async () => {
  const { root, game, project, studio } = await world();
  const other = path.join(root, "Other.uproject");
  await writeFile(other, "{}");
  const first = await writeEngineBinding(game, project, NOW);
  const second = await writeEngineBinding(game, other, NOW);
  assert.deepEqual(second.previous, first.binding);

  await restoreEngineBinding(game, second.previous);
  assert.deepEqual(await readEngineBinding(game), first.binding);

  await restoreEngineBinding(game, undefined);
  assert.equal(await readEngineBinding(game), undefined);
  const saved = JSON.parse(await readFile(studio, "utf8"));
  assert.equal(saved.engine, undefined);
  assert.equal(saved.title, "Fog Valley");
});
