/**
 * The template's HUD (`src/game-template/src/hud.js`) and the facade `studio.js` puts in front
 * of it, run under Node against a 2D context that records every call.
 *
 * What is guarded: the calls every shipped game already makes (text, bar, crosshair, flash) draw
 * exactly what they always drew; the newer primitives (arc, path, image, panel, font) draw
 * curves and rounded shapes at the drawing buffer's size, in lengths of the frame's height, so a
 * circle stays round and sharp at any pixel ratio; and the summary `state()` carries is bounded
 * and measured — a few ids, a count, the share of the frame the HUD covers and the items that run
 * into each other — however many items a game draws.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as hudModule from "../../src/game-template/src/hud.js";
import { domUi as hookDomUi, sceneHelpers } from "../../src/page/hook.ts";
import { hudContractGeneration, shippedHudGeneration } from "../../src/substrate/game-workspace.ts";

type Call = unknown[];
type Loose = Record<string, unknown>;
type HudApi = Record<string, (...args: unknown[]) => unknown>;
interface Hud {
  api: HudApi;
  compose(): void;
  tick(): void;
  summary(): Loose;
  flashAlpha: number;
}

/** The font size a recorded `font` string names, in pixels. */
function pxOf(font: string): number {
  return Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
}

/** A value as the log keeps it: a Path2D by its path, an image by its source. */
function logged(value: unknown): unknown {
  if (value && typeof value === "object") {
    const shaped = value as Loose;
    if ("d" in shaped) return { path: shaped.d };
    if ("src" in shaped) return { image: shaped.src };
  }
  return value;
}

/** A 2D context that records every method call and every property it is given. */
function recordingContext(log: Call[]): Loose {
  let font = "16px sans-serif";
  const target: Loose = {
    measureText: (text: unknown) => ({ width: String(text).length * pxOf(font) * 0.5 }),
  };
  const methods = [
    "clearRect",
    "fillRect",
    "strokeRect",
    "fillText",
    "beginPath",
    "closePath",
    "moveTo",
    "lineTo",
    "arc",
    "rect",
    "roundRect",
    "fill",
    "stroke",
    "save",
    "restore",
    "translate",
    "scale",
    "drawImage",
  ];
  for (const name of methods) target[name] = (...args: unknown[]) => log.push([name, ...args.map(logged)]);
  return new Proxy(target, {
    set(object, key, value) {
      if (key === "font") font = String(value);
      log.push(["set", String(key), value]);
      object[String(key)] = value;
      return true;
    },
  });
}

/** What a test's page has: the canvases the HUD created, each with its own recording context. */
interface Page {
  logs: Call[][];
  images: Array<Loose & { onload?: () => void; onerror?: () => void }>;
  fonts: Array<{ family: string; source: string; resolve: () => void }>;
  added: unknown[];
}

const GLOBALS = ["document", "Image", "Path2D", "FontFace"] as const;
let saved: Record<string, unknown> = {};
let page: Page;

function installPage(): void {
  const globals = globalThis as unknown as Loose;
  saved = Object.fromEntries(GLOBALS.map((name) => [name, globals[name]]));
  page = { logs: [], images: [], fonts: [], added: [] };
  const current = page;
  globals.document = {
    createElement: () => {
      const log: Call[] = [];
      current.logs.push(log);
      const context = recordingContext(log);
      return { width: 2, height: 2, getContext: () => context };
    },
    fonts: { add: (face: unknown) => current.added.push(face) },
  };
  globals.Path2D = class {
    d: string;
    constructor(d: string) {
      this.d = d;
    }
  };
  globals.Image = class {
    src = "";
    naturalWidth = 64;
    naturalHeight = 32;
    onload?: () => void;
    onerror?: () => void;
    constructor() {
      current.images.push(this as unknown as Loose);
    }
  };
  globals.FontFace = class {
    family: string;
    source: string;
    constructor(family: string, source: string) {
      this.family = family;
      this.source = source;
    }
    load() {
      return new Promise((resolve) => {
        current.fonts.push({ family: this.family, source: this.source, resolve: () => resolve(this) });
      });
    }
  };
}

