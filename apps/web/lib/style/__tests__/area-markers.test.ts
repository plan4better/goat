// Markers on polygons and lines (spec 3.3): one marker image per look at each polygon's label anchor or each line's
// center point, above the area or line and below the label, which moves beside it.
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import { isMarkerImage, parseMarkerImage } from "@/lib/style/compile/markerImage";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { tileUrl } from "@/lib/style/render/apply";

import { maplibreErrors } from "./maplibre";

const TILES: CompileInput["source"] = { type: "tiles", id: "s9", tiles: ["https://t/{z}/{x}/{y}"] };
const GEOJSON: CompileInput["source"] = {
  type: "points",
  id: "s9",
  data: { type: "FeatureCollection", features: [] },
};

const compile = (style: object, geometry: CompileInput["geometry"], extra: Partial<CompileInput> = {}) =>
  compileLayer({
    id: "9",
    style: { version: "1.0.0", kind: "vector", ...style } as LayerStyle,
    geometry,
    source: TILES,
    ...extra,
  });

type Out = ReturnType<typeof compileLayer>;
const valid = (out: Out) => maplibreErrors(out.layers, out.sources, out.state);
const layer = (out: Out, suffix: string) =>
  out.layers.find((l) => l.id === `9-${suffix}`) as Record<string, unknown> | undefined;
const layout = (out: Out, suffix: string) => (layer(out, suffix)?.layout ?? {}) as Record<string, unknown>;
const ids = (out: Out) => out.layers.map((l) => l.id.slice(2));

/** Every marker image name a property can end in. */
function imageNames(node: unknown, found: string[] = []): string[] {
  if (typeof node === "string" && isMarkerImage(node)) found.push(node);
  else if (Array.isArray(node)) node.forEach((item) => imageNames(item, found));
  return found;
}

const DISTRICTS = {
  symbol: {
    fill: { color: "#f0f0f0" },
    outline: { color: "#bdbdbd", width: 1 },
    marker: { color: "#08519c", size: 12 },
    label: { text: "{name}" },
  },
};

describe("markers on polygons", () => {
  it("are off unless a record sets them", () => {
    const out = compile({ symbol: { fill: { color: "#f0f0f0" } } }, "polygon");
    expect(ids(out)).toEqual(["fill"]);
    expect(out.tileParams.label).toBeUndefined();
  });

  it("draw a marker image at each polygon's label anchor, above the area and below the label", () => {
    const out = compile(DISTRICTS, "polygon", { highlight: true });
    expect(ids(out)).toEqual(["fill", "outline", "marker", "label"]);
    const marker = layer(out, "marker")!;
    expect(marker.type).toBe("symbol");
    expect(marker["source-layer"]).toBe("default_anchor");
    expect(out.tileParams.label).toBe(true);
    // A plain circle too is an image, without a stroke: the outline is the polygon's border.
    const [name] = imageNames(layout(out, "marker")["icon-image"]);
    expect(parseMarkerImage(name)).toMatchObject({
      shape: "circle",
      fill: "#08519c",
      stroke: "",
      strokeWidth: 0,
    });
    // The polygon highlights; the marker gets no ring of its own.
    expect(layer(out, "ring")).toBeUndefined();
    expect(valid(out)).toEqual([]);
  });

  it("the label moves beside the marker, as around a point marker", () => {
    const out = compile(DISTRICTS, "polygon");
    const label = layout(out, "label");
    // Half the marker's 12 px and 2 px, in ems of the 12 px label.
    const d = expect.closeTo(8 / 12, 6);
    expect(label["text-variable-anchor-offset"]).toEqual([
      "top",
      [0, d],
      "bottom",
      [0, expect.closeTo(-8 / 12, 6)],
      "right",
      [expect.closeTo(-8 / 12, 6), 0],
      "left",
      [d, 0],
    ]);
    expect(label["text-justify"]).toBe("auto");
    // Without a marker it stays on the anchor.
    const plain = compile({ symbol: { ...DISTRICTS.symbol, marker: undefined } }, "polygon");
    expect(layout(plain, "label")["text-variable-anchor-offset"]).toBeUndefined();
  });

  it("an icon, a size by field, rotation and anchor work as on points", () => {
    const out = compile(
      {
        symbol: {
          fill: { color: "#f0f0f0" },
          marker: {
            shape: "pin",
            icon: "goat:school",
            size: { field: "population", domain: [0, 30000], range: [10, 40] },
            rotation: 15,
          },
        },
      },
      "polygon"
    );
    const marker = layout(out, "marker");
    expect(imageNames(marker["icon-image"]).map((n) => parseMarkerImage(n)?.icon)).toEqual(["goat:school"]);
    expect(JSON.stringify(marker["icon-size"])).toContain("population");
    expect(marker["icon-rotate"]).toBe(15);
    expect(marker["icon-anchor"]).toBe("bottom");
    expect(out.images.map((i) => i.name)).toContain("goat:school");
    expect(valid(out)).toEqual([]);
  });

  it("the icon alone draws as on points", () => {
    const out = compile(
      { symbol: { fill: { color: "#f0f0f0" }, marker: { shape: "icon", icon: "goat:park", size: 20 } } },
      "polygon"
    );
    expect(layer(out, "icon")?.["source-layer"]).toBe("default_anchor");
    expect(layout(out, "icon")["icon-image"]).toBe("goat:park");
    expect(valid(out)).toEqual([]);
  });

  it("a class switches the marker on for its features alone", () => {
    const out = compile(
      {
        symbol: { fill: { color: "#deebf7" } },
        classify: [
          {
            field: "land_use",
            method: "categories",
            classes: [{ values: ["green"], marker: { shape: "circle", icon: "goat:park", size: 20 } }],
          },
        ],
      },
      "polygon",
      { fields: { land_use: "string" } }
    );
    const marker = layer(out, "marker")!;
    expect(marker["source-layer"]).toBe("default_anchor");
    expect(JSON.stringify(marker.filter)).toContain("green");
    expect(valid(out)).toEqual([]);
  });

  it("on raised polygons the marker sits on the roof", () => {
    const out = compile(
      { symbol: { fill: { color: "#f0f0f0" }, extrude: { height: 30 }, marker: { size: 10 } } },
      "polygon"
    );
    expect(layout(out, "marker")["symbol-height-offset"]).toBe(30);
  });

  it("on a GeoJSON source MapLibre places it inside the polygon itself", () => {
    const out = compile(DISTRICTS, "polygon", { source: GEOJSON });
    const marker = layer(out, "marker")!;
    expect(marker["source-layer"]).toBeUndefined();
    expect(marker.type).toBe("symbol");
    expect(layout(out, "marker")["symbol-placement"]).toBeUndefined();
    expect(valid(out)).toEqual([]);
  });
});

