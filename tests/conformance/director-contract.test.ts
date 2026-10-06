/**
 * The module contract, integration in waves, and lost registrations (D7, after the Midnight Apex
 * report): parallel loop workers rewrote each other's modules around a shared state object nobody
 * had written down, the director integrated them one at a time with a health pass each, and a
 * worker deleted cameras three other workers' checks looked through without anything noticing.
 *
 * The plan carries a contract the harness holds to its shape and commits as docs/ARCHITECTURE.md;
 * a loop worker under a plan of several looping parts starts only from a commit that holds it, with
 * its modules stubbed and a seam that leaves the other parts' modules alone. `integrate` takes a
 * wave of workers with one health pass, and running workers take the integration branch once per
 * wave. A camera, demo or probe another facet depends on may not go missing — not in a facet's
 * round, not in a merge.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { compilePlan } from "../../src/harness-seed/loop/director/rules.ts";
import {
  ARCHITECTURE_FILE,
  contractPointer,
  renderArchitecture,
} from "../../src/harness-seed/loop/director/contract-prompts.ts";
import {
  ContractRefusal,
  contractPath,
  derivedContract,
  ownsClaimingOthers,
  parseModuleContract,
} from "../../src/harness-seed/loop/director/module-contract.ts";
import {
  CONTRACT_REFUSALS_BEFORE_DERIVED,
  contractAtFork,
  contractBeforeFork,
  contractOnPlan,
  holdsContract,
  missingAt,
  writeArchitecture,
} from "../../src/harness-seed/loop/director/contract-gate.ts";
import { integrate } from "../../src/harness-seed/loop/director/integrate.ts";
import { CONFLICT_MERGE } from "../../src/harness-seed/loop/director/conflict-worker.ts";
import {
  dependentsOf,
  lostRegistrations,
  RegistrationKind,
  registryRefusal,
} from "../../src/harness-seed/loop/registry.ts";
import { verifyChallenger } from "../../src/harness-seed/loop/facet/phases/verify.ts";
import { VerdictSource } from "../../src/harness-seed/loop/verdict.ts";
import { WorkerMode } from "../../src/harness-seed/loop/outcomes.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { fixtureGit } from "../helpers/snapshot-fixtures.ts";
import { shellExec as sh } from "../helpers/posix-shell.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A plan of two looping parts, as the lead types it. */
const PARTS = [
  { id: "car", title: "Car handling", seam: "the car", owns: "src/car.js", done: ["the car drifts"], minutes: 30 },
  { id: "city", title: "City", seam: "the city", owns: "src/city.js", done: ["districts"], minutes: 30 },
];
const CONTRACT = {
  conventions: ["steer +1 = right", "metres"],
  modules: [
    {
      path: "src/car.js",
      owner: "car",
      api: ["export function stepCar(state, input, dt)"],
      state: "car",
      registers: { cameras: ["chase"] },
    },
    { path: "src/city.js", owner: "city", api: ["export function buildCity(scene)"] },
  ],
  shared: [{ path: "src/state.js", owner: "car" }],
};
const planArgs = (contract: unknown = CONTRACT, parts: unknown[] = PARTS) => ({
  summary: "Tonight: a city to drive through.",
  workers: JSON.stringify(parts),
  ...(contract === null ? {} : { contract: JSON.stringify(contract) }),
});