function restorePage(): void {
  const globals = globalThis as unknown as Loose;
  for (const name of GLOBALS) {
    if (saved[name] === undefined) delete globals[name];
    else globals[name] = saved[name];
  }
}

/** A renderer whose drawing buffer is `width` × `height` (the pixel ratio already applied). */
function rendererAt(width: number, height: number) {
  return {
    autoClear: true,
    renders: 0,
    render() {
      this.renders += 1;
    },
    getDrawingBufferSize(target: { x: number; y: number }) {
      target.x = width;
      target.y = height;
      return target;
    },
  };
}

/** A HUD on a renderer of that size, and the log of the canvas it paints. */
function hudAt(width: number, height: number): { hud: Hud; log: Call[] } {
  const renderer = rendererAt(width, height);
  const hud = (hudModule as unknown as { createHud(deps: Loose): Hud }).createHud({
    renderer: () => renderer,
    canvas: () => null,
  });
  return { hud, log: page.logs.at(-1)! };
}

/** What one compose drew: the calls after the last one, without the text measurements. */
function drawn(log: Call[], from = 0): Call[] {
  return log.slice(from).filter((call) => call[0] !== "measureText");
}

beforeEach(installPage);
afterEach(restorePage);

describe("the calls every shipped game makes", () => {
  it("draws text, a bar, a crosshair and a flash exactly as the first HUD did", () => {
    const { hud, log } = hudAt(1280, 720);
    hud.api.text("score", "SCORE 12\nLAP 2", { x: 0.5, y: 0.1, size: 20, align: "center" });
    hud.api.bar("hp", 0.5, { x: 0.1, y: 0.9, w: 0.3, h: 0.02, color: "#f00" });
    hud.api.crosshair({ dot: true });
    hud.api.flash("#ff0000", 0.4);
    hud.compose();
    assert.deepEqual(drawn(log), FIRST_HUD_AT_720);
  });

  it("scales design pixels with the frame and never below one", () => {
    const { hud, log } = hudAt(2560, 1440);
    hud.api.text("t", "HI");
    hud.api.crosshair();
    hud.compose();
    assert.deepEqual(drawn(log), FIRST_HUD_AT_1440);
  });
});

// The draw logs of the first HUD (hud.js before HUD_GENERATION), recorded from it and frozen.
const FIRST_HUD_AT_720: Call[] = [
  ["clearRect", 0, 0, 1280, 720],
  ["set", "font", "600 20px ui-sans-serif, system-ui, sans-serif"],
  ["set", "textAlign", "center"],
  ["set", "textBaseline", "top"],
  ["set", "shadowColor", "rgba(0,0,0,0.85)"],
  ["set", "shadowBlur", 2],
  ["set", "shadowOffsetY", 1],
  ["set", "fillStyle", "#e8eef8"],
  ["fillText", "SCORE 12", 640, 72],
  ["fillText", "LAP 2", 640, 97],
  ["set", "shadowBlur", 0],
  ["set", "shadowOffsetY", 0],
  ["set", "fillStyle", "rgba(0,0,0,0.55)"],
  ["fillRect", 128, 648, 384, 14.4],
  ["set", "fillStyle", "#f00"],
  ["fillRect", 128, 648, 192, 14.4],
  ["set", "strokeStyle", "#ffffff"],
  ["set", "lineWidth", 2],
  ["beginPath"],
  ["moveTo", 626, 360],
  ["lineTo", 636, 360],
  ["moveTo", 644, 360],
  ["lineTo", 654, 360],
  ["moveTo", 640, 346],
  ["lineTo", 640, 356],
  ["moveTo", 640, 364],
  ["lineTo", 640, 374],
  ["stroke"],
  ["set", "fillStyle", "#ffffff"],
  ["fillRect", 639, 359, 2, 2],
  ["set", "globalAlpha", 0.4],
  ["set", "fillStyle", "#ff0000"],
  ["fillRect", 0, 0, 1280, 720],
  ["set", "globalAlpha", 1],
];
const FIRST_HUD_AT_1440: Call[] = [
  ["clearRect", 0, 0, 2560, 1440],
  ["set", "font", "600 32px ui-sans-serif, system-ui, sans-serif"],
  ["set", "textAlign", "left"],
  ["set", "textBaseline", "top"],
  ["set", "shadowColor", "rgba(0,0,0,0.85)"],
  ["set", "shadowBlur", 4],
  ["set", "shadowOffsetY", 2],
  ["set", "fillStyle", "#e8eef8"],
  ["fillText", "HI", 51.2, 43.199999999999996],
  ["set", "shadowBlur", 0],
  ["set", "shadowOffsetY", 0],
  ["set", "strokeStyle", "#ffffff"],
  ["set", "lineWidth", 4],
  ["beginPath"],
  ["moveTo", 1252, 720],
  ["lineTo", 1272, 720],
  ["moveTo", 1288, 720],
  ["lineTo", 1308, 720],
  ["moveTo", 1280, 692],
  ["lineTo", 1280, 712],
  ["moveTo", 1280, 728],
  ["lineTo", 1280, 748],
  ["stroke"],
];

