/**
 * Tone numbers for an Unreal capture, so an agent judges its own frame against numbers as well as
 * its eye: the black point (luminance p2), the white point (p98), the contrast (luminance std),
 * aerial perspective (the far band, the upper middle of the frame, should be calmer than the near
 * band, its lower third) and the mean saturation. A frame without a deep black or with flat
 * contrast reads as fog soup or noon haze, however good its models are.
 *
 * Captures are PNGs, decoded here with node:zlib alone: 8-bit (or 16-bit, read at 8) grey, grey
 * with alpha, RGB, RGBA and palette images, not interlaced. Numbers are taken on a copy scaled to
 * {@link ANALYSIS_WIDTH} pixels wide, so a 4K still and a 720p strip frame read alike. The module
 * also encodes PNGs and lays frames out as one contact sheet, so a motion strip reaches the agent
 * as one picture.
 */
import { deflateSync, inflateSync } from "node:zlib";

/** A decoded image: 8-bit RGB samples row by row, three per pixel. */
export type RgbImage = { width: number; height: number; rgb: Uint8Array };

/** One tone gate check, by its wire name. */
export const ToneCheck = {
  BlackPoint: "black-point",
  Contrast: "contrast",
  AerialPerspective: "aerial-perspective",
} as const;
export type ToneCheck = (typeof ToneCheck)[keyof typeof ToneCheck];

/** A frame's tone numbers, each 0 to 1 (luminance is Rec. 709 on sRGB values). */
export type Tone = {
  /** The 2nd percentile of luminance: the black point. */
  p2: number;
  /** The 98th percentile of luminance: the white point. */
  p98: number;
  mean: number;
  /** The standard deviation of luminance: the contrast. */
  std: number;
  /** The luminance std of the lower third (the near ground). */
  nearStd: number;
  /** The luminance std of the upper middle band, from a third to half way down (the distance). */
  farStd: number;
  /** The mean HSV saturation. */
  saturation: number;
  /** The share of pixels at full white. */
  clipped: number;
};

/** The tone gate: a deep black point, real contrast, and air between near and far. */
export const BLACK_POINT_MAX = 0.05;
export const CONTRAST_MIN = 0.18;
/** A frame whose white point (p98) is under this is nearly black: more likely a render gone wrong than a grade. */
export const UNLIT_WHITE_MAX = 0.1;
/** The width tone numbers are taken at. */
export const ANALYSIS_WIDTH = 480;
/** The size consecutive strip frames are compared at. */
const DIFFERENCE_SIZE = { width: 320, height: 180 } as const;
/** The largest image decoded: a 4K capture is about 8.3 million pixels. */
const MAX_PIXELS = 40_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes per chunk header (length + type) and trailer (CRC). */
const CHUNK_HEAD = 8;
const CHUNK_CRC = 4;
const LUMA = [0.2126, 0.7152, 0.0722] as const;
const FULL = 255;

/** PNG colour types, by their number in IHDR. */
const ColorType = { Grey: 0, Rgb: 2, Palette: 3, GreyAlpha: 4, Rgba: 6 } as const;
type ColorType = (typeof ColorType)[keyof typeof ColorType];
const CHANNELS: Record<ColorType, number> = {
  [ColorType.Grey]: 1,
  [ColorType.Rgb]: 3,
  [ColorType.Palette]: 1,
  [ColorType.GreyAlpha]: 2,
  [ColorType.Rgba]: 4,
};

const MESSAGE = {
  NotPng: "The file is not a PNG.",
  Truncated: "The PNG is cut short.",
  NoHeader: "The PNG has no header.",
  Unsupported: (what: string) => `This PNG is not one the bridge reads: ${what}.`,
  TooLarge: "The PNG is too large to read.",
  BadFilter: (filter: number) => `The PNG has an unknown row filter ${filter}.`,
  NoPalette: "The palette PNG has no palette.",
  NoFrames: "There are no frames to lay out.",
} as const;

type Header = { width: number; height: number; depth: number; colorType: ColorType };

function isColorType(value: number): value is ColorType {
  return (Object.values(ColorType) as number[]).includes(value);
}

