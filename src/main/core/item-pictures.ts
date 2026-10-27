/**
 * Studio's own copy of each local draft's picture (`<userData>/item-pictures/<game>/.genex/items/
 * <localId>/<name>`), kept as the CLI wrote it. A Loop's builder lists store items in its build's
 * copy of the game, which reaches the game's own folder only when the build lands, yet the item's
 * card shows its picture at once: the card reads this copy first, then the game's own folder (a
 * draft made before Studio kept copies). The copy sits outside every agent-writable root, and only
 * a plain file in the draft's own folder is copied, never through a link.
 */
import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { isLocalPicture, type LocalListingDraft } from "../../shared/item-draft.ts";
import { assertProjectName } from "../../substrate/game-workspace.ts";
import { readContainedImage } from "../game-assets.ts";

/** The largest picture Studio keeps a copy of: what the card would read at all. */
const KEPT_PICTURE_MAX_BYTES = 16 * 1024 * 1024;
/** Where a local draft's picture lives in a game, and so in its kept copy. */
const LOCAL_ITEMS_PREFIX = ".genex/items/";

/** The kept copies of `project`'s pictures, laid out as the game lays out its drafts. */
function keptFolder(root: string, project: string): string {
  assertProjectName(project);
  return path.join(root, project);
}

/**
 * Keeps `draft`'s picture from `folder`, the CLI's run folder that holds what it just wrote: the
 * draft's earlier copy goes first, so a renamed picture leaves nothing behind. Nothing is kept for a
 * draft with no picture, or one that is not a plain file of a size the card reads.
 */
export async function keepDraftPicture(root: string, folder: string, draft: LocalListingDraft): Promise<void> {
  const file = draft.picture;
  if (!file || !isLocalPicture(file)) return;
  const source = path.join(folder, ...file.split("/"));
  const st = await lstat(source).catch(() => null);
  if (!st?.isFile() || st.size > KEPT_PICTURE_MAX_BYTES) return;
  const kept = keptFolder(root, draft.project);
  const target = path.join(kept, ...file.split("/"));
  await rm(path.dirname(target), { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

/**
 * A local draft's picture for its card: Studio's kept copy, else the game's own folder (`game`).
 * Null for anything that is not a draft's picture or does not read as an image.
 */
export async function readItemPicture(
  where: { root: string; game: string },
  project: string,
  file: string,
  resize: { resize?: (data: Buffer) => Promise<Buffer> } = {},
): Promise<{ mimeType: string; data: string } | null> {
  if (!isLocalPicture(file)) return null;
  const options = { prefixes: [LOCAL_ITEMS_PREFIX], ...resize };
  const kept = await readContainedImage(keptFolder(where.root, project), file, options);
  return kept ?? readContainedImage(where.game, file, options);
}