/** The calls of one name in a log. */
const callsOf = (log: Call[], name: string) => log.filter((call) => call[0] === name);
const near = (actual: unknown, expected: number, what: string) =>
  assert.ok(Math.abs(Number(actual) - expected) < 1e-6, `${what}: ${actual} is not ${expected}`);

describe("curves, paths, images, panels and fonts", () => {
  it("draws an arc as a curve sized by the frame's height, never as rectangles", () => {
    const { hud, log } = hudAt(1600, 900);
    hud.api.arc("rpm", { x: 0.9, y: 0.85, r: 0.08, fraction: 0.5 });
    hud.compose();
    const arcs = callsOf(log, "arc");
    assert.equal(arcs.length, 1, "one arc: the filled part of the gauge");
    near(arcs[0]![3], 0.08 * 900, "radius");
    near(arcs[0]![4], 0.75 * Math.PI, "a gauge opens at the bottom");
    near(arcs[0]![5], 1.5 * Math.PI, "half of the sweep is filled");
    assert.deepEqual(callsOf(log, "fillRect"), [], "no staircase of rectangles");
  });

  it("paints at the drawing buffer, so a pixel ratio of 2 doubles the radius in pixels", () => {
    const { hud, log } = hudAt(2560, 1440);
    hud.api.arc("rpm", { x: 0.9, y: 0.85, r: 0.08, fraction: 1, back: "rgba(255,255,255,0.2)" });
    hud.compose();
    assert.deepEqual(callsOf(log, "clearRect")[0], ["clearRect", 0, 0, 2560, 1440]);
    const arcs = callsOf(log, "arc");
    assert.equal(arcs.length, 2, "the track, then the filled part");
    for (const arc of arcs) near(arc[3], 115.2, "radius at 1440 buffer pixels");
  });

  it("anchors a panel to a frame corner and keeps that corner at any frame size", () => {
    for (const [width, height] of [
      [1600, 900],
      [960, 600],
    ] as const) {
      const { hud, log } = hudAt(width, height);
      hud.api.panel("map", { anchor: "bottom-right", x: 0.02, y: 0.03, w: 0.3, h: 0.2, radius: 0.01 });
      hud.compose();
      const [rect] = callsOf(log, "roundRect");
      const [, left, top, w, h, radius] = rect as number[];
      near(w, 0.3 * height, `width in frame heights at ${width}x${height}`);
      near(h, 0.2 * height, `height in frame heights at ${width}x${height}`);
      near(radius, 0.01 * height, "corner radius");
      near((left! + w!) / width, 0.98, `right edge at ${width}x${height}`);
      near((top! + h!) / height, 0.97, `bottom edge at ${width}x${height}`);
    }
  });

  it("places an item at each of the nine anchors", () => {
    const { hud, log } = hudAt(1000, 1000);
    const anchors = [
      "top-left",
      "top",
      "top-right",
      "left",
      "center",
      "right",
      "bottom-left",
      "bottom",
      "bottom-right",
    ];
    for (const anchor of anchors) hud.api.panel(anchor, { anchor, x: 0, y: 0, w: 0.2, h: 0.2 });
    hud.compose();
    const corners = callsOf(log, "roundRect").map((call) => [call[1], call[2]]);
    assert.deepEqual(corners, [
      [0, 0],
      [400, 0],
      [800, 0],
      [0, 400],
      [400, 400],
      [800, 400],
      [0, 800],
      [400, 800],
      [800, 800],
    ]);
  });

  it("draws a vector path through its viewBox into its box", () => {
    const { hud, log } = hudAt(1600, 900);
    hud.api.path("arrow", "M0 0 L24 12 L0 24 Z", { x: 0.1, y: 0.1, w: 0.1, h: 0.1, viewBox: "0 0 24 24" });
    hud.compose();
    assert.deepEqual(callsOf(log, "translate")[0], ["translate", 160, 90]);
    const [scale] = callsOf(log, "scale");
    near(scale![1], 90 / 24, "x scale");
    near(scale![2], 90 / 24, "y scale");
    assert.deepEqual(callsOf(log, "fill"), [["fill", { path: "M0 0 L24 12 L0 24 Z" }]]);
    assert.equal(callsOf(log, "save").length, callsOf(log, "restore").length, "the transform is put back");
  });

  it("reports an image as pending until it has decoded, then draws it", () => {
    const { hud, log } = hudAt(1600, 900);
    hud.api.image("logo", "assets/logo.png", { x: 0.05, y: 0.05, h: 0.1 });
    hud.compose();
    assert.deepEqual(callsOf(log, "drawImage"), [], "nothing to draw before it decodes");
    assert.equal(hud.summary().pending, 1);
    page.images[0]!.onload!();
    hud.compose();
    const [draw] = callsOf(log, "drawImage");
    assert.deepEqual(draw!.slice(0, 2), ["drawImage", { image: "assets/logo.png" }]);
    near(draw![2], 80, "left");
    near(draw![3], 45, "top");
    near(draw![4], 180, "width from the image's own aspect");
    near(draw![5], 90, "height in frame heights");
    assert.equal(hud.summary().pending, 0);
  });

  it("registers a bundled font and counts it pending until it has loaded", async () => {
    const { hud } = hudAt(1600, 900);
    hud.api.font("Racing", "assets/racing.woff2");
    assert.equal(page.fonts[0]!.family, "Racing");
    assert.match(page.fonts[0]!.source, /assets\/racing\.woff2/);
    assert.equal(hud.summary().pending, 1);
    page.fonts[0]!.resolve();
    await delay(0);
    assert.equal(page.added.length, 1, "the face joins document.fonts");
    assert.equal(hud.summary().pending, 0);
  });

  it("names its generation and its kinds", () => {
    const module = hudModule as unknown as { HUD_GENERATION: number; HudItemKind: Record<string, string> };
    assert.equal(module.HUD_GENERATION, 2);
    assert.deepEqual(Object.values(module.HudItemKind).sort(), [
      "arc",
      "bar",
      "crosshair",
      "image",
      "panel",
      "path",
      "text",
    ]);
  });
});

