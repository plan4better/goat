// The renderer's raster values: each raster layer gets the description of the value tiles its style reads, loaded
// once per address; a changed description is asked for after a quiet moment, the layer keeping its last drawing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterValues } from "@/lib/style/raster/values";
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
  style: { version: 1, kind: "raster", ...style } as unknown as LayerStyle,
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
  style: { version: 1, kind: "vector", symbol: { fill: { color: "#aaaaaa" } } } as unknown as LayerStyle,
  geometry: "polygon",
  entry: {},
  source: { type: "tiles", id: "src-v", tiles: ["https://geoapi/v/{z}/{x}/{y}"] },
};
const url = (query: string) => `${COVERAGE}?${query}&v=v1`;
const valuesIn = (layer: RenderLayer) => (layer.source.type === "raster" ? layer.source.values : undefined);

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
