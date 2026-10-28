import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { maplibreErrors } from "./maplibre";

const compile = (
  style: object,
  geometry: CompileInput["geometry"] = "point",
  extra: Partial<CompileInput> = {}
) =>
  compileLayer({
    id: "9",
    style: style as LayerStyle,
    geometry,
    source: { type: "tiles", id: "s9", tiles: ["https://t/{z}/{x}/{y}"] },
    ...extra,
  });

const valid = (out: ReturnType<typeof compileLayer>) => maplibreErrors(out.layers, out.sources, out.state);
const layer = (out: ReturnType<typeof compileLayer>, suffix: string) =>
  out.layers.find((l) => l.id === `9-${suffix}`) as Record<string, unknown> | undefined;

const ACTIVE = [
  "any",
  ["boolean", ["feature-state", "active"], false],
  ["boolean", ["feature-state", "hover"], false],
];

describe("points", () => {
  it("an empty point style draws the default marker", () => {
    const out = compile({ version: 1, kind: "vector" });
    expect(out.layers).toEqual([
      {
        id: "9-marker",
        type: "circle",
        source: "s9",
        "source-layer": "default",
        paint: { "circle-color": "#2bb381", "circle-radius": 4 },
      },
    ]);
  });

  it("a circle marker with an outline, faded by the layer opacity", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      opacity: 0.5,
      symbol: {
        marker: { color: "#f28e2b", size: 8, opacity: 0.8 },
        outline: { color: "#ffffff", width: 1 },
      },
    });
    expect(layer(out, "marker")?.paint).toEqual({
      "circle-color": "#f28e2b",
      "circle-radius": 4,
      "circle-opacity": 0.4,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1,
      "circle-stroke-opacity": 0.5,
    });
    expect(valid(out)).toEqual([]);
  });

  it("an icon on a circle is one marker image: overlapping points stack as whole markers", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: { marker: { shape: "circle", color: "#f28e2b", size: 20, icon: "goat:park" } },
    });
    expect(out.layers.map((l) => l.id)).toEqual(["9-marker"]);
    expect(layer(out, "marker")?.type).toBe("symbol");
    expect(layer(out, "marker")?.layout).toEqual({
      "icon-image": "goat-marker:circle|20|goat:park|#f28e2b||0|#ffffff",
      "icon-size": 1,
      "icon-allow-overlap": true,
    });
    expect(layer(out, "marker")?.paint).toEqual({});
    expect(out.images).toEqual([
      { name: "goat:park", url: "/assets/icons/maki/park.svg", sdf: true, height: 24, pixelRatio: 4 },
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("a square with a stroke and no icon is a marker image too", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: {
        marker: { shape: "square", color: "#1a6b4d", size: 12, opacity: 0.8 },
        outline: { color: "#ffffff", width: 1.5 },
      },
    });
    expect(layer(out, "marker")?.layout).toMatchObject({
      "icon-image": "goat-marker:square|12||#1a6b4d|#ffffff|1.5|#ffffff",
      "icon-size": 1,
    });
    expect(layer(out, "marker")?.paint).toEqual({ "icon-opacity": 0.8 });
    expect(valid(out)).toEqual([]);
  });

  it("a hexagon without an icon is a marker image; a square sets no anchor", () => {
    const out = compile({ version: 1, kind: "vector", symbol: { marker: { shape: "hexagon", size: 16 } } });
    expect(layer(out, "marker")?.layout).toMatchObject({
      "icon-image": "goat-marker:hexagon|16||#2bb381||0|#ffffff",
    });
    expect(layer(out, "marker")?.layout).not.toHaveProperty("icon-anchor");
    expect(valid(out)).toEqual([]);
  });

  it("a pin stands on its place with its tip, its highlight ring around the head; a set anchor wins", () => {
    const out = compile(
      { version: 1, kind: "vector", symbol: { marker: { shape: "pin", size: 24, icon: "goat:park" } } },
      "point",
      { highlight: true }
    );
    expect(layer(out, "marker")?.layout).toMatchObject({
      "icon-image": "goat-marker:pin|24|goat:park|#2bb381||0|#ffffff",
      "icon-anchor": "bottom",
    });
    // The head's centre is 15 of the 24 box above the tip.
    expect(layer(out, "ring")?.paint).toMatchObject({ "circle-translate": [0, -15] });
    expect(valid(out)).toEqual([]);
    const centred = compile({
      version: 1,
      kind: "vector",
      symbol: { marker: { shape: "pin", size: 24, anchor: "center" } },
    });
    expect(layer(centred, "marker")?.layout).toMatchObject({ "icon-anchor": "center" });
  });

  it("classes draw their own shapes: each feature's image names its shape, pins stand on their tip", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { size: 24, icon: "goat:park" } },
        classify: [
          {
            field: "kind",
            method: "categories",
            classes: [
              { values: ["school"], marker: { shape: "shield" } },
              { values: ["stop"], marker: { shape: "pin" } },
            ],
          },
        ],
      },
      "point",
      { fields: { kind: "string" } }
    );
    const layout = layer(out, "marker")?.layout as Record<string, unknown>;
    expect(layout["icon-image"]).toEqual([
      "concat",
      "goat-marker:",
      ["match", ["get", "kind"], "school", "shield", "stop", "pin", "circle"],
      "|24|goat:park|#2bb381||0|#ffffff",
    ]);
    expect(layout["icon-anchor"]).toEqual([
      "match",
      ["get", "kind"],
      "school",
      "center",
      "stop",
      "bottom",
      "center",
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("a circle without an icon whose classes take shapes draws as images", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: { marker: { size: 12 } },
      classify: [
        { field: "kind", method: "categories", classes: [{ values: ["a"], marker: { shape: "hexagon" } }] },
      ],
    });
    expect(layer(out, "marker")?.type).toBe("symbol");
    expect(valid(out)).toEqual([]);
  });

  it("markers by class name each feature's icon and color; emoji come from the emoji folder", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { shape: "circle", color: "#1f78b4", size: 24, icon: "goat:park" } },
        classify: [
          {
            field: "kind",
            method: "categories",
            classes: [{ values: ["fire"], marker: { icon: "emoji:1f525", color: "#d62728" } }],
          },
        ],
      },
      "point",
      { fields: { kind: "string" } }
    );
    const image = (layer(out, "marker")?.layout as Record<string, unknown>)["icon-image"];
    expect(image).toEqual([
      "concat",
      "goat-marker:circle|24|",
      ["match", ["get", "kind"], "fire", "emoji:1f525", "goat:park"],
      "|",
      ["match", ["get", "kind"], "fire", "#d62728", "#1f78b4"],
      "||0|#ffffff",
    ]);
    expect(out.images.map((i) => [i.name, i.url, i.sdf])).toEqual([
      ["goat:park", "/assets/icons/maki/park.svg", true],
      ["emoji:1f525", "/assets/icons/emoji/1f525.webp", false],
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("a stroke width by zoom steps through marker images; a size by zoom scales the largest", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          marker: {
            shape: "circle",
            icon: "goat:park",
            size: {
              zoom: [
                [10, 10],
                [16, 30],
              ],
            },
          },
          outline: {
            color: "#000000",
            width: {
              zoom: [
                [10, 1],
                [16, 3],
              ],
            },
          },
        },
      },
      "point",
      { fields: { pupils: "integer" } }
    );
    const layout = layer(out, "marker")?.layout as Record<string, unknown>;
    // A step at every whole zoom between the width's stops.
    const name = (w: string) => `goat-marker:circle|30|goat:park|#2bb381|#000000|${w}|#ffffff`;
    expect(layout["icon-image"]).toEqual([
      "step",
      ["zoom"],
      name("1"),
      ...[11, 12, 13, 14, 15, 16].flatMap((z) => [
        z,
        name(String(Math.round((1 + (z - 10) / 3) * 100) / 100)),
      ]),
    ]);
    expect(layout["icon-size"]).toEqual(["interpolate", ["linear"], ["zoom"], 10, 0.3333333333, 16, 1]);
    expect(valid(out)).toEqual([]);
  });

  it("markers with a shape draw where they collide unless overlap is turned off", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: { marker: { shape: "circle", icon: "goat:park", allow_overlap: false } },
    });
    expect(layer(out, "marker")?.layout).not.toHaveProperty("icon-allow-overlap");
  });

  it("the active marker gets a ring under it, by feature state", () => {
    const out = compile(
      { version: 1, kind: "vector", symbol: { marker: { shape: "square", size: 16 } } },
      "point",
      { highlight: true }
    );
    expect(out.layers.map((l) => l.id)).toEqual(["9-ring", "9-marker"]);
    expect(layer(out, "ring")?.paint).toEqual({
      "circle-radius": 8,
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#ffc300",
      "circle-stroke-width": ["case", ACTIVE, 3, 0],
    });
    expect(valid(out)).toEqual([]);
  });

  it("an emoji alone keeps its colors, in the layer of icons with their own colors", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: { marker: { shape: "icon", icon: "emoji:1f525", size: 24 } },
    });
    expect(out.layers.map((l) => l.id)).toEqual(["9-icon-asset"]);
    expect(layer(out, "icon-asset")?.layout).toMatchObject({ "icon-image": "emoji:1f525" });
    expect(valid(out)).toEqual([]);
  });

  it("an icon alone: tinted with the color, rotated with the map, anchored and offset", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: {
        marker: {
          shape: "icon",
          icon: "goat:arrow-up-solid",
          color: "#333333",
          size: 24,
          rotation: { field: "heading" },
          anchor: "bottom",
          offset: [0, -2],
        },
        outline: { color: "#ffffff", width: 2 },
      },
    });
    expect(out.layers.map((l) => l.id)).toEqual(["9-icon"]);
    expect(layer(out, "icon")?.layout).toEqual({
      "icon-image": "goat:arrow-up-solid",
      "icon-size": 1,
      "icon-rotate": ["to-number", ["get", "heading"], 0],
      "icon-rotation-alignment": "map",
      "icon-anchor": "bottom",
      "icon-offset": ["literal", [0, -2]],
    });
    expect(layer(out, "icon")?.paint).toEqual({
      "icon-color": "#333333",
      "icon-halo-color": "#ffffff",
      "icon-halo-width": 2,
    });
  });

  it("library and uploaded icons by class go into two layers with the images listed", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { shape: "icon", icon: "goat:school", size: 24 } },
        classify: [
          {
            field: "kind",
            method: "categories",
            classes: [{ values: ["kindergarten"], marker: { icon: "asset:42" } }],
          },
        ],
      },
      "point",
      {
        fields: { kind: "string" },
        resolveIcon: (ref) => (ref === "asset:42" ? { url: "https://api/asset/42", sdf: false } : null),
      }
    );
    expect(out.layers.map((l) => l.id)).toEqual(["9-icon", "9-icon-asset"]);
    const kind = ["match", ["get", "kind"], "kindergarten", "asset", "library"];
    expect(layer(out, "icon")?.filter).toEqual(["==", kind, "library"]);
    expect(layer(out, "icon-asset")?.filter).toEqual(["==", kind, "asset"]);
    expect(layer(out, "icon-asset")?.paint).toEqual({});
    expect(out.images.map((i) => [i.name, i.sdf])).toEqual([
      ["goat:school", true],
      ["asset:42", false],
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("uploads only in classes still list the default icon the other features draw, in the library layer", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { shape: "icon", color: "#1f78b4" } },
        classify: [
          {
            field: "kind",
            method: "categories",
            target: "marker.icon",
            classes: [{ values: ["fast"], marker: { icon: "asset:42" } }],
          },
        ],
      },
      "point",
      {
        fields: { kind: "string" },
        resolveIcon: (ref) => (ref === "asset:42" ? { url: "https://api/asset/42", sdf: false } : null),
      }
    );
    expect(out.images.map((i) => i.name).sort()).toEqual(["asset:42", "goat:marker"]);
    expect(out.layers.map((l) => l.id)).toEqual(["9-icon", "9-icon-asset"]);
    expect(layer(out, "icon")?.filter).toEqual([
      "==",
      ["match", ["get", "kind"], "fast", "asset", "library"],
      "library",
    ]);
    expect(layer(out, "icon")?.paint).toEqual({ "icon-color": "#1f78b4" });
    expect(valid(out)).toEqual([]);
  });
});

