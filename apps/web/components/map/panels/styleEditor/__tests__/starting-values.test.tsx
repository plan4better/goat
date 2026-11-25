// What a label, an icon and clustering start with when the panel switches them on and has nothing to bring back:
// Auto text and halo, an Auto icon color, an Auto cluster number (spec 18.10). The documents written are goatlib's
// fixture `starting_values.json`, which goatlib's tests validate (tests/unit/style/test_defaults.py).
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { evaluate, maplibreErrors } from "@/lib/style/__tests__/maplibre";
import { CONTRAST_FLOOR, contrastRatio, labelPair, textAgainst } from "@/lib/style/colors";
import { compileLayer } from "@/lib/style/compile";
import type { Geometry } from "@/lib/style/compile/types";
import { defaultStyle } from "@/lib/style/defaults";
import { POINT_LABEL_HALO, startingLabel } from "@/lib/style/editor/labels";
import { clusterRender } from "@/lib/style/editor/parts";
import { getIn, setIn } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { clone } from "@/lib/style/json";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { ClusterSection } from "@/components/map/panels/styleEditor/sections/ClusterSection";
import { GeneralSection } from "@/components/map/panels/styleEditor/sections/GeneralSection";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { choose, openGroup, renderPanel } from "./renderPanel";

type Row = { name: string; geometry: Geometry; style: LayerStyle & Record<string, unknown> };
const ROWS = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../../../../../packages/python/goatlib/tests/unit/style/fixtures/starting_values.json"
    ),
    "utf8"
  )
) as Row[];
const row = (name: string): Row => {
  const found = ROWS.find((r) => r.name === name);
  if (!found) throw new Error(`no fixture row ${name}`);
  return found;
};
/** The fixture's document with `values` at their paths (undefined: absent): the document before the switch. */
function without(style: LayerStyle, values: Record<string, unknown>): LayerStyle {
  return Object.entries(values).reduce(
    (doc, [path, value]) => setIn(doc, path, value),
    clone(style) as LayerStyle
  );
}

const FIELDS = [
  { name: "name", type: "string" as const, label: "name" },
  { name: "use", type: "string" as const, label: "use" },
];
const render = (document: LayerStyle, geometry: Geometry, featureCount = 50) =>
  renderPanel(
    <PopoverProvider>
      <GeneralSection />
      <ClusterSection />
      <SymbolSection />
    </PopoverProvider>,
    {
      document,
      data: {
        geometry,
        featureCount,
        fields: FIELDS,
        fieldTypes: { name: "string", use: "string" },
        sample: { name: "Berlin", use: "park" },
      },
    }
  );
/** The row labeled `label` (an open editor's own row, not its group's). */
const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;
/** A group's row in the section, also while its editor (titled the same) is open. */
const groupRow = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;
const turnOn = () => userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
const turnOff = () => userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));

const tiles = { type: "tiles" as const, id: "s", tiles: ["https://tiles.example/{z}/{x}/{y}"] };
const points = {
  type: "points" as const,
  id: "s",
  data: "https://geoapi.example/collections/9/items?f=json",
};
/** Clusters are computed in the browser from the points themselves. */
const compile = (style: LayerStyle, geometry: Geometry, tone: "light" | "dark", clustered = false) =>
  compileLayer({
    id: "t",
    style,
    geometry,
    source: clustered ? points : tiles,
    tone,
    fields: { name: "string", use: "string" },
  });
