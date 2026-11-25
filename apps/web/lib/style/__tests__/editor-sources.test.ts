// What the panel says sets a part or a key for the layer agrees with what the map draws, for documents the panel did
// not write itself (the AI assistant, an import, the JSON editor).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CLUSTER_SYMBOL } from "@/lib/style/compile/render";
import { classificationFor, modeOf, switchMode } from "@/lib/style/editor/forms";
import { labelTextStyleSummary } from "@/lib/style/editor/labels";
import {
  clusterRender,
  iconOff,
  iconSettings,
  markerOn,
  restoreIcon,
  setArrowsIcon,
} from "@/lib/style/editor/parts";
import { getIn } from "@/lib/style/editor/paths";
import {
  isPerLayer,
  laterSetter,
  markerFillState,
  partSetter,
  partState,
  perLayerPath,
  recordValuesAt,
  rowsOpening,
} from "@/lib/style/editor/sources";
import { summarize } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";

const doc = (extra: object) =>
  ({ version: "1.0.0", kind: "vector", ...extra }) as LayerStyle & Record<string, unknown>;
const ctx = { mapZoom: 12, geometry: "point" as const };
const classifyOf = (d: LayerStyle) => (d as unknown as Record<string, unknown>).classify;

const CLASS_ICONS = doc({
  symbol: { marker: { shape: "circle", color: "#5e4fa2", size: 18, icon_color: "#ffffff" } },
  classify: [
    {
      id: "category",
      field: "category",
      method: "categories",
      classes: [
        { id: "c1", values: ["playground"], marker: { icon: "goat:playground", color: "#4daf4a" } },
        { id: "c2", values: ["park"], marker: { icon: "goat:park", color: "#377eb8" } },
      ],
    },
  ],
});

