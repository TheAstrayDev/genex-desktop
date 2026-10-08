/**
 * `atomicWriteText`, the one write-then-rename writer: the MCP connector file, the coding-CLI
 * settings and a local session's transcript all go through it, with the mode they need.
 */
import assert from "node:assert/strict";
import { constants as FS } from "node:fs";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { atomicWriteText, openNoFollow, readRegularFile, renameFolder, replaceFile } from "../../src/substrate/fsx.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Windows keeps only a read-only flag, so there a mode is compared by its owner-write bit alone. */
async function expectMode(file: string, mode: number): Promise<void> {
  const actual = (await stat(file)).mode;
  if (process.platform === "win32") assert.equal((actual & 0o200) !== 0, (mode & 0o200) !== 0);
  else assert.equal(actual & 0o777, mode);
}

/** A rename that fails with `codes`, in order, before it lets the call through; logs every try. */
function flakyRename(codes: string[]) {
  const tries: string[] = [];
  const rename = async (from: string, to: string) => {
    tries.push(`${path.basename(from)}>${path.basename(to)}`);
    const code = codes.shift();
    if (code) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
  };
  return { rename, tries };
}

it("on Windows, a rename over a file another handle holds is tried again (EPERM, EACCES, EBUSY)", async () => {
  // A reader holding the target open makes Windows refuse the rename for a moment (bonsai.test.ts
  // on the runner: EPERM renaming a session transcript over itself).
  const flaky = flakyRename(["EPERM", "EACCES", "EBUSY"]);
  await replaceFile("C:\\s\\.tmp-1", "C:\\s\\a.json", { platform: "win32", rename: flaky.rename, retryDelayMs: 0 });
  assert.equal(flaky.tries.length, 4);
  const stuck = flakyRename(Array(20).fill("EPERM"));
  await assert.rejects(
    replaceFile("C:\\s\\.tmp-1", "C:\\s\\a.json", { platform: "win32", rename: stuck.rename, retryDelayMs: 0 }),
    { code: "EPERM" },
  );
  assert.ok(stuck.tries.length > 1 && stuck.tries.length < 20, "a lasting refusal still fails, after a few tries");
});

it("elsewhere, and for any other error, a failed rename fails at once", async () => {
  const posix = flakyRename(["EPERM"]);
  await assert.rejects(replaceFile("/s/.tmp-1", "/s/a.json", { platform: "darwin", rename: posix.rename }), {
    code: "EPERM",
  });
  assert.equal(posix.tries.length, 1);
  const missing = flakyRename(["ENOENT"]);
  await assert.rejects(replaceFile("C:\\s\\.tmp-1", "C:\\s\\a.json", { platform: "win32", rename: missing.rename }), {
    code: "ENOENT",
  });
  assert.equal(missing.tries.length, 1);
});

it("on Windows, a new folder's rename keeps trying while another app reads its files, within a budget", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  const flaky = flakyRename(["EPERM", "EBUSY", "EACCES"]);
  const absent = async () => false;
  await renameFolder("C:\\p\\.new", "C:\\p\\Game", { platform: "win32", rename: flaky.rename, sleep, exists: absent });
  assert.equal(flaky.tries.length, 4);
  const stuck = flakyRename(Array(10_000).fill("EPERM"));
  waits.length = 0;
  await assert.rejects(
    renameFolder("C:\\p\\.new", "C:\\p\\Game", { platform: "win32", rename: stuck.rename, sleep, exists: absent }),
    { code: "EPERM" },
  );
  const waited = waits.reduce((sum, ms) => sum + ms, 0);
  assert.ok(waited >= 10_000, `keeps trying for several seconds or more (${waited} ms)`);
  assert.ok(stuck.tries.length < 10_000, "and then gives up");
});

it("a folder's rename stops trying once something appears where it was going", async () => {
  const flaky = flakyRename(["EPERM", "EPERM"]);
  let checks = 0;
  const appears = async () => ++checks > 0;
  await assert.rejects(
    renameFolder("C:\\p\\.new", "C:\\p\\Game", {
      platform: "win32",
      rename: flaky.rename,
      sleep: async () => {},
      exists: appears,
    }),
    { code: "EPERM" },
  );
  assert.equal(flaky.tries.length, 1);
});