const paints = (out: ReturnType<typeof compileLayer>, key: string) =>
  out.layers.flatMap((l) => {
    const paint = (l as { paint?: Record<string, unknown> }).paint;
    return paint && key in paint ? [paint[key]] : [];
  });
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;
/** The colors a paint value draws for a feature, as `#rrggbb`. */
const drawn = (value: unknown, props: Record<string, unknown> = {}) => {
  const c = evaluate(value, props) as { r: number; g: number; b: number; a: number } | string;
  if (typeof c === "string") return c;
  return `#${[c.r, c.g, c.b]
    .map((x) =>
      Math.round((x / (c.a || 1)) * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
};

describe("a new polygon layer", () => {
  it("reads its outline as Auto with its width", () => {
    render(defaultStyle("polygon"), "polygon");
    expect(within(groupRow("style_editor.part_outline")).getByText("style_editor.auto · 1 px")).toBeDefined();
  });
});

/** The fixture's two point labels are the candidates for the halo a point label starts with; the panel writes the one
 * whose halo is `POINT_LABEL_HALO`. */
const POINT_CANDIDATES = [
  "a label switched on beside a point",
  "the other candidate for a point label: a plain light halo",
];
const pointLabelRow = (): Row => {
  const found = POINT_CANDIDATES.map(row).find(
    (r) => getIn(r.style, "symbol.label.halo.color") === POINT_LABEL_HALO
  );
  if (!found) throw new Error(`no point label row with the halo ${POINT_LABEL_HALO}`);
  return found;
};

describe("a label switched on", () => {
  for (const name of ["a label switched on over a polygon", "a label switched on along a line", "point"]) {
    it(`starts with its starting text and halo: ${name}`, async () => {
      const { style, geometry } = name === "point" ? pointLabelRow() : row(name);
      const { store } = render(without(style, { "symbol.label": undefined }), geometry);
      await openGroup("style_editor.part_label");
      await turnOn();
      expect(store.document).toEqual(style);
    });
  }

  it("a label the style switches off starts the same way when nothing is remembered", async () => {
    const { style, geometry } = row("a label switched on over a polygon");
    const { store } = render(without(style, { "symbol.label": false }), geometry);
    await openGroup("style_editor.part_label");
    await turnOn();
    expect(store.document).toEqual(style);
  });

  it("off and on again brings back what the label had", async () => {
    const label = { text: "{name}", color: "#000000", size: 14 };
    const { store } = render(
      { version: "1.0.0", kind: "vector", symbol: { fill: { color: "#7f3c8d" }, label } } as LayerStyle,
      "polygon"
    );
    await openGroup("style_editor.part_label");
    await turnOff();
    expect(store.get("symbol.label")).toBe(false);
    await turnOn();
    expect(store.get("symbol.label")).toEqual(label);
  });

  it("the point label's starting halo is the one named place, and both candidates are documents", () => {
    expect(startingLabel("point")).toEqual({ color: "auto", halo: { color: POINT_LABEL_HALO } });
    expect(getIn(pointLabelRow().style, "symbol.label")).toEqual(startingLabel("point"));
    expect(POINT_CANDIDATES.map((name) => getIn(row(name).style, "symbol.label"))).toEqual([
      { color: "auto", halo: { color: "auto" } },
      { color: "auto", halo: { color: "#ffffff" } },
    ]);
  });

  it("over a classified fill draws each class's own text color", async () => {
    const { store } = render(
      {
        version: "1.0.0",
        kind: "vector",
        symbol: { fill: { color: "#cccccc" } },
        classify: [
          {
            id: "k",
            field: "use",
            method: "categories",
            classes: [
              { id: "a", values: ["park"], fill: { color: "#11a579" } },
              { id: "b", values: ["home"], fill: { color: "#e73f74" } },
            ],
          },
        ],
      } as LayerStyle,
      "polygon"
    );
    await openGroup("style_editor.part_label");
    await turnOn();
    expect(store.get("symbol.label")).toEqual({ color: "auto", halo: { color: "auto" } });
    act(() => store.set("symbol.label.text", "{name}"));
    const out = compile(store.document, "polygon", "light");
    expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
    const [text] = paints(out, "text-color");
    const colors = ["park", "home", "shop"].map((use) => drawn(text, { use }));
    expect(new Set(colors).size).toBe(3);
  });

  it("in a class it inherits the layer's label rather than overriding its colors", async () => {
    const { store } = render(
      {
        version: "1.0.0",
        kind: "vector",
        symbol: { fill: { color: "#cccccc" }, label: { text: "{name}", color: "#000000" } },
        classify: [
          {
            id: "k",
            field: "use",
            method: "categories",
            classes: [{ id: "a", values: ["park"], fill: { color: "#11a579" }, label: false }],
          },
        ],
      } as LayerStyle,
      "polygon"
    );
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_label");
    await turnOn();
    expect(store.get("classify.0.classes.0.label")).toEqual({});
  });

  /** A polygon layer classified by `use`, with `records` as its classes. */
  const classified = (records: object[]) =>
    ({
      version: "1.0.0",
      kind: "vector",
      symbol: { fill: { color: "#cccccc" } },
      classify: [{ id: "k", field: "use", method: "categories", classes: records }],
    }) as LayerStyle;

  it("for the layer it starts empty while a class draws a label of its own, which keeps its colors", async () => {
    const { store } = render(
      classified([
        { id: "a", values: ["park"], label: { text: "{name}" } },
        { id: "b", values: ["home"] },
      ]),
      "polygon"
    );
    await openGroup("style_editor.part_label");
    await turnOn();
    expect(store.get("symbol.label")).toEqual({});
    expect(store.get("classify.0.classes.0.label")).toEqual({ text: "{name}" });
  });

  it("in a class it starts with Auto text and halo while the layer has no label anywhere", async () => {
    const { store } = render(
      classified([
        { id: "a", values: ["park"], label: false },
        { id: "b", values: ["home"] },
      ]),
      "polygon"
    );
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_label");
    await turnOn();
    expect(store.get("classify.0.classes.0.label")).toEqual(startingLabel("polygon"));
    expect(store.get("symbol.label")).toBeUndefined();
  });
});

describe("an icon switched on", () => {
  it("starts with an Auto icon color", async () => {
    const { style } = row("a marker that gets an icon");
    const { store } = render(
      without(style, { "symbol.marker.icon": undefined, "symbol.marker.icon_color": undefined }),
      "point"
    );
    await openGroup("style_editor.part_icon");
    await turnOn();
    expect(store.document).toEqual(style);
  });

  it("a pin's first icon picked in the icon row starts the same way, in one undo step", async () => {
    const marker = { shape: "pin", color: "#f2b701" };
    const { store } = render({ version: "1.0.0", kind: "vector", symbol: { marker } } as LayerStyle, "point");
    await openGroup("style_editor.part_icon");
    await userEvent.click(within(rowOf("style_editor.icon")).getAllByRole("button")[0]);
    await userEvent.click(screen.getByRole("button", { name: "Park" }));
    expect(store.get("symbol.marker")).toEqual({ ...marker, icon: "goat:park", icon_color: "auto" });
    act(() => store.undo());
    expect(store.get("symbol.marker")).toEqual(marker);
  });

  it("off and on again brings back the icon and its color", async () => {
    const marker = { color: "#f2b701", icon: "goat:park", icon_color: "#000000" };
    const { store } = render({ version: "1.0.0", kind: "vector", symbol: { marker } } as LayerStyle, "point");
    await openGroup("style_editor.part_icon");
    await turnOff();
    await turnOn();
    expect(store.get("symbol.marker")).toEqual(marker);
  });
});

describe("clusters switched on", () => {
  it("number their clusters in Auto, circles and icons alike", async () => {
    for (const name of ["clusters switched on for circles", "clusters switched on for icons"]) {
      const { style } = row(name);
      const { store, unmount } = render(without(style, { render: undefined }), "point");
      await choose("style_editor.draw_as", "features", "cluster");
      expect(store.document).toEqual(style);
      unmount();
    }
  });

  /** A layer's compiled layers by id: their layout and paint. */
  const byId = (out: ReturnType<typeof compileLayer>) =>
    Object.fromEntries(
      out.layers.map((l) => {
        const { layout, paint } = l as { layout?: unknown; paint?: unknown };
        return [l.id, { layout, paint }];
      })
    );

  it("leave an outlined pin's unclustered markers as they were drawn", async () => {
    const before = {
      version: "1.0.0",
      kind: "vector",
      symbol: {
        marker: { shape: "pin", color: "#f2b701", size: 12 },
        outline: { color: "#000000", width: 2 },
      },
    } as LayerStyle;
    const { store } = render(before, "point");
    await choose("style_editor.draw_as", "features", "cluster");
    const marker = (style: LayerStyle) =>
      (
        compile(style, "point", "light", true).layers.find((l) => l.id === "t-marker") as {
          layout: Record<string, unknown>;
        }
      ).layout;
    expect(marker(before)["icon-image"]).toBe("goat-marker:pin|12||#f2b701|#000000|2|#ffffff");
    expect(marker(store.document)["icon-image"]).toBe(marker(before)["icon-image"]);
    expect(marker(store.document)["icon-size"]).toEqual(marker(before)["icon-size"]);
  });

  it("draw exactly as clusters without a symbol, but for the word on the number", () => {
    const bases = [
      { marker: { shape: "circle", color: "#f2b701", size: 10 } },
      { marker: { shape: "pin", color: "#f2b701", size: 12, icon: "goat:park" }, outline: { width: 2 } },
    ];
    for (const symbol of bases)
      for (const tone of ["light", "dark"] as const) {
        const doc = { version: "1.0.0", kind: "vector", symbol } as LayerStyle;
        const render = clusterRender(doc);
        const written = setIn(setIn(doc, "render", render), "render.symbol.label.color", "#ffffff");
        const { symbol: _symbol, ...bare } = render;
        const absent = setIn(doc, "render", bare);
        expect(byId(compile(written, "point", tone, true))).toEqual(
          byId(compile(absent, "point", tone, true))
        );
      }
  });
});

describe("the starting values draw a valid color on a light and on a dark basemap", () => {
  const withText = (style: LayerStyle): LayerStyle => {
    return getIn(style, "symbol.label") ? setIn(style, "symbol.label.text", "{name}") : style;
  };
  /** The colors a layer draws for a feature: its paint's text colors, and the icon color its marker image names. */
  function colorsOf(out: ReturnType<typeof compileLayer>, id: string, props: Record<string, unknown>) {
    const layer = out.layers.find((l) => l.id === `t-${id}`) as
      | { paint?: Record<string, unknown>; layout?: Record<string, unknown> }
      | undefined;
    if (!layer) throw new Error(`no layer t-${id} in ${out.layers.map((l) => l.id).join(", ")}`);
    const paint = layer.paint ?? {};
    const image = layer.layout?.["icon-image"];
    return {
      text: "text-color" in paint ? drawn(paint["text-color"], props) : undefined,
      halo: "text-halo-color" in paint ? drawn(paint["text-halo-color"], props) : undefined,
      icon: image === undefined ? undefined : String(evaluate(image, props)).split("|").at(-1),
      circle: "circle-color" in paint ? drawn(paint["circle-color"], props) : undefined,
    };
  }
  for (const r of ROWS)
    for (const tone of ["light", "dark"] as const)
      it(`${r.name}, ${tone}`, () => {
        const out = compile(withText(r.style), r.geometry, tone, Boolean(r.style.render));
        expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
        if (r.name.startsWith("clusters")) {
          // The number on the cluster or its badge: white on the clusters' green, as a number left unset draws it.
          const on =
            (r.style.render as { count?: string } | undefined)?.count === "badge"
              ? "cluster-badge"
              : "cluster-label";
          expect(colorsOf(out, on, { point_count: 12 }).text).toBe("#ffffff");
          if (on === "cluster-label") expect(colorsOf(out, "cluster-marker", {}).circle).toBe("#2bb381");
        } else if (r.name.startsWith("a marker")) {
          // Dark on the yellow marker, on both basemaps.
          expect(colorsOf(out, "marker", {}).icon).toBe("#3a3541");
        } else {
          const { text, halo } = colorsOf(out, "label", { name: "x" });
          expect(text).toMatch(HEX);
          expect(halo).toMatch(HEX);
          if (getIn(r.style, "symbol.label.halo.color") === "auto") {
            // The pair: white on the dark basemap's side, the contrast floor between them.
            expect(tone === "dark" ? text : halo).toBe("#ffffff");
            expect(contrastRatio(text!, halo!)).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
          } else {
            // Auto text beside a set halo is read on that halo (spec 18.10): dark on the light halo on both
            // basemaps, the contrast floor between them.
            expect(halo).toBe("#ffffff");
            expect(text).toBe(textAgainst("#3969ac", "#ffffff", tone));
            expect(text).toBe(labelPair("#3969ac", "light").text);
            expect(contrastRatio(text!, halo!)).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
          }
        }
      });
});

describe("what a document without the new values draws", () => {
  it("a label and an icon left unset keep their colors", () => {
    const out = compile(
      {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: { color: "#f2b701", icon: "goat:park" }, label: { text: "{name}" } },
      } as LayerStyle,
      "point",
      "dark"
    );
    expect(paints(out, "text-color")).toEqual(["#3a3541"]);
    expect(paints(out, "text-halo-color")).toEqual(["#ffffff"]);
    const image = (out.layers.find((l) => l.id === "t-marker") as { layout: Record<string, unknown> }).layout;
    expect(String(image["icon-image"]).split("|").at(-1)).toBe("#ffffff");
  });
});