describe("the plan's module contract, held to its shape", () => {
  it("keeps a contract on the plan, and a plan without one exactly as it was", () => {
    const compiled = compilePlan(planArgs());
    assert.equal(compiled.error, undefined, compiled.error);
    assert.deepEqual(
      compiled.plan!.contract.modules.map((m: { path: string; owner: string }) => [m.path, m.owner]),
      [
        ["src/car.js", "car"],
        ["src/city.js", "city"],
      ],
    );
    assert.deepEqual(compiled.plan!.contract.conventions, ["steer +1 = right", "metres"]);
    assert.deepEqual(compiled.plan!.contract.modules[0].registers, { cameras: ["chase"], demos: [], probes: [] });
    const without = compilePlan(planArgs(null));
    assert.ok(!("contract" in without.plan!), "no contract key on a plan without one");
    assert.ok(!("single" in without.plan!.workers[0]), "a part says single only when it is");
  });

  it("refuses two owners for one path and an owner that is no part, by code, with the grammar", () => {
    const twice = parseModuleContract({ modules: [...CONTRACT.modules, { path: "src/car.js", owner: "city" }] }, [
      "car",
      "city",
    ]);
    assert.equal(twice.problem?.code, ContractRefusal.OwnedTwice);
    const sharedTwice = parseModuleContract(
      { modules: CONTRACT.modules, shared: [{ path: "src/city.js", owner: "car" }] },
      ["car", "city"],
    );
    assert.equal(sharedTwice.problem?.code, ContractRefusal.OwnedTwice, "a shared file is a path like any other");
    const stranger = parseModuleContract({ modules: [{ path: "src/x.js", owner: "hud" }] }, ["car", "city"]);
    assert.equal(stranger.problem?.code, ContractRefusal.UnknownOwner);
    assert.equal(parseModuleContract({ modules: [] }, ["car"]).problem?.code, ContractRefusal.NoModules);
    assert.equal(parseModuleContract("{not json", ["car"]).problem?.code, ContractRefusal.NotJson);
    const refused = compilePlan(planArgs({ modules: [{ path: "src/car.js", owner: "hud" }] }));
    assert.match(String(refused.error), /^plan: contract owner is not a part of this plan/);
    assert.match(String(refused.error), /contract is JSON: \{"conventions"/, "the refusal carries the grammar");
  });

  it("takes only a file relative to the game as a contract path", () => {
    const hostile = [
      "../outside.js",
      "/etc/passwd",
      "src/../../x.js",
      "src/*.js",
      "src/[ab].js",
      ".git/config",
      "src//car.js",
      "-rf",
      "a\\b.js",
      "line\nbreak.js",
      "",
    ];
    for (const value of hostile) {
      assert.equal(contractPath(value), null, JSON.stringify(value));
      const parsed = parseModuleContract({ modules: [{ path: value, owner: "car" }] }, ["car"]);
      assert.equal(parsed.problem?.code, ContractRefusal.BadPath, JSON.stringify(value));
    }
    assert.equal(contractPath("./src/car.js"), "src/car.js");
    assert.equal(contractPath("src/it's $(odd) name.js"), "src/it's $(odd) name.js", "quoted later, never refused");
  });

  it("counts a part marked single out of the looping parts", () => {
    const compiled = compilePlan(planArgs(null, [PARTS[0], { ...PARTS[1], mode: "single" }]));
    assert.equal(compiled.plan!.workers[1].single, true);
  });
});

describe("docs/ARCHITECTURE.md and a worker's pointer to it", () => {
  const contract = parseModuleContract(CONTRACT, ["car", "city"]).contract!;

  it("renders every module with its owner, API, state and registrations, and the shared files", () => {
    const text = renderArchitecture(contract, { car: "Car handling", city: "City" });
    assert.equal(renderArchitecture(contract, { car: "Car handling", city: "City" }), text, "pure");
    for (const line of [
      "### src/car.js — owned by `car` (Car handling)",
      "- api: `export function stepCar(state, input, dt)`",
      "- state: `state.car`",
      "- registers cameras: chase",
      "### src/city.js — owned by `city` (City)",
      "- src/state.js — owned by `car`; the other parts read it",
      "- steer +1 = right",
    ])
      assert.ok(text.includes(line), `${line}\n---\n${text}`);
  });

  it("points a worker at the file, with its own modules' API and the conventions — not the others'", () => {
    const pointer = contractPointer(
      contract,
      contract.modules.filter((m) => m.owner === "city"),
    );
    assert.match(pointer, /docs\/ARCHITECTURE\.md/);
    assert.match(pointer, /src\/city\.js \(api: export function buildCity\(scene\)\)/);
    assert.match(pointer, /Conventions: steer \+1 = right; metres/);
    assert.ok(!pointer.includes("stepCar"), "another part's API stays in the file");
  });

  it("finds a seam that reaches another part's module: the path, a folder above it, a glob over it", () => {
    assert.deepEqual(ownsClaimingOthers(["src/city.js"], contract, "city"), [], "its own module is no claim");
    for (const own of ["src/", "src", "src/*.js", "src/car.js", "**/state.js"])
      assert.ok(ownsClaimingOthers([own], contract, "city").length > 0, own);
  });

  it("writes a contract from the plan's seams that names only files one part owns", () => {
    const derived = derivedContract(
      [
        { id: "car", owns: ["src/car.js", "src/shared.js", "src/"] },
        { id: "city", owns: ["src/city.js", "src/shared.js", "src/new.js"] },
      ],
      new Set(["src/car.js", "src/city.js", "src/shared.js"]),
    );
    assert.equal(derived.derived, true);
    assert.deepEqual(
      derived.modules.map((m) => [m.path, m.owner]),
      [
        ["src/car.js", "car"],
        ["src/city.js", "city"],
      ],
    );
  });
});

describe("what a build registers that another part depends on", () => {
  const facets = [
    { id: "race", cameras: ["chase"], checks: [] },
    {
      id: "city",
      cameras: ["street"],
      checks: [
        { id: "lit", kind: "pixel", camera: "skyline", expr: "litFraction > 0.2" },
        { id: "crash", kind: "probe", demo: "pileup", expr: "state.traffic.cars >= 3" },
      ],
    },
  ];
  const before = {
    cameras: ["default", "street", "skyline", "chase", "orbit"],
    demos: ["pileup", "drift"],
    state: { traffic: { cars: 4 } },
    demoStates: null,
  };

  it("a camera dropped while another part uses it is one loss; dropped and unused, none", () => {
    const lost = lostRegistrations({
      before,
      after: { ...before, cameras: ["default", "skyline", "chase"] },
      dependents: dependentsOf(facets, ["race"]),
    });
    assert.deepEqual(lost, [{ kind: RegistrationKind.Camera, name: "street", usedBy: ["city"] }]);
  });

  it("a demo a check runs and a probe path a check reads are losses too", () => {
    const lost = lostRegistrations({
      before,
      after: { ...before, demos: ["drift"], state: { traffic: {} } },
      dependents: dependentsOf(facets, ["race"]),
    });
    assert.deepEqual(
      lost.map((l) => [l.kind, l.name, l.usedBy]),
      [
        [RegistrationKind.Demo, "pileup", ["city"]],
        [RegistrationKind.Probe, "state.traffic.cars", ["city"]],
      ],
    );
  });

  it("a look that could not read the state loses no probe: missing, truncated or cut", () => {
    for (const state of [
      { __missing: true },
      { __truncated: true, length: 90_000 },
      { traffic: {}, __cut: { chars: 90_000, paths: ["traffic.cars"] } },
    ]) {
      const lost = lostRegistrations({ before, after: { ...before, state }, dependents: dependentsOf(facets) });
      assert.deepEqual(lost, [], JSON.stringify(state));
    }
    assert.deepEqual(
      lostRegistrations({
        before: { ...before, cameras: null },
        after: { ...before, cameras: [] },
        dependents: dependentsOf(facets),
      }),
      [],
      "a look with no registry to compare loses nothing",
    );
  });

  it("refuses a facet's challenger by name, and never over its own cameras", () => {
    const refusal = registryRefusal({
      facetId: "race",
      facets,
      incumbent: { registeredCameras: before.cameras, registeredDemos: before.demos },
      challenger: { registeredCameras: ["default", "skyline"], registeredDemos: before.demos },
    });
    assert.match(String(refusal?.gap), /lost camera "street", which city depends on/);
    assert.equal(refusal?.lost.length, 1, "chase and orbit are race's own or nobody's");
  });
});

/** A verify phase over two looks at the same build, with nothing measured but the registry. */
async function verifyOver(challenger: Record<string, unknown>) {
  const recorder = ctxRecorder({ handlers: { "events.append": () => true } });
  const loop = {
    ctx: recorder.ctx,
    run: { runId: "run_registry", project: "apex" },
    facet: { id: "race", title: "Race" },
    spec: { id: "race", title: "Race", checks: [] },
    board: {},
    legacy: false,
    facets: [
      { id: "race", cameras: ["chase"], checks: [] },
      { id: "city", cameras: ["street"], checks: [] },
    ],
    incumbentEvidence: { ok: true, shots: [], registeredCameras: ["default", "street", "chase"], registeredDemos: [] },
    handle: null,
    deadline: Date.now() + 60 * 60_000,
    budgetMs: 60 * 60_000,
    budgets: { observationDelays: [] },
    hasTime: () => false,
    delegated: false,
    biggestGap: "the same gap",
    appendRun: async () => {},
  };
  const round = {
    evidence: { ok: true, shots: [], problems: [], ...challenger },
    gamedChecks: [],
    iteration: 1,
    iterationId: "1",
    challengerBroken: false,
  };
  await verifyChallenger(loop as never, round as never);
  return round as typeof round & { verdict: Record<string, unknown>; verdictSource: string; won: boolean };
}

describe("a facet's round that loses what another facet depends on", () => {
  it("is refused on the checks, naming the camera and the facet that depends on it", async () => {
    const lost = await verifyOver({ registeredCameras: ["default", "chase"], registeredDemos: [] });
    assert.equal(lost.won, false);
    assert.equal(lost.verdictSource, VerdictSource.Checks);
    assert.match(String(lost.verdict.biggest_gap), /lost camera "street", which city depends on/);
    const kept = await verifyOver({ registeredCameras: ["default", "street"], registeredDemos: [] });
    assert.notEqual(kept.verdictSource, VerdictSource.Checks, "dropping its own camera is its own business");
  });
});

/** A real repository standing in for the integration worktree: a base commit with the entry. */
async function integrationRepo() {
  const root = await tmpDir("studio-contract-");
  const repo = path.join(root, "integration");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await fixtureGit(repo, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(repo, "index.html"), "<canvas></canvas>\n");
  await writeFile(path.join(repo, "src", "main.js"), "// FACET WIRING\n");
  await fixtureGit(repo, ["add", "-A"]);
  await fixtureGit(repo, ["commit", "-q", "-m", "base"]);
  return { root, repo, head: await fixtureGit(repo, ["rev-parse", "HEAD"]) };
}

/** Commit files in the repository with the fixture's identity; answers the new head. */
async function commitFiles(repo: string, files: Record<string, string>, message = "change"): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), text);
  }
  await fixtureGit(repo, ["add", "-A"]);
  await fixtureGit(repo, ["commit", "-q", "-m", message]);
  return fixtureGit(repo, ["rev-parse", "HEAD"]);
}