describe("icons and shapes from every record", () => {
  it("reads the icon on when classes, other, a class shape or a rule carry it", () => {
    expect(markerOn(CLASS_ICONS)).toBe(true);
    const plain = { symbol: { marker: { color: "#888888" } } };
    const classify = (record: object) => [
      { id: "k", field: "kind", method: "categories", classes: [{ id: "a", values: ["x"] }], ...record },
    ];
    expect(
      markerOn(doc({ ...plain, classify: classify({ other: { marker: { icon: "goat:park" } } }) }))
    ).toBe(true);
    expect(
      markerOn(
        doc({
          ...plain,
          classify: [
            {
              id: "k",
              field: "kind",
              method: "categories",
              classes: [{ values: ["x"], marker: { shape: "square" } }],
            },
          ],
        })
      )
    ).toBe(true);
    expect(
      markerOn(
        doc({
          ...plain,
          rules: [{ when: { op: "=", args: [{ property: "kind" }, "x"] }, marker: { icon: "goat:park" } }],
        })
      )
    ).toBe(true);
    expect(markerOn(doc(plain))).toBe(false);
    // A shape by zoom whose stops are all circles draws plain circles.
    expect(
      markerOn(
        doc({
          symbol: {
            marker: {
              shape: {
                zoom: [
                  [5, "circle"],
                  [10, "circle"],
                ],
              },
            },
          },
        })
      )
    ).toBe(false);
    expect(
      markerOn(
        doc({
          symbol: {
            marker: {
              shape: {
                zoom: [
                  [5, "circle"],
                  [10, "square"],
                ],
              },
            },
          },
        })
      )
    ).toBe(true);
    // Markers switched off draw no icon, whatever a class says.
    expect(markerOn(doc({ symbol: { marker: false }, classify: CLASS_ICONS.classify }))).toBe(false);
  });

  it("off takes every record's icon and shape, on brings them back as they were", () => {
    const withRule = doc({
      ...CLASS_ICONS,
      classify: [
        ...(CLASS_ICONS.classify as object[]),
        {
          id: "size",
          field: "pop",
          method: "manual",
          target: "marker.icon",
          classes: [{ id: "s1", to: 10, marker: { icon: "goat:star" } }],
        },
        {
          id: "shape",
          field: "kind",
          method: "categories",
          target: "marker.size",
          classes: [{ id: "k1", values: ["x"], marker: { size: 20, shape: "square" } }],
        },
      ],
      rules: [
        { id: "r", when: { op: "=", args: [{ property: "kind" }, "y"] }, marker: { icon: "goat:cafe" } },
      ],
    });
    const kept = iconSettings(withRule);
    const off = iconOff(withRule, ctx);
    expect(markerOn(off)).toBe(false);
    // The classes keep their colors and sizes; only icons and shapes go.
    expect(classifyOf(off)).toEqual([
      {
        id: "category",
        field: "category",
        method: "categories",
        classes: [
          { id: "c1", values: ["playground"], marker: { color: "#4daf4a" } },
          { id: "c2", values: ["park"], marker: { color: "#377eb8" } },
        ],
      },
      {
        id: "shape",
        field: "kind",
        method: "categories",
        target: "marker.size",
        classes: [{ id: "k1", values: ["x"], marker: { size: 20 } }],
      },
    ]);
    expect(restoreIcon(off, kept)).toEqual(withRule);
  });

  it("off leaves the icon colors classes set, and a classification of the shape goes and comes back", () => {
    const colored = doc({
      symbol: { marker: { icon: "goat:park", icon_color: "#000000" } },
      classify: [
        {
          id: "c",
          field: "kind",
          method: "categories",
          target: "marker.icon_color",
          classes: [{ id: "c1", values: ["x"], marker: { icon_color: "#ff0000" } }],
        },
        {
          id: "s",
          field: "kind",
          method: "categories",
          target: "marker.shape",
          classes: [{ id: "s1", values: ["y"], marker: { shape: "square" } }],
        },
      ],
    });
    const kept = iconSettings(colored);
    const off = iconOff(colored, ctx);
    expect(markerOn(off)).toBe(false);
    expect(classifyOf(off)).toEqual([(colored.classify as object[])[0]]);
    expect(restoreIcon(off, kept)).toEqual(colored);
  });

  it("clusters of points whose classes or rules draw shapes or icons cluster like the points", () => {
    const shapes = doc({
      symbol: { marker: { color: "#888888" } },
      classify: [
        { id: "k", field: "kind", method: "categories", other: { marker: { shape: "square" } }, classes: [] },
      ],
    });
    // Either way with the default cluster symbol, its number on Auto.
    const symbol = { ...DEFAULT_CLUSTER_SYMBOL, label: { text: "{count}", color: "auto" } };
    expect(clusterRender(shapes)).toEqual({ type: "cluster", look: "points", count: "badge", symbol });
    expect(clusterRender(doc({ symbol: { marker: { color: "#888888" } } }))).toEqual({
      type: "cluster",
      symbol,
    });
    // The default symbol itself, which draws a cluster without one, keeps its white number.
    expect(DEFAULT_CLUSTER_SYMBOL.label.color).toBe("#ffffff");
  });
});

describe("parts switched on by classes or rules", () => {
  const outlineInClass = doc({
    symbol: { marker: { color: "#888888" } },
    classify: [
      {
        id: "k",
        field: "kind",
        method: "categories",
        classes: [{ id: "a", values: ["x"], outline: { color: "#ff0000", width: 2 } }],
      },
    ],
  });

  it("a part only classes turn on is on for some features, named by the classification", () => {
    expect(partState(outlineInClass, "outline", "point")).toBe("some");
    expect((partSetter(outlineInClass, "outline") as { field: string }).field).toBe("kind");
    expect(partState(outlineInClass, "label", "point")).toBe("none");
    expect(partState(outlineInClass, "marker", "point")).toBe("all");
    expect(partState(doc({ symbol: { outline: false } }), "outline", "point")).toBe("off");
    const byRule = doc({
      symbol: { fill: {} },
      rules: [{ when: { op: "=", args: [{ property: "kind" }, "x"] }, extrude: { height: 30 } }],
    });
    expect(partState(byRule, "extrude", "polygon")).toBe("some");
    expect(partSetter(byRule, "extrude")).toBe("rules");
  });

  it("hollow markers with a filled class are filled for some features", () => {
    const hollow = doc({
      symbol: { marker: { color: "#888888", fill: false } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          classes: [{ id: "a", values: ["x"], marker: { fill: true, color: "#ff0000" } }],
        },
      ],
    });
    expect(markerFillState(hollow)).toBe("some");
    expect(markerFillState(doc({ symbol: { marker: { fill: false } } }))).toBe("none");
    expect(markerFillState(doc({ symbol: { marker: {} } }))).toBe("all");
  });
});

