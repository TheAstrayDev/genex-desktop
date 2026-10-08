/**
 * Where the coding CLIs keep a sign-in on this Mac (SEC-3).
 *
 * `~/.codex` holds a ChatGPT refresh token when Codex uses its file store, and `~/.claude` holds
 * Claude Code's settings and transcripts. Studio borrows either as the 'system' login, and
 * `CODEX_HOME` / `CLAUDE_CONFIG_DIR` can move them. No agent process reads or writes any of
 * them: the sandbox denies them, and every contractor is told (Codex) or ruled (Claude) off.
 * One list, so those boundaries cannot drift apart. A CLI still reads its own home — these lists
 * constrain the commands an agent runs, not the CLI process.
 */
import os from "node:os";
import path from "node:path";

/**
 * The person's other sign-in stores under the home folder, by their segments: SSH keys, the
 * keychains, cloud and GitHub logins, `.netrc`. No agent process reads them (`baseDenyRead`), no
 * worker reaches them (the never-touch list) and no plugin folder is or holds one.
 */
export const HOME_SIGN_IN_STORES: readonly (readonly string[])[] = [
  [".ssh"],
  ["Library", "Keychains"],
  [".aws"],
  [".config", "gh"],
  [".netrc"],
];

/**
 * The sign-in homes to protect: both default homes, the homes the environment points at, and any
 * resolved login home the caller names. Never the home folder itself, one of its ancestors or a
 * relative path — denying those would take the whole machine away from every build.
 */
export function credentialHomes(
  logins: ReadonlyArray<string | null | undefined> = [],
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string[] {
  const candidates = [
    path.join(home, ".codex"),
    path.join(home, ".claude"),
    env.CODEX_HOME,
    env.CLAUDE_CONFIG_DIR,
    ...logins,
  ];
  const homeDir = path.resolve(home);
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    const dir = path.resolve(candidate);
    const covers = dir === homeDir || homeDir.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
    if (covers || out.includes(dir)) continue;
    out.push(dir);
  }
  return out;
}