it("elsewhere, and for any other error, a folder's rename fails at once", async () => {
  for (const [platform, code] of [
    ["darwin", "EPERM"],
    ["win32", "ENOENT"],
  ] as const) {
    const once = flakyRename([code]);
    await assert.rejects(
      renameFolder("/p/.new", "/p/Game", {
        platform,
        rename: once.rename,
        sleep: async () => {},
        exists: async () => false,
      }),
      { code },
    );
    assert.equal(once.tries.length, 1, platform);
  }
});

it("writes the whole text, with the requested mode, and leaves no temp file behind", async () => {
  const dir = await tmpDir("fsx-");
  const file = path.join(dir, "nested", "settings.json");
  await atomicWriteText(file, '{"a":1}', { mode: 0o600 });
  assert.equal(await readFile(file, "utf8"), '{"a":1}');
  await expectMode(file, 0o600);
  // Replacing a file that was readable by others gives the new one the requested mode, not the old.
  await chmod(file, 0o644);
  await atomicWriteText(file, "second", { mode: 0o600 });
  assert.equal(await readFile(file, "utf8"), "second");
  await expectMode(file, 0o600);
  assert.deepEqual(await readdir(path.dirname(file)), ["settings.json"]);
});

it("keeps the default mode without one, and cleans its temp file when the rename fails", async () => {
  const dir = await tmpDir("fsx-");
  const plain = path.join(dir, "plain.txt");
  await atomicWriteText(plain, "x");
  assert.equal((await stat(plain)).mode & 0o777, 0o666 & ~process.umask());
  const taken = path.join(dir, "taken");
  await mkdir(taken);
  await writeFile(path.join(taken, "keep"), "k");
  await assert.rejects(atomicWriteText(taken, "over a folder"));
  assert.deepEqual((await readdir(dir)).sort(), ["plain.txt", "taken"], "no temp file is left beside it");
  assert.equal(await readFile(path.join(taken, "keep"), "utf8"), "k");
});

/** Both ways a link is refused: the platform's O_NOFOLLOW, and the Windows check (no flag). */
const NO_FOLLOW_MODES: Array<[string, number | undefined]> = [
  ["with the platform's O_NOFOLLOW", FS.O_NOFOLLOW],
  ["without O_NOFOLLOW, as on Windows", undefined],
];

for (const [name, noFollow] of NO_FOLLOW_MODES) {
  it(`openNoFollow ${name}: refuses a link, reads and writes a regular file`, async () => {
    const dir = await tmpDir("no-follow-");
    const outside = path.join(dir, "outside.txt");
    await writeFile(outside, "the user's");
    const link = path.join(dir, "link.txt");
    await symlink(outside, link);
    const hostile: Array<[string, number]> = [
      ["read", FS.O_RDONLY],
      ["write", FS.O_WRONLY],
      ["truncate", FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC],
    ];
    for (const [what, flags] of hostile) {
      await assert.rejects(openNoFollow(link, flags, 0o600, noFollow), { code: "ELOOP" }, `${what} through a link`);
    }
    assert.equal(await readFile(outside, "utf8"), "the user's", "the link's target is untouched");

    const own = path.join(dir, "own.txt");
    const created = await openNoFollow(own, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC, 0o600, noFollow);
    await created.writeFile("first, longer");
    await created.close();
    const replaced = await openNoFollow(own, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC, 0o600, noFollow);
    await replaced.writeFile("second");
    await replaced.close();
    assert.equal(await readFile(own, "utf8"), "second", "an own file is truncated and rewritten");
  });
}

it("readRegularFile refuses a link and reads a regular file", async () => {
  const dir = await tmpDir("no-follow-read-");
  await writeFile(path.join(dir, "real.json"), "{}");
  await symlink(path.join(dir, "real.json"), path.join(dir, "link.json"));
  assert.equal((await readRegularFile(path.join(dir, "real.json"), 10)).toString(), "{}");
  await assert.rejects(readRegularFile(path.join(dir, "link.json"), 10), { code: "ELOOP" });
});