describe("the classification that sets a key", () => {
  const ROUTES = doc({
    symbol: { line: { color: "#2166ac", width: 3 }, casing: { color: "#ffffff", width: 1.5 } },
    classify: [
      {
        title: "Route status",
        field: "kind",
        method: "categories",
        classes: [
          { values: ["existing"], name: "Existing" },
          {
            values: ["planned"],
            name: "Planned",
            min_zoom: 13,
            line: { dash: "dashed", opacity: 0.6 },
            casing: false,
          },
        ],
      },
    ],
  });

  it("a classification without target whose classes set no main color does not set it", () => {
    expect(classificationFor(ROUTES, "line.color", "line")).toBeUndefined();
    expect(modeOf(ROUTES, "symbol.line.color", "line")).toBe("fixed");
    expect((classificationFor(ROUTES, "line.dash", "line") as { field: string }).field).toBe("kind");
    // Freshly added, before the server computes its classes, it does.
    const pending = doc({ classify: [{ id: "k", field: "kind", method: "categories", count: 7 }] });
    expect(classificationFor(pending, "line.color", "line")).toBeDefined();
  });

  it("Fixed on a main color set by classes that also set other keys keeps those keys", () => {
    const both = doc({
      symbol: { line: { color: "#2166ac" } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          palette: "goat:green",
          classes: [
            { id: "a", values: ["existing"], line: { color: "#ff0000" } },
            { id: "b", values: ["planned"], min_zoom: 13, line: { color: "#00ff00", dash: "dashed" } },
          ],
        },
      ],
    });
    const fixed = switchMode(both, "symbol.line.color", "fixed", { mapZoom: 12, geometry: "line" });
    expect(classifyOf(fixed)).toEqual([
      {
        id: "k",
        field: "kind",
        method: "categories",
        classes: [
          { id: "a", values: ["existing"] },
          { id: "b", values: ["planned"], min_zoom: 13, line: { dash: "dashed" } },
        ],
      },
    ]);
    expect(modeOf(fixed, "symbol.line.color", "line")).toBe("fixed");
    // A computed one stays as the author's classes: a recompute would color them again.
    const computed = doc({
      symbol: { line: { color: "#2166ac" } },
      classify: [
        {
          id: "q",
          field: "pop",
          method: "quantile",
          count: 2,
          computed: {
            at: "t",
            data: "d",
            scope: "dataset",
            generated: { target: "line.color", values: { a: "#ff0000" } },
          },
          classes: [
            { id: "a", to: 10, line: { color: "#ff0000", dash: "dashed" } },
            { id: "b", from: 10, line: { color: "#00ff00" } },
          ],
        },
      ],
    });
    expect(
      classifyOf(switchMode(computed, "symbol.line.color", "fixed", { mapZoom: 12, geometry: "line" }))
    ).toEqual([
      {
        id: "q",
        field: "pop",
        method: "manual",
        computed: { at: "t", data: "d", scope: "dataset" },
        classes: [
          { id: "a", to: 10, line: { dash: "dashed" } },
          { id: "b", from: 10 },
        ],
      },
    ]);
    // A classification that sets the color only goes with it, as before.
    const only = doc({
      symbol: { line: { color: "#2166ac" } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          classes: [{ values: ["a"], line: { color: "#ff0000" } }],
        },
      ],
    });
    expect(
      classifyOf(switchMode(only, "symbol.line.color", "fixed", { mapZoom: 12, geometry: "line" }))
    ).toBeUndefined();
  });

  it("of two classifications that set the same key, the one that targets it is named, else the later one", () => {
    const two = doc({
      symbol: { marker: { color: "#cccccc", size: 8 } },
      classify: [
        {
          id: "a",
          field: "category",
          method: "categories",
          target: "marker.size",
          classes: [{ id: "a1", values: ["x"], marker: { color: "#ff0000", size: 4 } }],
        },
        {
          id: "b",
          field: "kind",
          method: "categories",
          classes: [{ id: "b1", values: ["y"], marker: { color: "#00ff00", size: 12 } }],
          other: { marker: { color: "#0000ff" } },
        },
      ],
    });
    expect((classificationFor(two, "marker.color", "point") as { id: string }).id).toBe("b");
    // `a` targets the size: its editor stays reachable from the Size row; `b`'s class draws over it where it applies.
    expect((classificationFor(two, "marker.size", "point") as { id: string }).id).toBe("a");
  });

  it("a size classification stays named when a later color classification's class gets its own size", () => {
    const panelMade = doc({
      symbol: { marker: { color: "#cccccc", size: 8 } },
      classify: [
        {
          id: "pop",
          field: "pop",
          method: "quantile",
          count: 2,
          target: "marker.size",
          classes: [
            { id: "p1", to: 10, marker: { size: 4 } },
            { id: "p2", from: 10, marker: { size: 12 } },
          ],
        },
        {
          id: "kind",
          field: "kind",
          method: "categories",
          count: 2,
          classes: [{ id: "park", values: ["park"], marker: { color: "#00ff00", size: 20 } }],
        },
      ],
    });
    expect((classificationFor(panelMade, "marker.size", "point") as { id: string }).id).toBe("pop");
    expect((classificationFor(panelMade, "marker.color", "point") as { id: string }).id).toBe("kind");
  });

  it("Fixed takes a classification whose classes only hide features or set zooms away with the color", () => {
    const hidden = doc({
      symbol: { marker: { color: "#cccccc" } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          count: 2,
          classes: [
            { id: "c1", values: ["park"], visible: false, marker: { color: "#ff0000" } },
            { id: "c2", values: ["shop"], min_zoom: 12, marker: { color: "#00ff00" } },
          ],
        },
      ],
    });
    expect(
      classifyOf(switchMode(hidden, "symbol.marker.color", "fixed", { mapZoom: 12, geometry: "point" }))
    ).toBeUndefined();
  });

  it("a computed classification without target reads By <field> while the server colors its classes", () => {
    const repaint = doc({
      symbol: { marker: { color: "#cccccc" } },
      classify: [
        { id: "k", field: "kind", method: "categories", count: 5, classes: [{ id: "c1", values: ["park"] }] },
      ],
    });
    expect(modeOf(repaint, "symbol.marker.color", "point")).toBe("classes");
    // Classes the author lists (no count) color nothing until they set a color.
    const own = doc({
      symbol: { marker: { color: "#cccccc" } },
      classify: [{ id: "k", field: "kind", method: "categories", classes: [{ id: "c1", values: ["park"] }] }],
    });
    expect(modeOf(own, "symbol.marker.color", "point")).toBe("fixed");
  });
});

