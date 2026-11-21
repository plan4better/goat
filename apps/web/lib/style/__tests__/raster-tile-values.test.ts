// Values read from the value tiles the map loaded (raster/tileValues.ts): the code under a place on the tile the map
// draws there, decoded with the tiles' encoding, and the class or category a value is drawn in, checked against the
// shared raster color contract (packages/python/goatlib/tests/unit/style/fixtures/raster_color_cases.json). The
// tile's bytes and its decoding are handed in; the lab decodes real tiles in the browser (lab/rasters.lab.test.tsx).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { rasterColorSpec, rgbOf } from "@/lib/style/raster/color";
import {
  type MapRasterSource,
  type NamedRasterColorSpec,
  type PixelReaders,
  type TileValueDeps,
  type TilesMap,
  decodeWith,
  rasterClassAt,
  readsBackExactly,
  sourceTileOptions,
  tilePixelAt,
  tileUnder,
  tileValueAt,
  valueTileOptions,
} from "@/lib/style/raster/tileValues";
import { type RasterValues, valueTilesUrl } from "@/lib/style/raster/values";

type Decoded = Awaited<ReturnType<TileValueDeps["decode"]>>;

/** Whole numbers as goatlib encodes an int16 band: code q holds q - 32769. */
const VALUES: RasterValues = {
  encoding: { redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 32769 },
  range: [0, 9],
  integer: true,
  version: "v1-e3",
  maxzoom: 12,
};

/** The code of a value of VALUES. */
const code = (value: number) => value + 32769;

/** A value tile's URL template as the map's source names it, a new layer's each time: decoded tiles are kept under
 * their URLs for as long as the page lives, so every test reads tiles of its own. */
let layers = 0;
const template = (values: RasterValues = VALUES) =>
  valueTilesUrl(
    `https://geoapi.test/collections/l${++layers}/coverage`,
    { band: 1, resampling: "nearest" },
    values
  );

/** A template's tile at z/x/y. */
const tileUrl = (template: string, z: number, x: number, y: number) =>
  template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));

/** A decoded tile of `size` px, opaque, with codes at their pixels ([column, row, q]) and no data (q 0) elsewhere. */
function decoded(size: number, codes: Array<[number, number, number]>): Decoded {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  for (const [px, py, q] of codes) {
    const i = (py * size + px) * 4;
    rgba[i] = q >> 16;
    rgba[i + 1] = (q >> 8) & 255;
    rgba[i + 2] = q & 255;
  }
  return { width: size, height: size, rgba };
}

/** The place at pixel (px, py) of tile z/x/y of `size` px; fractions of a pixel allowed. */
function place(z: number, x: number, y: number, px: number, py: number, size = 256) {
  const n = 2 ** z;
  const tx = x + px / size;
  const ty = y + py / size;
  return {
    lng: (tx / n) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI,
  };
}

/** A tile at zoom 12 (Munich), and a place a quarter of a pixel into pixel (100, 37) of its 256 px picture: pixel
 * (200, 74) of its 512 px one. */
const Z = 12;
const X = 2176;
const Y = 1420;
const POINT = place(Z, X, Y, 100.25, 37.25);
/** The tile POINT is on, at zoom 12. */
const TILE = { z: Z, x: X, y: Y };

