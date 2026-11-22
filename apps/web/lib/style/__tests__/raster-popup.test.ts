// A raster file's popup (spec 9.7): when it opens by render type, its fields, its default content, and where its
// values come from: the value tiles the map shows (hover, and a click at once), then the raster service's point query
// (a click's exact value and every band).
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import { fetchRasterPoint, loadedRasterTileset, loadedRasterValues } from "@/lib/api/rasters";
import { equalIntervalClasses } from "@/lib/style/editor/raster";
import type { LayerStyle } from "@/lib/style/generated/types";
import { coverageUrl } from "@/lib/style/layerSource";
import { cellSource, infoSourceOf } from "@/lib/style/popup/infoSources";
import { rasterColorSpec } from "@/lib/style/raster/color";
import { type RasterInfo, bandFactsOf, imageBands, rasterInfoOf } from "@/lib/style/raster/metadata";
import {
  RASTER_POPUP_ON_BY_DEFAULT,
  imagePixels,
  pixelValueBands,
  pixelValuesAt,
  rasterPopupLayers,
  rasterPopupOf,
  rasterPopupProperties,
} from "@/lib/style/raster/popup";
import { tilePixelAt, tileUnder, tileValueAt } from "@/lib/style/raster/tileValues";
import {
  type RasterValues,
  reliefColorAt,
  reliefStops,
  valueQuery,
  valueTilesUrl,
} from "@/lib/style/raster/values";

import { layerPopup } from "@/components/map/popover/normalizePopup";

vi.mock("@/lib/api/rasters", () => ({
  fetchRasterPoint: vi.fn(async () => ({ values: [10, 250.5, 30], styled: null })),
  loadedRasterValues: vi.fn(() => undefined),
  loadedRasterTileset: vi.fn(() => undefined),
}));
vi.mock("@/lib/style/raster/tileValues", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  tileUnder: vi.fn(() => ({ z: 12, x: 2200, y: 1343 })),
  tileValueAt: vi.fn(async () => null),
  tilePixelAt: vi.fn(async () => null),
}));

const cog = (id: number, document: object, visible = true) => ({
  id,
  layer_id: `d${id}`,
  name: `Raster ${id}`,
  type: "raster",
  data_type: "cog",
  url: `https://files.example/${id}.tif`,
  visible,
  style: { id: `s${id}`, document: document as LayerStyle },
});

const ELEVATION = {
  version: "1.0.0",
  kind: "raster",
  render: { type: "continuous", band: 2, palette: "goat:elevation", domain: [181, 440] },
  legend: { unit: "m" },
};

/** A float band's value tiles: codes of 1/8192 from 0. */
const VALUES: RasterValues = {
  encoding: { redFactor: 8, greenFactor: 256 / 8192, blueFactor: 1 / 8192, baseShift: 0 },
  range: [0, 500],
  integer: false,
  version: "v1",
  maxzoom: 14,
};

/** A map that draws the layer's value tiles (its raster-dem source), as StyledLayers puts them on it. */
function mapDrawing(layer: ReturnType<typeof cog>, values = VALUES) {
  const query = valueQuery(layer.style.document as never)!;
  const template = valueTilesUrl(coverageUrl(layer.layer_id), query, values);
  const sources: Record<string, unknown> = { [`src-${layer.id}`]: { type: "raster-dem", tiles: [template] } };
  return {
    template,
    map: {
      getSource: (id: string) => sources[id],
      coveringTiles: () => [],
      getZoom: () => 12,
      getCenter: () => ({ lng: 13.4, lat: 52.5 }),
      getPitch: () => 0,
      getBearing: () => 0,
    },
  };
}

const here = { lng: 13.4, lat: 52.52 };

beforeEach(() => {
  vi.mocked(fetchRasterPoint).mockClear();
  vi.mocked(loadedRasterValues).mockReset().mockReturnValue(undefined);
  vi.mocked(tileValueAt).mockReset().mockResolvedValue(null);
  vi.mocked(tileUnder).mockClear();
  vi.mocked(tilePixelAt).mockReset().mockResolvedValue(null);
  vi.mocked(loadedRasterTileset).mockReset().mockReturnValue(undefined);
});

describe("when a raster popup opens", () => {
  it("a new raster style opens popups on click for colour scales, not for images", () => {
    // Spec 9.7: the same list as goatlib's `default_raster_popup`.
    expect(RASTER_POPUP_ON_BY_DEFAULT).toEqual(["continuous", "categorical", "hillshade"]);
    for (const type of RASTER_POPUP_ON_BY_DEFAULT) {
      const layer = cog(1, { version: "1.0.0", kind: "raster", render: { type } });
      expect(rasterPopupOf(layer)?.trigger, type).toBe("click");
    }
    // An image opens none unless its style asks for one; it opens on hover only where its pixels are its values
    // (`pixelValueBands`), which the data tell, not the style.
    expect(
      rasterPopupOf(cog(2, { version: "1.0.0", kind: "raster", render: { type: "image" } }))
    ).toBeUndefined();
    for (const trigger of ["click", "hover", "click_and_hover"]) {
      const image = cog(3, {
        version: "1.0.0",
        kind: "raster",
        render: { type: "image" },
        popup: { trigger },
      });
      expect(rasterPopupOf(image)?.trigger, trigger).toBe(trigger);
    }
    const both = cog(4, { ...ELEVATION, popup: { trigger: "click_and_hover" } });
    expect(rasterPopupOf(both)?.trigger).toBe("click_and_hover");
    // The drawn files whose popup opens on a click or a hover, top first.
    const hidden = cog(5, ELEVATION, false);
    const elevation = cog(6, ELEVATION);
    const image = cog(7, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "image" },
      popup: { trigger: "hover" },
    });
    expect(rasterPopupLayers([hidden, both, image, elevation], "click")).toEqual([both, elevation]);
    expect(rasterPopupLayers([hidden, both, image, elevation], "hover")).toEqual([both, image]);
  });

  it("services show no popup", () => {
    const wms = {
      ...cog(5, { version: "1.0.0", kind: "raster", render: { type: "image" }, popup: { trigger: "click" } }),
      data_type: "wms",
    };
    expect(rasterPopupOf(wms)).toBeUndefined();
    expect(infoSourceOf(wms)).toBeUndefined();
    expect(layerPopup(wms, { band_1: 1 })).toBeUndefined();
    const off = cog(6, { ...ELEVATION, popup: false });
    const disabled = cog(7, { ...ELEVATION, popup: { enabled: false } });
    expect(rasterPopupLayers([off, disabled], "click")).toEqual([]);
    expect(layerPopup(off, { value: 1 })).toBeUndefined();
    expect(infoSourceOf(off)).toBe(cellSource);
  });
});

