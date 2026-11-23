// The renderer's raster values: each raster layer gets the description of the value tiles its style reads, loaded
// once per address; a changed description is asked for after a quiet moment, the layer keeping its last drawing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterTileset, RasterValues } from "@/lib/style/raster/values";
import { RASTER_QUIET_MS } from "@/lib/style/render/apply";
import type { RenderLayer } from "@/lib/style/render/mapLayers";
import { rasterValuesOver, withRasterValues } from "@/lib/style/render/rasterValues";

const COVERAGE = "https://geoapi/collections/r1/coverage/tiles/WebMercatorQuad";

const valuesOf = (version: string): RasterValues => ({
  encoding: { redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 1 },
  range: [0, 255],
  integer: true,
  version,
});
const VALUES = valuesOf("1-e1");

const raster = (key: string, style: object): RenderLayer => ({
  key,
  style: { version: "1.0.0", kind: "raster", ...style } as unknown as LayerStyle,
  entry: {},
  source: {
    type: "raster",
    id: `src-${key}`,
    tiles: "https://geoapi/collections/r1/raster/tiles/{z}/{x}/{y}.webp",
    coverage: COVERAGE,
    version: "v1",
  },
});
const continuous = (key: string, band: unknown = 1) =>
  raster(key, { render: { type: "continuous", band, palette: "goat:elevation" } });
const vector: RenderLayer = {
  key: "v",
  style: {
    version: "1.0.0",
    kind: "vector",
    symbol: { fill: { color: "#aaaaaa" } },
  } as unknown as LayerStyle,
  geometry: "polygon",
  entry: {},
  source: { type: "tiles", id: "src-v", tiles: ["https://geoapi/v/{z}/{x}/{y}"] },
};
/** A description's URL: what it reads, for 512 px tiles, at the source's version. */
const url = (query: string) => `${COVERAGE}?${query}&tilesize=512&v=v1`;
const valuesIn = (layer: RenderLayer) => (layer.source.type === "raster" ? layer.source.values : undefined);

/** The colored tiles' description, its URL, and a raster layer whose source names it. */
const TILESET = "https://geoapi/collections/r1/raster/tiles";
const TILESET_URL = `${TILESET}?tilesize=512&v=v1`;
const IMAGE: RasterTileset = { version: "v1-0a1b2c3d-e3", maxzoom: 16, bounds: [11.39, 47.25, 11.41, 47.27] };
/** The extent the layer holds, wider than the file. */
const STORED: [number, number, number, number] = [11, 47, 12, 48];
const described = (layer: RenderLayer): RenderLayer =>
  layer.source.type === "raster"
    ? { ...layer, source: { ...layer.source, tileset: TILESET, bounds: STORED } }
    : layer;
const image = (key: string, render: object = { type: "image" }) => described(raster(key, { render }));
const imageIn = (layer: RenderLayer) => (layer.source.type === "raster" ? layer.source.image : undefined);
/** The image tiles' source a layer compiles to; undefined when it draws nothing (no tile is asked for). */
const imageSourceOf = (layer: RenderLayer) =>
  compileLayer({ id: layer.key, style: layer.style, source: layer.source }).sources[layer.source.id] as
    | { tiles: string[]; maxzoom?: number; bounds?: number[] }
    | undefined;

describe("withRasterValues", () => {
  it("attaches each raster layer's values for its band and resampling", () => {
    const asked: string[] = [];
    const layers = [
      continuous("1", 2),
      raster("2", { resampling: "nearest", render: { type: "hillshade" } }),
      raster("3", { render: { type: "continuous", band: { expression: "b2 - b1" } } }),
    ];
    const { layers: out, pending } = withRasterValues(layers, (address) => {
      asked.push(address);
      return VALUES;
    });
    expect(asked).toEqual([
      url("band=2&resampling=nearest"),
      url("band=1&resampling=nearest"),
      url("formula=b2%20-%20b1&resampling=nearest"),
    ]);
    expect(pending).toBe(false);
    expect(out.map(valuesIn)).toEqual([VALUES, VALUES, VALUES]);
    // Only the source changes: the style object stays, so an edited layer's document keeps its identity.
    expect(out[0].style).toBe(layers[0].style);
    expect(out[0].source).toMatchObject({ coverage: COVERAGE, version: "v1" });
  });

  it("is pending while a description loads", () => {
    const { layers, pending } = withRasterValues([continuous("1"), continuous("2", 2)], (address) =>
      address.includes("band=2") ? undefined : VALUES
    );
    expect(pending).toBe(true);
    expect(layers.map(valuesIn)).toEqual([VALUES, undefined]);
  });

  it("a failed description is not pending and draws nothing", () => {
    const layer = continuous("1");
    const { layers, pending } = withRasterValues([layer], () => null);
    expect(pending).toBe(false);
    expect(layers[0]).toBe(layer);
    expect(valuesIn(layers[0])).toBeUndefined();
  });

  it("a hidden layer's description is asked for but does not hold print and thumbnails", () => {
    const hidden = { ...continuous("1"), entry: { visible: false } };
    const load = vi.fn(() => undefined);
    const { layers, pending } = withRasterValues([hidden], load);
    expect(load).toHaveBeenCalledWith(url("band=1&resampling=nearest"), hidden);
    expect(pending).toBe(false);
    expect(layers[0]).toBe(hidden);
  });

  it("leaves vector layers and image renders as they are", () => {
    const load = vi.fn(() => VALUES);
    const image = raster("i", { render: { type: "image", bands: [3, 2, 1] } });
    const categories = raster("c", { render: { type: "categorical" } });
    const given = {
      ...continuous("g"),
      source: { ...continuous("g").source, values: VALUES },
    } as RenderLayer;
    const layers = [vector, image, categories, given];
    const out = withRasterValues(layers, load);
    expect(out.pending).toBe(false);
    out.layers.forEach((layer, i) => expect(layer).toBe(layers[i]));
    // A source that comes with its values (the style lab's fixtures) is not asked for.
    expect(load).not.toHaveBeenCalled();
  });
});

