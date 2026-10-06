/**
 * The module contract on the integration branch, and the gate that holds loop workers to it (D7).
 *
 * When a plan of two or more looping parts carries a contract, the harness renders it into
 * docs/MODULE-CONTRACT.md (a file of its own, never the game's docs/ARCHITECTURE.md) and commits
 * that one file on the integration branch (`contractOnPlan`). A loop worker under such a plan then
 * starts only from a commit that holds the contract, only when
 * the modules the contract gives it exist there (stubs, written by the lead or a single worker),
 * and only with a seam that leaves the other parts' modules alone; with no seam named it owns its
 * contract modules (`contractAtFork`). A single session, a conflict worker and a plan with one
 * looping part are never held, nor is a night resumed from a journal written before this gate
 * until its lead commits a contract (`NightState.contractLegacy`). A lead that gives no contract is refused twice, and then the harness
 * writes one from the plan's own seams rather than stall the build (`contractBeforeFork`).
 *
 * Its functions take the night explicitly; they are not bound onto it. A new module: workers.ts
 * calls it, and a kept older workers.ts simply never does.
 */
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { GIT, gitExec, headOf, shortFailure, shortSha } from "../git.ts";
import { RunEvent } from "../run-events.ts";
import { commitArg } from "../shell.ts";
import { WorkerMode } from "../outcomes.ts";
import { list } from "./args.ts";
import { conflictMergeOf } from "./conflict-worker.ts";
import {
  ARCHITECTURE_FILE,
  CONTRACT_GATE,
  contractCommittedWords,
  contractPointer,
  renderArchitecture,
} from "./contract-prompts.ts";
import {
  contractPath,
  contractRequired,
  derivedContract,
  loopParts,
  modulesOwnedBy,
  ownsClaimingOthers,
  partOfWorker,
  pathsOwnedBy,
  sameContract,
} from "./module-contract.ts";
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { ModuleContract } from "./module-contract.ts";
import type { Night } from "./night.ts";

/** "No contract" refusals a lead gets before the harness writes one from the plan's seams. */
export const CONTRACT_REFUSALS_BEFORE_DERIVED = 2;
/** The commit message of the contract's commit. */
const CONTRACT_COMMIT_MESSAGE = `studio: module contract (${ARCHITECTURE_FILE})`;
/** Why the contract's commit failed when git said nothing. */
const COMMIT_FAILED = "the commit failed with no message from git";

/** Why the contract file was not written, in the words the lead reads. */
const WRITE_REFUSED = {
  link: (what: string) => `${what} is a symbolic link; the studio writes the contract only inside the game`,
  notFile: (what: string) => `${what} is not a file`,
  outside: "docs/ resolves outside the integration worktree",
} as const;

/** The contract a night holds its loop workers to: the commit that wrote it, and the contract itself. */
export interface NightContract {
  commit: string;
  spec: ModuleContract;
  /**
   * Written right on the run's starting point (its original base, a base head, or a contract
   * written on one): the branch at `commit` holds the start and this document, nothing to land.
   */
  onStart?: boolean;
  /** Written on one of the run's base heads, so it is one too: the fork gate looks at it as a start. */
  baseHead?: boolean;
}

/** A gate's answer: the refusal, or what the worker starts with (its contract seam, when it named none). */
export type ContractGate = { refusal: string } | { refusal?: undefined; owns: string[] | null };

/**
 * Is the worker never held to a contract: a single session, a conflict worker, a plan of one
 * looping part, a night resumed from before the gate whose lead has given none?
 */
function exempt(night: Night, args: AnyRecord, mode: WorkerMode): boolean {
  if (mode !== WorkerMode.Loop || conflictMergeOf(args)) return true;
  if (night.state.contractLegacy === true) return true;
  return !contractRequired(night.state.plan);
}

/** Is this path a symbolic link (false when it does not exist)? */
async function linkAt(file: string): Promise<{ exists: boolean; link: boolean; file: boolean }> {
  try {
    const stat = await lstat(file);
    return { exists: true, link: stat.isSymbolicLink(), file: stat.isFile() };
  } catch {
    return { exists: false, link: false, file: false };
  }
}

