import { describe, expect, it } from "vitest";

import {
  LABEL_FONT_CHOICE,
  colorFields,
  keyOf,
  modeOf,
  modesFor,
  switchMode,
} from "@/lib/style/editor/forms";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";

const doc = (symbol: object, extra: object = {}) =>
  ({ version: 1, kind: "vector", symbol, ...extra }) as LayerStyle;

describe("value modes", () => {
  it("names the property of a path", () => {
    expect(keyOf("symbol.line.width")).toBe("line.width");
    expect(keyOf("symbol.label.halo.color")).toBe("label.halo.color");
    expect(keyOf("symbol.line.width.zoom.1.1")).toBe("line.width");
    expect(keyOf("classify.0.classes.2.fill.color")).toBe("fill.color");
    expect(keyOf("classify.1.other.marker.size")).toBe("marker.size");
    expect(keyOf("rules.0.outline.width")).toBe("outline.width");
    expect(keyOf("opacity")).toBe("opacity");
    expect(keyOf("render.radius")).toBe("heatmap.radius");
  });

  it("reads the mode of a value", () => {
    expect(modeOf(doc({ line: { width: 3 } }), "symbol.line.width", "line")).toBe("fixed");
    expect(
      modeOf(
        doc({
          line: {
            width: {
              zoom: [
                [10, 2],
                [16, 6],
              ],
            },
          },
        }),
        "symbol.line.width",
        "line"
      )
    ).toBe("zoom");
    expect(
      modeOf(doc({ marker: { size: { field: "p", range: [4, 20] } } }), "symbol.marker.size", "point")
    ).toBe("attribute");
    expect(
      modeOf(doc({ marker: { rotation: { field: "bearing" } } }), "symbol.marker.rotation", "point")
    ).toBe("raw");
    const classified = doc({ fill: {} }, { classify: [{ field: "use", method: "categories" }] });
    expect(modeOf(classified, "symbol.fill.color", "polygon")).toBe("classes");
    expect(modeOf(classified, "symbol.fill.opacity", "polygon")).toBe("fixed");
    const widths = doc(
      { outline: {} },
      {
        classify: [
          { field: "use", method: "categories", classes: [{ values: ["a"], outline: { width: 3 } }] },
        ],
      }
    );
    expect(modeOf(widths, "symbol.outline.width", "polygon")).toBe("classes");
  });

  it("offers a field's values as colors only when a field holds colors", () => {
    const fields = [
      { name: "cell", type: "string" },
      { name: "farbe", type: "string" },
      { name: "n", type: "integer" },
    ];
    expect(colorFields(fields, { cell: "CRS3035RES100mN3326200E4539200", farbe: "#d7301f", n: 3 })).toEqual([
      "farbe",
    ]);
    expect(colorFields(fields, undefined)).toEqual([]);
    expect(modesFor("fill.color", { scoped: false, hasNumberField: false, hasColorField: true })).toEqual([
      "fixed",
      "zoom",
      "raw",
      "classes",
    ]);
  });

  it("offers the modes the property takes", () => {
    expect(modesFor("heatmap.radius", { scoped: false, hasNumberField: true })).toEqual(["fixed", "zoom"]);
    expect(modesFor("fill.color", { scoped: false, hasNumberField: true })).toEqual([
      "fixed",
      "zoom",
      "attribute",
      "classes",
    ]);
    expect(modesFor("fill.color", { scoped: true, hasNumberField: true })).toEqual(["fixed", "zoom"]);
    expect(modesFor("fill.color", { scoped: false, hasNumberField: false })).toEqual([
      "fixed",
      "zoom",
      "classes",
    ]);
    expect(modesFor("line.dash", { scoped: false, hasNumberField: true })).toEqual([
      "fixed",
      "zoom",
      "classes",
    ]);
    expect(modesFor("arrows.spacing", { scoped: false, hasNumberField: true })).toEqual(["fixed", "zoom"]);
    expect(modesFor("marker.rotation", { scoped: false, hasNumberField: true })).toEqual([
      "fixed",
      "zoom",
      "attribute",
      "raw",
      "classes",
    ]);
  });

  it("to zoom writes two stops around the map zoom", () => {
    expect(switchMode(doc({ line: { width: 3 } }), "symbol.line.width", "zoom", { mapZoom: 12 })).toEqual(
      doc({
        line: {
          width: {
            zoom: [
              [9, 3],
              [15, 3],
            ],
          },
        },
      })
    );
    expect(
      switchMode(doc({ line: { dash: "dotted" } }), "symbol.line.dash", "zoom", { mapZoom: 23 })
    ).toEqual(
      doc({
        line: {
          dash: {
            zoom: [
              [20, "dotted"],
              [24, "dotted"],
            ],
            interpolate: "step",
          },
        },
      })
    );
    // An unset value starts from the reference default.
    expect(switchMode(doc({ line: {} }), "symbol.line.width", "zoom", { mapZoom: 2 })).toEqual(
      doc({
        line: {
          width: {
            zoom: [
              [0, 2],
              [5, 2],
            ],
          },
        },
      })
    );
  });

  it("to zoom puts its stops on half zooms, wherever the map is", () => {
    expect(
      switchMode(doc({ line: { width: 3 } }), "symbol.line.width", "zoom", { mapZoom: 5.546938919188786 })
    ).toEqual(
      doc({
        line: {
          width: {
            zoom: [
              [2.5, 3],
              [8.5, 3],
            ],
          },
        },
      })
    );
  });

  it("to fixed takes the value at the map zoom or for the sample feature", () => {
    const zoomed = doc({
      line: {
        width: {
          zoom: [
            [10, 2],
            [16, 6],
          ],
        },
      },
    });
    expect(switchMode(zoomed, "symbol.line.width", "fixed", { mapZoom: 13 })).toEqual(
      doc({ line: { width: 4 } })
    );
    const byAttribute = doc({ marker: { size: { field: "p", range: [4, 20], domain: [0, 100] } } });
    expect(
      switchMode(byAttribute, "symbol.marker.size", "fixed", { mapZoom: 12, sample: { p: 25 } })
    ).toEqual(doc({ marker: { size: 8 } }));
    const ramp = doc({
      fill: { color: { field: "d", palette: ["#000000", "#808080", "#ffffff"], domain: [0, 10] } },
    });
    expect(switchMode(ramp, "symbol.fill.color", "fixed", { mapZoom: 12, sample: { d: 6 } })).toEqual(
      doc({ fill: { color: "#808080" } })
    );
  });

  it("to fixed takes the sample's color along the palette by the form's scale", () => {
    const palette = ["#000000", "#404040", "#808080", "#c0c0c0", "#ffffff"];
    const form = (scale?: string) =>
      doc({ fill: { color: { field: "d", palette, domain: [0, 100], ...(scale ? { scale } : {}) } } });
    const fixed = (scale?: string) =>
      switchMode(form(scale), "symbol.fill.color", "fixed", { mapZoom: 12, sample: { d: 25 } });
    expect(fixed()).toEqual(doc({ fill: { color: "#404040" } }));
    expect(fixed("sqrt")).toEqual(doc({ fill: { color: "#808080" } }));
  });

  it("to fixed keeps the default when the sample's value of a raw field is no value of the property", () => {
    const raw = doc({ marker: { color: { field: "cell" }, size: { field: "cell" } } });
    const sample = { cell: "CRS3035RES100mN3326200E4539200" };
    expect(switchMode(raw, "symbol.marker.color", "fixed", { mapZoom: 12, sample })).toEqual(
      doc({ marker: { color: DEFAULTS["marker.color"], size: { field: "cell" } } })
    );
    expect(switchMode(raw, "symbol.marker.size", "fixed", { mapZoom: 12, sample })).toEqual(
      doc({ marker: { color: { field: "cell" }, size: DEFAULTS["marker.size"] } })
    );
    expect(
      switchMode(raw, "symbol.marker.color", "fixed", { mapZoom: 12, sample: { cell: "#a1b2c3" } })
    ).toEqual(doc({ marker: { color: "#a1b2c3", size: { field: "cell" } } }));
  });

  it("to attribute writes the field and the defaults, never a domain", () => {
    expect(
      switchMode(doc({ fill: { color: "#ff0000" } }), "symbol.fill.color", "attribute", {
        mapZoom: 12,
        field: "d",
      })
    ).toEqual(doc({ fill: { color: { field: "d", palette: "goat:green" } } }));
    expect(
      switchMode(doc({ marker: { size: 8 } }), "symbol.marker.size", "attribute", { mapZoom: 12, field: "p" })
    ).toEqual(doc({ marker: { size: { field: "p", range: [4, 24], scale: "sqrt" } } }));
    expect(
      switchMode(doc({ fill: { opacity: 1 } }), "symbol.fill.opacity", "attribute", {
        mapZoom: 12,
        field: "p",
      })
    ).toEqual(doc({ fill: { opacity: { field: "p", range: [0.2, 1], scale: "linear" } } }));
    expect(
      switchMode(doc({ marker: {} }), "symbol.marker.rotation", "raw", { mapZoom: 12, field: "bearing" })
    ).toEqual(doc({ marker: { rotation: { field: "bearing" } } }));
  });

  it("leaving classes removes the classification that sets the key", () => {
    const classified = doc(
      { fill: { color: "#cccccc" } },
      {
        classify: [
          { field: "use", method: "categories" },
          { field: "n", method: "quantile", target: "outline.width" },
        ],
      }
    );
    expect(
      switchMode(classified, "symbol.fill.color", "fixed", { mapZoom: 12, geometry: "polygon" })
    ).toEqual(
      doc(
        { fill: { color: "#cccccc" } },
        { classify: [{ field: "n", method: "quantile", target: "outline.width" }] }
      )
    );
    const records = doc(
      { outline: { width: 1 } },
      {
        classify: [
          {
            field: "use",
            method: "categories",
            classes: [{ values: ["a"], fill: { color: "#111111" }, outline: { width: 3 } }],
          },
        ],
      }
    );
    expect(
      switchMode(records, "symbol.outline.width", "fixed", { mapZoom: 12, geometry: "polygon" })
    ).toEqual(
      doc(
        { outline: { width: 1 } },
        {
          classify: [
            { field: "use", method: "categories", classes: [{ values: ["a"], fill: { color: "#111111" } }] },
          ],
        }
      )
    );
  });
});