describe("an image's pixels as its values", () => {
  const image = (render: object = {}) => ({
    version: "1.0.0",
    kind: "raster",
    render: { type: "image", ...render },
  });

  it("an image of 8 bit bands drawn as they are has its values in its pixels", () => {
    const facts = { count: 3, dtype: "uint8", scaled: false, colorTable: false };
    expect(pixelValueBands(image(), facts)).toEqual([1, 2, 3]);
    expect(pixelValueBands(image({ bands: [3, 1, 2] }), { ...facts, count: 4 })).toEqual([3, 1, 2]);
    // A color table colors a file without chosen bands; chosen bands are drawn as they are.
    expect(pixelValueBands(image(), { ...facts, colorTable: true })).toBeNull();
    expect(pixelValueBands(image({ bands: [1, 2, 3] }), { ...facts, colorTable: true })).toEqual([1, 2, 3]);
    // Stretched or scaled to their colors: 16 bit, signed, floats, a scale or offset.
    for (const dtype of ["uint16", "int8", "float32"])
      expect(pixelValueBands(image(), { ...facts, dtype }), dtype).toBeNull();
    expect(pixelValueBands(image(), { ...facts, scaled: true })).toBeNull();
    // One band is drawn as grey from its lowest to its highest value, two as the first.
    expect(pixelValueBands(image(), { ...facts, count: 1 })).toBeNull();
    expect(pixelValueBands(image(), { ...facts, count: 2 })).toBeNull();
    expect(pixelValueBands(image({ bands: [1, 2, 5] }), facts)).toBeNull();
    // An alpha band holds no values: the bands are counted without it, as goatlib reads them.
    expect(pixelValueBands(image(), { ...facts, count: 3, valueBands: [1, 2] })).toBeNull();
    expect(pixelValueBands(image(), { ...facts, count: 4, valueBands: [1, 2, 3] })).toEqual([1, 2, 3]);
    expect(
      pixelValueBands(image({ bands: [1, 2, 4] }), { ...facts, count: 4, valueBands: [1, 2, 3] })
    ).toBeNull();
    // Colour scales are colors; without facts nothing is known.
    expect(pixelValueBands(ELEVATION, facts)).toBeNull();
    expect(pixelValueBands(image(), undefined)).toBeNull();
    expect(pixelValueBands(image(), { ...facts, dtype: undefined })).toBeNull();
  });

  it("an image draws the bands its file marks red, green and blue, else its first three (goatlib `image_bands`)", () => {
    const facts = { count: 3, dtype: "uint8", scaled: false, colorTable: false };
    const bgr = { ...facts, colorInterp: ["blue", "green", "red"] };
    // A file stored blue, green, red and marked so draws red from its third band.
    expect(imageBands(undefined, bgr)).toEqual([3, 2, 1]);
    expect(pixelValueBands(image(), bgr)).toEqual([3, 2, 1]);
    // No markings, or not all three: its first three value bands.
    expect(imageBands(undefined, facts)).toEqual([1, 2, 3]);
    expect(imageBands(undefined, { ...facts, colorInterp: ["gray", "green", "red"] })).toEqual([1, 2, 3]);
    // An RGBA file: its alpha band holds no values.
    const rgba = {
      ...facts,
      count: 4,
      valueBands: [1, 2, 3],
      colorInterp: ["red", "green", "blue", "alpha"],
    };
    expect(imageBands(undefined, rgba)).toEqual([1, 2, 3]);
    expect(pixelValueBands(image(), rgba)).toEqual([1, 2, 3]);
    // Bands the style chooses win.
    expect(imageBands([2, 1, 3], bgr)).toEqual([2, 1, 3]);
    expect(pixelValueBands(image({ bands: [1, 2, 3] }), bgr)).toEqual([1, 2, 3]);
    // One or two value bands: the first. A file not known yet: no bands assumed, only chosen ones.
    expect(imageBands(undefined, { ...facts, count: 1 })).toEqual([1]);
    expect(imageBands(undefined, { ...facts, count: 2 })).toEqual([1]);
    expect(imageBands(undefined, undefined)).toBeNull();
    expect(imageBands([3, 2, 1], undefined)).toEqual([3, 2, 1]);
  });

  it("an image drawn with its color table reads its codes from value tiles, every color, shared ones too", () => {
    const facts = { count: 1, dtype: "uint8", scaled: false, colorTable: true, colorInterp: ["palette"] };
    // A road map's table, as DSK250's: three pairs of codes share a color (0 and 1 white, 2 and 98 grey, 15 and 59
    // red). The map draws the band's codes (value tiles) in these colors, so it knows each cell's code whatever its
    // color: no color is looked up.
    const table = {
      0: "#ffffff",
      1: "#ffffff",
      2: "#7f7f7f",
      98: "#7f7f7f",
      15: "#ff0000",
      59: "#ff0000",
      18: "#00ff00",
    };
    const roadMap = { ...facts, palette: { band: 1, colors: table } };
    expect(imagePixels(image(), roadMap)).toEqual({ kind: "palette", bands: [1], colors: table });
    // Every color shared: still every code.
    const shared = { ...facts, palette: { band: 1, colors: { 3: "#ff0000", 7: "#ff0000" } } };
    expect(imagePixels(image(), shared)).toEqual(expect.objectContaining({ kind: "palette", bands: [1] }));
    // No table geoapi describes (a 16 bit one over 256 entries, an older geoapi) or an empty one: nothing to hover.
    expect(imagePixels(image(), facts)).toBeNull();
    expect(imagePixels(image(), { ...facts, palette: { band: 1, colors: {} } })).toBeNull();
    // Chosen bands are drawn as they are, not with the table; a colour scale is no image.
    expect(imagePixels(image({ bands: [1, 1, 1] }), roadMap)).toEqual(
      expect.objectContaining({ kind: "bands", bands: [1, 1, 1] })
    );
    expect(imagePixels(ELEVATION, roadMap)).toBeNull();
    // 8 bit bands drawn as they are: their values, by band, from the pixels.
    const rgb = imagePixels(image(), { count: 3, dtype: "uint8", scaled: false, colorTable: false });
    expect(rgb).toEqual(expect.objectContaining({ kind: "bands", bands: [1, 2, 3] }));
    expect(pixelValuesAt(rgb as never, [142, 143, 138, 255])).toEqual({
      band_1: 142,
      band_2: 143,
      band_3: 138,
    });
  });
});