const ROUTES = { symbol: { line: { color: "#2166ac", width: 3 }, marker: { icon: "goat:bus", size: 18 } } };

describe("markers on lines", () => {
  it("draw at each line's center point", () => {
    const out = compile(ROUTES, "line");
    expect(ids(out)).toEqual(["line", "marker"]);
    expect(layer(out, "marker")?.["source-layer"]).toBe("default_decoration");
    expect(layer(out, "marker")?.filter).toBeUndefined();
    expect(out.tileParams.decorations).toEqual(["center"]);
    expect(valid(out)).toEqual([]);
  });

  it("with arrows at the ends, each layer keeps to its own kind of point", () => {
    const out = compile(
      {
        symbol: {
          ...ROUTES.symbol,
          arrows: { placement: "both_ends" },
          label: { text: "{name}", placement: "auto" },
        },
      },
      "line"
    );
    expect(out.tileParams.decorations).toEqual(["start", "end", "center"]);
    const kind = (suffix: string) => layer(out, suffix)?.filter;
    expect(kind("marker")).toEqual(["match", ["get", "_decoration"], ["center"], true, false]);
    expect(kind("label")).toEqual(["match", ["get", "_decoration"], ["center"], true, false]);
    expect(kind("arrows")).toEqual(["match", ["get", "_decoration"], ["start", "end"], true, false]);
    expect(tileUrl("https://t/{z}/{x}/{y}", out.tileParams)).toBe(
      "https://t/{z}/{x}/{y}?decoration=start,end,center"
    );
    // The automatic label at the center moves beside the marker: half the marker's 18 px and 2 px, in ems of the
    // 12 px label.
    const d = 11 / 12;
    expect(layout(out, "label")["text-variable-anchor-offset"]).toEqual([
      "top",
      [0, expect.closeTo(d, 6)],
      "bottom",
      [0, expect.closeTo(-d, 6)],
      "right",
      [expect.closeTo(-d, 6), 0],
      "left",
      [expect.closeTo(d, 6), 0],
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("on a GeoJSON line the automatic label stays at the line's middle, where MapLibre places it", () => {
    const out = compile(
      { symbol: { ...ROUTES.symbol, label: { text: "{name}", placement: "auto" } } },
      "line",
      { source: GEOJSON }
    );
    const label = layout(out, "label");
    expect(label["symbol-placement"]).toBe("line-center");
    // text-variable-anchor-offset needs a point placement (MapLibre's style spec); text-justify follows it.
    expect(label["text-variable-anchor-offset"]).toBeUndefined();
    expect(label["text-justify"]).toBeUndefined();
    expect(valid(out)).toEqual([]);
  });

  it("arrows alone keep their tile parameter and draw every point", () => {
    const out = compile({ symbol: { line: {}, arrows: { placement: "both_ends" } } }, "line");
    expect(tileUrl("https://t/{z}/{x}/{y}", out.tileParams)).toBe(
      "https://t/{z}/{x}/{y}?decoration=start,end"
    );
    expect(layer(out, "arrows")?.filter).toBeUndefined();
  });

  it("on a GeoJSON source the marker sits at the middle of the line", () => {
    const out = compile(ROUTES, "line", { source: GEOJSON });
    expect(layout(out, "marker")["symbol-placement"]).toBe("line-center");
    expect(layout(out, "marker")["icon-rotation-alignment"]).toBe("viewport");
    expect(valid(out)).toEqual([]);
  });
});

/** The label's layout at `placement`, with the marker or without. */
const placedLabel = (
  base: { symbol: Record<string, unknown> },
  geometry: CompileInput["geometry"],
  placement: string,
  extra: Partial<CompileInput> = {}
) => {
  const out = compile({ symbol: { ...base.symbol, label: { text: "{name}", placement } } }, geometry, extra);
  expect(valid(out)).toEqual([]);
  return { out, label: layout(out, "label") };
};

describe("label positions around the marker of an area or a line's center (spec 3.4)", () => {
  // Half the marker's 12 px (polygons) or 18 px (lines) and 2 px, in ems of the 12 px label.
  const AREA = 8 / 12;
  const LINE = 11 / 12;
  const NO_MARKER = 2 / 12;
  const plainArea = { symbol: { ...DISTRICTS.symbol, marker: undefined } };
  const plainLine = { symbol: { ...ROUTES.symbol, marker: undefined } };

  it("an area's label at a side of the marker sits there, clear of it, never moved to another side", () => {
    const { label } = placedLabel(DISTRICTS, "polygon", "above");
    expect(label["text-anchor"]).toBe("bottom");
    expect(label["text-offset"]).toEqual([0, expect.closeTo(-AREA, 6)]);
    expect(label["text-variable-anchor-offset"]).toBeUndefined();
    const right = placedLabel(DISTRICTS, "polygon", "below_right").label;
    expect(right["text-anchor"]).toBe("top-left");
    expect(right["text-offset"]).toEqual([expect.closeTo(AREA, 6), expect.closeTo(AREA, 6)]);
    expect(right["text-justify"]).toBe("auto");
  });

  it("in the middle the area's label sits on the marker", () => {
    const { label } = placedLabel(DISTRICTS, "polygon", "inside");
    expect(label["text-anchor"]).toBeUndefined();
    expect(label["text-offset"]).toBeUndefined();
    expect(label["text-variable-anchor-offset"]).toBeUndefined();
  });

  it("without a marker a side keeps 2 px from the label point; automatic and the middle sit on it", () => {
    const { label } = placedLabel(plainArea, "polygon", "left");
    expect(label["text-anchor"]).toBe("right");
    expect(label["text-offset"]).toEqual([expect.closeTo(-NO_MARKER, 6), 0]);
    for (const placement of ["auto", "inside"]) {
      const middle = placedLabel(plainArea, "polygon", placement).label;
      expect(middle["text-anchor"], placement).toBeUndefined();
      expect(middle["text-offset"], placement).toBeUndefined();
      expect(middle["text-variable-anchor-offset"], placement).toBeUndefined();
    }
  });

  it("a line's label at a side of its center marker sits there, at the center points", () => {
    const { out, label } = placedLabel(ROUTES, "line", "right");
    expect(layer(out, "label")?.["source-layer"]).toBe("default_decoration");
    expect(out.tileParams.decorations).toEqual(["center"]);
    expect(label["symbol-placement"]).toBeUndefined();
    expect(label["text-anchor"]).toBe("left");
    expect(label["text-offset"]).toEqual([expect.closeTo(LINE, 6), 0]);
    const plain = placedLabel(plainLine, "line", "below").label;
    expect(plain["text-anchor"]).toBe("top");
    expect(plain["text-offset"]).toEqual([0, expect.closeTo(NO_MARKER, 6)]);
  });

  it("in the middle the line's label sits on its center marker", () => {
    const { out, label } = placedLabel(ROUTES, "line", "center");
    expect(layer(out, "label")?.["source-layer"]).toBe("default_decoration");
    expect(label["text-anchor"]).toBeUndefined();
    expect(label["text-offset"]).toBeUndefined();
    expect(label["text-variable-anchor-offset"]).toBeUndefined();
  });

  it("on a GeoJSON line a side moves the label from the line's middle, upright beside the marker", () => {
    const { label } = placedLabel(ROUTES, "line", "above", { source: GEOJSON });
    expect(label["symbol-placement"]).toBe("line-center");
    expect(label["text-rotation-alignment"]).toBe("viewport");
    expect(label["text-anchor"]).toBe("bottom");
    expect(label["text-offset"]).toEqual([0, expect.closeTo(-LINE, 6)]);
  });
});

describe("markers switched off per feature", () => {
  it("a rule that switches the marker off leaves its features out of the marker layer", () => {
    const out = compile(
      {
        symbol: { fill: {}, marker: { size: 10 } },
        rules: [{ when: { op: "=", args: [{ property: "n" }, 1] }, marker: false }],
      },
      "polygon",
      { fields: { n: "number" } }
    );
    expect(JSON.stringify(layer(out, "marker")?.filter)).toContain('"n"');
    expect(valid(out)).toEqual([]);
  });
});
