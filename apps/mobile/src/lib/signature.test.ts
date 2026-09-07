import { gunzipSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  encodeSignaturePng,
  isSignatureEmpty,
  signatureDataUri,
  strokesToSvgPath,
  toBase64,
  type Stroke,
} from "./signature";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Walk the chunk list so the test reads the file the way a decoder would. */
function chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const found: { type: string; data: Uint8Array }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    found.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return found;
}

describe("strokesToSvgPath", () => {
  it("emits one move-to per stroke", () => {
    const strokes: Stroke[] = [
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      [{ x: 10, y: 11 }],
    ];
    expect(strokesToSvgPath(strokes)).toBe("M 1 2 L 3 4 M 10 11 L 10.1 11");
  });

  it("ignores empty strokes", () => {
    expect(strokesToSvgPath([[], []])).toBe("");
    expect(isSignatureEmpty([[], []])).toBe(true);
    expect(isSignatureEmpty([[{ x: 0, y: 0 }]])).toBe(false);
  });
});

describe("toBase64", () => {
  it("matches Node's own encoder at every padding length", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 255]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256);
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
});

describe("encodeSignaturePng", () => {
  const canvas = { width: 40, height: 20, lineWidth: 1 };

  it("produces a structurally valid PNG", () => {
    const png = encodeSignaturePng([], canvas);
    expect([...png.subarray(0, 8)]).toEqual(PNG_MAGIC);
    expect(chunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);

    const ihdr = chunks(png)[0]!.data;
    const view = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
    expect(view.getUint32(0)).toBe(40);
    expect(view.getUint32(4)).toBe(20);
    expect([ihdr[8], ihdr[9]]).toEqual([8, 0]); // 8-bit greyscale
  });

  it("writes a zlib stream Node can inflate, with a filter byte per row", () => {
    const png = encodeSignaturePng([], canvas);
    const raw = inflateSync(Buffer.from(chunks(png)[1]!.data));
    expect(raw).toHaveLength((40 + 1) * 20);
    // Blank canvas: every filter byte 0, every pixel white.
    for (let y = 0; y < 20; y += 1) expect(raw[y * 41]).toBe(0);
    expect(raw.every((b, i) => (i % 41 === 0 ? b === 0 : b === 255))).toBe(true);
    expect(() => gunzipSync(Buffer.from(chunks(png)[1]!.data))).toThrow(); // zlib, not gzip
  });

  it("draws the stroke as black pixels along the line", () => {
    const png = encodeSignaturePng(
      [
        [
          { x: 0, y: 5 },
          { x: 39, y: 5 },
        ],
      ],
      canvas,
    );
    const raw = inflateSync(Buffer.from(chunks(png)[1]!.data));
    const row = (y: number) => raw.subarray(y * 41 + 1, y * 41 + 41);
    expect([...row(5)].every((v) => v === 0)).toBe(true);
    expect([...row(4)].every((v) => v === 255)).toBe(true);
  });

  it("clips strokes that run off the canvas instead of throwing", () => {
    expect(() =>
      encodeSignaturePng(
        [
          [
            { x: -50, y: -50 },
            { x: 500, y: 500 },
          ],
        ],
        canvas,
      ),
    ).not.toThrow();
  });

  it("splits the deflate stream past the 64 KiB stored-block limit", () => {
    const big = encodeSignaturePng([], { width: 400, height: 400, lineWidth: 1 });
    const raw = inflateSync(Buffer.from(chunks(big)[1]!.data));
    expect(raw).toHaveLength(401 * 400); // > 65535, so more than one block
  });

  it("builds a data URI the app can turn into an uploadable blob", () => {
    const uri = signatureDataUri(encodeSignaturePng([], canvas));
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
  });
});
