import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import { formatNumber, textField } from "@/lib/style/compile/labels";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { fieldTypes, goldenPairs } from "./fixtures";
import { maplibreErrors } from "./maplibre";

const tiles = (id: string) => ({ type: "tiles" as const, id: `s${id}`, tiles: ["https://t/{z}/{x}/{y}"] });
const compile = (style: object, geometry: CompileInput["geometry"], extra: Partial<CompileInput> = {}) =>
  compileLayer({ id: "9", style: style as LayerStyle, geometry, source: tiles("9"), ...extra });
const label = (out: ReturnType<typeof compileLayer>) =>
  out.layers.find((l) => l.id === "9-label") as unknown as Record<string, Record<string, unknown>>;
const valid = (out: ReturnType<typeof compileLayer>) => maplibreErrors(out.layers, out.sources, out.state);
const LOCALE = { locale: ["global-state", "locale"] };

describe("labels", () => {
  it("compiles the districts example exactly (spec 16 golden)", () => {
    const { doc, dataset, expected } = goldenPairs()[1];
    const out = compileLayer({
      id: "414",
      style: doc,
      geometry: "polygon",
      fields: fieldTypes(dataset),
      source: tiles("414"),
    });
    expect(out.layers).toEqual(expected);
    expect(out.tileParams.label).toBe(true);
    expect(out.tileParams.fields).toEqual(["area_km2", "name"]);
    expect(out.state).toEqual({ locale: { default: "en-US" } });
    expect(valid(out)).toEqual([]);
  });

  it("odd field names and literal braces", () => {
    expect(textField('{Einwohner "2020" ß} \\{x\\}', { fields: { 'Einwohner "2020" ß': "string" } })).toEqual(
      ["concat", ["to-string", ["get", 'Einwohner "2020" ß']], " {x}"]
    );
    expect(textField("{area(ha)}", { fields: {} })).toEqual(["to-string", ["get", "area(ha)"]]);
  });

  it("number formats", () => {
    const x = ["to-number", ["get", "v"], 0];
    expect(formatNumber(x, { decimals: 0 })).toEqual(["number-format", ["round", x], LOCALE]);
    expect(formatNumber(x, { decimals: 1, thousands_separator: false })).toEqual([
      "to-string",
      ["/", ["round", ["*", x, 10]], 10],
    ]);
    expect(formatNumber(x, { suffix: " km" })).toEqual(["concat", ["number-format", x, LOCALE], " km"]);
    expect(formatNumber(x, { always_show_sign: true })).toEqual([
      "case",
      [">", x, 0],
      ["concat", "+", ["number-format", x, LOCALE]],
      ["number-format", x, LOCALE],
    ]);
    const one = { ...LOCALE, "min-fraction-digits": 1, "max-fraction-digits": 1 };
    expect(formatNumber(x, { abbreviate: true })).toEqual([
      "case",
      [">=", ["abs", x], 1000000],
      ["concat", ["number-format", ["/", x, 1000000], one], " M"],
      [">=", ["abs", x], 1000],
      ["concat", ["number-format", ["/", x, 1000], one], " k"],
      ["number-format", x, LOCALE],
    ]);
  });

  it("point labels around the marker, with priority and overlap", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          marker: { size: 8 },
          label: { text: "{name}", priority: { field: "rank", top: "largest" }, allow_overlap: true },
        },
      },
      "point",
      { fields: { name: "string", rank: "integer" } }
    );
    expect(label(out).layout).toEqual({
      "text-field": ["to-string", ["get", "name"]],
      "text-size": 12,
      "text-font": ["Noto Sans Regular"],
      "text-variable-anchor-offset": [
        "top",
        [0, 0.5],
        "bottom",
        [0, -0.5],
        "right",
        [-0.5, 0],
        "left",
        [0.5, 0],
      ],
      // Each line of the label lines up on the marker's side: left beside a label right of it, and so on.
      "text-justify": "auto",
      "symbol-sort-key": ["-", ["to-number", ["get", "rank"], 0]],
      "text-allow-overlap": true,
    });
    expect(label(out)["source-layer"]).toBe("default");
    expect(valid(out)).toEqual([]);
  });

  it("a fixed placement beside a point names the side the label sits on, clear of the marker (spec 3.4)", () => {
    // Marker 8 px, label 12 px: half the marker plus 2 px is 6 px, half an em.
    const placed = (placement: string, offset?: number[]) =>
      label(
        compile(
          {
            version: 1,
            kind: "vector",
            symbol: {
              marker: { size: 8 },
              label: { text: "{name}", placement, ...(offset ? { offset } : {}) },
            },
          },
          "point"
        )
      ).layout;
    const cases: Array<[string, string, number[], string | undefined]> = [
      ["above", "bottom", [0, -0.5], undefined],
      ["below", "top", [0, 0.5], undefined],
      ["left", "right", [-0.5, 0], "auto"],
      ["right", "left", [0.5, 0], "auto"],
      ["above_left", "bottom-right", [-0.5, -0.5], "auto"],
      ["above_right", "bottom-left", [0.5, -0.5], "auto"],
      ["below_left", "top-right", [-0.5, 0.5], "auto"],
      ["below_right", "top-left", [0.5, 0.5], "auto"],
    ];
    for (const [placement, anchor, offset, justify] of cases) {
      const layout = placed(placement);
      expect([placement, layout["text-anchor"], layout["text-offset"], layout["text-justify"]]).toEqual([
        placement,
        anchor,
        offset,
        justify,
      ]);
      // A fixed side: MapLibre does not move the label to another one.
      expect(layout["text-variable-anchor-offset"]).toBeUndefined();
    }
    // The label's own offset adds to the clearance: 12 px right is one em.
    expect(placed("right", [12, -6])["text-offset"]).toEqual([1.5, -0.5]);
    expect(placed("center")["text-anchor"]).toBeUndefined();
  });

  it("fixed placements without a marker keep 2 px from the point and pass MapLibre's validation", () => {
    for (const placement of ["below", "left", "above_right", "below_left"]) {
      const out = compile(
        { version: 1, kind: "vector", symbol: { marker: false, label: { text: "{name}", placement } } },
        "point"
      );
      expect(Math.max(...(label(out).layout["text-offset"] as number[]).map(Math.abs))).toBeCloseTo(2 / 12);
      expect(valid(out)).toEqual([]);
    }
  });

  it("only labels placed around the marker line up on its side", () => {
    const placed = (placement: string, geometry: CompileInput["geometry"]) =>
      label(
        compile({ version: 1, kind: "vector", symbol: { label: { text: "{name}", placement } } }, geometry)
      ).layout["text-justify"];
    expect(placed("auto", "point")).toBe("auto");
    expect(placed("above", "point")).toBeUndefined();
    expect(placed("center", "point")).toBeUndefined();
    expect(placed("line", "line")).toBeUndefined();
    expect(placed("inside", "polygon")).toBeUndefined();
  });

  it("case, letter spacing and line height (spec 3.4)", () => {
    const layout = (l: object, extra: object = {}) =>
      label(
        compile(
          { version: 1, kind: "vector", symbol: { fill: {}, label: { text: "{name}", ...l } }, ...extra },
          "polygon",
          {
            fields: { name: "string", t: "string" },
          }
        )
      ).layout;
    const styled = layout({ transform: "uppercase", letter_spacing: 0.1, line_height: 1.4 });
    expect(styled).toMatchObject({
      "text-transform": "uppercase",
      "text-letter-spacing": 0.1,
      "text-line-height": 1.4,
    });
    // Unset, MapLibre's own defaults draw the same.
    const plain = layout({});
    expect(plain["text-transform"]).toBeUndefined();
    expect(plain["text-letter-spacing"]).toBeUndefined();
    expect(plain["text-line-height"]).toBeUndefined();
    // By zoom: spacing and line height blend, the case switches.
    const zoomed = layout({
      transform: {
        zoom: [
          [10, "none"],
          [14, "uppercase"],
        ],
        interpolate: "step",
      },
      letter_spacing: {
        zoom: [
          [10, 0],
          [14, 0.2],
        ],
      },
      line_height: {
        zoom: [
          [10, 1.2],
          [14, 1.5],
        ],
      },
    });
    expect(zoomed["text-transform"]).toEqual(["step", ["zoom"], "none", 14, "uppercase"]);
    expect(zoomed["text-letter-spacing"]).toEqual(["interpolate", ["linear"], ["zoom"], 10, 0, 14, 0.2]);
    expect(zoomed["text-line-height"]).toEqual(["interpolate", ["linear"], ["zoom"], 10, 1.2, 14, 1.5]);
    // A class sets its own case and spacing.
    const byClass = layout(
      {},
      {
        classify: [
          {
            field: "t",
            method: "categories",
            classes: [{ values: ["a"], label: { transform: "uppercase", letter_spacing: 0.2 } }],
          },
        ],
      }
    );
    expect(byClass["text-transform"]).toEqual(["match", ["get", "t"], "a", "uppercase", "none"]);
    expect(byClass["text-letter-spacing"]).toEqual(["match", ["get", "t"], "a", 0.2, 0]);
    expect(
      valid(
        compile(
          {
            version: 1,
            kind: "vector",
            symbol: {
              fill: {},
              label: {
                text: "{name}",
                ...{ transform: "lowercase", letter_spacing: 0.05, line_height: 1.5 },
              },
            },
          },
          "polygon"
        )
      )
    ).toEqual([]);
  });

  it("the font stack follows the weight and the style, by zoom and per class (spec 16)", () => {
    const font = (l: object, extra: object = {}) =>
      label(
        compile(
          { version: 1, kind: "vector", symbol: { fill: {}, label: { text: "{name}", ...l } }, ...extra },
          "polygon",
          { fields: { name: "string", t: "string" } }
        )
      ).layout["text-font"];
    expect(font({})).toEqual(["Noto Sans Regular"]);
    expect(font({ font: { style: "italic" } })).toEqual(["Noto Sans Italic"]);
    expect(font({ font: { weight: "bold", style: "normal" } })).toEqual(["Noto Sans Bold"]);
    // Every weight upright and italic: one stack each.
    expect(font({ font: { weight: "bold", style: "italic" } })).toEqual(["Noto Sans Bold Italic"]);
    expect(font({ font: { weight: "medium" } })).toEqual(["Noto Sans Medium"]);
    expect(font({ font: { weight: "medium", style: "italic" } })).toEqual(["Noto Sans Medium Italic"]);
    expect(font({ font: { weight: "light" } })).toEqual(["Noto Sans Light"]);
    expect(font({ font: { weight: "light", style: "italic" } })).toEqual(["Noto Sans Light Italic"]);
    // By zoom: the stack switches at the stops of either key.
    const regular = ["literal", ["Noto Sans Regular"]];
    const bold = ["literal", ["Noto Sans Bold"]];
    const italic = ["literal", ["Noto Sans Italic"]];
    const boldItalic = ["literal", ["Noto Sans Bold Italic"]];
    expect(
      font({
        font: {
          weight: "bold",
          style: {
            zoom: [
              [10, "normal"],
              [14, "italic"],
            ],
            interpolate: "step",
          },
        },
      })
    ).toEqual(["step", ["zoom"], bold, 14, boldItalic]);
    // Both by zoom, as the panel's Font writes them: Regular, then Bold, then Italic.
    expect(
      font({
        font: {
          weight: {
            zoom: [
              [10, "regular"],
              [14, "bold"],
              [18, "regular"],
            ],
            interpolate: "step",
          },
          style: {
            zoom: [
              [10, "normal"],
              [14, "normal"],
              [18, "italic"],
            ],
            interpolate: "step",
          },
        },
      })
    ).toEqual(["step", ["zoom"], regular, 14, bold, 18, italic]);
    // A class sets its own style; the layer's weight stays where the class sets none.
    const byClass = font(
      { font: { weight: "bold" } },
      {
        classify: [
          {
            field: "t",
            method: "categories",
            classes: [
              { values: ["a"], label: { font: { style: "italic" } } },
              { values: ["b"], label: { font: { weight: "regular" } } },
            ],
          },
        ],
      }
    );
    expect(byClass).toEqual([
      "case",
      ["==", ["match", ["get", "t"], "a", "italic", "normal"], "italic"],
      ["match", ["get", "t"], "b", italic, boldItalic],
      ["match", ["get", "t"], "b", regular, bold],
    ]);
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { fill: {}, label: { text: "{name}", font: { style: "italic" } } },
        classify: [
          {
            field: "t",
            method: "categories",
            classes: [{ values: ["a"], label: { font: { weight: "bold", style: "normal" } } }],
          },
        ],
      },
      "polygon",
      { fields: { name: "string", t: "string" } }
    );
    expect(valid(out)).toEqual([]);
  });

  it("the repeat distance applies along lines only; the space around applies to every label (spec 3.4)", () => {
    const layout = (l: object, placement?: string, geometry: CompileInput["geometry"] = "line") =>
      label(
        compile(
          {
            version: 1,
            kind: "vector",
            symbol: {
              ...(geometry === "line" ? { line: {} } : { fill: {} }),
              label: { text: "{name}", ...(placement ? { placement } : {}), ...l },
            },
          },
          geometry
        )
      ).layout;
    // Unset, MapLibre's own defaults (250 px, 2 px) draw the same.
    expect(layout({})["symbol-spacing"]).toBeUndefined();
    expect(layout({})["text-padding"]).toBeUndefined();
    expect(layout({ spacing: 400, padding: 8 })).toMatchObject({ "symbol-spacing": 400, "text-padding": 8 });
    expect(
      layout({
        spacing: {
          zoom: [
            [10, 150],
            [16, 400],
          ],
        },
      })["symbol-spacing"]
    ).toEqual(["interpolate", ["linear"], ["zoom"], 10, 150, 16, 400]);
    // One label per line at its center, or one per polygon: nothing repeats.
    expect(layout({ spacing: 400 }, "center")["symbol-spacing"]).toBeUndefined();
    expect(layout({ spacing: 400, padding: 6 }, undefined, "polygon")).toMatchObject({ "text-padding": 6 });
    expect(layout({ spacing: 400 }, undefined, "polygon")["symbol-spacing"]).toBeUndefined();
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          line: {},
          label: {
            text: "{name}",
            spacing: 400,
            padding: {
              zoom: [
                [10, 0],
                [16, 8],
              ],
            },
          },
        },
      },
      "line"
    );
    expect(valid(out)).toEqual([]);
  });

  it("labels along lines or at their centers", () => {
    const along = compile(
      { version: 1, kind: "vector", symbol: { line: {}, label: { text: "{name}", max_width: 240 } } },
      "line"
    );
    expect(label(along).layout).toMatchObject({ "symbol-placement": "line", "text-max-width": 20 });
    const center = compile(
      { version: 1, kind: "vector", symbol: { line: {}, label: { text: "{name}", placement: "center" } } },
      "line"
    );
    expect(label(center)["source-layer"]).toBe("default_decoration");
    expect(center.tileParams.decorations).toEqual(["center"]);
  });

  it("lines of a label get their own size, color and weight", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          marker: {},
          label: {
            text: "{name}\n{kind}",
            size: 12,
            lines: [{ size: 14, font: { weight: "bold" } }, { color: "#666666" }],
          },
        },
      },
      "point",
      { fields: { name: "string", kind: "string" } }
    );
    expect(label(out).layout["text-field"]).toEqual([
      "format",
      ["to-string", ["get", "name"]],
      { "font-scale": 1.1666666667, "text-font": ["literal", ["Noto Sans Bold"]] },
      "\n",
      {},
      ["to-string", ["get", "kind"]],
      { "text-color": "#666666" },
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("a line's font replaces the label's for that line, italic included", () => {
    const sections = (lines: object[], font?: object) =>
      label(
        compile(
          {
            version: 1,
            kind: "vector",
            symbol: { marker: {}, label: { text: "{name}\n{kind}", ...(font ? { font } : {}), lines } },
          },
          "point",
          { fields: { name: "string", kind: "string" } }
        )
      ).layout["text-field"] as unknown[];
    const fontOf = (section: unknown) => (section as Record<string, unknown>)["text-font"];
    const italicLines = sections([{ font: { style: "italic" } }, {}]);
    expect(fontOf(italicLines[2])).toEqual(["literal", ["Noto Sans Italic"]]);
    // The line without a font keeps the label's.
    expect(fontOf(italicLines[6])).toBeUndefined();
    // Bold on an italic label: the line names its whole font.
    expect(fontOf(sections([{ font: { weight: "bold" } }, {}], { style: "italic" })[2])).toEqual([
      "literal",
      ["Noto Sans Bold"],
    ]);
    expect(fontOf(sections([{ font: { weight: "bold", style: "italic" } }, {}])[2])).toEqual([
      "literal",
      ["Noto Sans Bold Italic"],
    ]);
    expect(fontOf(sections([{ font: { weight: "light" } }, {}])[2])).toEqual([
      "literal",
      ["Noto Sans Light"],
    ]);
  });

  it("classes can change the text; layer opacity fades it", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        opacity: 0.5,
        symbol: { marker: {}, label: { text: "{name}" } },
        classify: [
          { field: "t", method: "categories", classes: [{ values: ["a"], label: { text: "{code}" } }] },
        ],
      },
      "point",
      { fields: { t: "string" } }
    );
    expect(label(out).layout["text-field"]).toEqual([
      "match",
      ["get", "t"],
      "a",
      ["to-string", ["get", "code"]],
      ["to-string", ["get", "name"]],
    ]);
    expect(label(out).paint["text-opacity"]).toBe(0.5);
  });
});