describe("keys set once for the layer", () => {
  it("every key the map reads once for the layer is read where a class holds it", () => {
    // The keys the compiler reads with `perLayer` from a layer style (the cluster symbol's own reads aside).
    const dir = path.resolve(__dirname, "../compile");
    const keys = new Set<string>();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      for (const m of source.matchAll(/perLayer\(style, "([a-z_.]+)"\)/g)) keys.add(m[1]);
      for (const m of source.matchAll(/perLayerNumber\("([a-z_.]+)"\)/g)) keys.add(m[1]);
    }
    expect(keys.size).toBeGreaterThan(10);
    for (const key of keys) {
      expect(isPerLayer(key), key).toBe(true);
      const [part, ...rest] = key.split(".");
      const held = doc({
        symbol: { [part]: {} },
        classify: [
          {
            id: "k",
            field: "kind",
            method: "categories",
            classes: [{ values: ["x"], [part]: { [rest.join(".")]: 1 } }],
          },
        ],
      });
      expect(perLayerPath(held, `symbol.${key}`), key).toBe(`classify.0.classes.0.${key}`);
      expect(classificationFor(held, key, "polygon"), key).toBeUndefined();
    }
  });

  it("are read where the first record sets them, never by classes", () => {
    const arrows = doc({
      symbol: { line: { color: "#333333" }, arrows: { size: 10 } },
      rules: [{ when: { op: "=", args: [{ property: "kind" }, "x"] }, arrows: { placement: "center" } }],
    });
    expect(perLayerPath(arrows, "symbol.arrows.placement")).toBe("rules.0.arrows.placement");
    expect(perLayerPath(arrows, "symbol.arrows.size")).toBe("symbol.arrows.size");
    const label = doc({
      symbol: { marker: { color: "#cccccc" }, label: { text: "{kind}" } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          classes: [{ id: "a", values: ["x"], label: { placement: "above" } }],
        },
      ],
    });
    expect(perLayerPath(label, "symbol.label.placement")).toBe("classify.0.classes.0.label.placement");
    expect(classificationFor(label, "label.placement", "point")).toBeUndefined();
    expect(modeOf(label, "symbol.label.placement", "point")).toBe("fixed");
    expect(perLayerPath(doc({ symbol: { label: { placement: "below" } } }), "symbol.label.placement")).toBe(
      "symbol.label.placement"
    );
  });
});