/** The IHDR fields this decoder reads, or an error naming what it can't. */
function readHeader(data: Buffer): Header {
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const [depth = 0, colorType = 0, , , interlace = 0] = data.subarray(8, 13);
  if (!isColorType(colorType)) throw new Error(MESSAGE.Unsupported(`colour type ${colorType}`));
  if (interlace !== 0) throw new Error(MESSAGE.Unsupported("interlaced"));
  const depthOk = depth === 8 || (depth === 16 && colorType !== ColorType.Palette);
  if (!depthOk) throw new Error(MESSAGE.Unsupported(`${depth}-bit samples`));
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw new Error(MESSAGE.TooLarge);
  return { width, height, depth, colorType };
}

type Chunks = { header: Header; palette: Buffer | undefined; data: Buffer };
type Chunk = { type: string; body: Buffer; next: number };

/** The chunk starting at `at`, and where the next one starts. */
function chunkAt(file: Buffer, at: number): Chunk {
  if (at + CHUNK_HEAD > file.length) throw new Error(MESSAGE.Truncated);
  const length = file.readUInt32BE(at);
  const end = at + CHUNK_HEAD + length;
  if (end + CHUNK_CRC > file.length) throw new Error(MESSAGE.Truncated);
  return {
    type: file.toString("latin1", at + 4, at + CHUNK_HEAD),
    body: file.subarray(at + CHUNK_HEAD, end),
    next: end + CHUNK_CRC,
  };
}

/** The PNG's header, palette and joined image data. */
function readChunks(png: Uint8Array): Chunks {
  const file = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const signed = file.length >= PNG_SIGNATURE.length && file.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  if (!signed) throw new Error(MESSAGE.NotPng);
  let header: Header | undefined;
  let palette: Buffer | undefined;
  const data: Buffer[] = [];
  for (let chunk = chunkAt(file, PNG_SIGNATURE.length); chunk.type !== "IEND"; chunk = chunkAt(file, chunk.next)) {
    if (chunk.type === "IHDR") header = readHeader(chunk.body);
    else if (chunk.type === "PLTE") palette = chunk.body;
    else if (chunk.type === "IDAT") data.push(chunk.body);
  }
  if (!header) throw new Error(MESSAGE.NoHeader);
  if (data.length === 0) throw new Error(MESSAGE.Truncated);
  return { header, palette, data: Buffer.concat(data) };
}

/** The predictor a row filter adds back to a sample. */
function predicted(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      const p = left + up - upLeft;
      const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
      if (pa <= pb && pa <= pc) return left;
      return pb <= pc ? up : upLeft;
    }
    default:
      throw new Error(MESSAGE.BadFilter(filter));
  }
}

/** Undoes one row's filter in place: `out` holds the rows above it already undone. */
function unfilterRow(raw: Buffer, out: Uint8Array, y: number, stride: number, bytesPerPixel: number): void {
  const filter = raw[y * (stride + 1)] ?? 0;
  const row = y * stride;
  for (let x = 0; x < stride; x++) {
    const hasLeft = x >= bytesPerPixel;
    const left = hasLeft ? (out[row + x - bytesPerPixel] ?? 0) : 0;
    const up = y > 0 ? (out[row - stride + x] ?? 0) : 0;
    const upLeft = hasLeft && y > 0 ? (out[row - stride + x - bytesPerPixel] ?? 0) : 0;
    out[row + x] = ((raw[y * (stride + 1) + 1 + x] ?? 0) + predicted(filter, left, up, upLeft)) & 0xff;
  }
}

/** The image's samples with every row's filter undone. */
function unfilter(raw: Buffer, height: number, stride: number, bytesPerPixel: number): Uint8Array {
  if (raw.length < height * (stride + 1)) throw new Error(MESSAGE.Truncated);
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) unfilterRow(raw, out, y, stride, bytesPerPixel);
  return out;
}