describe("the summary state() carries", () => {
  it("stays a few kilobytes with six thousand items, and still counts them", () => {
    const { hud } = hudAt(1600, 900);
    for (let i = 0; i < 6000; i++) {
      hud.api.bar(`segment-${i}`, 0.5, { x: (i % 100) / 100, y: Math.floor(i / 100) / 60, w: 0.008, h: 0.01 });
    }
    const summary = hud.summary();
    assert.ok(JSON.stringify(summary).length < 4096, `${JSON.stringify(summary).length} characters`);
    assert.equal(summary.count, 6000);
    assert.equal((summary.items as string[]).length, 64);
    assert.equal((summary.items as string[])[0], "segment-0");
    assert.deepEqual(summary.kinds, { bar: 6000 });
  });

  it("measures the share of the frame the HUD covers", () => {
    const { hud } = hudAt(1600, 900);
    assert.equal(hud.summary().coverage, 0, "an empty HUD covers nothing");
    hud.api.bar("a", 1, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    hud.api.bar("b", 1, { x: 0.5, y: 0.5, w: 0.3, h: 0.2 });
    const coverage = Number(hud.summary().coverage);
    assert.ok(Math.abs(coverage - 0.08) <= 0.01, `two bars cover 8% of the frame, measured ${coverage}`);
    hud.api.bar("b-again", 1, { x: 0.5, y: 0.5, w: 0.3, h: 0.2 });
    assert.equal(hud.summary().coverage, coverage, "the same area twice is covered once");
  });

  it("names panels that run into each other once, and not the text inside a panel", () => {
    const { hud } = hudAt(1600, 900);
    hud.api.panel("left", { x: 0.1, y: 0.1, w: 0.3, h: 0.3 });
    hud.api.panel("right", { x: 0.2, y: 0.1, w: 0.3, h: 0.3 });
    hud.api.text("label", "SPEED", { x: 0.12, y: 0.12 });
    assert.deepEqual(hud.summary().overlaps, [["left", "right"]]);
  });

  it("lists only a few overlaps however many items collide", () => {
    const { hud } = hudAt(1600, 900);
    for (let i = 0; i < 40; i++) hud.api.bar(`stack-${i}`, 1, { x: 0.4, y: 0.4, w: 0.2, h: 0.05 });
    const overlaps = hud.summary().overlaps as unknown[];
    assert.ok(overlaps.length > 0 && overlaps.length <= 8, `${overlaps.length} overlaps listed`);
  });

  it("leaves a hidden crosshair out of the coverage", () => {
    const { hud } = hudAt(1600, 900);
    hud.api.crosshair({ visible: false });
    assert.equal(hud.summary().coverage, 0);
    assert.equal(hud.summary().crosshair, false);
  });
});

/** A page `installStudio` can run on: no animation frames, no events, the test's canvases. */
function studioPage(body: unknown = null): void {
  const globals = globalThis as unknown as Loose;
  globals.window = { addEventListener: () => {}, requestAnimationFrame: () => 1 };
  const document = globals.document as Loose;
  document.addEventListener = () => {};
  document.querySelector = () => null;
  document.body = body;
}

async function installStudio(config: Loose): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const { installStudio: install } = await import("../../src/game-template/src/studio.js");
  return install(config as never) as unknown as Record<string, (...args: unknown[]) => unknown>;
}