/**
 * Write the contract file (`ARCHITECTURE_FILE`) into the worktree, and nowhere else: a `docs` folder or a contract
 * file that is a symbolic link, or a `docs` that resolves outside the worktree, writes nothing.
 * Answers why it did not write, or null.
 */
export async function writeArchitecture(worktree: string, text: string): Promise<string | null> {
  const root = await realpath(worktree);
  const target = path.join(root, ARCHITECTURE_FILE);
  const dir = path.dirname(target);
  const folder = await linkAt(dir);
  if (folder.link) return WRITE_REFUSED.link("docs");
  if (!folder.exists) await mkdir(dir);
  if ((await realpath(dir)) !== dir) return WRITE_REFUSED.outside;
  const file = await linkAt(target);
  if (file.link) return WRITE_REFUSED.link(ARCHITECTURE_FILE);
  if (file.exists && !file.file) return WRITE_REFUSED.notFile(ARCHITECTURE_FILE);
  await writeFile(target, text);
  return null;
}

/**
 * One question to git, its command line built by loop/git.ts: does it answer `expected`? Anything
 * that fails (a bad commit, a dead host) answers no.
 */
async function gitSays(
  ctx: HarnessCtx,
  worktree: string,
  command: () => string,
  label: string,
  expected = "yes",
): Promise<boolean> {
  try {
    const exec = await gitExec(ctx, worktree, command(), { label });
    return exec?.code === 0 && String(exec.stdout ?? "").trim() === expected;
  } catch {
    return false;
  }
}

/** Of `paths`, the ones `commit` does not hold. */
export async function missingAt(
  ctx: HarnessCtx,
  worktree: string,
  commit: string,
  paths: readonly string[],
  label = "module-contract",
): Promise<string[]> {
  const missing: string[] = [];
  for (const file of paths) {
    const exists = () => GIT.catFileExists(commitArg(commit), file);
    if (!(await gitSays(ctx, worktree, exists, label))) missing.push(file);
  }
  return missing;
}

/** Does `commit` hold `contract` (is the contract's commit its ancestor, or itself: nothing in it `commit` lacks)? */
export function holdsContract(
  ctx: HarnessCtx,
  worktree: string,
  contract: string,
  commit: string,
  label = "module-contract",
): Promise<boolean> {
  const lacking = () => GIT.revListCount(commitArg(commit), commitArg(contract));
  return gitSays(ctx, worktree, lacking, label, "0");
}

/** Stage and commit the contract file alone, whatever else is uncommitted there; why it could not, or null. */
async function commitArchitecture(night: Night, label: string): Promise<string | null> {
  const { ctx, integrationWorktree } = night;
  const unchanged = await gitSays(ctx, integrationWorktree, () => GIT.sameAsRev("HEAD", ARCHITECTURE_FILE), label);
  if (unchanged) return null;
  // Staged even where the game's .gitignore covers docs/ (an older git.ts adds it as it always did).
  const stage = GIT.addPath(ARCHITECTURE_FILE, { force: true });
  const commit = GIT.commit(CONTRACT_COMMIT_MESSAGE, { only: [ARCHITECTURE_FILE] });
  const committed = await gitExec(ctx, integrationWorktree, `${stage} && ${commit}`, { label }).catch(
    (error: unknown) => ({ code: 1, stdout: "", stderr: String((error as Error)?.message ?? error) }),
  );
  return committed.code === 0 ? null : shortFailure(committed) || COMMIT_FAILED;
}

/** Is `commit` the run's starting point: its original base, a base head, or a contract written on one? */
function isStart(night: Night, commit: string | null): boolean {
  const { state } = night;
  if (!commit) return false;
  if (commit === night.baseCommit || state.baseHeads.has(commit)) return true;
  return state.contract?.commit === commit && state.contract.onStart === true;
}

/**
 * Is `head` the run's starting point with only the contract written on it? The close has nothing
 * to land there and the art director nothing to judge: docs/ARCHITECTURE.md is not the night's work.
 */