/** The RGB of one pixel of unfiltered samples. */
function pixelRgb(samples: Uint8Array, index: number, chunks: Chunks): [number, number, number] {
  const { colorType, depth } = chunks.header;
  const step = depth / 8;
  const at = index * CHANNELS[colorType] * step;
  const sample = (channel: number) => samples[at + channel * step] ?? 0;
  if (colorType === ColorType.Palette) {
    const entry = (samples[index] ?? 0) * 3;
    const palette = chunks.palette;
    if (!palette) throw new Error(MESSAGE.NoPalette);
    return [palette[entry] ?? 0, palette[entry + 1] ?? 0, palette[entry + 2] ?? 0];
  }
  if (colorType === ColorType.Grey || colorType === ColorType.GreyAlpha) return [sample(0), sample(0), sample(0)];
  return [sample(0), sample(1), sample(2)];
}

/** Decodes a PNG (see the module notes); throws for anything it can't read, never answers a partial picture. */
export function decodePng(png: Uint8Array): RgbImage {
  const chunks = readChunks(png);
  const { width, height, depth, colorType } = chunks.header;
  const bytesPerPixel = Math.max(1, (CHANNELS[colorType] * depth) / 8);
  const stride = width * bytesPerPixel;
  const raw = inflateSync(chunks.data, { maxOutputLength: height * (stride + 1) });
  const samples = unfilter(raw, height, stride, bytesPerPixel);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(pixelRgb(samples, i, chunks), i * 3);
  return { width, height, rgb };
}

/** CRC-32 of a chunk's type and data, as PNG requires. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(CHUNK_CRC);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8-bit RGB PNG of the image, rows unfiltered. */
export function encodePng(image: RgbImage): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, ColorType.Rgb, 0, 0, 0], 8);
  const stride = image.width * 3;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++)
    raw.set(image.rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The source rows or columns [from, to) that target index `index` of `count` covers in `size`. */
function span(index: number, count: number, size: number): [number, number] {
  const from = Math.floor((index * size) / count);
  return [from, Math.max(from + 1, Math.floor(((index + 1) * size) / count))];
}

/** The mean colour of the source pixels in rows [top, bottom) and columns [left, right), written at `at`. */
function averageInto(image: RgbImage, rows: [number, number], columns: [number, number], out: Uint8Array, at: number) {
  const sum = [0, 0, 0];
  for (let y = rows[0]; y < rows[1]; y++)
    for (let x = columns[0]; x < columns[1]; x++) {
      const source = (y * image.width + x) * 3;
      for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (image.rgb[source + c] ?? 0);
    }
  const count = (rows[1] - rows[0]) * (columns[1] - columns[0]);
  for (let c = 0; c < 3; c++) out[at + c] = Math.round((sum[c] ?? 0) / count);
}

/** The image scaled to `width` x `height` by averaging the source pixels each target pixel covers. */
export function resize(image: RgbImage, width: number, height: number): RgbImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const rows = span(y, height, image.height);
    for (let x = 0; x < width; x++) averageInto(image, rows, span(x, width, image.width), rgb, (y * width + x) * 3);
  }
  return { width, height, rgb };
}

/** The image at {@link ANALYSIS_WIDTH} wide (never enlarged). */
function forAnalysis(image: RgbImage): RgbImage {
  if (image.width <= ANALYSIS_WIDTH) return image;
  const height = Math.max(1, Math.round((image.height * ANALYSIS_WIDTH) / image.width));
  return resize(image, ANALYSIS_WIDTH, height);
}

const luminance = (image: RgbImage, i: number) =>
  (LUMA[0] * (image.rgb[i * 3] ?? 0) + LUMA[1] * (image.rgb[i * 3 + 1] ?? 0) + LUMA[2] * (image.rgb[i * 3 + 2] ?? 0)) /
  FULL;

function saturationAt(image: RgbImage, i: number): number {
  const channels = [image.rgb[i * 3] ?? 0, image.rgb[i * 3 + 1] ?? 0, image.rgb[i * 3 + 2] ?? 0];
  const high = Math.max(...channels);
  return high > 0 ? (high - Math.min(...channels)) / high : 0;
}

/** The standard deviation of values. */
function deviation(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] ?? 0;
  const mean = sum / values.length;
  let squares = 0;
  for (let i = 0; i < values.length; i++) squares += ((values[i] ?? 0) - mean) ** 2;
  return Math.sqrt(squares / values.length);
}