type Look = Record<string, any>;

/** A night with only what the contract gate and `integrate` read, over a real repository. */
function stubNight(repo: string, head: string, plan: Record<string, any> | null) {
  const events: Array<{ type: string; payload: Record<string, any> }> = [];
  const notes: string[] = [];
  const looks: Array<Record<string, any>> = [];
  const recorder = ctxRecorder({
    handlers: {
      "run.exec": (p) => sh(String(p.command), String(p.cwd)),
      "assets.checkpoint": () => ({ committed: false }),
    },
  });
  const night: Record<string, any> = {
    ctx: recorder.ctx,
    run: { runId: "run_contract", project: "apex", setup: null },
    integrationWorktree: repo,
    shape: { main: "src/main.js" },
    ownShape: false,
    lead: null,
    nestedRepos: [],
    journal: { director: { integrationHead: head } },
    state: {
      plan,
      integrationHead: head,
      integrationHealthy: null,
      workers: new Map(),
      evidenceByHead: new Map(),
      healthByHead: new Map(),
      consoleByHead: new Map(),
      facetSpecs: [],
      ledger: [],
    },
    /** What the next health pass sees: a function of the head it looks at. */
    look: (_head: string): Look => ({ ok: true, problems: [], warnings: [], shots: [] }),
    note: (text: string) => void notes.push(text),
    appendRun: async (type: string, payload: Record<string, any>) => void events.push({ type, payload }),
    saveJournal: async () => {},
    protectHead: async () => {},
    decision: async () => {},
    writeVerdict: async () => {},
    recordVerdict: async () => ({}),
    workerCommit: async (worker: Record<string, any>) => worker.lastCommit,
    consoleInheritedBy: () => [],
    errorsLogged: () => [],
    shotsOf: () => [],
    ledgerLines: () => [],
    nestedGit: async () => "",
    withLease: (_lease: string, fn: (handle: string | null) => unknown) => fn(null),
    patientEvidence: async (_root: string, options: Record<string, any>) => {
      looks.push(options);
      return night.look(night.state.integrationHead);
    },
    rememberEvidence: (commit: string, evidence: Look) => {
      if (evidence.ok !== true) return;
      night.state.evidenceByHead.set(commit, {
        state: evidence.state ?? {},
        demoStates: evidence.demoStates ?? null,
        demos: evidence.registeredDemos ?? null,
        cameras: evidence.registeredCameras ?? [],
      });
    },
  };
  return { night, events, notes, looks, recorder };
}

