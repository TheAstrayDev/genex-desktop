/**
 * The module contract's words (module-contract.ts holds its data): the grammar the lead writes it
 * in, what a refused contract or a refused worker is told, the docs/ARCHITECTURE.md the harness
 * renders from it, and the short pointer a worker's brief carries. The tool schema only points
 * here: every session pays for `DIRECTOR_TOOLS` on every turn, and the grammar is read only by a
 * lead whose contract, or whose loop worker, was refused.
 */
import { shortSha } from "../git.ts";
import { ContractRefusal } from "./module-contract.ts";
import type { ContractModule, ContractProblem, ModuleContract } from "./module-contract.ts";

/** Where the harness writes the contract, relative to the game. */
export const ARCHITECTURE_FILE = "docs/ARCHITECTURE.md";

/** How the contract is written: the plan's `contract` argument. */
export const CONTRACT_GRAMMAR =
  'contract is JSON: {"conventions":["steer +1 = right","car local +Z is forward","metres"],"modules":[{"path":"src/car.js","owner":"<plan part id>","api":["export function stepCar(state, input, dt)"],"state":"car","registers":{"cameras":["chase"],"demos":["drift"],"probes":["car.speed"]}}],"shared":[{"path":"src/state.js","owner":"<plan part id>"}]}. Each path is one file relative to the game with exactly one owner, a part of this plan; api lists what other parts may call; state, registers and shared are optional. A part you only ever run as mode=single can say "mode":"single" in plan workers and is not counted.';

/** What a refused contract is told, by code. */
const REFUSAL_WORDS: Record<ContractRefusal, (detail: string) => string> = {
  [ContractRefusal.NotJson]: (detail) => `contract is not JSON (${detail})`,
  [ContractRefusal.NotObject]: (detail) =>
    `contract and its modules and shared lists must be JSON objects and arrays (${detail})`,
  [ContractRefusal.NoModules]: () => "contract names no modules",
  [ContractRefusal.TooMany]: (detail) => `contract lists too many entries (${detail})`,
  [ContractRefusal.BadPath]: (detail) =>
    `contract path ${detail} is not one file relative to the game (no absolute path, .., glob or .git)`,
  [ContractRefusal.OwnedTwice]: (detail) => `contract gives ${detail} two owners — every path has exactly one`,
  [ContractRefusal.UnknownOwner]: (detail) => `contract owner is not a part of this plan (${detail})`,
};

/** The plan's answer to a refused contract: what is wrong, and the grammar. */
export function contractRefusalWords(problem: ContractProblem): string {
  return `plan: ${REFUSAL_WORDS[problem.code](problem.detail)}. ${CONTRACT_GRAMMAR}`;
}

/** Why a loop worker may not start under a plan of several loop parts, by what is missing. */
export const CONTRACT_GATE = {
  none: (parts: number) =>
    `this plan has ${parts} parts that loop, and no module contract yet: call plan again with contract= so the harness writes ${ARCHITECTURE_FILE} before the workers fork — who owns which module, its API, the conventions. ${CONTRACT_GRAMMAR}`,
  notCommitted: (error: string) =>
    `the module contract could not be committed on the integration branch (${error}) — conclude what is open there, then call plan again with the same contract`,
  forkBefore: (fork: string, contract: string) =>
    `the fork point ${shortSha(fork)} does not contain the module contract (${shortSha(contract)}): fork from integration, or from a commit after it`,
  stubsMissing: (id: string, paths: readonly string[], fork: string) =>
    `the contract gives "${id}" ${paths.join(", ")}, which ${paths.length === 1 ? "does" : "do"} not exist at ${shortSha(fork)}: write the stubs first (each module's API as no-op exports, its cameras, demos and probes registered), commit them on integration, then start "${id}"`,
  ownsOthers: (id: string, claims: ReadonlyArray<{ own: string; path: string; owner: string }>) =>
    `worker "${id}" owns= would reach other parts' modules (${claims.map((c) => `${c.own} → ${c.path}, ${c.owner}'s`).join("; ")}): leave owns= empty to take its contract modules, or name only its own files`,
} as const;