describe("the HUD through installStudio", () => {
  let hadWindow: unknown;
  let hadStyle: unknown;
  beforeEach(() => {
    const globals = globalThis as unknown as Loose;
    hadWindow = globals.window;
    hadStyle = globals.getComputedStyle;
  });
  afterEach(() => {
    const globals = globalThis as unknown as Loose;
    globals.window = hadWindow;
    globals.getComputedStyle = hadStyle;
  });

  it("keeps state() under the evaluate cap with six thousand bars, before and after the module loads", async () => {
    studioPage();
    const renderer = { domElement: { width: 1600, height: 900 }, render() {}, setRenderTarget() {} };
    const api = await installStudio({ renderer });
    const hud = api.hud as unknown as HudApi;
    for (let i = 0; i < 6000; i++) hud.bar!(`segment-${i}`, 0.5, { x: (i % 100) / 100, y: Math.floor(i / 100) / 60 });

    const early = api.state!() as { hud: Loose };
    assert.ok(JSON.stringify(early).length < 64_000, `${JSON.stringify(early).length} characters before the load`);
    assert.equal(early.hud.count, 6000);
    assert.equal(early.hud.coverage, null, "nothing is measured before the module is there");

    for (let i = 0; i < 200 && hud.get!("segment-0") === null; i++) await delay(10);
    assert.notEqual(hud.get!("segment-0"), null, "the HUD module loaded and replayed the calls");
    const late = api.state!() as { hud: Loose };
    assert.ok(JSON.stringify(late).length < 64_000, `${JSON.stringify(late).length} characters after the load`);
    assert.equal(late.hud.count, 6000);
    assert.equal(typeof late.hud.coverage, "number");
  });
});