/** A worker branch off `from` that writes its own file: answers its commit. */
async function workerBranch(repo: string, from: string, name: string, files: Record<string, string>): Promise<string> {
  await fixtureGit(repo, ["checkout", "-q", "-b", name, from]);
  const commit = await commitFiles(repo, files, `worker ${name}`);
  await fixtureGit(repo, ["checkout", "-q", "main"]);
  return commit;
}

describe("the contract on the integration branch, and the gate a loop worker passes", () => {
  const plan = () => compilePlan(planArgs()).plan!;

  it("commits docs/ARCHITECTURE.md on the plan and names the stubs still to write", async () => {
    const { repo, head } = await integrationRepo();
    const { night, events } = stubNight(repo, head, plan());
    const said = await contractOnPlan(night as never);
    const committed = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    assert.notEqual(committed, head, "one commit on the integration branch");
    assert.equal(night.state.contract.commit, committed);
    assert.equal(night.state.integrationHead, committed);
    assert.deepEqual(
      (await fixtureGit(repo, ["show", "--name-only", "--format=", "HEAD"])).split("\n"),
      [ARCHITECTURE_FILE],
      "that file alone",
    );
    assert.match(await readFile(path.join(repo, ARCHITECTURE_FILE), "utf8"), /### src\/car\.js — owned by `car`/);
    assert.match(
      String(said),
      /Stubs still to write before their loop workers start: src\/car\.js, src\/city\.js, src\/state\.js/,
    );
    assert.deepEqual(
      events.map((e) => e.type),
      ["director_progress"],
    );
    assert.equal(await contractOnPlan(night as never), null, "the same contract again commits nothing");
  });

  it("refuses a loop worker without a contract twice, then writes one from the plan's seams", async () => {
    const { repo, head } = await integrationRepo();
    await commitFiles(repo, { "src/car.js": "export {};\n" });
    const { night, notes } = stubNight(
      repo,
      await fixtureGit(repo, ["rev-parse", "HEAD"]),
      compilePlan(planArgs(null)).plan!,
    );
    for (let i = 0; i < CONTRACT_REFUSALS_BEFORE_DERIVED; i++) {
      const refused = await contractBeforeFork(night as never, { id: "car" }, WorkerMode.Loop);
      assert.match(String(refused), /2 parts that loop, and no module contract yet: call plan again with contract=/);
    }
    assert.equal(night.state.contract, undefined, "nothing written while the lead can still write one");
    assert.equal(await contractBeforeFork(night as never, { id: "car" }, WorkerMode.Loop), null);
    assert.equal(night.state.contract.spec.derived, true);
    assert.deepEqual(
      night.state.contract.spec.modules.map((m: { path: string }) => m.path),
      ["src/car.js"],
      "only the seams that exist",
    );
    assert.ok(
      notes.some((n) => /the harness wrote one from the plan's owns/.test(n)),
      notes.join("\n"),
    );
    assert.notEqual(head, night.state.integrationHead);
  });

  it("never holds a single session, a conflict worker or a plan of one looping part", async () => {
    const { repo, head } = await integrationRepo();
    const exempt = [
      { plan: plan(), args: { id: "stubs" }, mode: WorkerMode.Single },
      { plan: plan(), args: { id: "car", [CONFLICT_MERGE]: { of: "car", commit: head } }, mode: WorkerMode.Loop },
      { plan: compilePlan(planArgs(null, [PARTS[0]])).plan!, args: { id: "car" }, mode: WorkerMode.Loop },
      {
        plan: compilePlan(planArgs(null, [PARTS[0], { ...PARTS[1], mode: "single" }])).plan!,
        args: { id: "car" },
        mode: WorkerMode.Loop,
      },
    ];
    for (const { plan: exemptPlan, args, mode } of exempt) {
      const { night } = stubNight(repo, head, exemptPlan);
      assert.equal(await contractBeforeFork(night as never, args, mode), null, JSON.stringify(args));
      assert.deepEqual(await contractAtFork(night as never, { id: args.id, args, mode, commit: head }), { owns: null });
    }
  });

  it("refuses a fork without the contract, a worker whose modules are not stubbed, and a seam over another's module", async () => {
    const { repo, head } = await integrationRepo();
    const { night } = stubNight(repo, head, plan());
    await contractOnPlan(night as never);
    const gate = (args: Record<string, unknown>, commit: string) =>
      contractAtFork(night as never, { id: String(args.id), args, mode: WorkerMode.Loop, commit });
    const before = await gate({ id: "car" }, head);
    assert.match(String(before.refusal), /does not contain the module contract/);
    const contract = night.state.contract.commit;
    const unstubbed = await gate({ id: "car" }, contract);
    assert.match(
      String(unstubbed.refusal),
      /the contract gives "car" src\/car\.js, src\/state\.js, which do not exist/,
    );
    const stubbed = await commitFiles(repo, {
      "src/car.js": "export function stepCar() {}\n",
      "src/state.js": "export const state = {};\n",
    });
    assert.deepEqual(await gate({ id: "car" }, stubbed), { owns: ["src/car.js", "src/state.js"] }, "its contract seam");
    assert.deepEqual(await gate({ id: "car", owns: "src/car.js" }, stubbed), { owns: null }, "a seam of its own");
    const wide = await gate({ id: "car", owns: "src/" }, stubbed);
    assert.match(String(wide.refusal), /owns= would reach other parts' modules \(src\/ → src\/city\.js, city's\)/);
    const restart = await gate({ id: "car-2", replaces: "car" }, stubbed);
    assert.deepEqual(restart, { owns: ["src/car.js", "src/state.js"] }, "a restart is the same part");
  });

  it("never runs a path or a commit a contract names: every git question is quoted", async () => {
    const { root, repo, head } = await integrationRepo();
    const { recorder } = stubNight(repo, head, null);
    const hostile = [
      "src/$(touch dollar).js",
      "src/`touch backtick`.js",
      "src/a; touch semi.js",
      "src/it's.js",
      "src/a && touch and.js",
    ];
    assert.deepEqual(await missingAt(recorder.ctx as never, repo, head, hostile), hostile, "none of them exists");
    assert.equal(await holdsContract(recorder.ctx as never, repo, "$(touch c)", head), false, "not a commit: no");
    assert.equal(await holdsContract(recorder.ctx as never, repo, head, "HEAD; touch d"), false);
    assert.deepEqual((await readdir(repo)).sort(), [".git", "index.html", "src"], "nothing in the names ran");
    assert.deepEqual((await readdir(path.join(repo, "src"))).sort(), ["main.js"]);
    assert.deepEqual((await readdir(root)).sort(), ["integration"]);
  });

  it("writes the contract only inside the worktree: a linked docs folder or file writes nothing", async () => {
    const cases = [
      {
        name: "docs is a link out of the worktree",
        arrange: async (repo: string, outside: string) => symlink(outside, path.join(repo, "docs")),
      },
      {
        name: "the contract file is a link out of the worktree",
        arrange: async (repo: string, outside: string) => {
          await mkdir(path.join(repo, "docs"));
          await symlink(path.join(outside, "victim.md"), path.join(repo, ARCHITECTURE_FILE));
        },
      },
      {
        name: "the contract file is a folder",
        arrange: async (repo: string) => mkdir(path.join(repo, ARCHITECTURE_FILE), { recursive: true }),
      },
    ];
    for (const { name, arrange } of cases) {
      const { root, repo } = await integrationRepo();
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "victim.md"), "untouched\n");
      await arrange(repo, outside);
      const refused = await writeArchitecture(repo, "# Architecture\n");
      assert.ok(refused, name);
      assert.deepEqual((await readdir(outside)).sort(), ["victim.md"], name);
      assert.equal(await readFile(path.join(outside, "victim.md"), "utf8"), "untouched\n", name);
    }
  });
});

