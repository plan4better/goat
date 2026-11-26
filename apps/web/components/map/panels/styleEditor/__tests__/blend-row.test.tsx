// The Layer section's Blend row (spec 4.7): shown where the layer draws something that mixes with the map below,
// absent for points that draw nothing that mixes, disabled with its note where the layer's kind draws without it.
// Normal writes nothing, and opening the panel writes nothing.
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import en from "@/i18n/locales/en/common.json";

import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterInfo } from "@/lib/style/raster/metadata";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { LayerSection } from "@/components/map/panels/styleEditor/sections/LayerSection";
import { RasterLayerSection } from "@/components/map/panels/styleEditor/sections/RasterLayerSection";

import { choose, echoTransport, i18n, renderPanel } from "./renderPanel";

vi.mock("@/lib/api/rasters", () => ({ fetchRasterPoint: vi.fn(async () => null) }));

type Geometry = "point" | "line" | "polygon";

/** One 8 bit band with a color table geoapi describes (`palette`). */
const PALETTED: RasterInfo = {
  bands: 1,
  bits: [8],
  colorTable: true,
  integer: true,
  dtype: "uint8",
  scaled: false,
  names: [""],
  colorInterp: ["palette"],
  palette: { band: 1, colors: { 0: "#ffffff", 1: "#ffffff", 7: "#008000" } },
  stats: [],
};
const BYTE: RasterInfo = { ...PALETTED, colorTable: false, palette: undefined, colorInterp: undefined };

const LABEL = "style_editor.blend";
const row = () => screen.queryByRole("combobox", { name: LABEL });
const disabled = () => row()?.hasAttribute("disabled");
const NOTES = [
  "style_editor.blend_columns",
  "style_editor.blend_heights",
  "style_editor.blend_hillshade",
  "style_editor.blend_values",
  "style_editor.blend_dark_basemap",
  "style_editor.blend_light_basemap",
];
/** The modes in the order the row lists them. */
const BLENDS = ["normal", "multiply", "screen", "overlay", "color", "luminosity", "plus-lighter"];
/** The blend a test's document holds, if any. */
const storedBlend = (doc: object): string | undefined => ("blend" in doc ? String(doc.blend) : undefined);
/** The notes under the row that show: none, or the one named. */
const notes = () => NOTES.filter((key) => screen.queryByText(key) !== null);

function vector(geometry: Geometry, doc: object = {}, tone: "light" | "dark" = "light") {
  const transport = echoTransport();
  const view = renderPanel(
    <PopoverProvider>
      <LayerSection />
    </PopoverProvider>,
    {
      document: { version: "1.0.0", kind: "vector", ...doc } as LayerStyle,
      data: { geometry },
      transport,
      tone,
    }
  );
  return { ...view, transport };
}

function raster(doc: object, info?: RasterInfo, tone: "light" | "dark" = "light", service = false) {
  const transport = echoTransport();
  const view = renderPanel(
    <PopoverProvider>
      <RasterLayerSection service={service} />
    </PopoverProvider>,
    {
      document: { version: "1.0.0", kind: "raster", ...doc } as LayerStyle,
      data: service ? {} : { raster: { dataset: "d1", info } },
      transport,
      tone,
    }
  );
  return { ...view, transport };
}