/** Tile reads answered with `tile` (null: no tile), counting the requests and decodings. */
function deps(tile: Decoded | null) {
  const bytes = new ArrayBuffer(8);
  return {
    bytes,
    fetchTile: vi.fn<TileValueDeps["fetchTile"]>(async () => (tile ? bytes : null)),
    decode: vi.fn<TileValueDeps["decode"]>(async () => {
      if (!tile) throw new Error("nothing to decode");
      return tile;
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A stand-in for `fetch` answering every tile with `status` (thrown: no answer), and the bytes it answers. */
function answering(status: () => number | Error) {
  const bytes = new ArrayBuffer(16);
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const answer = status();
    if (answer instanceof Error) throw answer;
    return { ok: answer >= 200 && answer < 300, status: answer, arrayBuffer: async () => bytes };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { bytes, fetchMock };
}

describe("tileValueAt", () => {
  it("reads the code under the point and decodes it with the encoding", async () => {
    // The pixel's neighbours hold other codes: a read one pixel off shows.
    const tile = decoded(256, [
      [100, 37, code(46)],
      [101, 37, code(47)],
      [99, 37, code(48)],
      [100, 38, code(49)],
      [100, 36, code(50)],
    ]);
    const read = deps(tile);
    const url = template();
    expect(await tileValueAt(VALUES, url, POINT, TILE, read)).toBe(46);
    // The tile the map's source asks for there, its path z/y/x as the template names it.
    expect(read.fetchTile).toHaveBeenCalledWith(tileUrl(url, Z, X, Y));
    expect(url).toContain("/{z}/{y}/{x}?");
    expect(read.decode).toHaveBeenCalledWith(read.bytes);

    // A fractional step and a code past 65535 (red, green and blue all in use): base + q * step.
    const step = 0.25;
    const fractional: RasterValues = {
      ...VALUES,
      encoding: { redFactor: 65536 * step, greenFactor: 256 * step, blueFactor: step, baseShift: 10 },
      integer: false,
    };
    const q = 1 * 65536 + 17 * 256 + 112;
    const other = deps(decoded(256, [[100, 37, q]]));
    expect(await tileValueAt(fractional, template(fractional), POINT, TILE, other)).toBe(-10 + q * step);
  });

  it("reads a 512 px tile, as the map loads them, at the same place", async () => {
    const tile = decoded(512, [
      [200, 74, code(7)],
      [201, 74, code(8)],
      [200, 75, code(9)],
      [199, 74, code(10)],
      [200, 73, code(11)],
    ]);
    const url = template();
    const read = deps(tile);
    expect(await tileValueAt(VALUES, url, POINT, TILE, read)).toBe(7);
    expect(read.fetchTile).toHaveBeenCalledWith(tileUrl(url, Z, X, Y));
  });

  it("returns null for no data, outside the tile set and a missing tile", async () => {
    // Code 0 is no data.
    const empty = deps(decoded(256, [[101, 37, code(5)]]));
    expect(await tileValueAt(VALUES, template(), POINT, TILE, empty)).toBeNull();

    // Outside the file's bounds and past the map's latitudes: no tile is asked for.
    const outside = deps(decoded(256, [[100, 37, code(5)]]));
    const bounded: RasterValues = { ...VALUES, bounds: [11, 48, 12, 49] };
    expect(await tileValueAt(bounded, template(bounded), { lng: 12.5, lat: 48.5 }, TILE, outside)).toBeNull();
    expect(await tileValueAt(bounded, template(bounded), { lng: 11.5, lat: 47.5 }, TILE, outside)).toBeNull();
    expect(await tileValueAt(VALUES, template(), { lng: 11.5, lat: 86 }, TILE, outside)).toBeNull();
    expect(outside.fetchTile).not.toHaveBeenCalled();
    // Inside the bounds the tile is read.
    expect(await tileValueAt(bounded, template(bounded), POINT, TILE, outside)).toBe(5);
    expect(outside.fetchTile).toHaveBeenCalledTimes(1);
    // No tile under the point (none of the map's tiles holds it), or a tile that does not hold it.
    expect(await tileValueAt(VALUES, template(), POINT, null, outside)).toBeNull();
    expect(await tileValueAt(VALUES, template(), POINT, { ...TILE, x: X + 1 }, outside)).toBeNull();
    expect(await tileValueAt(VALUES, template(), POINT, { ...TILE, z: 13 }, outside)).toBeNull();
    expect(outside.fetchTile).toHaveBeenCalledTimes(1);

    // No tile there (geoapi answers 204 for a tile without cells).
    const missing = deps(null);
    expect(await tileValueAt(VALUES, template(), POINT, TILE, missing)).toBeNull();
    expect(missing.fetchTile).toHaveBeenCalledTimes(1);
    expect(missing.decode).not.toHaveBeenCalled();
  });

  it("reads a tile that fails to load or decode as no value, and does not ask for it again at once", async () => {
    const url = template();
    const failing = {
      fetchTile: vi.fn<TileValueDeps["fetchTile"]>(async () => {
        throw new TypeError("Failed to fetch");
      }),
      decode: vi.fn<TileValueDeps["decode"]>(),
    };
    expect(await tileValueAt(VALUES, url, POINT, TILE, failing)).toBeNull();
    expect(await tileValueAt(VALUES, url, POINT, TILE, failing)).toBeNull();
    // Hovering sends no request per move over a tile that failed (it is asked for again after a while, see below).
    expect(failing.fetchTile).toHaveBeenCalledTimes(1);

    const broken = deps(decoded(256, []));
    broken.decode.mockRejectedValue(new Error("not an image"));
    const brokenUrl = template();
    expect(await tileValueAt(VALUES, brokenUrl, POINT, TILE, broken)).toBeNull();
    expect(await tileValueAt(VALUES, brokenUrl, POINT, TILE, broken)).toBeNull();
    expect(broken.fetchTile).toHaveBeenCalledTimes(1);
  });

  it("reads the same tile in every copy of the world", async () => {
    const read = deps(decoded(256, [[100, 37, code(4)]]));
    const url = template();
    for (const shift of [0, 360, -720]) {
      expect(await tileValueAt(VALUES, url, { ...POINT, lng: POINT.lng + shift }, TILE, read)).toBe(4);
    }
    expect(read.fetchTile).toHaveBeenCalledTimes(1);
    expect(read.fetchTile).toHaveBeenCalledWith(tileUrl(url, Z, X, Y));
  });

  it("decodes a tile once for many reads", async () => {
    const tile = decoded(
      256,
      Array.from({ length: 20 }, (_, i) => [10 * i, 5 * i, code(i)] as [number, number, number])
    );
    const read = deps(tile);
    const url = template();
    // Twenty reads while the tile is still loading share its one request and decoding.
    const values = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tileValueAt(VALUES, url, place(Z, X, Y, 10 * i + 0.5, 5 * i + 0.5), TILE, read)
      )
    );
    expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(await tileValueAt(VALUES, url, place(Z, X, Y, 30.5, 15.5), TILE, read)).toBe(3);
    expect(read.fetchTile).toHaveBeenCalledTimes(1);
    expect(read.decode).toHaveBeenCalledTimes(1);
  });

  it("keeps the 24 tiles read last", async () => {
    const read = deps(decoded(256, [[100, 37, code(1)]]));
    const url = template();
    const at = (i: number) =>
      tileValueAt(VALUES, url, place(Z, X + i, Y, 100.25, 37.25), { ...TILE, x: X + i }, read);
    for (let i = 0; i < 24; i++) await at(i);
    expect(read.decode).toHaveBeenCalledTimes(24);
    // Tile 0 read again is kept, and is then read more recently than tile 1.
    await at(0);
    expect(read.decode).toHaveBeenCalledTimes(24);
    // A 25th tile leaves out the one read longest ago: tile 1.
    await at(24);
    expect(read.decode).toHaveBeenCalledTimes(25);
    await at(0);
    expect(read.decode).toHaveBeenCalledTimes(25);
    await at(1);
    expect(read.decode).toHaveBeenCalledTimes(26);
  });

  it("asks the browser cache first, as MapLibre asks for the tile, and a 204 or a 4xx is no tile", async () => {
    let status = 200;
    const { bytes, fetchMock } = answering(() => status);
    const decode = vi.fn<TileValueDeps["decode"]>(async () => decoded(256, [[100, 37, code(2)]]));

    const url = template();
    expect(await tileValueAt(VALUES, url, POINT, TILE, { decode })).toBe(2);
    // The URL the map's source loaded, from the browser's cache whatever its age (the tiles are immutable), with the
    // Accept header MapLibre sends for image tiles: a cache that keeps answers by Accept finds the map's.
    expect(fetchMock).toHaveBeenCalledWith(tileUrl(url, Z, X, Y), {
      cache: "force-cache",
      headers: { accept: "image/webp,*/*" },
    });
    expect(decode).toHaveBeenCalledWith(bytes);

    for (const answer of [204, 404]) {
      status = answer;
      expect(await tileValueAt(VALUES, template(), POINT, TILE, { decode }), `status ${answer}`).toBeNull();
    }
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("asks again 30 seconds after a 5xx or no answer, never after a 204 or a 4xx", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const later = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);
    const decode = vi.fn<TileValueDeps["decode"]>(async () => decoded(256, [[100, 37, code(8)]]));
    const answers: Record<string, Array<number | Error>> = {};
    const { fetchMock } = answering(() => 0);
    fetchMock.mockImplementation(async (url: string) => {
      const answer = answers[url].shift()!;
      if (answer instanceof Error) throw answer;
      return {
        ok: answer >= 200 && answer < 300,
        status: answer,
        arrayBuffer: async () => new ArrayBuffer(8),
      };
    });
    const cases = [
      { first: 503, again: true },
      { first: new TypeError("Failed to fetch"), again: true },
      { first: 204, again: false },
      { first: 404, again: false },
    ].map((c) => {
      const url = template();
      answers[tileUrl(url, Z, X, Y)] = [c.first, 200];
      return { ...c, url, read: () => tileValueAt(VALUES, url, POINT, TILE, { decode }) };
    });

    for (const c of cases) expect(await c.read(), String(c.first)).toBeNull();
    later(29);
    for (const c of cases) expect(await c.read(), String(c.first)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    later(2);
    for (const c of cases) expect(await c.read(), String(c.first)).toBe(c.again ? 8 : null);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    // Read once, a tile is kept for good.
    later(3600);
    for (const c of cases) expect(await c.read(), String(c.first)).toBe(c.again ? 8 : null);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("never rejects, whatever the tile reader does", async () => {
    const tile = decoded(256, [[100, 37, code(9)]]);
    const throwing = {
      fetchTile: vi.fn<TileValueDeps["fetchTile"]>(() => {
        throw new Error("thrown at once");
      }),
      decode: vi.fn<TileValueDeps["decode"]>(async () => tile),
    };
    await expect(tileValueAt(VALUES, template(), POINT, TILE, throwing)).resolves.toBeNull();

    const badDecode = {
      fetchTile: vi.fn<TileValueDeps["fetchTile"]>(async () => new ArrayBuffer(8)),
      decode: vi.fn<TileValueDeps["decode"]>(() => {
        throw new Error("thrown at once");
      }),
    };
    await expect(tileValueAt(VALUES, template(), POINT, TILE, badDecode)).resolves.toBeNull();

    // A reader left out takes the default.
    answering(() => 200);
    await expect(
      tileValueAt(VALUES, template(), POINT, TILE, { fetchTile: undefined, decode: async () => tile })
    ).resolves.toBe(9);
  });

  it("reads at the antimeridian and up to the edge of the map's latitudes", async () => {
    const n = 2 ** Z;
    // Every pixel holds the code, so any place on the tile reads it.
    const full = decoded(
      256,
      Array.from({ length: 256 * 256 }, (_, i) => [i % 256, Math.floor(i / 256), code(6)])
    );
    const read = deps(full);
    const url = template();
    // East and west of the antimeridian are the same place: the first column of tiles.
    for (const lng of [180, -180]) {
      expect(
        await tileValueAt(VALUES, url, { lng, lat: POINT.lat }, { ...TILE, x: 0 }, read),
        `lng ${lng}`
      ).toBe(6);
    }
    expect(read.fetchTile).toHaveBeenCalledTimes(1);
    expect(read.fetchTile).toHaveBeenCalledWith(tileUrl(url, Z, 0, Y));

    // Just inside the map's latitudes, the first and the last row of tiles; just outside, no tile is asked for.
    expect(await tileValueAt(VALUES, url, { lng: POINT.lng, lat: 85.05 }, { ...TILE, y: 0 }, read)).toBe(6);
    expect(read.fetchTile).toHaveBeenLastCalledWith(tileUrl(url, Z, X, 0));
    expect(await tileValueAt(VALUES, url, { lng: POINT.lng, lat: -85.05 }, { ...TILE, y: n - 1 }, read)).toBe(
      6
    );
    expect(read.fetchTile).toHaveBeenLastCalledWith(tileUrl(url, Z, X, n - 1));
    expect(read.fetchTile).toHaveBeenCalledTimes(3);
    for (const lat of [85.0512, -85.0512]) {
      const edge = { ...TILE, y: lat > 0 ? 0 : n - 1 };
      expect(await tileValueAt(VALUES, url, { lng: POINT.lng, lat }, edge, read), `lat ${lat}`).toBeNull();
    }
    expect(read.fetchTile).toHaveBeenCalledTimes(3);
  });
});

describe("tilePixelAt", () => {
  /** A colored tile of `size` px, transparent but at the pixels painted ([column, row]). */
  function painted(size: number, pixels: Array<[number, number]>): Decoded {
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (const [px, py] of pixels) {
      const i = (py * size + px) * 4;
      rgba.set([200, 120, 40, 255], i);
    }
    return { width: size, height: size, rgba };
  }

  /** The map's raster source of an image, as MapLibre holds it: its tiles' URL template (`{z}/{x}/{y}`), a new
   * layer's each time, its size and zooms. */
  const imageSource = (bounds?: MapRasterSource["bounds"]): MapRasterSource => ({
    tiles: [`https://geoapi.test/collections/i${++layers}/raster/tiles/{z}/{x}/{y}.webp?style=abc&v=v1-e3`],
    tileSize: 512,
    minzoom: 0,
    maxzoom: 14,
    ...(bounds ? { bounds } : {}),
  });

  it("reads the color of a pixel the map paints on a colored tile, from the tile it loaded", async () => {
    const source = imageSource();
    const read = deps(painted(256, [[100, 37]]));
    expect(await tilePixelAt(source, POINT, TILE, read)).toEqual([200, 120, 40, 255]);
    // The map's own URL: the browser's cache answers.
    expect(read.fetchTile).toHaveBeenCalledWith(tileUrl(source.tiles[0], Z, X, Y));
    // A transparent pixel (no data, outside the file within the tile) is painted by nothing.
    expect(await tilePixelAt(source, place(Z, X, Y, 101.5, 37.5), TILE, read)).toBeNull();
    // One read of the tile for both.
    expect(read.fetchTile).toHaveBeenCalledTimes(1);
    // A partly transparent pixel comes with its alpha: a palette lookup answers only for an opaque one.
    const tile = painted(256, []);
    tile.rgba.set([10, 20, 30, 128], (37 * 256 + 100) * 4);
    expect(await tilePixelAt(imageSource(), POINT, TILE, deps(tile))).toEqual([10, 20, 30, 128]);
  });

  it("reads nothing outside the source, without a tile, or where the tile is missing", async () => {
    const read = deps(painted(256, [[100, 37]]));
    const bounded = imageSource([11, 48, 12, 49]);
    expect(await tilePixelAt(bounded, { lng: 12.5, lat: 48.5 }, TILE, read)).toBeNull();
    expect(await tilePixelAt(bounded, { lng: 11.5, lat: 86 }, TILE, read)).toBeNull();
    expect(await tilePixelAt(bounded, POINT, null, read)).toBeNull();
    expect(await tilePixelAt(bounded, POINT, { ...TILE, x: X + 1 }, read)).toBeNull();
    expect(read.fetchTile).not.toHaveBeenCalled();
    expect(await tilePixelAt(bounded, POINT, TILE, read)).toEqual([200, 120, 40, 255]);
    const missing = deps(null);
    expect(await tilePixelAt(imageSource(), POINT, TILE, missing)).toBeNull();
  });

  it("tells a pixel it could not read from one where nothing is painted", async () => {
    // A tile that failed to load, or whose pixels cannot be read exactly: unknown, not empty.
    const failing = {
      fetchTile: vi.fn<TileValueDeps["fetchTile"]>(async () => {
        throw new TypeError("Failed to fetch");
      }),
      decode: vi.fn<TileValueDeps["decode"]>(),
    };
    expect(await tilePixelAt(imageSource(), POINT, TILE, failing)).toBeUndefined();
    const inexact = deps(painted(256, [[100, 37]]));
    inexact.decode.mockRejectedValue(
      new Error("No exact way to read a value tile's pixels in this browser.")
    );
    expect(await tilePixelAt(imageSource(), POINT, TILE, inexact)).toBeUndefined();
    // Outside the source and where no tile is: nothing painted.
    expect(
      await tilePixelAt(imageSource([11, 48, 12, 49]), { lng: 12.5, lat: 48.5 }, TILE, failing)
    ).toBeNull();
  });

  it("asks for the tiles with the options of the map's raster source", () => {
    // The compiled image source names its size and, from the colored tiles' description, its native zoom; MapLibre
    // holds 0 and 22 for zooms the spec leaves out.
    const tiles = "https://geoapi.test/collections/l/raster/tiles/{z}/{x}/{y}.webp";
    for (const image of [{ version: "v1", maxzoom: 15 }, { version: "v1" }]) {
      const out = compileLayer({
        id: "1",
        style: { version: "1.0.0", kind: "raster", render: { type: "image" } } as LayerStyle,
        source: { type: "raster", id: "s", tiles, tileset: tiles, coverage: "c", version: "1", image },
      });
      const spec = out.sources.s as { type: string; tiles: string[]; tileSize: number; maxzoom?: number };
      expect(spec.type).toBe("raster");
      const held = { ...spec, minzoom: 0, maxzoom: spec.maxzoom ?? 22 };
      expect(sourceTileOptions(held)).toEqual({
        tileSize: 512,
        minzoom: 0,
        maxzoom: image.maxzoom ?? 22,
        roundZoom: true,
      });
    }
  });
});

describe("reading a tile's pixels", () => {
  /** A tile image of 2 x 1 px, closed once read. */
  const image = () => ({ width: 2, height: 1, close: vi.fn() }) as unknown as ImageBitmap;
  /** Two opaque pixels: code(5) and no data. */
  const PIXELS = decoded(1, [[0, 0, code(5)]]).rgba;
  const TWO = new Uint8ClampedArray([...PIXELS, 0, 0, 0, 255]);

  function readers(over: Partial<PixelReaders>) {
    const picture = image();
    return {
      picture,
      readers: {
        image: vi.fn<PixelReaders["image"]>(async () => picture),
        canvasExact: vi.fn<PixelReaders["canvasExact"]>(() => true),
        canvas: vi.fn<PixelReaders["canvas"]>(() => TWO),
        videoFrame: vi.fn<NonNullable<PixelReaders["videoFrame"]>>(async () => TWO),
        ...over,
      },
    };
  }

  it("reads through a canvas when it reads back exactly", async () => {
    const { picture, readers: r } = readers({});
    const bytes = new ArrayBuffer(8);
    expect(await decodeWith(r)(bytes)).toEqual({ width: 2, height: 1, rgba: TWO });
    expect(r.image).toHaveBeenCalledWith(bytes);
    expect(r.canvas).toHaveBeenCalledWith(picture);
    expect(r.videoFrame).not.toHaveBeenCalled();
    expect(picture.close).toHaveBeenCalled();
  });

  it("reads through a video frame where the canvas adds noise", async () => {
    const { picture, readers: r } = readers({ canvasExact: () => false });
    expect(await decodeWith(r)(new ArrayBuffer(8))).toEqual({ width: 2, height: 1, rgba: TWO });
    expect(r.videoFrame).toHaveBeenCalledWith(picture);
    expect(r.canvas).not.toHaveBeenCalled();
    expect(picture.close).toHaveBeenCalled();
  });

  it("gives no value, never a wrong one, where neither reads exactly", async () => {
    const tileRead = (r: PixelReaders) => ({
      fetchTile: async () => new ArrayBuffer(8),
      decode: decodeWith(r),
    });
    // No video frames in this browser.
    const { picture, readers: none } = readers({ canvasExact: () => false, videoFrame: undefined });
    await expect(decodeWith(none)(new ArrayBuffer(8))).rejects.toThrow();
    expect(picture.close).toHaveBeenCalled();
    const url = template();
    for (const x of [X, X + 1]) {
      const at = place(Z, x, Y, 0.25, 0.25, 2);
      expect(await tileValueAt(VALUES, url, at, { ...TILE, x }, tileRead(none))).toBeNull();
    }
    expect(none.canvas).not.toHaveBeenCalled();
    // A video frame the browser cannot copy (an unknown pixel format).
    const { readers: unknown } = readers({
      canvasExact: () => false,
      videoFrame: async () => {
        throw new Error("Unrecognized format I420");
      },
    });
    expect(
      await tileValueAt(VALUES, template(), place(Z, X, Y, 0.25, 0.25, 2), TILE, tileRead(unknown))
    ).toBeNull();
    expect(unknown.canvas).not.toHaveBeenCalled();
    // The same readers with an exact canvas read the value.
    const { readers: exact } = readers({});
    expect(await tileValueAt(VALUES, template(), place(Z, X, Y, 0.25, 0.25, 2), TILE, tileRead(exact))).toBe(
      5
    );
  });

  it("finds a canvas that adds noise with MapLibre's 5 x 5 pattern", () => {
    /** A 2D context that keeps what is drawn, and adds `noise` to one byte of what it reads back. */
    const context = (noise: number) => {
      const data = new Uint8ClampedArray(5 * 5 * 4);
      return {
        fillStyle: "" as string,
        fillRect(x: number, y: number) {
          const [r, g, b] = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(this.fillStyle)!.slice(1).map(Number);
          data.set([r, g, b, 255], (y * 5 + x) * 4);
        },
        getImageData: () => {
          const read = new Uint8ClampedArray(data);
          read[42] += noise;
          return { data: read } as ImageData;
        },
      };
    };
    expect(readsBackExactly(context(0))).toBe(true);
    expect(readsBackExactly(context(1))).toBe(false);
  });
});

/** A covering tile as MapLibre's `coveringTiles` gives one. */
const covering = (z: number, x: number, y: number, wrap = 0) => ({ canonical: { z, x, y }, wrap });

/** A map at a camera, whose `coveringTiles` answers `tiles`; `camera` changes the camera. */
function mapOf(tiles: Array<ReturnType<typeof covering>>) {
  const camera = {
    zoom: 12,
    lng: 11.5,
    lat: 48.1,
    pitch: 70,
    bearing: 0,
    elevation: 0,
    fov: 36.87,
    worldCopies: true,
    container: { clientWidth: 1000, clientHeight: 700 },
    canvas: { width: 2000, height: 1400 },
  };
  /** The map's `render` listeners. */
  const rendered: Array<() => void> = [];
  const map = {
    coveringTiles: vi.fn<TilesMap["coveringTiles"]>(() => tiles),
    getZoom: () => camera.zoom,
    getCenter: () => ({ lng: camera.lng, lat: camera.lat }),
    getPitch: () => camera.pitch,
    getBearing: () => camera.bearing,
    getRoll: () => 0,
    getPadding: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    getProjection: () => ({ type: "mercator" }),
    getCenterElevation: () => camera.elevation,
    getVerticalFieldOfView: () => camera.fov,
    getRenderWorldCopies: () => camera.worldCopies,
    getContainer: () => camera.container,
    // The size MapLibre draws at: `resize()` sets it once the container changed.
    getCanvas: () => camera.canvas,
    terrain: undefined as unknown,
    on: vi.fn((type: string, listener: () => void) => {
      if (type === "render") rendered.push(listener);
    }),
  };
  const render = () => rendered.forEach((listener) => listener());
  return { map, camera, render };
}

describe("tileUnder", () => {
  it("reads the tile that holds the point at that tile's zoom, as on a tilted map", async () => {
    // Near the camera z 14 tiles, further away z 13 and z 12, as MapLibre covers a tilted view.
    const near = covering(14, 4 * X + 1, 4 * Y + 3);
    const middle = covering(13, 2 * X + 1, 2 * Y);
    const far = covering(12, X, Y - 1);
    const { map } = mapOf([covering(14, 4 * X, 4 * Y + 3), near, middle, covering(13, 2 * X, 2 * Y), far]);
    const options = valueTileOptions({ ...VALUES, maxzoom: 14 });
    const at = (t: ReturnType<typeof covering>) =>
      place(t.canonical.z, t.canonical.x, t.canonical.y, 100.25, 37.25);
    for (const t of [near, middle, far]) expect(tileUnder(map, options, at(t))).toEqual(t.canonical);

    // Each tile read at its own zoom: the code at the point's pixel of that tile.
    const values: RasterValues = { ...VALUES, maxzoom: 14 };
    const url = template(values);
    const pictures = new Map(
      [near, middle, far].map((t, k) => [
        tileUrl(url, t.canonical.z, t.canonical.x, t.canonical.y),
        decoded(256, [
          [100, 37, code(10 + k)],
          [101, 37, code(20)],
          [100, 38, code(20)],
        ]),
      ])
    );
    const buffers = new Map<ArrayBuffer, Decoded>();
    const read = {
      fetchTile: vi.fn<TileValueDeps["fetchTile"]>(async (tile) => {
        const bytes = new ArrayBuffer(8);
        buffers.set(bytes, pictures.get(tile)!);
        return bytes;
      }),
      decode: vi.fn<TileValueDeps["decode"]>(async (bytes) => buffers.get(bytes)!),
    };
    const readAt = (point: { lng: number; lat: number }) =>
      tileValueAt(values, url, point, tileUnder(map, options, point), read);
    expect(await readAt(at(near))).toBe(10);
    expect(await readAt(at(middle))).toBe(11);
    expect(await readAt(at(far))).toBe(12);
    expect(read.fetchTile.mock.calls.map(([tile]) => tile)).toEqual([...pictures.keys()]);
  });

  it("finds the tile in the map's copies of the world", () => {
    const { map } = mapOf([covering(12, X, Y, 1), covering(12, X, Y, -1)]);
    const options = valueTileOptions(VALUES);
    for (const shift of [360, -360])
      expect(tileUnder(map, options, { ...POINT, lng: POINT.lng + shift })).toEqual(TILE);
    // A place given in the first copy finds the tile drawn in another.
    expect(tileUnder(map, options, POINT)).toEqual(TILE);
  });

  it("gives null for a point outside every covering tile, without a request", async () => {
    const { map } = mapOf([covering(12, X + 1, Y), covering(13, 2 * X, 2 * Y + 2)]);
    const options = valueTileOptions(VALUES);
    expect(tileUnder(map, options, POINT)).toBeNull();
    // Past the map's latitudes.
    expect(tileUnder(map, options, { lng: POINT.lng, lat: 86 })).toBeNull();
    const read = deps(decoded(256, [[100, 37, code(1)]]));
    expect(await tileValueAt(VALUES, template(), POINT, tileUnder(map, options, POINT), read)).toBeNull();
    expect(read.fetchTile).not.toHaveBeenCalled();
  });

  it("takes the tile at maxzoom when the map is zoomed in further", () => {
    // MapLibre covers the view with tiles of the source's maxzoom and magnifies them; a deeper tile stands for its
    // ancestor there.
    const { map } = mapOf([covering(18, 64 * X + 20, 64 * Y + 9)]);
    const deep = place(18, 64 * X + 20, 64 * Y + 9, 10, 10);
    expect(tileUnder(map, valueTileOptions(VALUES), deep)).toEqual(TILE);
    expect(map.coveringTiles).toHaveBeenCalledWith(expect.objectContaining({ maxzoom: 12 }));
    // A tile at or below maxzoom is read as it is.
    const { map: native } = mapOf([covering(12, X, Y)]);
    expect(tileUnder(native, valueTileOptions(VALUES), POINT)).toEqual(TILE);
  });

  it("asks for the tiles with the options of the compiled value source", () => {
    // A raster-dem source's zooms when its spec gives none (MapLibre's RasterDEMTileSource).
    const MAPLIBRE_DEFAULTS = { minzoom: 0, maxzoom: 22 };
    const coverage = "https://geoapi.test/collections/l/coverage/tiles/WebMercatorQuad";
    for (const values of [
      VALUES,
      { ...VALUES, maxzoom: 16, bounds: [11, 48, 12, 49] as RasterValues["bounds"] },
      (({ maxzoom: _m, ...v }) => v)(VALUES),
    ]) {
      for (const render of [
        { type: "categorical", classes: [{ value: 3, color: "#2e7d32" }] },
        { type: "hillshade" },
      ]) {
        const out = compileLayer({
          id: "1",
          style: { version: "1.0.0", kind: "raster", render } as LayerStyle,
          source: {
            type: "raster",
            id: "s",
            tiles: `${coverage}/{z}/{x}/{y}.webp`,
            coverage,
            version: "1",
            values,
          },
        });
        const source = out.sources.s as {
          type: string;
          tileSize: number;
          minzoom?: number;
          maxzoom?: number;
        };
        expect(source.type).toBe("raster-dem");
        // Raster sources round the zoom (MapLibre's RasterTileSource `roundZoom`).
        expect(valueTileOptions(values)).toEqual({
          tileSize: source.tileSize,
          minzoom: source.minzoom ?? MAPLIBRE_DEFAULTS.minzoom,
          maxzoom: source.maxzoom ?? MAPLIBRE_DEFAULTS.maxzoom,
          roundZoom: true,
        });
      }
    }
    // The map is asked with exactly those options, and with its terrain where it has one, as MapLibre asks for the
    // tiles a source loads.
    const { map } = mapOf([covering(12, X, Y)]);
    tileUnder(map, valueTileOptions(VALUES), POINT);
    expect(map.coveringTiles).toHaveBeenLastCalledWith(valueTileOptions(VALUES));
    const terrain = { source: "dem" };
    map.terrain = terrain;
    tileUnder(map, valueTileOptions(VALUES), POINT);
    expect(map.coveringTiles).toHaveBeenLastCalledWith({ ...valueTileOptions(VALUES), terrain });
  });

  it("computes the covering tiles once for many reads at one camera", () => {
    const { map, camera } = mapOf([covering(12, X, Y)]);
    const options = valueTileOptions(VALUES);
    for (let i = 0; i < 50; i++) tileUnder(map, options, place(Z, X, Y, i, i));
    expect(map.coveringTiles).toHaveBeenCalledTimes(1);
    // Each change of the camera or the map's size computes them anew, once; also those that move no camera: the
    // terrain's height under the center, the field of view, the world's copies, and the size MapLibre draws at.
    const changes: Array<() => void> = [
      () => (camera.zoom = 12.5),
      () => (camera.lng = 11.6),
      () => (camera.lat = 48.2),
      () => (camera.pitch = 50),
      () => (camera.bearing = 30),
      () => (map.terrain = { source: "dem" }),
      () => (camera.elevation = 512),
      () => (camera.fov = 60),
      () => (camera.worldCopies = false),
      () => (camera.canvas = { ...camera.canvas, width: 1600 }),
      () => (camera.canvas = { ...camera.canvas, height: 1200 }),
    ];
    changes.forEach((change, k) => {
      change();
      tileUnder(map, options, POINT);
      tileUnder(map, options, POINT);
      expect(map.coveringTiles).toHaveBeenCalledTimes(k + 2);
    });
    // Another source's options are kept apart: switching between two layers computes nothing more.
    const other = valueTileOptions({ ...VALUES, maxzoom: 16 });
    tileUnder(map, other, POINT);
    tileUnder(map, options, POINT);
    tileUnder(map, other, POINT);
    expect(map.coveringTiles).toHaveBeenCalledTimes(changes.length + 2);
    // The container's size alone is not the map's until it is resized.
    camera.container = { clientWidth: 640, clientHeight: 480 };
    tileUnder(map, options, POINT);
    expect(map.coveringTiles).toHaveBeenCalledTimes(changes.length + 2);
  });

  it("computes the covering tiles anew on the frame after a zoom change", () => {
    // The globe hands over to Mercator by zoom, and the map applies it when it draws the next frame: tiles computed
    // between a zoom change and that frame are dropped then.
    const { map, camera, render } = mapOf([covering(12, X, Y)]);
    const options = valueTileOptions(VALUES);
    tileUnder(map, options, POINT);
    expect(map.on).toHaveBeenCalledTimes(1);
    expect(map.on).toHaveBeenCalledWith("render", expect.any(Function));
    camera.zoom = 9;
    tileUnder(map, options, POINT);
    tileUnder(map, options, POINT);
    expect(map.coveringTiles).toHaveBeenCalledTimes(2);
    render();
    tileUnder(map, options, POINT);
    tileUnder(map, options, POINT);
    expect(map.coveringTiles).toHaveBeenCalledTimes(3);
    // Frames without a zoom change (a hover's repaint) keep them.
    render();
    render();
    tileUnder(map, options, POINT);
    expect(map.coveringTiles).toHaveBeenCalledTimes(3);
    // One listener per map.
    tileUnder(map, valueTileOptions({ ...VALUES, maxzoom: 16 }), POINT);
    expect(map.on).toHaveBeenCalledTimes(1);
  });
});

/** A contract case of the raster service's colors: a style and cells of known values with the color each is drawn
 * in, null where none. */
interface ContractCase {
  id: string;
  style: JsonObject;
  samples: Array<{ value: number | null; color: string | null; no_data?: boolean }>;
}

const CONTRACT = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../../../packages/python/goatlib/tests/unit/style/fixtures/raster_color_cases.json"
    ),
    "utf8"
  )
) as ContractCase[];

describe("rasterClassAt", () => {
  it("finds the class or category of a value", () => {
    const classes: NamedRasterColorSpec = {
      kind: "classes",
      band: 1,
      noData: [],
      classes: [
        { to: 10, color: "#111111", name: "Niedrig" },
        { from: 10, to: 20, color: "#222222", name: "Mittel" },
        // Overlaps the class before it: the first class holding a value wins.
        { from: 15, to: 30, color: "#333333" },
        { from: 30, to: 40, color: null, name: "Verborgen" },
      ],
    };
    // Classes are [from, to).
    expect(rasterClassAt(classes, 10)).toEqual({ name: "Mittel", color: "#222222" });
    expect(rasterClassAt(classes, 9.99)).toEqual({ name: "Niedrig", color: "#111111" });
    expect(rasterClassAt(classes, -1e9)).toEqual({ name: "Niedrig", color: "#111111" });
    expect(rasterClassAt(classes, 17)).toEqual({ name: "Mittel", color: "#222222" });
    // A class without a name.
    expect(rasterClassAt(classes, 20)).toEqual({ color: "#333333" });
    // A hidden class draws nothing, and a value past every class is in none.
    expect(rasterClassAt(classes, 35)).toBeNull();
    expect(rasterClassAt(classes, 40)).toBeNull();

    const categories: NamedRasterColorSpec = {
      kind: "categories",
      band: 1,
      noData: [0],
      classes: [
        { value: 1, color: "#4a90c2", name: "Wasser" },
        { value: 3, color: "#2e7d32", name: "Wald" },
        { value: 6, color: null, name: "Feuchtgebiet" },
        { value: 9, color: "#9aa3ad" },
      ],
      other: "#cccccc",
    };
    const wald = { name: "Wald", color: "#2e7d32" };
    expect(rasterClassAt(categories, 3)).toEqual(wald);
    // Categories hold the values that round to them.
    expect(rasterClassAt(categories, 3.4)).toEqual(wald);
    expect(rasterClassAt(categories, 2.5)).toEqual(wald);
    expect(rasterClassAt(categories, 9)).toEqual({ color: "#9aa3ad" });
    // A value in no category: the other color's, or none without one.
    expect(rasterClassAt(categories, 7)).toBe("other");
    expect(rasterClassAt({ ...categories, other: null }, 7)).toBeNull();
    // A hidden category is never "other"; the style's no data is in no class.
    expect(rasterClassAt(categories, 6)).toBeNull();
    expect(rasterClassAt(categories, 0)).toBeNull();
    expect(rasterClassAt(categories, Number.NaN)).toBeNull();
    // A tile decodes to finite values only.
    expect(rasterClassAt(categories, Number.POSITIVE_INFINITY)).toBeNull();
    expect(rasterClassAt(classes, Number.NEGATIVE_INFINITY)).toBeNull();

    // A coloring as rasterColorSpec gives it (no names) is read as it is.
    const render = { type: "categorical", classes: [{ value: 3, name: "Wald", color: "#2e7d32" }] };
    expect(rasterClassAt(rasterColorSpec(render)!, 3)).toEqual({ color: "#2e7d32" });

    // Ramps, stops and images have no classes.
    const ramp = rasterColorSpec({ type: "continuous", palette: ["#000000", "#ffffff"], domain: [0, 1] })!;
    expect(ramp.kind).toBe("ramp");
    expect(rasterClassAt(ramp, 0.5)).toBeNull();
    const stops = rasterColorSpec({ type: "continuous", stops: [{ value: 0, color: "#000000" }] })!;
    expect(stops.kind).toBe("stops");
    expect(rasterClassAt(stops, 0)).toBeNull();
    expect(rasterClassAt({ kind: "rgb", bands: null, noData: [] }, 1)).toBeNull();
  });

  it("agrees with the raster service's colors on the contract's classes and categories", () => {
    const checked = CONTRACT.flatMap((c) => {
      const render = isObject(c.style.render) ? c.style.render : {};
      const spec = rasterColorSpec(render);
      if (spec?.kind !== "classes" && spec?.kind !== "categories") return [];
      return (
        c.samples
          // A cell of the file's no data reaches no popup: its code is 0.
          .filter((s): s is typeof s & { value: number } => s.value !== null && !s.no_data)
          .map((s) => {
            const found = rasterClassAt(spec, s.value);
            const color = found === "other" ? (spec.kind === "categories" ? spec.other : null) : found?.color;
            return {
              id: c.id,
              value: s.value,
              drawn: color ? rgbOf(color) : null,
              want: s.color ? rgbOf(s.color) : null,
            };
          })
      );
    });
    expect(new Set(checked.map((c) => c.id)).size).toBeGreaterThanOrEqual(3);
    expect(checked.filter((c) => JSON.stringify(c.drawn) !== JSON.stringify(c.want))).toEqual([]);
  });
});