describe("a raster popup's fields and content", () => {
  const de = commonT("de");
  const info = rasterInfoOf({
    width: 1,
    height: 1,
    bounds: [0, 0, 1, 1],
    count: 3,
    dtype: "float32",
    nodata: null,
    bits: [32, 32, 32],
    color_table: null,
    names: ["Höhe", "", ""],
    scales: [1, 1, 1],
    offsets: [0, 0, 0],
    bands: [],
  });

  it("the raster fields are the value, its class and every band", () => {
    expect(cellSource.fields(cog(1, ELEVATION), info, de)).toEqual([
      { name: "value", label: de("style_editor.value"), type: "number" },
      { name: "class", label: de("style_editor.popup_class"), type: "string" },
      { name: "band_1", label: "Höhe", type: "number" },
      { name: "band_2", label: de("style_editor.band_n", { n: 2 }), type: "number" },
      { name: "band_3", label: de("style_editor.band_n", { n: 3 }), type: "number" },
    ]);
    // Before the file's info has answered: the value and its class.
    expect(cellSource.fields(cog(1, ELEVATION), undefined, de).map((f) => f.name)).toEqual([
      "value",
      "class",
    ]);
    expect(de("style_editor.popup_class")).toBe("Klasse");
  });

  it("an RGBA file's alpha band is no band of values: its fields and contents leave it out", () => {
    const stat = (index: number) => ({
      index,
      min: 0,
      max: 255,
      mean: 100,
      std: 50,
      p2: 2,
      p98: 250,
      histogram: { counts: [], edges: [] },
      values: null,
      approximate: false,
    });
    // `count` is the file's 4 bands; statistics are the 3 value bands'.
    const rgba = rasterInfoOf({
      width: 1,
      height: 1,
      bounds: [0, 0, 1, 1],
      count: 4,
      dtype: "uint8",
      nodata: null,
      bits: [8, 8, 8, 8],
      color_table: null,
      names: ["", "", "", ""],
      scales: [1, 1, 1, 1],
      offsets: [0, 0, 0, 0],
      bands: [stat(1), stat(2), stat(3)],
    });
    // The band facts the pixel rule counts: the three value bands.
    expect(bandFactsOf(rgba)?.valueBands).toEqual([1, 2, 3]);
    expect(cellSource.fields(cog(1, ELEVATION), rgba, de).map((f) => f.name)).toEqual([
      "value",
      "class",
      "band_1",
      "band_2",
      "band_3",
    ]);
    // The panel's default content of every band (no cell yet).
    const photo = cog(2, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "image" },
      popup: { bands: "all" },
    });
    const config = rasterPopupProperties(photo.style.document as never, rasterPopupOf(photo)!, undefined, {
      t: de,
      info: rgba,
    });
    expect(
      (config.blocks[0] as { attributes: Array<{ name: string }> }).attributes.map((a) => a.name)
    ).toEqual(["band_1", "band_2", "band_3"]);
  });

  it("default content shows the value with label and unit, and the class", () => {
    const dem = cog(1, {
      version: "1.0.0",
      kind: "raster",
      render: {
        type: "continuous",
        band: 1,
        palette: "goat:elevation",
        domain: [30, 120],
        classify: {
          method: "manual",
          classes: [
            { to: 40, name: "Niederung", color: "#a6d96a" },
            { from: 40, name: "Wald", color: "#2e7d32" },
          ],
        },
      },
      legend: { unit: "m" },
    });
    const popup = layerPopup(dem, { value: 46.2, class: "Wald" }, { t: de, info });
    expect(popup?.trigger).toBe("click");
    expect(popup?.blocks).toEqual([
      expect.objectContaining({
        type: "fieldList",
        attributes: [{ name: "value", label: "Höhe", type: "number", suffix: " m" }],
      }),
      expect.objectContaining({
        type: "badge",
        field: "class",
        mode: "per_value",
        palette: { Wald: "#2e7d32" },
      }),
    ]);
    // A ramp without classes has no class to show.
    expect(layerPopup(cog(2, ELEVATION), { value: 250.5 }, { t: de })?.blocks).toEqual([
      expect.objectContaining({
        type: "fieldList",
        attributes: [
          { name: "value", label: de("style_editor.band_n", { n: 2 }), type: "number", suffix: " m" },
        ],
      }),
    ]);
    // All bands add every band the cell has; a formula is labeled with its name, else the translated "Value".
    const formula = cog(3, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "continuous", band: { expression: "b1 / 2" }, palette: "goat:green", domain: [0, 1] },
      popup: { bands: "all" },
    });
    const labels = (values: Record<string, unknown>) =>
      (
        layerPopup(formula, values, { t: de, info })?.blocks[0] as { attributes: Array<{ label: string }> }
      ).attributes.map((a) => a.label);
    expect(labels({ value: 0.5, band_1: 1, band_2: 0 })).toEqual([
      de("style_editor.value"),
      "Höhe",
      de("style_editor.band_n", { n: 2 }),
    ]);
    expect(de("style_editor.value")).not.toBe("Value");
    // An image shows the bands it draws, in its order.
    const image = cog(4, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "image", bands: [3, 1, 2] },
      popup: {},
    });
    const attributes = (
      layerPopup(image, { band_1: 1, band_2: 2, band_3: 3 }, { t: de, info })?.blocks[0] as {
        attributes: Array<{ name: string }>;
      }
    ).attributes;
    expect(attributes.map((a) => a.name)).toEqual(["band_3", "band_1", "band_2"]);
  });

  it("in the map the value is labeled with the band's name from the value tiles' description", () => {
    // The map loads no file info: the description it loaded names the bands.
    vi.mocked(loadedRasterValues).mockReturnValue({ ...VALUES, names: ["", "Höhe"] });
    const popup = layerPopup(cog(1, ELEVATION), { value: 250.5 }, { t: de });
    expect((popup?.blocks[0] as { attributes: Array<{ label: string }> }).attributes[0].label).toBe("Höhe");
    // Without a name: "Band 2".
    vi.mocked(loadedRasterValues).mockReturnValue({ ...VALUES, names: ["", ""] });
    const unnamed = layerPopup(cog(1, ELEVATION), { value: 250.5 }, { t: de });
    expect((unnamed?.blocks[0] as { attributes: Array<{ label: string }> }).attributes[0].label).toBe(
      de("style_editor.band_n", { n: 2 })
    );
  });

  it("the default content shows the cell's color beside its value, as the map draws it", () => {
    const first = (popup: ReturnType<typeof layerPopup>) =>
      (popup?.blocks[0] as { attributes: Array<{ name: string; label?: string; swatch?: string }> })
        .attributes[0];
    // A color range: the color at the value from the relief stops the map draws with.
    vi.mocked(loadedRasterValues).mockReturnValue(VALUES);
    const ramp = cog(1, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "continuous", band: 1, palette: ["#000000", "#ffffff"], domain: [0, 100] },
    });
    const stops = reliefStops(rasterColorSpec(ramp.style.document.render as never) as never, VALUES)!;
    const grey = first(layerPopup(ramp, { value: 50 }, { t: de }));
    expect(grey).toEqual(
      expect.objectContaining({ name: "value", swatch: reliefColorAt(stops, VALUES, 50) })
    );
    expect(grey.swatch).toMatch(/^#(7f|80){3}$/);
    // Categories: the category's color; a hillshade with a palette: the palette's color there.
    const whole = { ...VALUES, integer: true, encoding: { ...VALUES.encoding, blueFactor: 1 } };
    vi.mocked(loadedRasterValues).mockReturnValue(whole);
    const landCover = cog(2, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "categorical", classes: [{ value: 3, name: "Wald", color: "#2e7d32" }] },
    });
    expect(first(layerPopup(landCover, { value: 3, class: "Wald" }, { t: de })).swatch).toBe("#2e7d32");
    const shaded = cog(3, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "hillshade", palette: ["#000000", "#ffffff"], domain: [0, 100] },
    });
    expect(first(layerPopup(shaded, { value: 100 }, { t: de })).swatch).toBe("#ffffff");
    // Shading alone draws no color.
    const shading = cog(4, { version: "1.0.0", kind: "raster", render: { type: "hillshade" } });
    expect(first(layerPopup(shading, { value: 100 }, { t: de }))).not.toHaveProperty("swatch");
    // An 8 bit image: one row of its pixel's color and the values it is made of, named by the bands' names when the
    // file names them all, else "Color".
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: { count: 3, dtype: "uint8", scaled: false, colorTable: false },
    });
    const photo = cog(5, { version: "1.0.0", kind: "raster", render: { type: "image" }, popup: {} });
    const rgb = { band_1: 142, band_2: 143, band_3: 138 };
    expect(layerPopup(photo, rgb, { t: de })?.blocks[0]).toEqual(
      expect.objectContaining({
        attributes: [
          expect.objectContaining({
            name: "band_1",
            label: de("style_editor.color"),
            join: ["band_1", "band_2", "band_3"],
            swatch: "#8e8f8a",
          }),
        ],
      })
    );
    expect(de("style_editor.color")).toBe("Farbe");
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: {
        count: 4,
        dtype: "uint8",
        scaled: false,
        colorTable: false,
        names: ["Rot", "Grün", "Blau", "NIR"],
      },
    });
    expect(first(layerPopup(photo, rgb, { t: de })).label).toBe("Rot, Grün, Blau");
    // A click's exact answer has a band the image does not draw: with every band asked for, below the row.
    const all = cog(7, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "image" },
      popup: { bands: "all" },
    });
    const rows = (
      layerPopup(all, { ...rgb, band_4: 40 }, { t: de })?.blocks[0] as {
        attributes: Array<{ name: string; label: string }>;
      }
    ).attributes;
    expect(rows.map((a) => [a.name, a.label])).toEqual([
      ["band_1", "Rot, Grün, Blau"],
      ["band_4", "NIR"],
    ]);
    // Before the colored tiles' description has loaded, the bands it draws are not known: the cell's bands, each in
    // its own row, none joined or named a color.
    vi.mocked(loadedRasterTileset).mockReturnValue(undefined);
    const before = (
      layerPopup(photo, { band_1: 40, band_2: 120, band_3: 200, band_4: 9 }, { t: de })?.blocks[0] as {
        attributes: Array<{ name: string; label: string; join?: string[] }>;
      }
    ).attributes;
    expect(before.map((a) => [a.name, a.label, a.join])).toEqual(
      [1, 2, 3, 4].map((n) => [`band_${n}`, de("style_editor.band_n", { n }), undefined])
    );
    // A file that names not every band it draws but marks them red, green and blue: the colors' names, in the order
    // it draws them; a BGR file draws red from its third band.
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: {
        count: 3,
        dtype: "uint8",
        scaled: false,
        colorTable: false,
        names: ["", "", ""],
        colorInterp: ["blue", "green", "red"],
      },
    });
    const bgr = first(layerPopup(photo, { band_1: 40, band_2: 120, band_3: 200 }, { t: de }));
    expect(bgr).toEqual(
      expect.objectContaining({
        name: "band_3",
        label: "Rot, Grün, Blau",
        join: ["band_3", "band_2", "band_1"],
        swatch: "#c87828",
      })
    );
    const en = commonT("en");
    expect(first(layerPopup(photo, { band_1: 40, band_2: 120, band_3: 200 }, { t: en })).label).toBe(
      "Red, Green, Blue"
    );
    // Bands the style chooses that are not marked so: "Color".
    const chosen = cog(8, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "image", bands: [1, 2, 3] },
      popup: {},
    });
    expect(first(layerPopup(chosen, { band_1: 40, band_2: 120, band_3: 200 }, { t: de })).label).toBe(
      de("style_editor.color")
    );
    // An image drawn with its color table: the code of the band it colors, beside the code's color.
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: {
        count: 1,
        dtype: "uint8",
        scaled: false,
        colorTable: true,
        names: [""],
        colorInterp: ["palette"],
        palette: { band: 1, colors: { 3: "#ff0000", 7: "#008000" } },
      },
    });
    const map250 = cog(9, { version: "1.0.0", kind: "raster", render: { type: "image" }, popup: {} });
    expect(layerPopup(map250, { value: 7, band_1: 7 }, { t: de })?.blocks[0]).toEqual(
      expect.objectContaining({
        attributes: [
          expect.objectContaining({
            name: "band_1",
            label: de("style_editor.band_n", { n: 1 }),
            swatch: "#008000",
          }),
        ],
      })
    );
    // Blocks a user wrote stay as written; the style panel's content, without a cell, has none.
    const written = cog(6, {
      ...ramp.style.document,
      popup: { blocks: [{ type: "field_list", attributes: [{ field: "value" }] }] },
    });
    vi.mocked(loadedRasterValues).mockReturnValue(VALUES);
    expect(first(layerPopup(written, { value: 50 }, { t: de }))).not.toHaveProperty("swatch");
    expect(
      (
        rasterPopupProperties(ramp.style.document as never, rasterPopupOf(ramp)!, undefined, { t: de })
          .blocks[0] as { attributes: Array<object> }
      ).attributes[0]
    ).not.toHaveProperty("swatch");
  });

  it("blocks written in the style render for rasters", () => {
    const layer = cog(1, {
      ...ELEVATION,
      popup: {
        trigger: "click_and_hover",
        header: "compact",
        bands: "all",
        blocks: [
          { type: "field_list", attributes: [{ field: "band_2", label: "Rot", format: { decimals: 1 } }] },
        ],
      },
    });
    const popup = layerPopup(layer, { value: 250.5, band_2: 250.5 }, { t: de });
    expect(popup?.trigger).toBe("click_and_hover");
    expect(popup?.header).toBe("compact");
    expect(popup?.blocks).toEqual([
      expect.objectContaining({
        type: "fieldList",
        attributes: [{ name: "band_2", label: "Rot", type: "number", format_config: { decimals: 1 } }],
      }),
    ]);
  });
});