describe("withRasterValues for images", () => {
  it("attaches an image render's colored tiles' description, and a value render's values only", () => {
    const asked: string[] = [];
    const layers = [image("i"), image("c", { type: "categorical" }), described(continuous("v"))];
    const { layers: out, pending } = withRasterValues(layers, (address) => {
      asked.push(address);
      return address.startsWith(TILESET) ? IMAGE : VALUES;
    });
    expect(asked).toEqual([TILESET_URL, TILESET_URL, url("band=1&resampling=nearest")]);
    expect(pending).toBe(false);
    expect(out.map(imageIn)).toEqual([IMAGE, IMAGE, undefined]);
    expect(out.map(valuesIn)).toEqual([undefined, undefined, VALUES]);
    expect(out[0].style).toBe(layers[0].style);
  });

  it("an image asks for no tile until its description has answered; a failed one draws as before", () => {
    const layer = image("i");
    const loading = withRasterValues([layer], () => undefined);
    expect(loading.pending).toBe(true);
    expect(imageSourceOf(loading.layers[0])).toBeUndefined();
    const hidden = { ...layer, entry: { visible: false } };
    expect(withRasterValues([hidden], () => undefined).pending).toBe(false);
    // Failed: the layer's own extent, no native zoom, the source's version.
    const failed = withRasterValues([layer], () => null);
    expect(failed.pending).toBe(false);
    expect(imageIn(failed.layers[0])).toBeNull();
    const before = imageSourceOf(failed.layers[0]);
    expect(before).toMatchObject({ bounds: STORED });
    expect(before).not.toHaveProperty("maxzoom");
    expect(before?.tiles[0]).toContain("&v=v1&");
    // Answered: the file's native zoom, bounds and version.
    const loaded = imageSourceOf(withRasterValues([layer], () => IMAGE).layers[0]);
    expect(loaded).toMatchObject({ maxzoom: 16, bounds: IMAGE.bounds });
    expect(loaded?.tiles[0]).toContain(`&v=${IMAGE.version}&`);
  });

  it("asks nothing for a source with its description, or without its address, which draws at once", () => {
    const load = vi.fn(() => IMAGE);
    const given = { ...image("g"), source: { ...image("g").source, image: IMAGE } } as RenderLayer;
    const failed = { ...image("f"), source: { ...image("f").source, image: null } } as RenderLayer;
    const plain = raster("n", { render: { type: "image" } });
    const out = withRasterValues([given, failed, plain], load);
    expect(load).not.toHaveBeenCalled();
    expect(out.pending).toBe(false);
    expect(imageSourceOf(out.layers[2])).toBeDefined();
  });
});

/** A colored tiles' description of a file with a color table on band 1 (geoapi's `palette`). */
const PALETTED: RasterTileset = {
  ...IMAGE,
  bands: {
    count: 1,
    dtype: "uint8",
    scaled: false,
    colorTable: true,
    colorInterp: ["palette"],
    palette: { band: 1, colors: { 0: "#ffffff", 1: "#ffffff", 7: "#008000" } },
  },
};
/** The address of its table band's value tiles: band 1, read nearest. */
const TABLE_VALUES_URL = url("band=1&resampling=nearest");
/** What a compiled layer draws. */
const drawnBy = (layer: RenderLayer) =>
  compileLayer({ id: layer.key, style: layer.style, source: layer.source }).layers.map((l) => l.type);