describe("heights and values by attribute in zoom stops", () => {
  it("a height or a base by attribute is in proportion to the field: a linear scale (spec 3.6)", () => {
    for (const [key, range] of [
      ["height", [0, 50]],
      ["base", [0, 10]],
    ] as const)
      expect(
        switchMode(doc({ extrude: { height: 10 } }), `symbol.extrude.${key}`, "attribute", {
          mapZoom: 12,
          field: "density",
        })
      ).toEqual(
        doc({ extrude: { height: 10, [key]: { field: "density", range: [...range], scale: "linear" } } })
      );
  });

  it("a value by attribute switched to zoom keeps the field at every stop (spec 4.4)", () => {
    const size = { field: "pupils", range: [3, 10], scale: "sqrt", computed: { domain: [0, 1500] } };
    expect(
      switchMode(doc({ marker: { size } }), "symbol.marker.size", "zoom", { mapZoom: 12, field: "x" })
    ).toEqual(
      doc({
        marker: {
          size: {
            zoom: [
              [9, size],
              [15, size],
            ],
          },
        },
      })
    );
    const color = { field: "pupils", palette: "d3:viridis" };
    expect(switchMode(doc({ fill: { color } }), "symbol.fill.color", "zoom", { mapZoom: 12 })).toEqual(
      doc({
        fill: {
          color: {
            zoom: [
              [9, color],
              [15, color],
            ],
          },
        },
      })
    );
  });

  it("a field's values as they are switched to zoom become plain stops, as before", () => {
    expect(
      switchMode(doc({ marker: { rotation: { field: "bearing" } } }), "symbol.marker.rotation", "zoom", {
        mapZoom: 12,
        sample: { bearing: 90 },
      })
    ).toEqual(
      doc({
        marker: {
          rotation: {
            zoom: [
              [9, 90],
              [15, 90],
            ],
          },
        },
      })
    );
  });

  it("zoom stops by attribute switched to fixed take the nearest stop's value for the sample", () => {
    const stops = doc({
      marker: {
        size: {
          zoom: [
            [11, { field: "p", range: [4, 20], domain: [0, 100] }],
            [16, { field: "p", range: [8, 40], domain: [0, 100] }],
          ],
        },
      },
    });
    expect(switchMode(stops, "symbol.marker.size", "fixed", { mapZoom: 15, sample: { p: 25 } })).toEqual(
      doc({ marker: { size: 16 } })
    );
    expect(switchMode(stops, "symbol.marker.size", "fixed", { mapZoom: 11.5, sample: { p: 25 } })).toEqual(
      doc({ marker: { size: 8 } })
    );
  });
});