describe("point outlines and offsets", () => {
  it("an outline only a rule sets draws only where the rule holds", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: { marker: {} },
      rules: [{ when: { op: "=", args: [{ property: "big" }, true] }, outline: { width: 2.5 } }],
    });
    expect(layer(out, "marker")?.paint).toMatchObject({
      "circle-stroke-opacity": ["case", ["==", ["get", "big"], true], 1, 0],
    });
    expect(valid(out)).toEqual([]);
  });

  it("an icon's halo shows only where its outline is on", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: { marker: { shape: "icon", icon: "goat:park" } },
      rules: [{ when: { op: "=", args: [{ property: "big" }, true] }, outline: { width: 2 } }],
    });
    expect(layer(out, "icon")?.paint).toMatchObject({
      "icon-halo-width": [
        "case",
        [">", ["case", ["==", ["get", "big"], true], 1, 0], 0],
        ["case", ["==", ["get", "big"], true], 2, 1],
        0,
      ],
    });
    expect(valid(out)).toEqual([]);
  });

  it("an outline in the fill color takes the marker color", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: { marker: { color: "#f28e2b" }, outline: { color: "fill", width: 2 } },
    });
    expect(layer(out, "marker")?.paint).toMatchObject({ "circle-stroke-color": "#f28e2b" });
    expect(valid(out)).toEqual([]);
  });

  it("an icon halo in the fill color takes the icon color", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: {
        marker: { shape: "icon", icon: "goat:park", color: "#333333" },
        outline: { color: "fill", width: 1 },
      },
    });
    expect(layer(out, "icon")?.paint).toMatchObject({ "icon-halo-color": "#333333" });
    expect(valid(out)).toEqual([]);
  });

  it("circles move by the base offset only: circle-translate cannot vary per feature", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { offset: [0, -4] } },
        classify: [
          { field: "t", method: "categories", classes: [{ values: ["a"], marker: { offset: [0, 10] } }] },
        ],
      },
      "point",
      { fields: { t: "string" } }
    );
    expect(layer(out, "marker")?.paint).toMatchObject({ "circle-translate": ["literal", [0, -4]] });
    expect(valid(out)).toEqual([]);
  });
});