/** The value at a percentile of values sorted ascending. */
const percentile = (sorted: Float64Array, share: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))] ?? 0;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** A frame's tone numbers (see {@link Tone}). */
export function toneOf(frame: RgbImage): Tone {
  const image = forAnalysis(frame);
  const count = image.width * image.height;
  const lum = new Float64Array(count);
  let saturation = 0;
  let clipped = 0;
  for (let i = 0; i < count; i++) {
    lum[i] = luminance(image, i);
    saturation += saturationAt(image, i);
    if ((lum[i] ?? 0) >= 1) clipped++;
  }
  const band = (from: number, to: number) =>
    lum.subarray(Math.floor(from * image.height) * image.width, Math.floor(to * image.height) * image.width);
  const nearStd = deviation(band(2 / 3, 1));
  const farStd = deviation(band(1 / 3, 1 / 2));
  const std = deviation(lum);
  const sorted = Float64Array.from(lum).sort();
  const mean = lum.reduce((sum, value) => sum + value, 0) / count;
  return {
    p2: round3(percentile(sorted, 0.02)),
    p98: round3(percentile(sorted, 0.98)),
    mean: round3(mean),
    std: round3(std),
    nearStd: round3(nearStd),
    farStd: round3(farStd),
    saturation: round3(saturation / count),
    clipped: round3(clipped / count),
  };
}

/** Which tone gate checks a frame fails; it passes when it fails none. */
export function toneGate(tone: Tone): { pass: boolean; fails: ToneCheck[] } {
  const fails: ToneCheck[] = [];
  if (tone.p2 > BLACK_POINT_MAX) fails.push(ToneCheck.BlackPoint);
  if (tone.std < CONTRAST_MIN) fails.push(ToneCheck.Contrast);
  if (tone.farStd >= tone.nearStd) fails.push(ToneCheck.AerialPerspective);
  return { pass: fails.length === 0, fails };
}

/** Whether a frame is nearly black (its white point under {@link UNLIT_WHITE_MAX}). */
export const looksUnlit = (tone: Tone): boolean => tone.p98 < UNLIT_WHITE_MAX;

/**
 * How much two consecutive frames differ: the mean absolute difference (0 to 1) of their lower two
 * thirds at 320 x 180, so drifting clouds don't count as motion. A strip whose frames differ by
 * less than about 8/255 shows the same view.
 */
export function frameDifference(a: RgbImage, b: RgbImage): number {
  const [small, other] = [a, b].map((frame) => resize(frame, DIFFERENCE_SIZE.width, DIFFERENCE_SIZE.height));
  if (!small || !other) return 0;
  const from = Math.floor(DIFFERENCE_SIZE.height / 3) * DIFFERENCE_SIZE.width * 3;
  let sum = 0;
  for (let i = from; i < small.rgb.length; i++) sum += Math.abs((small.rgb[i] ?? 0) - (other.rgb[i] ?? 0));
  return sum / (small.rgb.length - from) / FULL;
}

/** Frames laid out `columns` to a row, each scaled to `cellWidth` wide at the first frame's aspect. */
export function contactSheet(frames: RgbImage[], columns: number, cellWidth: number): RgbImage {
  const [first] = frames;
  if (!first) throw new Error(MESSAGE.NoFrames);
  const cellHeight = Math.max(1, Math.round((first.height * cellWidth) / first.width));
  const across = Math.max(1, Math.min(columns, frames.length));
  const rows = Math.ceil(frames.length / across);
  const width = across * cellWidth;
  const sheet = new Uint8Array(width * rows * cellHeight * 3);
  frames.forEach((frame, n) => {
    const cell = resize(frame, cellWidth, cellHeight);
    const [left, top] = [(n % across) * cellWidth, Math.floor(n / across) * cellHeight];
    for (let y = 0; y < cellHeight; y++)
      sheet.set(cell.rgb.subarray(y * cellWidth * 3, (y + 1) * cellWidth * 3), ((top + y) * width + left) * 3);
  });
  return { width, height: rows * cellHeight, rgb: sheet };
}
