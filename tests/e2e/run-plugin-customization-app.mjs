/** Real app/IPC/registry screenshots and geometry; an owned live profile, without starting provider work. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";
import { expect } from "@playwright/test";
import { allocateProfile } from "../../scripts/studio-dev/ownership.mjs";
import { liveLaunchEnv } from "../../scripts/studio-dev/live-env.ts";
import { resolveElectron } from "../../scripts/electron-runtime.mjs";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { PluginCapability, PluginSourceKind } from "../../src/shared/plugins.ts";
import { pluginTheme } from "../helpers/plugin-theme.ts";

const root = process.cwd();
const id = `customization-review-${Date.now()}`;
const buildId = `b-${id}`;
const out = path.join(root, ".studio-dev/evidence", ...(process.env.GITHUB_ACTIONS ? ["windows-tests", id] : [id]));
await mkdir(out, { recursive: true });
const owner = allocateProfile(root, id, "live", null);
const seeds = path.join(out, "seeds");
const pkg = path.join(out, "plugin");
await mkdir(seeds);
await mkdir(pkg);
const pluginId = "theastraydev-review-theme";
const manifest = {
  apiVersion: 3,
  id: pluginId,
  version: "1.0.0",
  name: "Workshop",
  publisher: "TheAstrayDev",
  description: "Disposable theme and New Chat panel for reviewing PR 112.",
  backend: "backend.mjs",
  tools: [],
  actions: [],
  skills: [],
  settings: [],
  capabilities: [PluginCapability.UiCustomization],
  panels: [{ id: "notes", title: "Workspace notes", file: "notes.html", placement: "settings" }],
};
await writeFile(path.join(pkg, "plugin.json"), JSON.stringify(manifest));
await writeFile(path.join(pkg, "backend.mjs"), "export async function activate() { return {}; }\n");
const sdk = await readFile(path.join(root, "src/plugin-sdk/panel.js"), "utf8");
await writeFile(
  path.join(pkg, "notes.html"),
  `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;font:14px system-ui}h2{font-size:18px;margin:0 0 12px}p{line-height:1.6;margin:0;opacity:.8}</style><h2>Your next game starts here</h2><p>Keep an idea close while you build.<br>Start with one scene, one mechanic, one clear goal.</p><script>${sdk}</script><script>async function paint(){const c=await studioPlugin.call('context');document.body.style.background=c.theme.background;document.body.style.color=c.theme.foreground}paint();addEventListener('message',e=>{if(e.data?.type==='studio-plugin-context-changed')paint()})</script>`,
);
const registry = new PluginRegistry(
  path.join(owner.core, "engine-homes/plugins"),
  seeds,
  path.join(root, "src/plugin-sdk/backend.mjs"),
);
await registry.init();
await registry.installLocal(pkg, PluginSourceKind.Local, manifest.capabilities);
await registry.setEnabled(pluginId, true);
const profile = { version: 1, theme: pluginTheme("Workshop") };
await registry.setCustomization(pluginId, profile);
registry.cancel();
execFileSync(process.execPath, ["scripts/build.mjs", `--dev-build=${buildId}`], { stdio: "inherit" });
const launch = path.join(owner.root, "launch.json");
await writeFile(launch, JSON.stringify({ version: 1, profileId: id, ownerId: owner.ownerId, buildId }));
let app;
const checks = [];
const check = (name, actual) => {
  assert.ok(actual, name);
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  app = await electron.launch({
    executablePath: resolveElectron(),
    args: [path.join(root, `.studio-dev/builds/${buildId}/main/main.mjs`), `--studio-dev-launch=${launch}`],
    env: liveLaunchEnv(process.env),
    timeout: 60000,
  });
  const stdout = createWriteStream(path.join(out, "app-stdout.log"));
  const stderr = createWriteStream(path.join(out, "app-stderr.log"));
  app.process().stdout?.pipe(stdout);
  app.process().stderr?.pipe(stderr);
  // Owned studio:dev readiness already budgets 60s; Playwright's default 30s can expire during sandbox startup.
  const page = await app.firstWindow({ timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
  page.setDefaultTimeout(15000);
  await page.locator('[data-onboarding-action="next"]').click();
  await page
    .locator('[data-onboarding-action="skip"], [data-onboarding-action="start"]')
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole("dialog", { name: "Welcome to Genex", exact: true }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "New game", exact: true }).click();
  await page.locator("[data-genex-promo] .genex-promo-close").click();
  await page.locator("[data-genex-promo]").waitFor({ state: "hidden" });
  await page.locator("[data-home] .home-title").waitFor({ state: "visible" });
  const geometry = () =>
    page.locator("[data-home]").evaluate((home) => ({
      title: home.querySelector(".home-title").getBoundingClientRect().y,
      prompt: home.querySelector("[data-home-composer]").getBoundingClientRect().y,
    }));
  const before = await geometry();
  await page.evaluate(({ id, profile }) => window.studio.pluginSetCustomization(id, profile), {
    id: pluginId,
    profile: { ...profile, newChat: { panel: "notes", height: 240 } },
  });
  await page.locator("[data-new-chat-plugin] iframe").waitFor({ state: "visible" });
  const after = await geometry();
  check(
    "Home title and composer stay fixed when a maximum-height panel appears",
    Math.abs(before.title - after.title) < 1 && Math.abs(before.prompt - after.prompt) < 1,
  );
  check(
    "panel is below the composer and labelled",
    await page
      .locator("[data-new-chat-plugin]")
      .evaluate(
        (el) =>
          el.getBoundingClientRect().top >=
            document.querySelector(".home-compose-row").getBoundingClientRect().bottom &&
          el.textContent.includes("Workshop"),
      ),
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-tab-appearance").click();
  await page.getByRole("button", { name: "Theme source", exact: true }).click();
  await page.getByRole("menuitemradio").filter({ hasText: "Workshop · Plugin" }).click();
  await page.getByRole("button", { name: "Turn off plugin theme", exact: true }).waitFor();
  check("plugin theme hides built-in editors", (await page.locator(".appearance-native-editors").count()) === 0);
  const off = page.getByRole("button", { name: "Turn off plugin theme", exact: true });
  check(
    "turn off has a visible fill and pointer cursor",
    await off.evaluate(
      (el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)" && getComputedStyle(el).cursor === "pointer",
    ),
  );
  for (const mode of ["light", "dark"]) {
    await page.locator(`[data-appearance] input[value="${mode}"]`).check();
    await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, mode);
    await expect(page.frameLocator("[data-new-chat-plugin] iframe").locator("body")).toHaveCSS(
      "background-color",
      mode === "light" ? "rgb(255, 255, 255)" : "rgb(17, 17, 17)",
    );
    check(`Home panel updates to the ${mode} theme`, true);
    await page.screenshot({ path: path.join(out, `appearance-${mode}.png`) });
    await page.keyboard.press("Escape");
    await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
    await page.locator("[data-home]").waitFor({ state: "visible" });
    await page.screenshot({ path: path.join(out, `home-${mode}.png`) });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator("#settings-tab-appearance").click();
  }
  await off.focus();
  await page.keyboard.press("Enter");
  await page.locator(".appearance-native-editors").waitFor({ state: "visible" });
  check("keyboard turn off restores built-in editors", true);
  await page.evaluate((id) => window.studio.pluginEnable(id, false), pluginId);
  await page.waitForFunction(() => !document.querySelector('[aria-label="Theme source"]'));
  check("Theme source row is hidden when no enabled plugin offers a theme", true);
  await page.evaluate((id) => window.studio.pluginEnable(id, true), pluginId);
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
  const size = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(900, 650);
    return win.getContentSize();
  });
  await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, size);
  await page.locator("[data-new-chat-plugin]").scrollIntoViewIfNeeded();
  const short = await page.locator("[data-new-chat-plugin]").evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    right: el.getBoundingClientRect().right,
    height: innerHeight,
    width: innerWidth,
  }));
  console.log("Short-window geometry:", JSON.stringify(short));
  check(
    "panel fits a shorter window and remains reachable",
    short.bottom <= short.height + 1 && short.right <= short.width + 1,
  );
  await page.screenshot({ path: path.join(out, "home-short.png") });
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify(
      {
        checks,
        before,
        after,
        short,
        buildId,
        profile: id,
        providers: "live",
        providerCalls: 0,
        electron: await app.evaluate(() => process.versions.electron),
      },
      null,
      2,
    ),
  );
  console.log(`Evidence: ${out}`);
} catch (error) {
  const startup = await readFile(path.join(owner.core, "logs/studio.log"), "utf8").catch(() => "No startup log");
  await writeFile(path.join(out, "startup.log"), startup);
  console.error(startup);
  if (app) {
    const page = app.windows()[0];
    if (page) {
      await page.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
      await writeFile(
        path.join(out, "failure.txt"),
        `${error.stack}\n${await page
          .locator("body")
          .innerText()
          .catch(() => "")}`,
      );
    }
  }
  throw error;
} finally {
  await app?.close();
}
