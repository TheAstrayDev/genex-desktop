/**
 * The unreal-game fixture: the fixture game linked to a stand-in Unreal project inside its own
 * folder, with the Unreal plugin on. Its chat shows the link line (with Undo) and offers the steps
 * card, whose rows come live from the real plugin on this machine. No Unreal is installed or opened:
 * the project file is a stand-in, and opening it is native, so a fixture refuses it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StudioCore } from "../studio-core.ts";

/** The bundled Unreal plugin's id. */
const UNREAL_PLUGIN = "unreal";
/** The stand-in project: an Unreal project file as Unreal 5.8 writes a new Blueprint one. */
const PROJECT_FILE = path.join("unreal", "FixtureGame.uproject");
const PROJECT = { FileVersion: 3, EngineAssociation: "5.8", Category: "", Description: "" };

/** Links the game to its stand-in project and offers the steps card in its chat. */
export async function seedUnrealGame(core: StudioCore, project: { name: string; dir: string }, threadId: string) {
  const file = path.join(project.dir, PROJECT_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(PROJECT, null, 2)}\n`);
  await core.plugins.setEnabled(UNREAL_PLUGIN, true);
  const binding = { project: project.name, directory: project.dir, threadId };
  await core.engineLinks.link(UNREAL_PLUGIN, binding, { project: file, auto: true });
  await core.engineLinks.steps(UNREAL_PLUGIN, binding);
}