/** What `plan` adds to its answer once the contract is committed: where it is, and the stubs still to write. */
export function contractCommittedWords(
  commit: string,
  missing: readonly string[],
  { lead = false, derived = false }: { lead?: boolean; derived?: boolean } = {},
): string {
  const what = derived
    ? `No contract was given, so the harness wrote one from the plan's owns into ${ARCHITECTURE_FILE}`
    : `The module contract is committed on integration as ${ARCHITECTURE_FILE}`;
  const at = `${what} (${shortSha(commit)}); loop workers fork from it or later.`;
  if (!missing.length) return at;
  const hands = lead
    ? "start one worker with mode=single from=integration to write them, then integrate it"
    : "write them with your own hands in the integration worktree and commit, or start one worker with mode=single to write them and integrate it";
  return `${at} Stubs still to write before their loop workers start: ${missing.join(", ")} — ${hands}.`;
}

/** One module as ARCHITECTURE.md lists it. */
function moduleLines(module: ContractModule, title: string): string[] {
  const lines = [`### ${module.path} — owned by \`${module.owner}\` (${title})`, ""];
  for (const api of module.api) lines.push(`- api: \`${api}\``);
  if (module.state) lines.push(`- state: \`state.${module.state}\``);
  const registers = module.registers;
  if (registers?.cameras.length) lines.push(`- registers cameras: ${registers.cameras.join(", ")}`);
  if (registers?.demos.length) lines.push(`- registers demos: ${registers.demos.join(", ")}`);
  if (registers?.probes.length) lines.push(`- reports probes: ${registers.probes.join(", ")}`);
  if (lines.length === 2) lines.push("- api: none named yet");
  lines.push("");
  return lines;
}

/**
 * docs/ARCHITECTURE.md, rendered from the contract: pure, the same contract renders the same bytes.
 * `titles` maps a part id to its plan title.
 */
export function renderArchitecture(contract: ModuleContract, titles: Readonly<Record<string, string>> = {}): string {
  const lines = [
    "# Architecture",
    "",
    contract.derived
      ? "The studio wrote this module contract from the build plan's seams. Change it by re-planning, never by editing another part's module."
      : "The module contract of this build, written by the studio from the plan. Change it by re-planning, never by editing another part's module.",
    "",
  ];
  if (contract.conventions.length) lines.push("## Conventions", "", ...contract.conventions.map((c) => `- ${c}`), "");
  lines.push("## Modules", "");
  if (!contract.modules.length) lines.push("No module has a single owner yet.", "");
  for (const module of contract.modules) lines.push(...moduleLines(module, titles[module.owner] ?? module.owner));
  if (contract.shared.length) {
    lines.push("## Shared files", "");
    for (const shared of contract.shared)
      lines.push(`- ${shared.path} — owned by \`${shared.owner}\`; the other parts read it`);
    lines.push("");
  }
  lines.push(
    "## Rules",
    "",
    "- Edit only the modules your part owns; reach another module only through the API listed here.",
    "- A camera, demo or probe listed here stays registered: removing one another part relies on is a regression.",
    "",
  );
  return lines.join("\n");
}

/**
 * The few lines a loop worker's brief carries about the contract: the pointer to the whole file,
 * its own modules' APIs and the conventions — never the whole contract.
 */
export function contractPointer(contract: ModuleContract, modules: readonly ContractModule[]): string {
  const own = modules.map((module) => `${module.path}${module.api.length ? ` (api: ${module.api.join("; ")})` : ""}`);
  return [
    `MODULE CONTRACT: ${ARCHITECTURE_FILE} names every module, its owner and its API — read it before you build.`,
    own.length ? `Your modules: ${own.join("; ")}. Keep their API and what they register.` : "",
    contract.conventions.length ? `Conventions: ${contract.conventions.join("; ")}.` : "",
    "Never edit another part's module: what you need from it goes through its API, or to the director.",
  ]
    .filter(Boolean)
    .join("\n");
}