describe("Fixed keeps a classification only while a row opens it", () => {
  const fixed = (d: LayerStyle, geometry: "point" | "polygon") =>
    switchMode(d, `symbol.${geometry === "point" ? "marker" : "fill"}.color`, "fixed", {
      mapZoom: 12,
      geometry,
    });
  const colored = (geometry: "point" | "polygon", record: object, symbol: object = {}) =>
    doc({
      symbol: { [geometry === "point" ? "marker" : "fill"]: { color: "#cccccc" }, ...symbol },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          count: 2,
          classes: [
            {
              id: "a",
              values: ["park"],
              [geometry === "point" ? "marker" : "fill"]: { color: "#00ff00" },
              ...record,
            },
            { id: "b", values: ["shop"], [geometry === "point" ? "marker" : "fill"]: { color: "#ff0000" } },
          ],
        },
      ],
    });

  it("an outline one class turns on: kept, and the Outline editor's row opens it", () => {
    const next = fixed(colored("polygon", { outline: { color: "#000000" } }), "polygon");
    const c = (classifyOf(next) as object[])[0];
    expect(rowsOpening(next, c as never, "polygon")).toEqual(["some:outline"]);
  });

  it("hollow markers one class fills: kept, and the Fill editor's row opens it", () => {
    const d = colored("point", {}, { marker: { color: "#cccccc", fill: false } });
    (d.classify as Array<{ classes: Array<Record<string, unknown>> }>)[0].classes[0].marker = {
      color: "#00ff00",
      fill: true,
    };
    const next = fixed(d, "point");
    const c = (classifyOf(next) as object[])[0];
    expect(rowsOpening(next, c as never, "point")).toEqual(["fill"]);
  });

  it("a key set once for the layer, or a part switched off, alone: removed as before", () => {
    expect(
      classifyOf(
        fixed(colored("point", { label: { placement: "above" } }, { label: { text: "{kind}" } }), "point")
      )
    ).toBeUndefined();
    expect(
      classifyOf(fixed(colored("polygon", { outline: false }, { outline: { width: 1 } }), "polygon"))
    ).toBeUndefined();
  });

  it("an outline width classes set on a drawn outline: kept, its Width row opens it", () => {
    const next = fixed(colored("polygon", { outline: { width: 3 } }, { outline: { width: 1 } }), "polygon");
    const c = (classifyOf(next) as object[])[0];
    expect(rowsOpening(next, c as never, "polygon")).toEqual(["outline.width"]);
  });
});