export function contractAloneOnStart(night: Night, head: string | null | undefined): boolean {
  const contract = night.state.contract;
  return Boolean(head && contract?.onStart === true && contract.commit === head);
}

/**
 * The contract's commit changes one document, so it stands where the commit it was written on
 * stood: a starting point stays one (a blank base stage is no broken game), and what the harness
 * knew of its parent — loads or not, the console it logs, what it reported — holds for it too.
 */
function inheritStanding(night: Night, from: string, to: string): void {
  const { state } = night;
  if (state.baseHeads.has(from)) state.baseHeads.add(to);
  const health = state.healthByHead.get(from);
  if (health !== undefined) state.healthByHead.set(to, health);
  const logged = state.consoleByHead.get(from);
  if (logged !== undefined) state.consoleByHead.set(to, logged);
  const seen = state.evidenceByHead.get(from);
  if (seen !== undefined) state.evidenceByHead.set(to, seen);
}

/** The contract the night holds, with where it was written when that was the run's start. */
function nightContract(night: Night, commit: string, spec: ModuleContract, parent: string | null): NightContract {
  const onStart = isStart(night, parent);
  const baseHead = Boolean(parent && night.state.baseHeads.has(parent));
  return { commit, spec, ...(onStart ? { onStart } : {}), ...(baseHead ? { baseHead } : {}) };
}

/**
 * Render the contract into its file (`ARCHITECTURE_FILE`) and commit it on the integration branch: the new
 * head is protected, journalled and on the record, and the night holds its loop workers to it.
 * Answers the commit, or why there is none.
 */
export async function commitContract(
  night: Night,
  spec: ModuleContract,
): Promise<{ commit: string } | { error: string }> {
  const { appendRun, ctx, integrationWorktree, journal, note, protectHead, run, saveJournal, state } = night;
  const label = `director:${run.runId}:module-contract`;
  const titles = Object.fromEntries((state.plan?.workers ?? []).map((part: AnyRecord) => [part.id, part.title]));
  // The commit the contract is written on: what the new head inherits its standing from.
  const parent = await headOf(ctx, integrationWorktree, { label }).catch(() => null);
  const written = await writeArchitecture(integrationWorktree, renderArchitecture(spec, titles)).catch(
    (error: unknown) => String((error as Error)?.message ?? error),
  );
  const failed = written ?? (await commitArchitecture(night, label));
  if (failed) {
    state.contractError = failed;
    return { error: failed };
  }
  const head = await headOf(ctx, integrationWorktree, { label });
  state.contract = nightContract(night, head, spec, parent);
  state.contractError = null;
  if (parent && head !== parent) inheritStanding(night, parent, head);
  // A night resumed from before the gate is held from the contract its lead gave on.
  state.contractLegacy = false;
  if (head !== state.integrationHead) {
    state.integrationHead = head;
    journal.director.integrationHead = head;
    // Workers that follow a closed wave take the contract with it: it is what they are held to.
    if (state.waveHead) state.waveHead = head;
    await protectHead(head);
    await appendRun(RunEvent.DirectorProgress, { head });
  }
  await saveJournal();
  note(`the module contract is ${ARCHITECTURE_FILE} at ${shortSha(head)}`);
  return { commit: head };
}

/** Every path the contract gives an owner. */
const allPaths = (spec: ModuleContract): string[] => [...spec.modules, ...spec.shared].map((entry) => entry.path);

/**
 * The plan's contract, committed when the plan has two or more looping parts and the contract is
 * new or changed: the sentence `plan` adds to its answer, or null when there was nothing to do.
 */
export async function contractOnPlan(night: Night): Promise<string | null> {
  const { ctx, integrationWorktree, state } = night;
  const spec: ModuleContract | null = state.plan?.contract ?? null;
  if (!spec || !contractRequired(state.plan)) return null;
  if (sameContract(state.contract?.spec, spec)) return null;
  const committed = await commitContract(night, spec);
  if ("error" in committed) return CONTRACT_GATE.notCommitted(committed.error);
  const missing = await missingAt(ctx, integrationWorktree, committed.commit, allPaths(spec));
  return contractCommittedWords(committed.commit, missing, {
    lead: Boolean(night.lead),
    worktree: integrationWorktree,
  });
}

