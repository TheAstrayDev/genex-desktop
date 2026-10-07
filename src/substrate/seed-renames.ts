/**
 * Names the harness seed renamed. Its code once called a loop run a "night"; the shipped files now
 * say "loop run". A seed upgrade keeps every file the in-app agent edited, and a kept or
 * agent-written file still uses the old names, which the shipped files no longer export or
 * import: the harness would not load. `applySeed` rewrites them in those files before its pass
 * (seed-upgrade.ts `carryRenamesOver`). These tables are the only place the old names remain.
 */
import path from "node:path";

/** Seed modules moved to a new path, by their old workspace-relative path. */
export const RENAMED_SEED_FILES: Readonly<Record<string, string>> = {
  "loop/director/night.ts": "loop/director/loop-run.ts",
  "loop/after-night.ts": "loop/after-loop-run.ts",
  "loop/after-night-prompts.ts": "loop/after-loop-run-prompts.ts",
};

/** Names one seed module exports, or another reads off a shared object, by their old spelling. */
export const RENAMED_SEED_NAMES: Readonly<Record<string, string>> = {
  AfterNight: "AfterLoopRun",
  Night: "LoopRun",
  NightClock: "LoopRunClock",
  NightContract: "LoopRunContract",
  NightData: "LoopRunData",
  NightLogEntry: "LoopRunLogEntry",
  NightShape: "LoopRunShape",
  NightState: "LoopRunState",
  SERVES_AFTER_NIGHT: "SERVES_AFTER_LOOP_RUN",
  afterLeadNight: "afterLeadLoopRun",
  afterNight: "afterLoopRun",
  afterNightGrant: "afterLoopRunGrant",
  afterNightNote: "afterLoopRunNote",
  bindNight: "bindLoopRun",
  closeTheNight: "closeTheLoopRun",
  finishedNight: "finishedLoopRun",
  learnedTonight: "learnedThisRun",
  nightClock: "loopRunClock",
  nightRefusal: "loopRunRefusal",
  nightReport: "loopRunReport",
  ownSessionAfterNight: "ownSessionAfterLoopRun",
  prepareNight: "prepareLoopRun",
  recordNight: "recordLoopRun",
  restoreNight: "restoreLoopRun",
  servesAfterNight: "servesAfterLoopRun",
  tonight: "runLedger",
};

/** Old names that are also plain English: rewritten on code lines, never in a comment line. */
const ENGLISH_NAMES: ReadonlySet<string> = new Set(["Night", "tonight"]);

/** A line that is all comment: `//`, or a block comment's opening or continuation. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** A relative module specifier in quotes. */
const RELATIVE_SPECIFIER = /(["'])(\.{1,2}\/[^"'\n]*)\1/g;

const NAME_RULES = Object.entries(RENAMED_SEED_NAMES).map(([from, to]) => ({
  pattern: new RegExp(`(?<![\\w$])${from}(?![\\w$])`, "g"),
  to,
  english: ENGLISH_NAMES.has(from),
}));

/**
 * The source of the module at `rel` (workspace-relative) with every old name and every specifier
 * of a moved module rewritten. Idempotent: text that uses only the new names comes back unchanged.
 */
export function renameInSource(rel: string, text: string): string {
  return text
    .split("\n")
    .map((line) => renameInLine(rel, line))
    .join("\n");
}

function renameInLine(rel: string, line: string): string {
  const comment = COMMENT_LINE.test(line);
  let out = comment
    ? line
    : line.replace(RELATIVE_SPECIFIER, (whole, quote: string, specifier: string) => {
        const moved = movedSpecifier(rel, specifier);
        return moved === null ? whole : `${quote}${moved}${quote}`;
      });
  for (const rule of NAME_RULES) if (!(comment && rule.english)) out = out.replace(rule.pattern, rule.to);
  return out;
}

/** The specifier the module at `rel` reaches a moved module by, or null when `specifier` names none. */
function movedSpecifier(rel: string, specifier: string): string | null {
  const from = path.posix.dirname(rel);
  const moved = RENAMED_SEED_FILES[path.posix.normalize(path.posix.join(from, specifier))];
  if (!moved) return null;
  const relative = path.posix.relative(from, moved);
  return relative.startsWith(".") ? relative : `./${relative}`;
}