describe("withRasterValues for an image drawn with its color table", () => {
  it("asks for its table band's values once the colored tiles' description names the table, in the same pass", () => {
    const asked: string[] = [];
    const { layers, pending } = withRasterValues([image("p")], (address) => {
      asked.push(address);
      return address.startsWith(TILESET) ? PALETTED : VALUES;
    });
    expect(asked).toEqual([TILESET_URL, TABLE_VALUES_URL]);
    expect(pending).toBe(false);
    expect(imageIn(layers[0])).toEqual(PALETTED);
    expect(valuesIn(layers[0])).toEqual(VALUES);
    // Drawn from the value tiles in the table's colors: no image tiles.
    expect(drawnBy(layers[0])).toEqual(["color-relief"]);
  });

  it("is pending and draws nothing while its values load; a hidden one does not hold print", () => {
    const layer = image("p");
    const loading = withRasterValues([layer], (address) =>
      address.startsWith(TILESET) ? PALETTED : undefined
    );
    expect(loading.pending).toBe(true);
    expect(drawnBy(loading.layers[0])).toEqual([]);
    const hidden = { ...layer, entry: { visible: false } };
    expect(
      withRasterValues([hidden], (address) => (address.startsWith(TILESET) ? PALETTED : undefined)).pending
    ).toBe(false);
  });

  it("whose values failed draws the colored tiles, as any image", () => {
    const { layers, pending } = withRasterValues([image("p")], (address) =>
      address.startsWith(TILESET) ? PALETTED : null
    );
    expect(pending).toBe(false);
    expect(valuesIn(layers[0])).toBeNull();
    expect(drawnBy(layers[0])).toEqual(["raster"]);
    expect(imageSourceOf(layers[0])?.tiles[0]).toContain(`&v=${PALETTED.version}&`);
  });

  it("chosen bands and a table geoapi does not describe draw the colored tiles and read no values", () => {
    const asked: string[] = [];
    const load = (address: string) => {
      asked.push(address);
      return address.startsWith(TILESET) ? PALETTED : VALUES;
    };
    const chosen = withRasterValues([image("c", { type: "image", bands: [1, 1, 1] })], load);
    expect(drawnBy(chosen.layers[0])).toEqual(["raster"]);
    const plain: RasterTileset = { ...PALETTED, bands: { ...PALETTED.bands!, palette: undefined } };
    const described = withRasterValues([image("n")], (address) => {
      asked.push(address);
      return address.startsWith(TILESET) ? plain : VALUES;
    });
    expect(drawnBy(described.layers[0])).toEqual(["raster"]);
    expect(asked).toEqual([TILESET_URL, TILESET_URL]);
  });
});

