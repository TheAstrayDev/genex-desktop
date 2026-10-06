/** What the round's gate tells a builder about the integration merge. */

/** The facts of a merge the harness could not settle on its own. */
export interface HandMergeFacts {
  /** The integration head to merge. */
  head: string;
  /** Why the harness could not merge it. */
  reason: string;
  /** The conflicted files this part may edit; every other conflicted file is another part's. */
  left: readonly string[];
}

/** How a builder settles a conflicted file another part owns: their side, never an edit. */
const TAKE_THEIRS =
  "belongs to another part: take theirs with `git checkout --theirs -- <file>`, then `git add` it, and never edit it";

/**
 * The note a builder gets when the integration merge needs its hands. It names only the files it
 * may edit: a file another part owns cannot be hand-merged with an edit, so it takes their side.
 */
export function handMergeNote({ head, reason, left }: HandMergeFacts): string {
  const resolve = left.length
    ? `resolve the conflicts in ${left.join(", ")} (this part's files) keeping both sides' work (yours and theirs); any other file that conflicts ${TAKE_THEIRS}`
    : `every file that conflicts ${TAKE_THEIRS}`;
  return `Other facets' accepted work is on commit ${head}. Your worktree could not merge it automatically (${reason}). FIRST run \`git merge ${head}\`, ${resolve}, and commit the merge — then continue with your own checks.`;
}

/** Why a build whose hand merge was left half done is not judged: the files still in conflict. */
export function unresolvedMergeWords(files: readonly string[]): string {
  return `the integration merge was left unfinished — conflicts remain in ${files.join(", ") || "the worktree"}; finish it (resolve, \`git add\`, commit) before the build can be judged`;
}