describe("the label's Font", () => {
  const fonts = [
    "regular",
    "bold",
    "medium",
    "light",
    "italic",
    "bold_italic",
    "medium_italic",
    "light_italic",
  ];

  it("is one of eight fonts, every weight upright and italic", () => {
    expect(LABEL_FONT_CHOICE.values).toEqual(fonts);
    expect(LABEL_FONT_CHOICE.read({})).toBe("regular");
    expect(LABEL_FONT_CHOICE.read({ font: { weight: "light", style: "italic" } })).toBe("light_italic");
    expect(LABEL_FONT_CHOICE.read({ font: { weight: "bold", style: "italic" } })).toBe("bold_italic");
    expect(LABEL_FONT_CHOICE.read({ font: { style: "italic" } })).toBe("italic");
    expect(LABEL_FONT_CHOICE.read({ font: { weight: "medium" } })).toBe("medium");
  });

  it("writes both keys: the layer leaves the defaults out, a class or a rule writes them", () => {
    expect(LABEL_FONT_CHOICE.write("medium_italic", false)).toEqual({
      "font.weight": "medium",
      "font.style": "italic",
    });
    expect(LABEL_FONT_CHOICE.write("light", false)).toEqual({
      "font.weight": "light",
      "font.style": undefined,
    });
    expect(LABEL_FONT_CHOICE.write("italic", false)).toEqual({
      "font.weight": undefined,
      "font.style": "italic",
    });
    expect(LABEL_FONT_CHOICE.write("regular", true)).toEqual({
      "font.weight": "regular",
      "font.style": "normal",
    });
    for (const font of fonts) {
      const written = LABEL_FONT_CHOICE.write(font, true);
      expect(
        LABEL_FONT_CHOICE.read({ font: { weight: written["font.weight"], style: written["font.style"] } })
      ).toBe(font);
    }
  });
});