describe("minor writes and reads from the second review", () => {
  it("an arrows icon pick writes turn_with_line where a rule holds it", () => {
    const d = doc({
      symbol: { line: { color: "#333333" }, arrows: { icon: "goat:arrow" } },
      rules: [
        { id: "r", when: { op: "=", args: [{ property: "kind" }, "x"] }, arrows: { turn_with_line: true } },
      ],
    });
    const next = setArrowsIcon(d, perLayerPath(d, "symbol.arrows.icon"), "goat:park");
    expect(getIn(next, "symbol.arrows")).toEqual({ icon: "goat:park" });
    expect(getIn(next, "rules.0.arrows.turn_with_line")).toBe(false);
  });

  it("a later classification whose classes are still to come draws over a class's own value", () => {
    const d = doc({
      symbol: { marker: { color: "#cccccc", size: 8 } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          classes: [{ id: "a", values: ["park"], marker: { size: 20 } }],
        },
        { id: "p", field: "pop", method: "quantile", count: 5, target: "marker.size" },
      ],
    });
    expect((laterSetter(d, { classify: 0, key: 0 }, "marker.size") as { id: string }).id).toBe("p");
  });

  it("in class scope, a line height another class holds is read where it is held", () => {
    const d = doc({
      symbol: { marker: { color: "#cccccc" }, label: { text: "{kind}" } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          classes: [
            { id: "a", values: ["park"] },
            { id: "b", values: ["shop"], label: { line_height: 2 } },
          ],
        },
      ],
    });
    const t = ((key: string) => key) as never;
    expect(
      labelTextStyleSummary(d, "symbol.label", { classify: 0, key: 0 }, t, {
        fields: [],
        mapZoom: 12,
        geometry: "point",
        language: "en",
      })
    ).toContain("style_editor.ts_line_height");
  });
});

describe("follow-ups: Fixed and the rows agree for rarer documents", () => {
  const fixedOn = (d: LayerStyle, path: string, geometry: "point" | "line" | "polygon") =>
    switchMode(d, path, "fixed", { mapZoom: 12, geometry });

  it("a class's font style beside another classification of the font weight: removed", () => {
    const d = doc({
      symbol: { fill: { color: "#cccccc" }, label: { text: "{kind}" } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          classes: [
            { id: "a", values: ["park"], fill: { color: "#00ff00" }, label: { font: { style: "italic" } } },
          ],
        },
        {
          id: "w",
          field: "pop",
          method: "manual",
          target: "label.font.weight",
          classes: [{ id: "w1", to: 10, label: { font: { weight: "bold" } } }],
        },
      ],
    });
    expect(
      (classifyOf(fixedOn(d, "symbol.fill.color", "polygon")) as Array<{ id: string }>).map((c) => c.id)
    ).toEqual(["w"]);
  });

  it("a class arrows color beside an arrows icon a class holds that keeps its colors: removed", () => {
    const d = doc({
      symbol: { line: { color: "#333333" }, arrows: {} },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          classes: [
            {
              id: "a",
              values: ["park"],
              line: { color: "#00ff00" },
              arrows: { icon: "emoji:0023-fe0f-20e3", color: "#ff0000" },
            },
          ],
        },
      ],
    });
    expect(classifyOf(fixedOn(d, "symbol.line.color", "line"))).toBeUndefined();
  });

  it("classes still to come with another key in No data: removed, the color reads Fixed", () => {
    const d = doc({
      symbol: { fill: { color: "#cccccc" }, outline: { width: 1 } },
      classify: [
        {
          id: "q",
          field: "pop",
          method: "quantile",
          count: 5,
          classes: [],
          no_data: { fill: { color: "#999999" }, outline: { width: 3 } },
        },
      ],
    });
    const after = fixedOn(d, "symbol.fill.color", "polygon");
    expect(classifyOf(after)).toBeUndefined();
    expect(modeOf(after, "symbol.fill.color", "polygon")).toBe("fixed");
  });
});