/**
 * Before a loop worker's fork point is read: is there a contract to hold it to? Refused while
 * there is none — twice, and then the harness writes one from the plan's seams and commits it, so
 * a lead that never writes one does not stall the build. Answers the refusal, or null.
 */
export async function contractBeforeFork(night: Night, args: AnyRecord, mode: WorkerMode): Promise<string | null> {
  const { ctx, integrationWorktree, note, state } = night;
  if (exempt(night, args, mode) || state.contract) return null;
  // A contract the lead gave that could not be committed is the lead's to give again; one the
  // harness derived is tried again below, so a cause since cleared does not stall every worker.
  if (state.contractError && state.plan?.contract) return CONTRACT_GATE.notCommitted(state.contractError);
  const parts = loopParts(state.plan);
  const refusals = state.contractRefusals ?? 0;
  if (refusals < CONTRACT_REFUSALS_BEFORE_DERIVED) {
    state.contractRefusals = refusals + 1;
    return CONTRACT_GATE.none(parts.length);
  }
  const named = [...new Set(parts.flatMap((part) => part.owns ?? []).map(contractPath))].filter(
    (file): file is string => file !== null,
  );
  const missing = new Set(await missingAt(ctx, integrationWorktree, "HEAD", named));
  const committed = await commitContract(night, derivedContract(parts, new Set(named.filter((f) => !missing.has(f)))));
  if ("error" in committed) return CONTRACT_GATE.derivedNotCommitted(committed.error);
  note(contractCommittedWords(committed.commit, [], { lead: Boolean(night.lead), derived: true }));
  return null;
}

/**
 * Once the fork point is known: does it hold the contract, does it hold this worker's modules, and
 * does the seam it asked for leave the other parts' modules alone? Answers the refusal, or the
 * seam it starts with — its contract paths when it named none (null: what it asked for).
 */
export async function contractAtFork(
  night: Night,
  { id, args, mode, commit }: { id: string; args: AnyRecord; mode: WorkerMode; commit: string | null },
): Promise<ContractGate> {
  const { ctx, integrationWorktree, state } = night;
  const contract = state.contract;
  if (exempt(night, args, mode) || !contract) return { owns: null };
  const part = partOfWorker(state.plan, [id, args.replaces, args.goal]);
  const asked = list(args.owns);
  const claims = ownsClaimingOthers(asked, contract.spec, part);
  if (claims.length) return { refusal: CONTRACT_GATE.ownsOthers(id, claims) };
  if (commit && !(await holdsContract(ctx, integrationWorktree, contract.commit, commit)))
    return { refusal: CONTRACT_GATE.forkBefore(commit, contract.commit) };
  const mine = pathsOwnedBy(contract.spec, part);
  const missing = commit ? await missingAt(ctx, integrationWorktree, commit, mine) : [];
  if (missing.length && commit) return { refusal: CONTRACT_GATE.stubsMissing(id, missing, commit) };
  return { owns: asked.length || !mine.length ? null : mine };
}

/**
 * The seam a loop worker with no `owns=` starts with under the contract: the paths it gives the
 * worker's plan part (what `contractAtFork` defaults its owns to). Empty for a worker the contract
 * does not hold, or when there is no contract yet.
 */
export function contractSeam(night: Night, id: string, args: AnyRecord, mode: WorkerMode): string[] {
  const contract = night.state.contract;
  if (!contract || exempt(night, args, mode)) return [];
  return pathsOwnedBy(contract.spec, partOfWorker(night.state.plan, [id, args.replaces, args.goal]));
}

/** A loop worker's brief with the contract's pointer, its own modules and the conventions — or as it was. */
export function briefWithContract(night: Night, brief: string, candidates: readonly unknown[]): string {
  const contract = night.state.contract;
  if (!contract) return brief;
  const part = partOfWorker(night.state.plan, candidates);
  return `${brief}\n\n${contractPointer(contract.spec, modulesOwnedBy(contract.spec, part))}`;
}