// ── no-dom-ui: a second canvas over the game ─────────────────────────────────

/** One element of a declared page: a tag, an id, a box in view pixels, and its style. */
function element(tag: string, id: string, box: [number, number, number, number], style: Loose = {}): Loose {
  const [x, y, w, h] = box;
  return {
    tagName: tag.toUpperCase(),
    id,
    className: "",
    childNodes: [],
    textContent: "",
    style,
    getBoundingClientRect: () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }),
    getClientRects: () => (w > 0 && h > 0 ? [1] : []),
    closest: () => null,
  };
}

function declarePage(elements: Loose[]): void {
  const globals = globalThis as unknown as Loose;
  (globals.document as Loose).body = { querySelectorAll: () => elements };
  globals.getComputedStyle = (node: Loose) => ({
    display: "block",
    visibility: "visible",
    opacity: "1",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    borderStyle: "none",
    borderWidth: "0px",
    ...(node.style as Loose),
  });
}

describe("no-dom-ui sees a second canvas over the game", () => {
  let hadWindow: unknown;
  let hadStyle: unknown;
  beforeEach(() => {
    const globals = globalThis as unknown as Loose;
    hadWindow = globals.window;
    hadStyle = globals.getComputedStyle;
  });
  afterEach(() => {
    const globals = globalThis as unknown as Loose;
    globals.window = hadWindow;
    globals.getComputedStyle = hadStyle;
  });

  const game = element("canvas", "game", [0, 0, 960, 600]);
  const overlay = element("canvas", "overlay", [0, 0, 960, 600]);
  const beside = element("canvas", "minimap", [970, 0, 200, 200]);
  const hidden = element("canvas", "ghost", [0, 0, 960, 600], { display: "none" });
  const expected = ["canvas#overlay (second canvas over the game)"];

  it("in the page hook", () => {
    declarePage([game, overlay, beside, hidden]);
    assert.deepEqual(hookDomUi(game), expected);
    assert.deepEqual(sceneHelpers({ renderer: { domElement: game } }).domUi(), expected);
    assert.deepEqual(hookDomUi(null), [], "with no game canvas known, no canvas is judged");
  });

  it("in the contract's own fallback", async () => {
    studioPage();
    declarePage([game, overlay, beside, hidden]);
    const api = await installStudio({ scene: { children: [] }, renderer: { domElement: game, render() {} } });
    const inspected = (api.inspect as () => { domUi(): string[] })();
    assert.deepEqual(inspected.domUi(), expected);
  });
});

// ── which HUD a game holds ───────────────────────────────────────────────────

describe("which HUD a game's copy is", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  const firstGeneration = read("../fixtures/hud-generation-1.js.txt");
  const template = read("../../src/game-template/src/hud.js");

  it("reads the generation a copy declares, and a copy that declares none as the first", () => {
    assert.equal(hudContractGeneration(null), 0, "no file at all");
    assert.equal(hudContractGeneration(firstGeneration), 1);
    assert.equal(hudContractGeneration(template), 2, "the shipped template is the current one");
    assert.equal(hudContractGeneration("export const HUD_GENERATION = 7;\n"), 7);
  });

  it("recognises only the exact bytes the studio shipped, whatever the line endings", () => {
    assert.equal(shippedHudGeneration(firstGeneration), 1);
    assert.equal(shippedHudGeneration(firstGeneration.replace(/\n/g, "\r\n")), 1, "a checkout with CRLF endings");
    assert.equal(shippedHudGeneration(`${firstGeneration}// my own tweak\n`), null, "an edited copy is the game's");
    assert.equal(shippedHudGeneration(firstGeneration.replace("0.86", "0.9")), null);
    assert.equal(shippedHudGeneration(null), null);
    assert.equal(shippedHudGeneration(template), null, "the current HUD is not an older shipped one");
  });
});