describe("follow-ups: rule scope with isNull follows the cascade", () => {
  const t = ((key: string) => key) as never;
  const ctx = { fields: [], mapZoom: 12, geometry: "polygon" as const, language: "en" };
  const POP = {
    id: "p",
    field: "pop",
    method: "manual",
    classes: [{ id: "p1", to: 10, fill: { color: "#111111" } }],
    no_data: { fill: { color: "#999999" } },
  };
  const KIND = {
    id: "k",
    field: "kind",
    method: "categories",
    classes: [{ id: "k1", values: ["park"], fill: { color: "#00ff00" } }],
    no_data: { fill: { color: "#888888" } },
  };
  const isNullKind = { op: "isNull", args: [{ property: "kind" }] };
  const scoped = (classify: object[], when: object) =>
    summarize(
      doc({
        symbol: { fill: { color: "#cccccc" } },
        classify,
        rules: [{ id: "r", when, outline: { width: 2 } }],
      }),
      "symbol.fill.color",
      t,
      { ...ctx, scope: { rule: "r", index: 0 } }
    );

  it("a later field's No data draws over earlier classifications", () => {
    expect(scoped([POP, KIND], isNullKind)).toBe("#888888 · 100%");
    expect(scoped([KIND, POP], isNullKind)).toBe("style_editor.by_field");
  });

  it("isNull inside an and is followed", () => {
    expect(
      scoped([POP, KIND], { op: "and", args: [isNullKind, { op: ">", args: [{ property: "pop" }, 1] }] })
    ).toBe("#888888 · 100%");
  });
});

describe("follow-ups: then by a later classification without target still to come", () => {
  it("counts it for the main color", () => {
    const d = doc({
      symbol: { marker: { color: "#cccccc", size: 8 } },
      classify: [
        {
          id: "p",
          field: "pop",
          method: "manual",
          target: "marker.size",
          classes: [{ id: "p1", to: 10, marker: { size: 4, color: "#123456" } }],
        },
        { id: "k", field: "kind", method: "categories", count: 5, classes: [] },
      ],
    });
    expect((laterSetter(d, { classify: 0, key: 0 }, "marker.color") as { id: string }).id).toBe("k");
  });
});

describe("the records' values at a key", () => {
  const d = doc({
    symbol: { fill: { opacity: 0.8 } },
    classify: [
      {
        id: "a",
        field: "kind",
        classes: [{ fill: { color: "#f00" } }, { fill: { opacity: 0.4 } }],
        other: { fill: {} },
      },
    ],
    rules: [{ id: "r", when: {}, fill: { opacity: 0.1 } }],
  });

  it("lists classes, Other, No data and rules in cascade order, the same string while nothing changed", () => {
    expect(recordValuesAt(d, ["fill.opacity"])).toBe("[[null],[0.4],[null],[0.1]]");
    expect(recordValuesAt(d, ["fill.opacity"])).toBe(recordValuesAt(structuredClone(d), ["fill.opacity"]));
  });

  it("changes when a record's value at the key changes, not for another key", () => {
    const other = doc({ ...d, rules: [{ id: "r", when: {}, fill: { opacity: 0.1, color: "#000" } }] });
    expect(recordValuesAt(other, ["fill.opacity"])).toBe(recordValuesAt(d, ["fill.opacity"]));
    const changed = doc({ ...d, rules: [{ id: "r", when: {}, fill: { opacity: 0.2 } }] });
    expect(recordValuesAt(changed, ["fill.opacity"])).not.toBe(recordValuesAt(d, ["fill.opacity"]));
  });
});