describe("where a raster popup's values come from", () => {
  const de = commonT("de");
  const ctx = (map: unknown, trigger: "click" | "hover", onFirst?: (r: unknown) => void) =>
    ({ map, trigger, t: de, locale: "de", onFirst }) as never;

  it("on hover the value comes from the tile the map shows, never from geoapi", async () => {
    const elevation = cog(1, ELEVATION);
    const { map, template } = mapDrawing(elevation);
    vi.mocked(loadedRasterValues).mockReturnValue(VALUES);
    // A code's value is rounded to the codes' precision: what the tile tells apart.
    vi.mocked(tileValueAt).mockResolvedValue(250.50006103515625);
    expect(cellSource.hover).toBe(true);
    expect(await cellSource.at(elevation, here, ctx(map, "hover"))).toEqual({
      values: { value: 250.5 },
      exact: false,
    });
    expect(tileUnder).toHaveBeenCalledWith(
      map,
      expect.objectContaining({ maxzoom: 14, tileSize: 512 }),
      here
    );
    expect(vi.mocked(tileValueAt).mock.calls[0].slice(0, 3)).toEqual([VALUES, template, here]);
    expect(fetchRasterPoint).not.toHaveBeenCalled();
  });

  it("a click shows the tile's value at once, then the exact value and every band", async () => {
    const elevation = cog(1, ELEVATION);
    const { map } = mapDrawing(elevation);
    vi.mocked(loadedRasterValues).mockReturnValue(VALUES);
    vi.mocked(tileValueAt).mockResolvedValue(250.5);
    const first = vi.fn();
    const exact = await cellSource.at(elevation, here, ctx(map, "click", first));
    expect(first).toHaveBeenCalledWith({ values: { value: 250.5 }, exact: false });
    expect(fetchRasterPoint).toHaveBeenCalledWith("d1", here, undefined);
    expect(exact).toEqual({ values: { value: 250.5, band_1: 10, band_2: 250.5, band_3: 30 }, exact: true });
    // geoapi not answering keeps what the tile showed.
    vi.mocked(fetchRasterPoint).mockResolvedValueOnce(null);
    expect(await cellSource.at(elevation, here, ctx(map, "click"))).toEqual({
      values: { value: 250.5 },
      exact: false,
    });
  });

  it("no popup where no value is known", async () => {
    const elevation = cog(1, ELEVATION);
    const { map } = mapDrawing(elevation);
    const none = async () => {
      expect(await cellSource.at(elevation, here, ctx(map, "hover"))).toBeNull();
      expect(await cellSource.at(elevation, here, ctx(map, "click"))).toBeNull();
    };
    // The values' description not loaded, or failed: the map draws nothing.
    await none();
    expect(tileValueAt).not.toHaveBeenCalled();
    vi.mocked(loadedRasterValues).mockReturnValue(VALUES);
    // No data (code 0), outside the file or the tiles, no tile under the point: the tile read gives no value.
    await none();
    // The style's own no data.
    const noData = cog(2, { ...ELEVATION, render: { ...ELEVATION.render, no_data: { values: [-9999] } } });
    vi.mocked(tileValueAt).mockResolvedValue(-9999);
    expect(await cellSource.at(noData, here, ctx(mapDrawing(noData).map, "hover"))).toBeNull();
    expect(await cellSource.at(noData, here, ctx(mapDrawing(noData).map, "click"))).toBeNull();
    expect(fetchRasterPoint).not.toHaveBeenCalled();
  });

  it("a colour scale the raster service colors draws no value tiles: no hover, a click asks geoapi", async () => {
    const elevation = cog(1, ELEVATION);
    // The description is loaded, but the map draws image tiles (a float band of unknown range).
    vi.mocked(loadedRasterValues).mockReturnValue({ ...VALUES, range: null });
    const map = { ...mapDrawing(elevation).map, getSource: () => ({ type: "raster", tiles: ["https://x"] }) };
    expect(await cellSource.at(elevation, here, ctx(map, "hover"))).toBeNull();
    expect(tileValueAt).not.toHaveBeenCalled();
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect(await cellSource.at(elevation, here, ctx(map, "click"))).toEqual({
      values: { value: 250.5, band_1: 10, band_2: 250.5, band_3: 30 },
      exact: true,
    });
  });

  it("an image render opens on click only, from geoapi", async () => {
    const image = cog(1, { version: "1.0.0", kind: "raster", render: { type: "image" }, popup: {} });
    const map = mapDrawing(cog(9, ELEVATION)).map;
    expect(await cellSource.at(image, here, ctx(map, "hover"))).toBeNull();
    expect(await cellSource.at(image, here, ctx(map, "click"))).toEqual({
      values: { band_1: 10, band_2: 250.5, band_3: 30 },
      exact: true,
    });
    expect(tileValueAt).not.toHaveBeenCalled();
    // Outside the file: no popup.
    vi.mocked(fetchRasterPoint).mockResolvedValueOnce({ values: [null, null, null], styled: null });
    expect(await cellSource.at(image, here, ctx(map, "click"))).toBeNull();
  });

  it("an image's popup knows where the map paints it, from the colored tile it loaded", async () => {
    const image = cog(1, { version: "1.0.0", kind: "raster", render: { type: "image" }, popup: {} });
    // The map's raster source of the image's colored tiles, as MapLibre holds it.
    const colored = {
      type: "raster",
      tiles: ["https://geoapi.test/collections/d1/raster/tiles/{z}/{x}/{y}.webp?style=t&v=v1"],
      tileSize: 512,
      minzoom: 0,
      maxzoom: 14,
      bounds: [13, 52, 14, 53],
    };
    const map = {
      ...mapDrawing(cog(9, ELEVATION)).map,
      getSource: (id: string) => (id === "src-1" ? colored : undefined),
    };
    vi.mocked(tilePixelAt).mockResolvedValue([200, 120, 40, 255]);
    expect(await cellSource.paints(image, here, ctx(map, "hover"))).toBe(true);
    expect(tileUnder).toHaveBeenCalledWith(
      map,
      { tileSize: 512, minzoom: 0, maxzoom: 14, roundZoom: true },
      here
    );
    expect(vi.mocked(tilePixelAt).mock.calls[0].slice(0, 2)).toEqual([colored, here]);
    // Transparent there (no data, outside the file): nothing painted.
    vi.mocked(tilePixelAt).mockResolvedValue(null);
    expect(await cellSource.paints(image, here, ctx(map, "hover"))).toBe(false);
    // A popup that is off, and a layer drawn from value tiles (its cell's value answers): no colored tile is read.
    vi.mocked(tilePixelAt).mockClear();
    const off = cog(1, { version: "1.0.0", kind: "raster", render: { type: "image" } });
    expect(await cellSource.paints(off, here, ctx(map, "hover"))).toBe(false);
    const elevation = cog(2, ELEVATION);
    vi.mocked(loadedRasterValues).mockReturnValue(VALUES);
    expect(await cellSource.paints(elevation, here, ctx(mapDrawing(elevation).map, "hover"))).toBe(false);
    expect(tilePixelAt).not.toHaveBeenCalled();
    expect(fetchRasterPoint).not.toHaveBeenCalled();
  });

  it("a colour scale the raster service colors is painted where its colored tile is", async () => {
    const elevation = cog(1, ELEVATION);
    vi.mocked(loadedRasterValues).mockReturnValue({ ...VALUES, range: null });
    const colored = {
      type: "raster",
      tiles: ["https://x/{z}/{x}/{y}.webp"],
      tileSize: 512,
      minzoom: 0,
      maxzoom: 22,
    };
    const map = {
      ...mapDrawing(elevation).map,
      getSource: (id: string) => (id === "src-1" ? colored : undefined),
    };
    vi.mocked(tilePixelAt).mockResolvedValue([200, 120, 40, 255]);
    expect(await cellSource.paints(elevation, here, ctx(map, "hover"))).toBe(true);
    expect(fetchRasterPoint).not.toHaveBeenCalled();
  });

  it("an 8 bit image hovers from its pixels; a click adds every band from geoapi", async () => {
    const image = cog(1, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "image" },
      popup: { trigger: "click_and_hover" },
    });
    // The colored tiles' description the map loaded: a 4 band 8 bit file drawn as it is.
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: { count: 4, dtype: "uint8", scaled: false, colorTable: false },
    });
    const colored = {
      type: "raster",
      tiles: ["https://geoapi.test/collections/d1/raster/tiles/{z}/{x}/{y}.webp?style=t&v=v1"],
      tileSize: 512,
      minzoom: 0,
      maxzoom: 14,
    };
    const map = {
      ...mapDrawing(cog(9, ELEVATION)).map,
      getSource: (id: string) => (id === "src-1" ? colored : undefined),
    };
    vi.mocked(tilePixelAt).mockResolvedValue([142, 143, 138, 255]);
    expect(await cellSource.at(image, here, ctx(map, "hover"))).toEqual({
      values: { band_1: 142, band_2: 143, band_3: 138 },
      exact: false,
    });
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    // A click shows them at once, then every band from geoapi: the tile shows three of four.
    vi.mocked(fetchRasterPoint).mockResolvedValueOnce({ values: [142, 143, 138, 255], styled: null });
    const first = vi.fn();
    expect(await cellSource.at(image, here, ctx(map, "click", first))).toEqual({
      values: { band_1: 142, band_2: 143, band_3: 138, band_4: 255 },
      exact: true,
    });
    expect(first).toHaveBeenCalledWith({ values: { band_1: 142, band_2: 143, band_3: 138 }, exact: false });
    // A pixel this browser could not read (a tile that failed, a canvas that is not exact): a click asks geoapi.
    vi.mocked(fetchRasterPoint).mockClear();
    vi.mocked(tilePixelAt).mockResolvedValue(undefined);
    expect(await cellSource.at(image, here, ctx(map, "hover"))).toBeNull();
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect(await cellSource.at(image, here, ctx(map, "click"))).toEqual({
      values: { band_1: 10, band_2: 250.5, band_3: 30 },
      exact: true,
    });
    // Nothing painted there: no popup, no request.
    vi.mocked(fetchRasterPoint).mockClear();
    vi.mocked(tilePixelAt).mockResolvedValue(null);
    expect(await cellSource.at(image, here, ctx(map, "click"))).toBeNull();
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    // A 16 bit image is stretched to its colors: no hover read, a click asks geoapi.
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: { count: 3, dtype: "uint16", scaled: false, colorTable: false },
    });
    vi.mocked(tilePixelAt).mockClear();
    expect(await cellSource.at(image, here, ctx(map, "hover"))).toBeNull();
    expect(tilePixelAt).not.toHaveBeenCalled();
    expect(await cellSource.at(image, here, ctx(map, "click"))).toEqual({
      values: { band_1: 10, band_2: 250.5, band_3: 30 },
      exact: true,
    });
  });

  it("an image drawn with its color table hovers each cell's own code from its value tiles, shared colors too", async () => {
    const paletted = cog(1, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "image", no_data: { values: [98] } },
      popup: { trigger: "click_and_hover" },
    });
    const facts = { count: 1, dtype: "uint8", scaled: false, colorTable: true, colorInterp: ["palette"] };
    // 0 and 1 share white, 2 and 98 grey; 3 has no entry.
    const colors = { 0: "#ffffff", 1: "#ffffff", 2: "#7f7f7f", 98: "#7f7f7f", 7: "#008000" };
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: { ...facts, palette: { band: 1, colors } },
    });
    // Its table band's value tiles, read nearest, as the map draws them.
    const values: RasterValues = {
      encoding: { redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 1 },
      range: [0, 205],
      integer: true,
      version: "v1",
      maxzoom: 12,
    };
    const template = valueTilesUrl(coverageUrl("d1"), { band: 1, resampling: "nearest" }, values);
    vi.mocked(loadedRasterValues).mockImplementation((url) =>
      url.includes("band=1&resampling=nearest") ? values : undefined
    );
    const map = {
      ...mapDrawing(cog(9, ELEVATION)).map,
      getSource: (id: string) => (id === "src-1" ? { type: "raster-dem", tiles: [template] } : undefined),
    };
    // White: 0 and 1 each answer their own code, read from the tile, no request, no pixel read.
    for (const code of [0, 1]) {
      vi.mocked(tileValueAt).mockResolvedValue(code);
      expect(await cellSource.at(paletted, here, ctx(map, "hover"))).toEqual({
        values: { value: code, band_1: code },
        exact: false,
      });
    }
    expect(vi.mocked(tileValueAt).mock.calls[0].slice(0, 3)).toEqual([values, template, here]);
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect(tilePixelAt).not.toHaveBeenCalled();
    // A click shows the code at once, then geoapi's exact value.
    vi.mocked(tileValueAt).mockResolvedValue(2);
    vi.mocked(fetchRasterPoint).mockResolvedValueOnce({ values: [2], styled: null });
    const first = vi.fn();
    expect(await cellSource.at(paletted, here, ctx(map, "click", first))).toEqual({
      values: { value: 2, band_1: 2 },
      exact: true,
    });
    expect(first).toHaveBeenCalledWith({ values: { value: 2, band_1: 2 }, exact: false });
    // A code the table has no entry for, and the style's no data, are drawn transparent: no popup, no request.
    vi.mocked(fetchRasterPoint).mockClear();
    for (const code of [3, 98]) {
      vi.mocked(tileValueAt).mockResolvedValue(code);
      expect(await cellSource.at(paletted, here, ctx(map, "hover")), String(code)).toBeNull();
      expect(await cellSource.at(paletted, here, ctx(map, "click")), String(code)).toBeNull();
    }
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    // The default content: the code under the band's label, with its entry's color.
    expect(layerPopup(paletted, { value: 1, band_1: 1 })?.blocks[0]).toEqual(
      expect.objectContaining({
        attributes: [expect.objectContaining({ name: "band_1", swatch: "#ffffff" })],
      })
    );
  });

  it("a color table image whose values failed: no hover, a click asks the point query; nothing while they load", async () => {
    const paletted = cog(1, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "image" },
      popup: { trigger: "click_and_hover" },
    });
    const facts = { count: 1, dtype: "uint8", scaled: false, colorTable: true, colorInterp: ["palette"] };
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: { ...facts, palette: { band: 1, colors: { 0: "#ffffff", 1: "#ffffff", 7: "#008000" } } },
    });
    // No values description loaded (it failed): the map draws the colored tiles instead.
    const colored = {
      type: "raster",
      tiles: ["https://geoapi.test/collections/d1/raster/tiles/{z}/{x}/{y}.webp?style=t&v=v1"],
      tileSize: 512,
      minzoom: 0,
      maxzoom: 14,
    };
    const drawing = {
      ...mapDrawing(cog(9, ELEVATION)).map,
      getSource: (id: string) => (id === "src-1" ? colored : undefined),
    };
    expect(await cellSource.at(paletted, here, ctx(drawing, "hover"))).toBeNull();
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect(tilePixelAt).not.toHaveBeenCalled();
    vi.mocked(fetchRasterPoint).mockResolvedValueOnce({ values: [1], styled: null });
    expect(await cellSource.at(paletted, here, ctx(drawing, "click"))).toEqual({
      values: { value: 1, band_1: 1 },
      exact: true,
    });
    // The pointer as for an image whose popup opens on click: where the colored tiles paint.
    vi.mocked(tilePixelAt).mockResolvedValue([255, 255, 255, 255]);
    expect(await cellSource.paints(paletted, here, ctx(drawing, "click"))).toBe(true);
    // While the values load the map draws nothing: no popup, no request.
    vi.mocked(fetchRasterPoint).mockClear();
    const loading = { ...drawing, getSource: () => undefined };
    expect(await cellSource.at(paletted, here, ctx(loading, "click"))).toBeNull();
    expect(fetchRasterPoint).not.toHaveBeenCalled();
  });

  it("categories without classes draw the file as stored: its color table's codes from value tiles", async () => {
    const stored = cog(1, { version: "1.0.0", kind: "raster", render: { type: "categorical", classes: [] } });
    const facts = { count: 1, dtype: "uint8", scaled: false, colorTable: true, colorInterp: ["palette"] };
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: { ...facts, palette: { band: 1, colors: { 0: "#ffffff", 1: "#ffffff", 7: "#008000" } } },
    });
    const values: RasterValues = {
      encoding: { redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 1 },
      range: [0, 205],
      integer: true,
      version: "v1",
      maxzoom: 12,
    };
    const template = valueTilesUrl(coverageUrl("d1"), { band: 1, resampling: "nearest" }, values);
    vi.mocked(loadedRasterValues).mockImplementation((url) =>
      url.includes("band=1&resampling=nearest") ? values : undefined
    );
    const map = {
      ...mapDrawing(cog(9, ELEVATION)).map,
      getSource: (id: string) => (id === "src-1" ? { type: "raster-dem", tiles: [template] } : undefined),
    };
    vi.mocked(tileValueAt).mockResolvedValue(0);
    const read = await cellSource.at(stored, here, ctx(map, "hover"));
    expect(read).toEqual({ values: { value: 0, band_1: 0 }, exact: false });
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    // The default content: the value with its entry's color.
    expect(layerPopup(stored, read!.values)?.blocks[0]).toEqual(
      expect.objectContaining({ attributes: [expect.objectContaining({ name: "value", swatch: "#ffffff" })] })
    );
    // A code without an entry: nothing drawn, no popup.
    vi.mocked(tileValueAt).mockResolvedValue(3);
    expect(await cellSource.at(stored, here, ctx(map, "hover"))).toBeNull();
  });

  it("an image's hover gives no answer until its description tells the bands it draws", async () => {
    // A BGR file: before the colored tiles' description has loaded, nothing is assumed; after, red is band 3.
    const photo = cog(1, {
      version: "1.0.0",
      kind: "raster",
      render: { type: "image" },
      popup: { trigger: "click_and_hover" },
    });
    const colored = {
      type: "raster",
      tiles: ["https://geoapi.test/collections/d1/raster/tiles/{z}/{x}/{y}.webp?style=t&v=v1"],
      tileSize: 512,
      minzoom: 0,
      maxzoom: 14,
    };
    const map = {
      ...mapDrawing(cog(9, ELEVATION)).map,
      getSource: (id: string) => (id === "src-1" ? colored : undefined),
    };
    vi.mocked(tilePixelAt).mockResolvedValue([200, 120, 40, 255]);
    expect(await cellSource.at(photo, here, ctx(map, "hover"))).toBeNull();
    expect(tilePixelAt).not.toHaveBeenCalled();
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: {
        count: 3,
        dtype: "uint8",
        scaled: false,
        colorTable: false,
        colorInterp: ["blue", "green", "red"],
      },
    });
    expect(await cellSource.at(photo, here, ctx(map, "hover"))).toEqual({
      values: { band_3: 200, band_2: 120, band_1: 40 },
      exact: false,
    });
  });

  it("a formula's value comes from the tile, then geoapi colors it with the style's token", async () => {
    vi.mocked(fetchRasterPoint).mockResolvedValueOnce({ values: [100, 200, 300, 500], styled: 0.666 });
    const ndvi = cog(8, {
      version: "1.0.0",
      kind: "raster",
      render: {
        type: "continuous",
        band: { name: "NDVI", expression: "(b4 - b1) / (b4 + b1)" },
        palette: "goat:green",
        domain: [-1, 1],
      },
    });
    const { map } = mapDrawing(ndvi);
    vi.mocked(loadedRasterValues).mockReturnValue(VALUES);
    vi.mocked(tileValueAt).mockResolvedValue(0.6666);
    const record = await cellSource.at(ndvi, here, ctx(map, "click"));
    const [, , token] = vi.mocked(fetchRasterPoint).mock.calls[0];
    expect(typeof token).toBe("string");
    expect(record?.values).toEqual({ value: 0.666, band_1: 100, band_2: 200, band_3: 300, band_4: 500 });
    expect(layerPopup(ndvi, record?.values)?.blocks[0]).toEqual(
      expect.objectContaining({
        attributes: [expect.objectContaining({ name: "value", label: "NDVI", type: "number" })],
      })
    );
  });

  it("no popup over cells the map does not draw, on hover or on click", async () => {
    const integer: RasterValues = {
      ...VALUES,
      integer: true,
      encoding: { ...VALUES.encoding, blueFactor: 1 },
    };
    /** The record a hover and a click give at a cell of `value` over value tiles. */
    const records = async (render: object, value: number) => {
      const layer = cog(1, { version: "1.0.0", kind: "raster", render });
      const { map } = mapDrawing(layer, integer);
      vi.mocked(loadedRasterValues).mockReturnValue(integer);
      vi.mocked(tileValueAt).mockResolvedValue(value);
      vi.mocked(fetchRasterPoint).mockResolvedValue({ values: [value], styled: null });
      return [
        await cellSource.at(layer, here, ctx(map, "hover")),
        await cellSource.at(layer, here, ctx(map, "click")),
      ];
    };
    const classes = {
      type: "continuous",
      palette: "goat:elevation",
      domain: [0, 30],
      classify: {
        method: "manual",
        classes: [{ to: 10 }, { from: 10, to: 20, visible: false }, { from: 20 }],
      },
    };
    // A hidden class.
    expect(await records(classes, 15)).toEqual([null, null]);
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect((await records(classes, 25)).map((r) => r?.values.value)).toEqual([25, 25]);
    // A value in no category, without a color for the rest; a hidden category.
    const categories = {
      type: "categorical",
      classes: [
        { value: 1, color: "#4a90c2" },
        { value: 6, color: "#7a87c6", visible: false },
      ],
    };
    expect(await records(categories, 9)).toEqual([null, null]);
    expect(await records(categories, 6)).toEqual([null, null]);
    expect((await records({ ...categories, other_color: "#cccccc" }, 9))[0]?.values.value).toBe(9);
    // Beyond a color range or the stops whose outside cells are left out; drawn in the end colors otherwise.
    const ramp = { type: "continuous", palette: "goat:elevation", domain: [100, 200] };
    expect(await records({ ...ramp, outside: "hide" }, 250)).toEqual([null, null]);
    expect((await records({ ...ramp, outside: "hide" }, 150))[0]?.values.value).toBe(150);
    expect((await records(ramp, 250))[0]?.values.value).toBe(250);
    const stops = {
      type: "continuous",
      stops: [
        { value: 100, color: "#000000" },
        { value: 200, color: "#ffffff" },
      ],
      outside: "hide",
    };
    expect(await records(stops, 50)).toEqual([null, null]);
    // A hillshade draws its shading under colors left out.
    expect((await records({ ...ramp, type: "hillshade", outside: "hide" }, 250))[0]?.values.value).toBe(250);
    // Colors the raster service paints: a click's exact value in a hidden class opens nothing either.
    const layer = cog(1, { version: "1.0.0", kind: "raster", render: classes });
    const served = { ...mapDrawing(layer).map, getSource: () => ({ type: "raster", tiles: ["https://x"] }) };
    vi.mocked(fetchRasterPoint).mockResolvedValue({ values: [15], styled: null });
    expect(await cellSource.at(layer, here, ctx(served, "click"))).toBeNull();
    vi.mocked(fetchRasterPoint).mockResolvedValue({ values: [25], styled: null });
    expect((await cellSource.at(layer, here, ctx(served, "click")))?.values).toMatchObject({ value: 25 });
  });

  it("an open class is named by the band's minimum and maximum, or where values outside stop", async () => {
    const en = commonT("en");
    // Equal intervals 5 over the colour range [32, 119] of a band that holds -38.94 to 189.14 (the description's range,
    // the band's statistics).
    const render = {
      type: "continuous",
      palette: "goat:elevation",
      domain: [32, 119],
      classify: { method: "equal_interval", count: 5, classes: equalIntervalClasses([32, 119], 5) },
    };
    const values: RasterValues = { ...VALUES, range: [-38.94, 189.14] };
    const classOf = async (r: object, value: number, trigger: "hover" | "click") => {
      const layer = cog(1, { version: "1.0.0", kind: "raster", render: r, legend: { unit: "m" } });
      const { map } = mapDrawing(layer, values);
      vi.mocked(loadedRasterValues).mockReturnValue(values);
      vi.mocked(tileValueAt).mockResolvedValueOnce(value);
      vi.mocked(fetchRasterPoint).mockResolvedValueOnce({ values: [value], styled: null });
      const record = await cellSource.at(layer, here, { map, trigger, t: en, locale: "en" } as never);
      return record?.values.class;
    };
    expect(await classOf(render, 12, "hover")).toBe("-38.94 to 49.4 m");
    expect(await classOf(render, 200, "hover")).toBe("101.6 to 189.14 m");
    // A click's exact value from geoapi is named the same.
    expect(await classOf(render, 12, "click")).toBe("-38.94 to 49.4 m");
    // Values outside left out: the classes end at the colour range, which names them, and a cell beyond it is not
    // drawn, so it opens no popup (its end included: 119 is drawn).
    const hide = { ...render, outside: "hide" };
    expect(await classOf(hide, 40, "hover")).toBe("32 to 49.4 m");
    expect(await classOf(hide, 119, "hover")).toBe("101.6 to 119 m");
    expect(await classOf(hide, 12, "hover")).toBeUndefined();
    expect(await classOf(hide, 200, "click")).toBeUndefined();
    // The panel's preview names them from the file's statistics.
    const info: RasterInfo = {
      bands: 1,
      bits: [32],
      colorTable: false,
      integer: false,
      names: [""],
      stats: [{ index: 1, min: -38.94, max: 189.14, p2: 32, p98: 119, values: null }],
    };
    const preview = rasterPopupProperties(
      { version: "1.0.0", kind: "raster", render, legend: { unit: "m" } },
      { trigger: "click", bands: "styled", popup: {} },
      undefined,
      { t: en, locale: "en", info }
    );
    expect(Object.keys((preview.blocks[1] as { palette: object }).palette)).toEqual([
      "-38.94 to 49.4 m",
      "49.4 to 66.8 m",
      "66.8 to 84.2 m",
      "84.2 to 101.6 m",
      "101.6 to 189.14 m",
    ]);
  });

  it("a cell's class is its name, the legend's text for it, or Other", async () => {
    const landCover = cog(1, {
      version: "1.0.0",
      kind: "raster",
      render: {
        type: "categorical",
        // An entry without a value is left out, as the coloring leaves it out: names stay with their class.
        classes: [
          { name: "ohne Wert" },
          { value: 1, name: "Wasser", color: "#4a90c2" },
          { value: 3, name: "Wald", color: "#2e7d32" },
          { value: 4, color: "#e6c35c" },
          { value: 6, name: "Feuchtgebiet", color: "#7a87c6", visible: false },
        ],
        other_color: "#cccccc",
      },
    });
    const { map } = mapDrawing(landCover, {
      ...VALUES,
      integer: true,
      encoding: { ...VALUES.encoding, blueFactor: 1 },
    });
    vi.mocked(loadedRasterValues).mockReturnValue({
      ...VALUES,
      integer: true,
      encoding: { ...VALUES.encoding, blueFactor: 1 },
    });
    const at = async (value: number) => {
      vi.mocked(tileValueAt).mockResolvedValueOnce(value);
      return (await cellSource.at(landCover, here, ctx(map, "hover")))?.values;
    };
    expect(await at(3)).toEqual({ value: 3, class: "Wald" });
    expect(await at(4)).toEqual({ value: 4, class: "4" });
    expect(await at(9)).toEqual({ value: 9, class: de("style_editor.other") });
    // A hidden category: the map draws nothing there, no popup.
    expect(await at(6)).toBeUndefined();
    // The default badge colors the cell's class.
    expect(layerPopup(landCover, { value: 9, class: "Andere" }, { t: de })?.blocks[1]).toEqual(
      expect.objectContaining({ type: "badge", palette: { Andere: "#cccccc" } })
    );
    expect(layerPopup(landCover, { value: 4, class: "4" }, { t: de })?.blocks[1]).toEqual(
      expect.objectContaining({ type: "badge", palette: { "4": "#e6c35c" } })
    );
  });
});
