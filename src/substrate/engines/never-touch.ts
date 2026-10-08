/**
 * The never-touch list: what no worker reaches, in any mode, Bypass included. A sign-in (the
 * coding CLIs' homes, the person's other sign-in stores, Genex's own secrets, the keychain),
 * Genex's own data, and every game but the worker's own. The host builds the list from what it
 * knows; this module only judges one tool call against it, lexically and without touching the
 * disk: a file tool by its path fields (a search also by the folder it walks), a shell command by
 * the paths its words name (`~`, `~user`, `~+`, `$HOME`, `$PWD` and `$USER` expanded, `$'…'` and
 * `$"…"` read as the shell quotes them, a glob or another variable by the fixed folder in front of
 * it, a relative path against the folder a `cd` moved to, `sh -c`, `eval`, `$(…)` and backticks
 * followed; on Windows drive, share and Git Bash paths too) and any `security` call. A shell word
 * reaches what it names and everything below it, as a search does: `rm -rf ~/.codex` and `cd ..`
 * reach what those folders hold. A path a program builds while it runs escapes any text screen; in
 * every mode, Bypass included, the worker's box holds those at the OS boundary too
 * (claude-code.ts `workerSandbox`). The hook that carries the verdict into a session, and follows
 * links, is `neverTouchHook` in claude-permissions.ts.
 */
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { isInside } from "../paths.ts";
import { STUDIO_TOOL_PREFIX } from "./studio-tool-prompts.ts";
import type { ScreenedCall } from "./types.ts";

/** What a never-touch root holds, as the refusal names it. */
export const NeverTouchKind = {
  Login: "login",
  GenexData: "genex_data",
  OtherGame: "other_game",
} as const;
export type NeverTouchKind = (typeof NeverTouchKind)[keyof typeof NeverTouchKind];

/** One folder or file no worker reaches, absolute and real. */
export interface NeverTouchRoot {
  path: string;
  kind: NeverTouchKind;
}

/**
 * What a worker never reaches: `roots` (absolute real paths), less the `open` folders inside them
 * it may still use (its own copy under Genex's scratch folder, its run's capture folders, a game
 * kept inside Genex's data).
 */
export interface NeverTouchList {
  roots: NeverTouchRoot[];
  open: string[];
  /**
   * Folders inside the roots it may read but never write: what its own Claude home hands every
   * session of that home (the shell snapshots and environment each command sources, plans, todos).
   */
  readOpen?: string[];
}

/** A call that reaches the list: the kind of root, and the path it named. */
export interface NeverTouchHit {
  kind: NeverTouchKind;
  path: string;
}

/** One path a call names, and whether it searches below it (a search reaches every root it holds). */
export interface ScreenedPath {
  path: string;
  searches: boolean;
  /** The call only reads it (a file tool that reads): a folder open for reading is open to it. */
  reads?: boolean;
}

/** What a worker reads when the list refuses a call. */
const MESSAGE = {
  what: {
    [NeverTouchKind.Login]: "a sign-in or the keychain",
    [NeverTouchKind.GenexData]: "Genex's own data",
    [NeverTouchKind.OtherGame]: "another game",
  } satisfies Record<NeverTouchKind, string>,
  refused: (what: string, where: string) =>
    `Genex never lets a worker reach ${what}: ${where}. Do not retry it or work around it; carry on without it.`,
} as const;