describe("the Blend row of a vector layer", () => {
  it("shows for polygons, lines and flat hexagons, after Opacity and before Visible, at Normal", () => {
    for (const [geometry, doc] of [
      ["polygon", { symbol: { fill: { color: "#fcbba1" } } }],
      ["line", { symbol: { line: { color: "#2166ac" } } }],
      ["point", { render: { type: "h3" } }],
    ] as const) {
      const { unmount, container } = vector(geometry, doc);
      expect([geometry, row()?.textContent, disabled(), notes()]).toEqual([geometry, "normal", false, []]);
      const text = container.textContent ?? "";
      expect(text.indexOf("style_editor.opacity")).toBeLessThan(text.indexOf(LABEL));
      expect(text.indexOf(LABEL)).toBeLessThan(text.indexOf("style_editor.visible"));
      unmount();
    }
  });

  it("is absent for points drawn as features, a heatmap or clusters", () => {
    for (const doc of [
      {},
      { render: { type: "features" } },
      { render: { type: "heatmap" } },
      { render: { type: "cluster" } },
      // A stored blend stays stored: the check names it (blend_not_drawn), the row does not show.
      { blend: "multiply", render: { type: "heatmap" } },
    ]) {
      const { unmount, store } = vector("point", doc);
      expect([doc, row()]).toEqual([doc, null]);
      expect(store.get("blend")).toBe(storedBlend(doc));
      unmount();
    }
  });

  it("hexagon columns show the row disabled, with its note, and keep a stored blend", () => {
    const { store } = vector("point", { blend: "multiply", render: { type: "h3", extrude: {} } });
    expect([row()?.textContent, disabled(), notes()]).toEqual([
      "multiply",
      true,
      ["style_editor.blend_columns"],
    ]);
    expect(store.get("blend")).toBe("multiply");
    expect(store.canUndo).toBe(false);
  });

  it("a raised polygon keeps the row, with the note that its outline blends", () => {
    const { store } = vector("polygon", { symbol: { fill: { color: "#336699" }, extrude: { height: 10 } } });
    expect([row()?.textContent, disabled(), notes()]).toEqual([
      "normal",
      false,
      ["style_editor.blend_heights"],
    ]);
    expect(store.canUndo).toBe(false);
  });

  it("each choice writes its value; Normal removes the key", async () => {
    const { store } = vector("polygon");
    let current = "normal";
    for (const next of BLENDS.slice(1)) {
      await choose(LABEL, current, next);
      expect(store.get("blend")).toBe(next);
      current = next;
    }
    await choose(LABEL, current, "normal");
    expect(store.get("blend")).toBeUndefined();
    expect("blend" in store.document).toBe(false);
  });

  it("choosing a mode is one undo step, back to the style without the key", async () => {
    const start = { version: "1.0.0", kind: "vector", symbol: { fill: { color: "#fcbba1" } } };
    const { store } = vector("polygon", { symbol: start.symbol });
    await choose(LABEL, "normal", "multiply");
    expect(store.get("blend")).toBe("multiply");
    act(() => store.undo());
    expect(store.document).toEqual(start);
    expect(store.canUndo).toBe(false);
  });

  it("lists the seven modes in order, each with its name and sub-line from the locale's texts", async () => {
    const texts = en.style_editor as Record<string, string>;
    i18n.addResourceBundle("en", "common", en);
    try {
      vector("polygon", { blend: "plus-lighter" });
      const field = screen.getByRole("combobox", { name: texts.blend });
      expect(field.textContent).toBe("Plus lighter");
      await userEvent.click(field);
      const options = within(screen.getByRole("listbox")).getAllByRole("option");
      expect(options).toHaveLength(BLENDS.length);
      BLENDS.forEach((value, i) => {
        for (const key of [`value_blend_${value}`, `value_blend_${value}_sub`]) {
          expect(texts[key], key).toBeTruthy();
          expect(within(options[i]).getByText(texts[key]), key).toBeTruthy();
        }
      });
      expect(options.slice(-2).map((option) => within(option).getAllByText(/\S/)[0].textContent)).toEqual([
        "Luminosity",
        "Plus lighter",
      ]);
    } finally {
      i18n.removeResourceBundle("en", "common");
    }
  });

  it("Multiply and then Normal leaves the style without the key", async () => {
    const { store } = vector("line", { symbol: { line: { color: "#2166ac" } } });
    await choose(LABEL, "normal", "multiply");
    expect(store.document).toMatchObject({ blend: "multiply" });
    await choose(LABEL, "multiply", "normal");
    expect("blend" in store.document).toBe(false);
    expect(store.document).toEqual({
      version: "1.0.0",
      kind: "vector",
      symbol: { line: { color: "#2166ac" } },
    });
  });

  it("the dark-basemap note shows for Multiply on a dark basemap only", () => {
    for (const [blend, tone, shown] of [
      ["multiply", "dark", ["style_editor.blend_dark_basemap"]],
      ["multiply", "light", []],
      ["screen", "dark", []],
      ["overlay", "dark", []],
      ["plus-lighter", "dark", []],
      [undefined, "dark", []],
    ] as const) {
      const { unmount } = vector("polygon", blend ? { blend } : {}, tone);
      expect([blend, tone, notes()]).toEqual([blend, tone, shown]);
      unmount();
    }
  });

  it("the light-basemap note shows for Add on a light basemap only", () => {
    for (const [blend, tone, shown] of [
      ["plus-lighter", "light", ["style_editor.blend_light_basemap"]],
      ["plus-lighter", "dark", []],
      ["luminosity", "light", []],
      ["screen", "light", []],
      ["multiply", "light", []],
      [undefined, "light", []],
    ] as const) {
      const { unmount } = vector("polygon", blend ? { blend } : {}, tone);
      expect([blend, tone, notes()]).toEqual([blend, tone, shown]);
      unmount();
    }
  });

  it("choosing Add on a light basemap shows the note; Normal takes it away", async () => {
    const { store } = vector("polygon");
    await choose(LABEL, "normal", "plus-lighter");
    expect(store.get("blend")).toBe("plus-lighter");
    expect(notes()).toEqual(["style_editor.blend_light_basemap"]);
    await choose(LABEL, "plus-lighter", "luminosity");
    expect(store.get("blend")).toBe("luminosity");
    expect(notes()).toEqual([]);
    await choose(LABEL, "luminosity", "normal");
    expect("blend" in store.document).toBe(false);
  });

  it("the note of the layer's kind wins over the basemap notes", () => {
    for (const [geometry, doc, note] of [
      [
        "polygon",
        { blend: "plus-lighter", symbol: { extrude: { height: 10 } } },
        "style_editor.blend_heights",
      ],
      ["point", { blend: "plus-lighter", render: { type: "h3", extrude: {} } }, "style_editor.blend_columns"],
    ] as const) {
      const { unmount } = vector(geometry, doc, "light");
      expect([geometry, notes()]).toEqual([geometry, [note]]);
      unmount();
    }
  });

  it("the note of the layer's kind wins over the dark-basemap note", () => {
    for (const [geometry, doc, note] of [
      ["polygon", { symbol: { extrude: { height: 10 } } }, "style_editor.blend_heights"],
      ["point", { render: { type: "h3", extrude: {} } }, "style_editor.blend_columns"],
    ] as const) {
      const { unmount } = vector(geometry, { blend: "multiply", ...doc }, "dark");
      expect([geometry, notes()]).toEqual([geometry, [note]]);
      unmount();
    }
  });

  it("opening the panel writes nothing", () => {
    for (const [geometry, doc] of [
      ["polygon", {}],
      ["polygon", { blend: "normal" }],
      ["polygon", { blend: "screen" }],
      ["polygon", { blend: "plus-lighter" }],
      ["line", { blend: "luminosity" }],
      ["point", { blend: "multiply" }],
      ["point", { render: { type: "h3", extrude: {} } }],
    ] as const) {
      const { unmount, store, transport } = vector(geometry, doc, "dark");
      expect([doc, store.canUndo, transport.saves.length, store.get("blend")]).toEqual([
        doc,
        false,
        0,
        storedBlend(doc),
      ]);
      unmount();
    }
  });
});

