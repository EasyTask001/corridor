/**
 * Proof-of-delivery signature capture, with no native dependency.
 *
 * The screen collects raw touch points (PanResponder); this module turns them
 * into (a) an SVG path for the live preview and (b) a real PNG for upload.
 * Encoding the PNG here rather than screenshotting a view keeps the whole
 * pipeline pure TypeScript — unit-testable, and free of `react-native-view-shot`
 * or a WebView-backed canvas.
 *
 * The output is an 8-bit greyscale PNG whose IDAT is a zlib stream of *stored*
 * (uncompressed) deflate blocks: a signature is a few hundred KB of mostly
 * white at most, and a real deflate implementation would be far more code than
 * the saving is worth.
 */

export interface Point {
  x: number;
  y: number;
}

export type Stroke = Point[];

export interface SignatureCanvas {
  width: number;
  height: number;
  /** Stroke thickness in pixels (odd numbers centre nicely). */
  lineWidth?: number;
}

export const SIGNATURE_FILENAME = "pod-signature.png";
export const SIGNATURE_MIME_TYPE = "image/png";

/** `M x y L x y …` for `react-native-svg`'s `<Path d>`. A single tap becomes a dot. */
export function strokesToSvgPath(strokes: Stroke[]): string {
  return strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => {
      const [head, ...rest] = stroke;
      const start = `M ${round(head!.x)} ${round(head!.y)}`;
      if (rest.length === 0) return `${start} L ${round(head!.x + 0.1)} ${round(head!.y)}`;
      return [start, ...rest.map((p) => `L ${round(p.x)} ${round(p.y)}`)].join(" ");
    })
    .join(" ");
}

export function isSignatureEmpty(strokes: Stroke[]): boolean {
  return strokes.every((stroke) => stroke.length === 0);
}

/** Render the strokes as an 8-bit greyscale PNG (black ink on white). */
export function encodeSignaturePng(strokes: Stroke[], canvas: SignatureCanvas): Uint8Array {
  const width = Math.max(1, Math.round(canvas.width));
  const height = Math.max(1, Math.round(canvas.height));
  const pixels = rasterize(strokes, width, height, canvas.lineWidth ?? 3);

  // PNG scanlines are prefixed with a filter byte; 0 = "None".
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Base64 without `Buffer` (absent in React Native) — for a `data:` URI. */
export function toBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : alphabet[c & 63];
  }
  return out;
}

/** A `data:` URI the app can hand to `fetch()` to obtain an uploadable Blob. */
export function signatureDataUri(png: Uint8Array): string {
  return `data:${SIGNATURE_MIME_TYPE};base64,${toBase64(png)}`;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

const round = (n: number) => Math.round(n * 10) / 10;

function rasterize(
  strokes: Stroke[],
  width: number,
  height: number,
  lineWidth: number,
): Uint8Array {
  const pixels = new Uint8Array(width * height).fill(0xff);
  const radius = Math.max(0, Math.floor((lineWidth - 1) / 2));

  const plot = (x: number, y: number) => {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && px < width && py >= 0 && py < height) pixels[py * width + px] = 0;
      }
    }
  };

  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    plot(Math.round(stroke[0]!.x), Math.round(stroke[0]!.y));
    for (let i = 1; i < stroke.length; i += 1) {
      line(
        Math.round(stroke[i - 1]!.x),
        Math.round(stroke[i - 1]!.y),
        Math.round(stroke[i]!.x),
        Math.round(stroke[i]!.y),
        plot,
      );
    }
  }
  return pixels;
}

/** Bresenham — integer-only, so it behaves identically on every device. */
function line(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number) => void,
) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    plot(x, y);
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

const DEFLATE_MAX_BLOCK = 0xffff;

/** zlib container around stored (BTYPE=00) deflate blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([0x78, 0x01])];
  for (let offset = 0; offset < data.length; offset += DEFLATE_MAX_BLOCK) {
    const block = data.subarray(offset, Math.min(offset + DEFLATE_MAX_BLOCK, data.length));
    const isLast = offset + DEFLATE_MAX_BLOCK >= data.length ? 1 : 0;
    const len = block.length;
    parts.push(
      Uint8Array.from([isLast, len & 0xff, (len >>> 8) & 0xff, ~len & 0xff, (~len >>> 8) & 0xff]),
      block,
    );
  }
  const adler = adler32(data);
  parts.push(
    Uint8Array.from([
      (adler >>> 24) & 0xff,
      (adler >>> 16) & 0xff,
      (adler >>> 8) & 0xff,
      adler & 0xff,
    ]),
  );
  return concat(parts);
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