describe("order, time and highlight", () => {
  it("orders circles and symbols by a field", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      order: { field: "visitors", top: "largest" },
      symbol: { marker: {} },
    });
    expect((layer(out, "marker")?.layout as Record<string, unknown>)["circle-sort-key"]).toEqual([
      "to-number",
      ["get", "visitors"],
      0,
    ]);
    // Icons alone collide: the top feature wins the place.
    const icons = compile({
      version: 1,
      kind: "vector",
      order: { field: "visitors", top: "largest" },
      symbol: { marker: { shape: "icon", icon: "goat:park" } },
    });
    expect((layer(icons, "icon")?.layout as Record<string, unknown>)["symbol-sort-key"]).toEqual([
      "-",
      ["to-number", ["get", "visitors"], 0],
    ]);
    // Markers with a shape overlap: the top feature draws on top.
    const markers = compile({
      version: 1,
      kind: "vector",
      order: { field: "visitors", top: "largest" },
      symbol: { marker: { icon: "goat:park" } },
    });
    expect((layer(markers, "marker")?.layout as Record<string, unknown>)["symbol-sort-key"]).toEqual([
      "to-number",
      ["get", "visitors"],
      0,
    ]);
  });

  it("orders by the classes of the first classification, the first class on top", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        order: { by: "classes" },
        symbol: { fill: {} },
        classify: [{ field: "t", method: "categories", classes: [{ values: ["a"] }, { values: ["b"] }] }],
      },
      "polygon",
      { fields: { t: "string" } }
    );
    expect((layer(out, "fill")?.layout as Record<string, unknown>)["fill-sort-key"]).toEqual([
      "match",
      ["get", "t"],
      "a",
      2,
      "b",
      1,
      0,
    ]);
  });

  it("filters by the time slider", () => {
    const out = compile({ version: 1, kind: "vector", time: { field: "year", step: 1 } }, "point", {
      fields: { year: "integer" },
      entry: { time: { value: 2024 } },
    });
    const unset = ["==", ["global-state", "9:time"], null];
    expect(layer(out, "marker")?.filter).toEqual([
      "any",
      unset,
      ["==", ["get", "year"], ["global-state", "9:time"]],
    ]);
    expect(out.state).toEqual({ "9:time": { default: 2024 } });
    const dated = compile({ version: 1, kind: "vector", time: { field: "day", step: "month" } }, "point", {
      fields: { day: "date" },
    });
    expect(layer(dated, "marker")?.filter).toEqual([
      "any",
      unset,
      ["==", ["slice", ["to-string", ["get", "day"]], 0, 7], ["global-state", "9:time"]],
    ]);
    expect(valid(out)).toEqual([]);
    expect(valid(dated)).toEqual([]);
  });

  it("without a slider value every time shows (a thumbnail has no slider to choose one)", () => {
    const out = compile({ version: 1, kind: "vector", time: { field: "year", step: 1 } }, "point", {
      fields: { year: "integer" },
    });
    expect(out.state).toEqual({ "9:time": { default: null } });
    expect(layer(out, "marker")?.filter).toEqual([
      "any",
      ["==", ["global-state", "9:time"], null],
      ["==", ["get", "year"], ["global-state", "9:time"]],
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("highlights the active feature in each part's paint, zoom staying at the top level", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          line: {
            width: {
              zoom: [
                [10, 2],
                [16, 6],
              ],
            },
          },
        },
      },
      "line",
      { highlight: true }
    );
    const paint = layer(out, "line")?.paint as Record<string, unknown>;
    expect(paint["line-color"]).toEqual(["case", ACTIVE, "#ffc300", "#2166ac"]);
    expect(paint["line-width"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      ["case", ACTIVE, 3, 2],
      16,
      ["case", ACTIVE, 6, 6],
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("a polygon without an outline gets one that shows only when highlighted", () => {
    const out = compile({ version: 1, kind: "vector", symbol: { fill: {}, outline: false } }, "polygon", {
      highlight: true,
    });
    expect(layer(out, "outline")?.paint).toEqual({
      "line-color": "#ffc300",
      "line-width": 3,
      "line-opacity": ["case", ACTIVE, 1, 0],
    });
    expect(valid(out)).toEqual([]);
  });
});

describe("hollow markers (marker.fill: false)", () => {
  it("a hollow circle draws its outline only: no fill opacity, the stroke stays", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: {
        marker: { color: "#1a6b4d", size: 10, opacity: 0.8, fill: false },
        outline: { color: "fill", width: 2 },
      },
    });
    expect(layer(out, "marker")?.paint).toEqual({
      "circle-color": "#1a6b4d",
      "circle-radius": 5,
      "circle-opacity": 0,
      "circle-stroke-color": "#1a6b4d",
      "circle-stroke-width": 2,
    });
    expect(valid(out)).toEqual([]);
  });

  it("a class draws hollow circles while the others stay filled", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { color: "#1a6b4d", opacity: 0.8 }, outline: {} },
        classify: [
          { field: "kind", method: "categories", classes: [{ values: ["a"], marker: { fill: false } }] },
        ],
      },
      "point",
      { fields: { kind: "string" } }
    );
    const opacity = (layer(out, "marker")?.paint as Record<string, unknown>)["circle-opacity"];
    expect(JSON.stringify(opacity)).toContain('["match",["get","kind"],"a",false,true]');
    expect(valid(out)).toEqual([]);
  });

  it("a hollow shape leaves its fill out of the image name and is not faded by the fill opacity", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: {
        marker: { shape: "diamond", color: "#1a6b4d", size: 12, opacity: 0.5, fill: false },
        outline: { color: "fill", width: 1.5 },
      },
    });
    expect(layer(out, "marker")?.layout).toMatchObject({
      "icon-image": "goat-marker:diamond|12|||#1a6b4d|1.5|#1a6b4d",
    });
    // The marker opacity is the fill's: a hollow marker's outline and icon are not faded by it.
    expect(layer(out, "marker")?.paint).toEqual({});
    expect(valid(out)).toEqual([]);
  });

  it("the icon on a hollow pin takes the marker color unless the icon color is set; the highlight ring stays", () => {
    const pin = (marker: object) =>
      compile(
        {
          version: 1,
          kind: "vector",
          symbol: {
            marker: { shape: "pin", color: "#f28e2b", size: 24, icon: "goat:park", fill: false, ...marker },
            outline: { color: "fill", width: 2 },
          },
        },
        "point",
        { highlight: true }
      );
    const out = pin({});
    expect(layer(out, "marker")?.layout).toMatchObject({
      "icon-image": "goat-marker:pin|24|goat:park||#f28e2b|2|#f28e2b",
    });
    expect(layer(out, "ring")?.type).toBe("circle");
    expect(valid(out)).toEqual([]);
    expect(layer(pin({ icon_color: "#3a3541" }), "marker")?.layout).toMatchObject({
      "icon-image": "goat-marker:pin|24|goat:park||#f28e2b|2|#3a3541",
    });
  });

  it("a filled marker's image name is as before", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      symbol: { marker: { shape: "square", color: "#1a6b4d", size: 12, fill: true } },
    });
    expect(layer(out, "marker")?.layout).toMatchObject({
      "icon-image": "goat-marker:square|12||#1a6b4d||0|#ffffff",
    });
  });

  it("the icon alone ignores the fill switch", () => {
    const style = (fill: boolean) => ({
      version: 1,
      kind: "vector",
      symbol: { marker: { shape: "icon", icon: "goat:park", color: "#f28e2b", fill } },
    });
    expect(compile(style(false)).layers).toEqual(compile(style(true)).layers);
  });
});
