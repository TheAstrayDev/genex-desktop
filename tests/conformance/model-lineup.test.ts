import assert from "node:assert/strict";
import { test } from "node:test";
import { latestModels, modelName, shownModels } from "../../src/renderer/model-lineup.ts";
import { EngineId } from "../../src/shared/providers.ts";

const row = (id: string, label: string, resolvedModel?: string, providerDefault?: boolean) => ({
  id,
  label,
  ...(resolvedModel ? { resolvedModel } : {}),
  ...(providerDefault ? { providerDefault } : {}),
});

/** Claude Code 2.1.286 with a warm model cache, as it listed on 2026-10-01. */
const CLAUDE = [
  row("default", "Default (recommended)", "claude-opus-5-5"),
  row("opus", "Opus 5.5", "claude-opus-5-5", true),
  row("claude-fable-5-1", "Fable 5.1", "claude-fable-5-1"),
  row("sonnet", "Sonnet 5.5", "claude-sonnet-5-5"),
  row("haiku", "Haiku 4.5", "claude-haiku-4-5-20251001"),
  row("claude-sonnet-5", "Sonnet 5", "claude-sonnet-5"),
  row("claude-opus-5", "Opus 5", "claude-opus-5"),
  row("claude-fable-5", "Fable 5", "claude-fable-5"),
  row("claude-opus-4-8", "Opus 4.8", "claude-opus-4-8"),
  row("claude-opus-4-7", "Opus 4.7", "claude-opus-4-7"),
  row("claude-opus-4-6", "Opus 4.6", "claude-opus-4-6"),
  row("claude-sonnet-4-6", "Sonnet 4.6", "claude-sonnet-4-6"),
];

/** Codex 0.159.2's `model/list`, as it listed on 2026-10-01. */
const CODEX = [
  row("gpt-6.1-sol", "GPT-6.1-Sol", undefined, true),
  row("gpt-6-astra", "GPT-6-Astra"),
  row("gpt-6-sol", "GPT-6-Sol"),
  row("gpt-6-luna", "GPT-6-Luna"),
  row("gpt-5.6-sol", "GPT-5.6-Sol"),
  row("gpt-5.6-terra", "GPT-5.6-Terra"),
  row("gpt-5.6-luna", "GPT-5.6-Luna"),
  row("gpt-5.5", "GPT-5.5"),
];

test("the picker shows the newest model of each family from the newest generation", () => {
  assert.deepEqual([...latestModels(EngineId.ClaudeCode, CLAUDE)], ["opus", "claude-fable-5-1", "sonnet"]);
  assert.deepEqual([...latestModels(EngineId.Codex, CODEX)], ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]);
});

test("a cold Claude cache lists bare names and context variants; the lineup and names hold", () => {
  const cold = [
    row("default", "Default (recommended)", "claude-opus-5[1m]"),
    row("opus[1m]", "Opus (1M context)", "claude-opus-5[1m]", true),
    row("claude-fable-5-1[1m]", "Fable", "claude-fable-5-1"),
    row("sonnet", "Sonnet", "claude-sonnet-5"),
    row("haiku", "Haiku", "claude-haiku-4-5-20251001"),
  ];
  assert.deepEqual([...latestModels(EngineId.ClaudeCode, cold)], ["opus[1m]", "claude-fable-5-1[1m]", "sonnet"]);
  assert.deepEqual(
    cold.slice(1).map((model) => modelName(EngineId.ClaudeCode, model)),
    ["Opus 5 (1M context)", "Fable 5.1", "Sonnet 5", "Haiku 4.5"],
  );
  // A provider name that already says the version is kept as it is.
  assert.deepEqual(
    CLAUDE.slice(1, 5).map((model) => modelName(EngineId.ClaudeCode, model)),
    ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5"],
  );
  assert.equal(modelName(EngineId.Codex, CODEX[0]!), "GPT-6.1-Sol");
});

test("an alias and its pinned twin are one model: the provider default, else the first listed", () => {
  const twins = [row("opus", "Opus 5.5", "claude-opus-5-5"), row("claude-opus-5-5", "Opus 5.5", "claude-opus-5-5")];
  assert.deepEqual([...latestModels(EngineId.ClaudeCode, twins)], ["opus"]);
  const pinnedDefault = [twins[0]!, { ...twins[1]!, providerDefault: true }];
  assert.deepEqual([...latestModels(EngineId.ClaudeCode, pinnedDefault)], ["claude-opus-5-5"]);
});

test("a model whose id cannot be read stays in the picker", () => {
  const claude = [...CLAUDE, row("claude-3-5-sonnet-20241022", "Sonnet 3.5"), row("mystery", "Mystery")];
  const codex = [...CODEX, row("gpt-5.1-codex-max", "GPT-5.1-Codex-Max")];
  assert.ok(latestModels(EngineId.ClaudeCode, claude).has("claude-3-5-sonnet-20241022"));
  assert.ok(latestModels(EngineId.ClaudeCode, claude).has("mystery"));
  assert.ok(latestModels(EngineId.Codex, codex).has("gpt-5.1-codex-max"));
  // An engine without a reader (a local one) keeps every model.
  assert.deepEqual([...latestModels(EngineId.Ollama, [row("qwen3:8b", "Qwen3 8B")])], ["qwen3:8b"]);
});

test("Settings choices override the rule, and the provider default always shows", () => {
  const shown = shownModels(EngineId.ClaudeCode, CLAUDE, { haiku: true, sonnet: false, opus: false });
  assert.deepEqual([...shown], ["opus", "claude-fable-5-1", "haiku"]);
  assert.deepEqual(
    [...shownModels(EngineId.Codex, CODEX, { "gpt-5.6-terra": true })],
    ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-terra"],
  );
});

test("the metered catalogs start with their first few: OpenRouter's three, OpenCode's two beside its default", () => {
  const listed = Array.from({ length: 20 }, (_, index) => row(`vendor/m${index}`, `M${index}`));
  assert.deepEqual(
    [...latestModels(EngineId.OpenRouter, listed)],
    listed.slice(0, 3).map((model) => model.id),
  );
  assert.deepEqual(
    [...latestModels(EngineId.OpenCode, [row("default", "Default"), ...listed])],
    listed.slice(0, 2).map((model) => model.id),
  );
  assert.equal(shownModels(EngineId.OpenRouter, listed, { "vendor/m15": true }).has("vendor/m15"), true);
  assert.equal(shownModels(EngineId.OpenRouter, listed, { "vendor/m0": false }).has("vendor/m0"), false);
});