describe("the Blend row of a raster file or a map service", () => {
  it("shows after Opacity and before Resampling for an image and a map service", () => {
    for (const [doc, info, service] of [
      [{ render: { type: "image" } }, BYTE, false],
      // Chosen bands draw as they are, not with the file's color table.
      [{ render: { type: "image", bands: [1, 1, 1] } }, PALETTED, false],
      [{}, undefined, true],
    ] as const) {
      const { unmount, container } = raster(doc, info, "light", service);
      expect([doc, row()?.textContent, disabled(), notes()]).toEqual([doc, "normal", false, []]);
      const text = container.textContent ?? "";
      expect(text.indexOf("style_editor.opacity")).toBeLessThan(text.indexOf(LABEL));
      expect(text.indexOf(LABEL)).toBeLessThan(text.indexOf("style_editor.resampling"));
      unmount();
    }
  });

  it("colors from values show the row disabled with their note, a stored blend as its value", () => {
    for (const [doc, info] of [
      [{ render: { type: "continuous", palette: "goat:elevation" } }, BYTE],
      [
        {
          render: {
            type: "continuous",
            palette: "goat:elevation",
            classify: { method: "quantile", count: 5 },
          },
        },
        BYTE,
      ],
      [{ render: { type: "categorical", classes: [{ value: 1, color: "#ff0000" }] } }, BYTE],
      [{ render: { type: "image" } }, PALETTED],
      // Adjustments by zoom draw the colored tiles, still in the table's colors: no blend either.
      [
        {
          brightness: {
            zoom: [
              [8, 0],
              [14, 0.3],
            ],
          },
          render: { type: "image" },
        },
        PALETTED,
      ],
      [{ blend: "multiply", render: { type: "continuous", palette: "goat:elevation" } }, BYTE],
    ] as const) {
      const { unmount, store } = raster(doc, info);
      const stored = storedBlend(doc);
      expect([doc, row()?.textContent, disabled(), notes()]).toEqual([
        doc,
        stored ?? "normal",
        true,
        ["style_editor.blend_values"],
      ]);
      expect([doc, store.get("blend"), store.canUndo]).toEqual([doc, stored, false]);
      unmount();
    }
  });

  it("a hillshade shows the row disabled with its note, with or without colors", () => {
    for (const render of [{ type: "hillshade" }, { type: "hillshade", palette: "goat:elevation" }]) {
      const { unmount } = raster({ render }, BYTE, "dark");
      expect([render, disabled(), notes()]).toEqual([render, true, ["style_editor.blend_hillshade"]]);
      unmount();
    }
  });

  it("Multiply and then Normal leaves the style without the key; the dark-basemap note follows Multiply", async () => {
    const { store } = raster({ render: { type: "image" } }, BYTE, "dark");
    await choose(LABEL, "normal", "multiply");
    expect(store.get("blend")).toBe("multiply");
    expect(notes()).toEqual(["style_editor.blend_dark_basemap"]);
    await choose(LABEL, "multiply", "normal");
    expect("blend" in store.document).toBe(false);
    expect(notes()).toEqual([]);
  });

  it("an image writes luminosity and Add; the light-basemap note follows Add, a disabled row keeps its own note", async () => {
    const { store, unmount } = raster({ render: { type: "image" } }, BYTE, "light");
    await choose(LABEL, "normal", "luminosity");
    expect(store.get("blend")).toBe("luminosity");
    expect(notes()).toEqual([]);
    await choose(LABEL, "luminosity", "plus-lighter");
    expect(store.get("blend")).toBe("plus-lighter");
    expect(notes()).toEqual(["style_editor.blend_light_basemap"]);
    unmount();
    const scale = raster(
      { blend: "plus-lighter", render: { type: "continuous", palette: "goat:elevation" } },
      BYTE
    );
    expect([disabled(), notes()]).toEqual([true, ["style_editor.blend_values"]]);
    scale.unmount();
  });

  it("a map service writes the blend too", async () => {
    const { store } = raster({}, undefined, "light", true);
    await choose(LABEL, "normal", "screen");
    expect(store.get("blend")).toBe("screen");
  });

  it("opening the panel writes nothing", () => {
    for (const [doc, info] of [
      [{ render: { type: "image" } }, BYTE],
      [{ blend: "normal", render: { type: "image" } }, BYTE],
      [{ blend: "multiply", render: { type: "image" } }, PALETTED],
      [{ blend: "multiply", render: { type: "hillshade" } }, BYTE],
    ] as const) {
      const { unmount, store, transport } = raster(doc, info, "dark");
      expect([doc, store.canUndo, transport.saves.length, store.get("blend")]).toEqual([
        doc,
        false,
        0,
        storedBlend(doc),
      ]);
      unmount();
    }
  });
});