describe("integration in waves", () => {
  it("merges a wave in order with one integration_merge each and ONE health pass, and closes the wave", async () => {
    const { repo, head } = await integrationRepo();
    const { night, events, looks } = stubNight(repo, head, null);
    const car = await workerBranch(repo, head, "car", { "src/car.js": "export const car = 1;\n" });
    const city = await workerBranch(repo, head, "city", { "src/city.js": "export const city = 1;\n" });
    for (const [id, commit] of [
      ["car", car],
      ["city", city],
    ])
      night.state.workers.set(id, { id, title: id, from: head, lastCommit: commit, merging: null });
    night.state.facetSpecs.push({
      id: "hud",
      cameras: [],
      checks: [{ id: "lap", kind: "probe", demo: "lap", expr: "state.lap >= 1" }],
    });
    const answer = JSON.parse(await integrate(night as never, { worker: "car,city" }));
    assert.equal(answer.merged, true, JSON.stringify(answer));
    assert.deepEqual(answer.wave, { merged: ["car", "city"] });
    assert.deepEqual(
      events.filter((e) => e.type === "integration_merge").map((e) => e.payload.facetId),
      ["car", "city"],
    );
    assert.equal(events.filter((e) => e.type === "integration_health").length, 1, "one health pass for the wave");
    assert.equal(looks.length, 1);
    assert.deepEqual(looks[0]!.requiredDemos, ["lap"], "the demos workers' checks name");
    assert.equal(looks[0]!.maxDemos, 0);
    const merged = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    assert.equal(night.state.waveHead, merged, "a healthy integrate closes the wave");
    // The lead's own commit moves the integration head, not the wave: workers take it with the next.
    const fix = await commitFiles(repo, { "src/main.js": "// FACET WIRING\n// fixed\n" }, "lead fix");
    night.state.integrationHead = fix;
    assert.equal(night.state.waveHead, merged);
    const closed = JSON.parse(await integrate(night as never, { wave: "close" }));
    assert.equal(closed.wave, "closed");
    assert.equal(night.state.waveHead, fix);
  });

  it("answers a single worker's merge with exactly the keys it always had", async () => {
    const { repo, head } = await integrationRepo();
    const { night } = stubNight(repo, head, null);
    const car = await workerBranch(repo, head, "car", { "src/car.js": "export const car = 1;\n" });
    night.state.workers.set("car", { id: "car", title: "car", from: head, lastCommit: car, merging: null });
    const answer = JSON.parse(await integrate(night as never, { worker: "car" }));
    assert.deepEqual(Object.keys(answer), ["merged", "union", "head", "health", "next"]);
    assert.equal(answer.next, "judge or look at integration before you build on it");
  });

  it("fails the health pass of a merge that lost a demo another worker's check runs, and names it", async () => {
    const { repo, head } = await integrationRepo();
    const { night, notes } = stubNight(repo, head, null);
    night.state.evidenceByHead.set(head, { state: {}, demoStates: null, demos: ["pileup"], cameras: ["default"] });
    night.state.facetSpecs.push({
      id: "city",
      cameras: [],
      checks: [{ id: "crash", kind: "probe", demo: "pileup", expr: "state.cars >= 3" }],
    });
    night.look = () => ({
      ok: true,
      problems: [],
      warnings: [],
      shots: [],
      registeredCameras: ["default"],
      registeredDemos: [],
      state: {},
    });
    const race = await workerBranch(repo, head, "race", { "src/race.js": "export const race = 1;\n" });
    night.state.workers.set("race", { id: "race", title: "race", from: head, lastCommit: race, merging: null });
    const answer = JSON.parse(await integrate(night as never, { worker: "race" }));
    assert.equal(answer.health.ok, false);
    assert.match(answer.health.problems.join("\n"), /lost demo "pileup", which city depends on/);
    assert.deepEqual(answer.lost, [{ kind: "demo", name: "pileup", usedBy: ["city"] }]);
    assert.match(answer.next, /lost what another worker depends on/);
    assert.equal(night.state.integrationHealthy, false);
    assert.equal(night.state.waveHead, undefined, "an unhealthy merge closes no wave");
    assert.ok(
      notes.some((n) => /integrated race → .*health problems/.test(n)),
      notes.join("\n"),
    );
  });

  it("stops a wave at its first conflict and says what merged and what was not tried", async () => {
    const { repo, head } = await integrationRepo();
    const { night, events } = stubNight(repo, head, null);
    const car = await workerBranch(repo, head, "car", { "src/shared.js": "car\n" });
    const city = await workerBranch(repo, head, "city", { "src/shared.js": "city\n" });
    const hud = await workerBranch(repo, head, "hud", { "src/hud2.js": "hud\n" });
    for (const [id, commit] of [
      ["car", car],
      ["city", city],
      ["hud", hud],
    ])
      night.state.workers.set(id, { id, title: id, from: head, lastCommit: commit, merging: null });
    const answer = JSON.parse(await integrate(night as never, { worker: "car,city,hud" }));
    assert.equal(answer.merged, false);
    assert.deepEqual(answer.conflict, ["src/shared.js"]);
    assert.deepEqual(answer.wave, { merged: ["car"], notTried: ["hud"], skipped: {} });
    assert.equal(events.filter((e) => e.type === "integration_health").length, 0, "no health pass on half a wave");
    assert.equal(night.state.integrationHealthy, null);
  });
});