describe("rasterValuesOver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A cache like loadRasterValues: answers what `known` holds, and nothing (loading) for any other address. */
  const setup = () => {
    const known = new Map<string, RasterValues | null>();
    const load = vi.fn((address: string, _onLoad: () => void) => known.get(address));
    const redraw = vi.fn();
    return { known, load, redraw, values: rasterValuesOver(load, redraw) };
  };
  const asked = (load: ReturnType<typeof setup>["load"]) => load.mock.calls.map(([address]) => address);

  it("asks for a layer's first description at once", () => {
    const { load, redraw, values } = setup();
    const { layers, pending } = values.attach([continuous("1")]);
    expect(asked(load)).toEqual([url("band=1&resampling=nearest")]);
    expect(load.mock.calls[0][1]).toBe(redraw);
    expect(pending).toBe(true);
    expect(valuesIn(layers[0])).toBeUndefined();
  });

  it("asks for a changed description once it stayed the wanted one, keeping the last drawing meanwhile", () => {
    const { known, load, redraw, values } = setup();
    const first = continuous("1", { expression: "b1" });
    known.set(url("formula=b1&resampling=nearest"), VALUES);
    const drawn = values.attach([first]).layers[0];
    expect(valuesIn(drawn)).toEqual(VALUES);

    // A formula typed key by key: no address is asked for while it changes.
    for (const formula of ["b1 ", "b1 +", "b1 + b", "b1 + b2"]) {
      const { layers, pending } = values.attach([continuous("1", { expression: formula })]);
      expect(pending).toBe(true);
      expect(layers[0].style).toBe(first.style);
      expect(layers[0].source).toEqual(drawn.source);
      vi.advanceTimersByTime(RASTER_QUIET_MS - 50);
    }
    expect(load).toHaveBeenCalledTimes(1);
    expect(redraw).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(redraw).toHaveBeenCalledTimes(1);
    const typed = continuous("1", { expression: "b1 + b2" });
    const loading = values.attach([typed]);
    expect(asked(load)).toEqual([
      url("formula=b1&resampling=nearest"),
      url("formula=b1%20%2B%20b2&resampling=nearest"),
    ]);
    // Still the last drawing while the new description loads.
    expect(loading.pending).toBe(true);
    expect(loading.layers[0].style).toBe(first.style);

    const next = valuesOf("2-e1");
    known.set(url("formula=b1%20%2B%20b2&resampling=nearest"), next);
    const loaded = values.attach([typed]);
    expect(loaded.pending).toBe(false);
    expect(loaded.layers[0].style).toBe(typed.style);
    expect(valuesIn(loaded.layers[0])).toEqual(next);
  });

  it("a description asked for before is used at once, and a failed one draws nothing", () => {
    const { known, load, values } = setup();
    known.set(url("band=1&resampling=nearest"), VALUES);
    known.set(url("band=2&resampling=nearest"), null);
    values.attach([continuous("1")]);
    values.attach([continuous("1", 2)]);
    vi.advanceTimersByTime(RASTER_QUIET_MS);
    const failed = values.attach([continuous("1", 2)]);
    expect(failed.pending).toBe(false);
    expect(valuesIn(failed.layers[0])).toBeUndefined();
    // Back to band 1: known, no quiet moment.
    const back = values.attach([continuous("1")]);
    expect(back.pending).toBe(false);
    expect(valuesIn(back.layers[0])).toEqual(VALUES);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("an image waits for its description; switched to values it keeps its drawing until those have loaded", () => {
    const { known, load, redraw, values } = setup();
    const first = image("1");
    const drawing = values.attach([first]);
    expect(asked(load)).toEqual([TILESET_URL]);
    expect(drawing.pending).toBe(true);
    expect(imageSourceOf(drawing.layers[0])).toBeUndefined();

    known.set(TILESET_URL, IMAGE as never);
    const drawn = values.attach([first]).layers[0];
    expect(imageIn(drawn)).toEqual(IMAGE);

    // A continuous render after a quiet moment: the image stays meanwhile.
    const switched = described(continuous("1"));
    const waiting = values.attach([switched]);
    expect(waiting.pending).toBe(true);
    expect(waiting.layers[0].style).toBe(first.style);
    expect(imageIn(waiting.layers[0])).toEqual(IMAGE);
    vi.advanceTimersByTime(RASTER_QUIET_MS);
    expect(redraw).toHaveBeenCalledTimes(1);
    known.set(url("band=1&resampling=nearest"), VALUES);
    const loaded = values.attach([switched]).layers[0];
    expect(loaded.style).toBe(switched.style);
    expect(valuesIn(loaded)).toEqual(VALUES);
  });

  it("an image drawn with its color table asks for its values right after its colored tiles' description, no quiet moment", () => {
    const { known, load, redraw, values } = setup();
    const layer = image("1");
    expect(values.attach([layer]).pending).toBe(true);
    known.set(TILESET_URL, PALETTED as never);
    const loading = values.attach([layer]);
    expect(asked(load)).toEqual([TILESET_URL, TILESET_URL, TABLE_VALUES_URL]);
    expect(loading.pending).toBe(true);
    known.set(TABLE_VALUES_URL, VALUES);
    const loaded = values.attach([layer]);
    expect(loaded.pending).toBe(false);
    expect(valuesIn(loaded.layers[0])).toEqual(VALUES);
    expect(drawnBy(loaded.layers[0])).toEqual(["color-relief"]);
    // Drawn again (an opacity edit): both known, nothing waits.
    const again = values.attach([image("1", { type: "image" })]);
    expect(again.pending).toBe(false);
    vi.advanceTimersByTime(RASTER_QUIET_MS);
    expect(redraw).not.toHaveBeenCalled();
  });

  it("forgets a layer that left: no redraw for it, and a new one asks at once", () => {
    const { known, load, redraw, values } = setup();
    known.set(url("band=1&resampling=nearest"), VALUES);
    values.attach([continuous("1")]);
    values.attach([continuous("1", 2)]);
    values.attach([vector]);
    vi.advanceTimersByTime(RASTER_QUIET_MS);
    expect(redraw).not.toHaveBeenCalled();
    values.attach([continuous("1", 3)]);
    expect(asked(load).at(-1)).toBe(url("band=3&resampling=nearest"));

    // Switched to an image render while a band was being chosen: no quiet moment ends for it.
    values.attach([continuous("1", 4)]);
    values.attach([raster("1", { render: { type: "image", bands: [3, 2, 1] } })]);
    vi.advanceTimersByTime(RASTER_QUIET_MS);
    expect(redraw).not.toHaveBeenCalled();

    values.attach([continuous("1", 5)]);
    values.dispose();
    vi.advanceTimersByTime(RASTER_QUIET_MS);
    expect(redraw).not.toHaveBeenCalled();
  });
});
