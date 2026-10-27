/**
 * The typed codes a failure crosses IPC with (`IpcResult`'s `code`), so the renderer can tell
 * failures apart without reading their words. Each code's vocabulary lives with its domain; this
 * module only gathers the ones a refusal or failure may name across the boundary.
 */
import { CliInstallRefusal } from "./cli-install.ts";
import { ClaudeLoginRefusal } from "./claude-login.ts";
import { SendFailure } from "./composer.ts";
import { ModelInstallProblem, ModelPullProblem } from "./model-install.ts";
import { ModeSwitchFailure } from "./permissions.ts";

/**
 * A code a failure may carry across IPC: one value of a domain's vocabulary, never words. No two
 * vocabularies here share a value, so a code alone says which failure it was (`error_toast_shown`).
 */
export type StudioErrorCode =
  | CliInstallRefusal
  | ClaudeLoginRefusal
  | SendFailure
  | ModelInstallProblem
  | ModelPullProblem
  | ModeSwitchFailure;

/**
 * The vocabularies above, read when first asked for, so a vocabulary's module may itself import
 * the error helpers.
 */
export const studioErrorVocabularies = (): ReadonlyArray<Readonly<Record<string, StudioErrorCode>>> => [
  CliInstallRefusal,
  ClaudeLoginRefusal,
  SendFailure,
  ModelInstallProblem,
  ModelPullProblem,
  ModeSwitchFailure,
];

let known: ReadonlySet<string> | null = null;

/** Is `value` one of the app's error codes? Anything else (a Node `ENOENT`, words, a path) is not. */
export function isStudioErrorCode(value: unknown): value is StudioErrorCode {
  known ??= new Set(studioErrorVocabularies().flatMap((vocabulary) => Object.values(vocabulary)));
  return typeof value === "string" && known.has(value);
}
