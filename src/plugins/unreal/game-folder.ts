/**
 * An Unreal project inside a Genex game's folder: New game, made from an open game, puts the
 * project in `<game>/unreal/`, so the game's checkpoints, Rewind and landing cover it. The game's
 * `.gitignore` gets Unreal's scratch and build folders first, so no snapshot sweeps them in. The
 * game folder is the user's, so nothing is written through a link and nothing is replaced.
 */
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CreateError, CreateErrorCode } from "./create-project.ts";

/** The project's folder inside the game. */
export const GAME_PROJECT_FOLDER = "unreal";
/** What the game's ignore file needs for a project inside it: Unreal's scratch, builds and Python caches. */
const UNREAL_IGNORES = [
  `${GAME_PROJECT_FOLDER}/Saved/`,
  `${GAME_PROJECT_FOLDER}/Intermediate/`,
  `${GAME_PROJECT_FOLDER}/DerivedDataCache/`,
  `${GAME_PROJECT_FOLDER}/Binaries/`,
  `${GAME_PROJECT_FOLDER}/Plugins/*/Intermediate/`,
  `${GAME_PROJECT_FOLDER}/Plugins/*/Binaries/`,
  "__pycache__/",
] as const;
const IGNORE_FILE = ".gitignore";

const MESSAGE = {
  HasProject: "This game already has an unreal folder, so New game can't make its project there.",
  IgnoreIsLink: "This game's .gitignore is a link, so Genex won't write through it.",
} as const;

const lstatOrNull = (file: string) => lstat(file).catch(() => null);

/** Refuses a game that already has something at `unreal`, or whose ignore file isn't a plain file. */
export async function assertGameFolderFree(gameDir: string): Promise<void> {
  if (await lstatOrNull(path.join(gameDir, GAME_PROJECT_FOLDER)))
    throw new CreateError(CreateErrorCode.NameTaken, MESSAGE.HasProject);
  const ignore = await lstatOrNull(path.join(gameDir, IGNORE_FILE));
  if (ignore && !ignore.isFile()) throw new CreateError(CreateErrorCode.Link, MESSAGE.IgnoreIsLink);
}

/** Adds the lines a project inside the game needs to its ignore file; what is there stays. */
export async function ignoreUnrealScratch(gameDir: string): Promise<void> {
  await assertGameFolderFree(gameDir);
  const file = path.join(gameDir, IGNORE_FILE);
  const current = await readFile(file, "utf8").catch(() => null);
  const lines = new Set((current ?? "").split(/\r?\n/).map((line) => line.trim()));
  const missing = UNREAL_IGNORES.filter((line) => !lines.has(line));
  if (missing.length === 0) return;
  const before = current === null ? "" : `${current.replace(/\s*$/, "")}\n`;
  await writeFile(file, `${before}${missing.join("\n")}\n`);
}