describe("label offsets", () => {
  it("an offset by zoom compiles per stop, in ems of the label size", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          line: {},
          label: {
            text: "{name}",
            offset: {
              zoom: [
                [10, [0, 2]],
                [16, [0, 6]],
              ],
            },
          },
        },
      },
      "line",
      { fields: { name: "string" } }
    );
    expect(label(out).layout["text-offset"]).toEqual([
      "step",
      ["zoom"],
      ["literal", [0, 0.1666666667]],
      16,
      ["literal", [0, 0.5]],
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("an offset a class sets moves only that class's labels", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { line: {}, label: { text: "{name}" } },
        classify: [
          { field: "t", method: "categories", classes: [{ values: ["a"], label: { offset: [0, 12] } }] },
        ],
      },
      "line",
      { fields: { t: "string", name: "string" } }
    );
    expect(label(out).layout["text-offset"]).toEqual([
      "match",
      ["get", "t"],
      "a",
      ["literal", [0, 1]],
      ["literal", [0, 0]],
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("labels around markers that grow by zoom keep their distance at every stop (spec 16)", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          marker: {
            size: {
              zoom: [
                [10, 6],
                [16, 14],
              ],
            },
          },
          label: { text: "{name}" },
        },
      },
      "point",
      { fields: { name: "string" } }
    );
    // (size / 2 + 2) / label size: 5 / 12 at zoom 10, 9 / 12 at zoom 16
    const at = (d: number) => [
      "literal",
      ["top", [0, d], "bottom", [0, -d], "right", [-d, 0], "left", [d, 0]],
    ];
    expect(label(out).layout["text-variable-anchor-offset"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      at(0.4166666667),
      16,
      at(0.75),
    ]);
    expect(valid(out)).toEqual([]);
  });
});