/** The path fields of Claude Code's file tools. */
const PATH_FIELDS = ["file_path", "path", "notebook_path"] as const;
/** The tools that search below a folder: a search reaches whatever it walks. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["Glob", "Grep", "LS"]);
/** The file tools that only read: a folder open for reading is open to them. A command may write anything. */
const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
/** The search whose `pattern` is a path pattern; Grep's is a regex over file contents, never a path. */
const PATH_PATTERN_TOOL = "Glob";
/** Grep's file filter: a path pattern, read by its fixed folder. */
const GREP_GLOB_FIELD = "glob";
/** The shell tool, screened by its command line; a job's command is screened as one of its calls. */
export const SHELL_TOOL = "Bash";
/** The macOS keychain's command line tool: any call of it is a sign-in reached. */
const KEYCHAIN_COMMAND = "security";
/** The word that ends a command's options (`cd -- dir`). */
const OPTIONS_END = "--";
/** What a shell word is split on to find the paths it names (quotes, operators, redirections, `=`). */
const PATH_WORD_SPLIT = /[\s'"`;&|<>=()]+/;
/**
 * A shell word that names a path: absolute, from a home folder, from the folder it stands in
 * (`$PWD`, `$OLDPWD`), `.` or `..` or relative by them, or with a `/`.
 */
const PATH_WORD = /^(?:\/|~|\$\{?(?:HOME|PWD|OLDPWD)\b|\.\.?(?:\/|$))|\//;
/** On Windows also: a drive (`C:\`, `C:/`), a share (`\\server`), or any word with a `\`. */
const WINDOWS_PATH_WORD = /^(?:[A-Za-z]:[\\/]|\\\\)|\\/;
/** A Git Bash drive path (`/c/Users/…`): its drive letter. */
const GIT_BASH_DRIVE = /^\/([A-Za-z])(?=\/|$)/;
/** A word's tilde prefix: `~`, `~+` (the folder it stands in), `~-` (the one before) or `~name` (a user's home). */
const TILDE_PREFIX = /^~([+-]|[A-Za-z0-9._][A-Za-z0-9._-]*)?(?=[/\\]|$)/;
/** The shell variables a path is built from that the screen knows: `$HOME`, `$PWD`, `$USER`, `$LOGNAME`, bare or braced. */
const KNOWN_VARIABLE = /\$(?:\{(HOME|PWD|USER|LOGNAME)\}|(HOME|PWD|USER|LOGNAME)(?![A-Za-z0-9_]))/g;
/**
 * What the screen cannot read in a path: a parameter form of those (`${HOME:-/x}`, `${HOME%/}`),
 * an indirection (`${!x}`), or the folder a `cd` left (`$OLDPWD`).
 */
const UNREADABLE_VARIABLE = /\$\{[#!]?(?:HOME|PWD|OLDPWD|USER|LOGNAME)[^A-Za-z0-9_}]|\$\{?OLDPWD(?![A-Za-z0-9_])|\$\{!/;
/** The first glob character of a pattern: what comes before it is a fixed folder. */
const GLOB_START = /[*?[{]/;
/** The first character of a shell word the shell fills in as it runs: a glob, or a variable the screen does not know. */
const SHELL_FILLED_START = /[*?[{$]/;
/** A word that is only slashes: a path only where a path is read, never a pattern's or a text's. */
const SLASHES_ONLY = /^\/+$/;
/** Commands whose arguments are text, never a path read: a lone `/` there is a character. */
const TEXT_COMMANDS: ReadonlySet<string> = new Set(["echo", "printf", "tr"]);
/** Commands whose first argument is a pattern or a script, never a path: `grep -rn '//' src`. */
const PATTERN_COMMANDS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg", "ag", "sed", "awk", "gawk"]);
/** The quote `$'…'` opens: ANSI-C, whose backslash escapes are decoded. */
const ANSI_QUOTE = "$'";
/** ANSI-C quoting's one-character escapes. */
const ANSI_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["a", "\x07"],
  ["b", "\b"],
  ["e", "\x1b"],
  ["E", "\x1b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
  ["?", "?"],
]);
/** ANSI-C quoting's numbered escapes: octal, `\x`, `\u`, `\U` and a control character (`\cX`). */
const ANSI_CODE = /^(?:([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|c(.))/s;
/** Commands that run the next word as a command (their own options skipped). */
const WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "nice",
  "time",
  "xargs",
  "caffeinate",
  "then",
  "do",
  "else",
  "if",
  "while",
  "until",
  "!",
  "{",
]);
/** Shells whose `-c` argument is itself a command line. */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** A shell variable assignment ahead of a command (`A=1 cmd`). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** What ends a simple command outside quotes: `;`, `&`, `|`, a subshell's brackets, a backtick, a newline. */
const COMMAND_BREAK = /[;&|()`\n]/;
/** What ends a word outside quotes: blanks and redirections. */
const WORD_BREAK = /[\s<>]/;
/** How deep `sh -c`, `eval` and command substitutions are followed into a command line. */
const NESTED_COMMANDS_MAX = 4;
/** The commands that move the folder later relative paths are read against. */
const CHANGES_FOLDER: ReadonlySet<string> = new Set(["cd", "pushd"]);

/** The never-touch roots no open folder sits in: what a deny rule or a brief may name whole. */
export function neverTouchWhole(list: NeverTouchList): string[] {
  const open = [...list.open, ...(list.readOpen ?? [])];
  return list.roots.map((root) => path.resolve(root.path)).filter((root) => !open.some((dir) => isInside(root, dir)));
}

/**
 * The folders of `dirs` a worker may be handed to write: none that is, sits inside or holds a
 * never-touch root outside its open folders. A box that cannot deny inside a writable folder
 * (Codex's) would otherwise open the root with it.
 */
export function writableRoots(
  dirs: readonly string[],
  list: NeverTouchList,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return dirs.filter((dir) => !pathVerdict({ path: dir, searches: true }, list, platform));
}

/** The refusal a worker reads for a hit. */
export function neverTouchReason(hit: NeverTouchHit): string {
  return MESSAGE.refused(MESSAGE.what[hit.kind], hit.path);
}

/** The path rules of a platform: Windows's for Windows, POSIX's for every other. */
function pathsOf(platform: NodeJS.Platform): path.PlatformPath {
  return platform === StudioPlatform.Windows ? path.win32 : path.posix;
}

/** A path as this platform's volumes compare it: macOS and Windows volumes are case-blind. */
function folded(target: string, platform: NodeJS.Platform): string {
  const nfc = target.normalize("NFC");
  return platform === StudioPlatform.Mac || platform === StudioPlatform.Windows ? nfc.toLowerCase() : nfc;
}

/** Whether `target` is `root` or inside it, both already folded. */
function within(root: string, target: string, sep: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The folder a tilde prefix names: the home folder, the one the word stands in, or a user's home beside it. */
function tildeFolder(name: string, base: string, home: string, platform: NodeJS.Platform): string {
  if (!name) return home;
  if (name === "+") return base;
  if (name === "-") throw new TypeError("a path from the folder a cd left, which the screen cannot know");
  const paths = pathsOf(platform);
  return paths.join(paths.dirname(home), name);
}

/** What one of the variables the screen knows holds (`KNOWN_VARIABLE`). */
function variableValue(name: string, base: string, home: string, platform: NodeJS.Platform): string {
  if (name === "HOME") return home;
  if (name === "PWD") return base;
  return pathsOf(platform).basename(home);
}

/**
 * A word as the shell fills in what the screen knows: a tilde prefix, `$HOME`, `$PWD`, `$USER`,
 * and on Windows a Git Bash drive. Throws on a form it cannot read (`UNREADABLE_VARIABLE`).
 */
function expandWord(word: string, base: string, home: string, platform: NodeJS.Platform): string {
  if (UNREADABLE_VARIABLE.test(word)) throw new TypeError("a path built from a variable the screen cannot read");
  const tilde = TILDE_PREFIX.exec(word);
  const named = tilde ? tildeFolder(tilde[1] ?? "", base, home, platform) + word.slice(tilde[0].length) : word;
  const filled = named.replace(KNOWN_VARIABLE, (_match, braced: string | undefined, bare: string | undefined) =>
    variableValue(braced ?? bare ?? "", base, home, platform),
  );
  if (platform !== StudioPlatform.Windows) return filled;
  return filled.replace(GIT_BASH_DRIVE, (_match, drive: string) => `${drive.toUpperCase()}:`);
}

/** A word's path, what the screen knows filled in (`expandWord`) and resolved against the working folder. */
function expanded(word: string, cwd: string, home: string, platform: NodeJS.Platform): string {
  return pathsOf(platform).resolve(cwd, expandWord(word, cwd, home, platform) || ".");
}

/** The folder part of a pattern's fixed front: up to its last separator. */
function fixedFolder(fixed: string): string {
  const cut = Math.max(fixed.lastIndexOf("/"), fixed.lastIndexOf("\\"));
  return fixed.slice(0, cut + 1);
}

/** The fixed folder in front of a pattern's first glob character, when the pattern leaves its folder. */
function patternFolder(pattern: string, base: string, home: string, platform: NodeJS.Platform): string | null {
  const filled = expandWord(pattern, base, home, platform);
  const leaves = pathsOf(platform).isAbsolute(filled) || filled.split(/[/\\]/).includes("..");
  if (!leaves) return null;
  const folder = fixedFolder(filled.split(GLOB_START)[0] ?? "");
  return pathsOf(platform).resolve(base, folder || ".");
}

/** A search's file filter: Glob's `pattern`, Grep's `glob`; a Grep `pattern` is a regex and names no path. */
function searchPattern(call: ScreenedCall): unknown {
  if (call.tool === PATH_PATTERN_TOOL) return call.input.pattern;
  return call.tool === "Grep" ? call.input[GREP_GLOB_FIELD] : undefined;
}

/** A file tool's paths, from its path fields and a search's file filter that leaves its folder. */
function filePaths(call: ScreenedCall, cwd: string, home: string, platform: NodeJS.Platform): ScreenedPath[] {
  const searches = SEARCH_TOOLS.has(call.tool);
  const reads = READ_TOOLS.has(call.tool);
  const named: ScreenedPath[] = [];
  for (const field of PATH_FIELDS) {
    const value = call.input[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new TypeError(`${call.tool}.${field} is not a path`);
    named.push({ path: expanded(value, cwd, home, platform), searches, reads });
  }
  if (!searches) return named;
  const base = named[0]?.path ?? cwd;
  const pattern = searchPattern(call);
  const folder = typeof pattern === "string" ? patternFolder(pattern, base, home, platform) : null;
  return [
    ...named,
    ...(named.length ? [] : [{ path: cwd, searches, reads }]),
    ...(folder ? [{ path: folder, searches, reads }] : []),
  ];
}

/**
 * A shell word's path: what it names, or, when the shell fills part of it in as it runs (a glob, a
 * variable the screen does not know), the fixed folder in front of that, reaching everything below.
 */
function wordPath(word: string, base: string, home: string, platform: NodeJS.Platform): ScreenedPath {
  const filled = expandWord(word, base, home, platform);
  const paths = pathsOf(platform);
  if (!SHELL_FILLED_START.test(filled)) return { path: paths.resolve(base, filled || "."), searches: true };
  const folder = fixedFolder(filled.split(SHELL_FILLED_START)[0] ?? "");
  return { path: paths.resolve(base, folder || "."), searches: true };
}

/**
 * The folder a `cd` moves to, from `base`: its first word that is no option (`--` ends them), the
 * home folder with none.
 */
function movedTo(args: readonly string[], base: string, home: string, platform: NodeJS.Platform): string {
  const target = args.find((word) => !/^-[LPe@]+$/.test(word) && word !== OPTIONS_END);
  if (target === "-") return base;
  return target === undefined ? home : expanded(target, base, home, platform);
}

/** The command lines a simple command runs in turn: an `sh -c` script, `eval`'s words. */
function nestedScripts(words: readonly string[], at: number, fold: (text: string) => string): string[] {
  const name = fold(path.basename(words[at] ?? ""));
  const rest = words.slice(at + 1);
  if (name === "eval") return rest.length ? [rest.join(" ")] : [];
  if (!SHELLS.has(name)) return [];
  const script = rest[rest.findIndex((w) => /^-[a-z]*c[a-z]*$/i.test(w)) + 1];
  return script ? [script] : [];
}

/**
 * The command substitutions of a command line, `$(…)` and backticks, wherever they stand outside
 * single quotes (inside double quotes too, where the lexer keeps them as one word).
 */
function substitutions(command: string): string[] {
  const found: string[] = [];
  let single = false;
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (c === "\\" && !single) i++;
    else if (c === "'") single = !single;
    else if (!single && c === "$" && command.charAt(i + 1) === "(") {
      const end = closingParen(command, i + 2);
      found.push(command.slice(i + 2, end));
      i = end;
    } else if (!single && c === "`") {
      const end = command.indexOf("`", i + 1);
      const stop = end < 0 ? command.length : end;
      found.push(command.slice(i + 1, stop));
      i = stop;
    }
  }
  return found;
}

/** Where the `)` that closes a substitution opened just before `from` stands (the end of the line if none). */
function closingParen(command: string, from: number): number {
  let depth = 1;
  for (let i = from; i < command.length; i++) {
    const c = command.charAt(i);
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return command.length;
}

/** The command lines run inside a command line: its substitutions, and each simple command's script. */
function nestedCommands(command: string, platform: NodeJS.Platform): string[] {
  const fold = (text: string) => folded(text, platform);
  const scripts = simpleCommands(command).flatMap((words) => {
    const at = commandWord(words, fold);
    return at < 0 ? [] : nestedScripts(words, at, fold);
  });
  return [...substitutions(command), ...scripts];
}

/**
 * The words of a simple command that are text, never a path: a lone `/` (or `//`) given to a
 * command whose arguments are text (`tr / _`), or as a search's pattern (`grep -rn '//' src`).
 */
function textWords(words: readonly string[], at: number, fold: (text: string) => string): Set<number> {
  if (at < 0) return new Set();
  const name = fold(path.basename(words[at] ?? ""));
  const args = words.map((word, index) => ({ word, index })).slice(at + 1);
  if (TEXT_COMMANDS.has(name))
    return new Set(args.filter(({ word }) => SLASHES_ONLY.test(word)).map(({ index }) => index));
  if (!PATTERN_COMMANDS.has(name)) return new Set();
  const pattern = args.find(({ word }) => !word.startsWith("-"));
  return pattern && SLASHES_ONLY.test(pattern.word) ? new Set([pattern.index]) : new Set();
}

/**
 * Every word of a command line that names a path, resolved against the folder the command stands
 * in (`cd` moves it): each shell word as the shell reads it (a quoted folder with spaces stays
 * whole) and an option's value (`--out=/x`), each reaching what it names and all below it; every
 * other piece of a word as a path alone. Nested command lines are followed; one nested too deep
 * to read throws (the hook refuses it).
 */
function commandPaths(
  command: string,
  cwd: string,
  home: string,
  platform: NodeJS.Platform,
  depth = 0,
): ScreenedPath[] {
  if (depth > NESTED_COMMANDS_MAX) throw new TypeError("a command line nested too deep to screen");
  const fold = (text: string) => folded(text, platform);
  const found: ScreenedPath[] = [];
  let base = cwd;
  for (const words of simpleCommands(command)) {
    const at = commandWord(words, fold);
    const text = textWords(words, at, fold);
    found.push(...words.flatMap((word, index) => (text.has(index) ? [] : wordPaths(word, base, home, platform))));
    // Once a `cd` moved away, a bare name (`.codex`) is a path from where it went, as the shell reads it.
    if (base !== cwd) found.push(...movedArguments(words, at, text, base, home, platform));
    if (at >= 0 && CHANGES_FOLDER.has(fold(words[at] ?? ""))) base = movedTo(words.slice(at + 1), base, home, platform);
  }
  for (const nested of nestedCommands(command, platform))
    found.push(...commandPaths(nested, base, home, platform, depth + 1));
  return found;
}

/**
 * A simple command's arguments as paths from `base`, the folder a `cd` moved to: every word after
 * the command's own that is no option and no text, whether or not it looks like a path.
 */
function movedArguments(
  words: readonly string[],
  at: number,
  text: ReadonlySet<number>,
  base: string,
  home: string,
  platform: NodeJS.Platform,
): ScreenedPath[] {
  if (at < 0) return [];
  return words.flatMap((word, index) => {
    const argument = index > at && !text.has(index) && word && !word.startsWith("-");
    return argument ? [wordPath(word, base, home, platform)] : [];
  });
}

/** Whether a piece of a shell word names a path on this platform. */
function namesPath(piece: string, platform: NodeJS.Platform): boolean {
  return PATH_WORD.test(piece) || (platform === StudioPlatform.Windows && WINDOWS_PATH_WORD.test(piece));
}

/**
 * The paths one shell word names, from `base`: the word and an option's value (`--out=/x`), each
 * reaching what it names and all below it; every other piece of it a path alone. A variable set to
 * a lone `/` (`IFS=/`) names no folder.
 */
function wordPaths(word: string, base: string, home: string, platform: NodeJS.Platform): ScreenedPath[] {
  const assigns = ASSIGNMENT.test(word);
  const values = word.split("=").filter((piece, index) => !(assigns && index > 0 && SLASHES_ONLY.test(piece)));
  const whole = new Set([word, ...values].filter((piece) => piece && namesPath(piece, platform)));
  const pieces = word
    .split(PATH_WORD_SPLIT)
    .filter((piece) => piece && !whole.has(piece) && namesPath(piece, platform));
  return [
    ...[...whole].map((piece) => wordPath(piece, base, home, platform)),
    ...pieces.map((piece) => ({ path: expanded(piece, base, home, platform), searches: false })),
  ];
}

/** The paths a call names; a malformed call throws (the hook refuses it). */
export function screenedPaths(
  call: ScreenedCall,
  cwd: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): ScreenedPath[] {
  if (call.tool.startsWith(STUDIO_TOOL_PREFIX)) return [];
  if (call.tool !== SHELL_TOOL) return filePaths(call, cwd, home, platform);
  const command = call.input.command;
  if (typeof command !== "string") throw new TypeError("Bash.command is not a command line");
  return commandPaths(command, cwd, home, platform);
}

/**
 * The root a path reaches, outside every open folder (and, for a call that only reads, every folder
 * open for reading): the deepest root it is inside (an engine home inside Genex's data is a
 * sign-in), else, for a search, the outermost root it holds.
 */
export function pathVerdict(
  screened: ScreenedPath,
  list: NeverTouchList,
  platform: NodeJS.Platform = process.platform,
): NeverTouchHit | null {
  const paths = pathsOf(platform);
  const target = folded(paths.resolve(screened.path), platform);
  const openDirs = [...list.open, ...(screened.reads ? (list.readOpen ?? []) : [])];
  const open = openDirs.map((dir) => folded(paths.resolve(dir), platform));
  const isOpen = (candidate: string) => open.some((dir) => within(dir, candidate, paths.sep));
  const roots = list.roots
    .map((root) => ({ kind: root.kind, path: root.path, folded: folded(paths.resolve(root.path), platform) }))
    .sort((a, b) => b.folded.length - a.folded.length);
  const inside = roots.find((root) => within(root.folded, target, paths.sep) && !isOpen(target));
  if (inside) return { kind: inside.kind, path: screened.path };
  if (!screened.searches) return null;
  const held = roots.findLast((root) => within(target, root.folded, paths.sep) && !isOpen(root.folded));
  return held ? { kind: held.kind, path: held.path } : null;
}

/** A command line being split into simple commands: the words so far, the open word and quote. */
interface Lexer {
  commands: string[][];
  word: string | null;
  quote: string | null;
}

/** Ends the open word, if any, into the current simple command. */
function endWord(lexer: Lexer): void {
  if (lexer.word !== null) lexer.commands.at(-1)?.push(lexer.word);
  lexer.word = null;
}

/** One ANSI-C escape, from just past its backslash: the text it stands for, and how many characters it took. */
function ansiEscape(command: string, at: number): [text: string, length: number] {
  const c = command.charAt(at);
  const simple = ANSI_ESCAPES.get(c);
  if (simple !== undefined) return [simple, 1];
  const code = ANSI_CODE.exec(command.slice(at));
  if (!code) return [`\\${c}`, c ? 1 : 0];
  const [whole, octal, hex, short, long, control] = code;
  if (control !== undefined) return [String.fromCharCode(control.charCodeAt(0) & 0x1f), whole.length];
  const point = octal ? Number.parseInt(octal, 8) : Number.parseInt(hex ?? short ?? long ?? "", 16);
  if (!Number.isInteger(point) || point > 0x10ffff) throw new TypeError("an ANSI-C escape the screen cannot read");
  return [String.fromCodePoint(point), whole.length];
}

/** One character inside quotes; returns how many characters it took (an escape takes more than one). */
function quoted(lexer: Lexer, command: string, at: number): number {
  const c = command.charAt(at);
  const ansi = lexer.quote === ANSI_QUOTE;
  if (c === (ansi ? "'" : lexer.quote)) {
    lexer.quote = null;
    return 1;
  }
  if (ansi && c === "\\") {
    const [text, length] = ansiEscape(command, at + 1);
    lexer.word = (lexer.word ?? "") + text;
    return 1 + length;
  }
  const escaped = c === "\\" && lexer.quote === '"';
  lexer.word = (lexer.word ?? "") + (escaped ? command.charAt(at + 1) : c);
  return escaped ? 2 : 1;
}

/**
 * The quote a `$` opens outside quotes, `$'…'` (ANSI-C) or `$"…"` (locale), whose `$` is no part of
 * the word; null for any other `$`.
 */
function dollarQuote(c: string, next: string): string | null {
  if (c !== "$") return null;
  if (next === "'") return ANSI_QUOTE;
  return next === '"' ? next : null;
}

/** One character outside quotes; returns how many characters it took. */
function unquoted(lexer: Lexer, command: string, at: number): number {
  const c = command.charAt(at);
  const next = command.charAt(at + 1);
  const opens = dollarQuote(c, next);
  if (opens) {
    lexer.quote = opens;
    lexer.word ??= "";
    return 2;
  }
  if (c === "'" || c === '"') {
    lexer.quote = c;
    lexer.word ??= "";
  } else if (c === "\\") {
    lexer.word = (lexer.word ?? "") + next;
    return 2;
  } else if (COMMAND_BREAK.test(c)) {
    // `$(` opens a command of its own: the `$` is not a word.
    if (c === "(" && lexer.word === "$") lexer.word = null;
    endWord(lexer);
    lexer.commands.push([]);
  } else if (WORD_BREAK.test(c)) endWord(lexer);
  else lexer.word = (lexer.word ?? "") + c;
  return 1;
}

/** A command line's simple commands, as words with quotes removed: split on `;`, `&`, `|`, newlines, subshells. */
function simpleCommands(command: string): string[][] {
  const lexer: Lexer = { commands: [[]], word: null, quote: null };
  let i = 0;
  while (i < command.length) i += lexer.quote ? quoted(lexer, command, i) : unquoted(lexer, command, i);
  endWord(lexer);
  return lexer.commands.filter((words) => words.length);
}

/** The command a simple command runs, past assignments and wrappers (with their options); its index. */
function commandWord(words: string[], fold: (text: string) => string): number {
  let i = 0;
  let wrapped = false;
  while (i < words.length) {
    const word = words[i] ?? "";
    const skipped = ASSIGNMENT.test(word) || WRAPPERS.has(fold(word)) || (wrapped && /^(?:-|\d+$)/.test(word));
    if (!skipped) return i;
    wrapped ||= WRAPPERS.has(fold(word));
    i++;
  }
  return -1;
}

/** Whether a command line calls the keychain tool, followed into `sh -c`, `eval` and substitutions. */
function callsKeychain(command: string, platform: NodeJS.Platform, depth = 0): boolean {
  if (depth > NESTED_COMMANDS_MAX) return true;
  const fold = (text: string) => folded(text, platform);
  for (const words of simpleCommands(command)) {
    const at = commandWord(words, fold);
    if (at >= 0 && fold(path.basename(words[at] ?? "")) === KEYCHAIN_COMMAND) return true;
  }
  return nestedCommands(command, platform).some((nested) => callsKeychain(nested, platform, depth + 1));
}

/**
 * The never-touch verdict on one call, or null when it reaches nothing on the list. `cwd` is the
 * session's working folder, `home` the folder `~` and `$HOME` name. Throws on a call it cannot
 * read (the hook refuses those).
 */
export function neverTouchVerdict(
  call: ScreenedCall,
  list: NeverTouchList,
  cwd: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): NeverTouchHit | null {
  const command = call.tool === SHELL_TOOL ? call.input.command : undefined;
  if (typeof command === "string" && callsKeychain(command, platform))
    return { kind: NeverTouchKind.Login, path: KEYCHAIN_COMMAND };
  for (const screened of screenedPaths(call, cwd, home, platform)) {
    const hit = pathVerdict(screened, list, platform);
    if (hit) return hit;
  }
  return null;
}
