import distance from "@turf/distance";
import { describe, expect, it } from "vitest";

import { type AreaPiece, type FilterArea, type PolygonCoords, viewPolygon } from "@/lib/filter/area";

import {
  areaSummary,
  circlePiece,
  drawnOutline,
  editable,
  viewStale,
  withFeature,
  withPiece,
  withReplaced,
  withoutFeature,
  withoutPiece,
} from "@/components/map/panels/filter/area/pieces";

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key;

const square = (x: number): PolygonCoords => [
  [
    [x, 0],
    [x + 1, 0],
    [x + 1, 1],
    [x, 0],
  ],
];
const VIEW: AreaPiece = { kind: "view", polygons: [viewPolygon([7, 50, 8, 51])] };
const POLYGON: AreaPiece = { kind: "shape", shape: "polygon", polygons: [square(0)] };
const CIRCLE: AreaPiece = { kind: "shape", shape: "circle", polygons: [square(2)] };
const area = (pieces: AreaPiece[], op: FilterArea["op"] = "inside"): FilterArea => ({
  pieces,
  op,
  enabled: true,
});
const regions = (...names: string[]): AreaPiece => ({
  kind: "features",
  source: "region",
  features: names.map((name, i) => ({ id: `DE${i}`, name, n: 1 })),
  polygons: names.map((_, i) => square(10 + i)),
});

describe("the area's summary", () => {
  it("names a single piece", () => {
    expect(areaSummary(area([VIEW]), t)).toBe("filter_panel.area_view");
    expect(areaSummary(area([POLYGON]), t)).toBe("filter_panel.area_shape_polygon");
    expect(areaSummary(area([CIRCLE]), t)).toBe("filter_panel.area_shape_circle");
    expect(areaSummary(area([{ kind: "shape", polygons: [square(0)] }]), t)).toBe("filter_panel.area_shape");
    expect(areaSummary(area([{ kind: "shape", label: "Old town", polygons: [square(0)] }]), t)).toBe(
      "Old town"
    );
    expect(areaSummary(area([regions("Bayern")]), t)).toBe("Bayern");
  });

  it("counts shapes and features, the shapes together where the first one is", () => {
    expect(areaSummary(area([POLYGON, VIEW, CIRCLE, regions("Bayern", "Hessen", "Bremen")]), t)).toBe(
      'filter_panel.area_shapes{"count":2}, filter_panel.area_view, filter_panel.area_regions{"count":3}'
    );
    const layer = { ...regions("a", "b"), source: "layer-1" } as AreaPiece;
    expect(areaSummary(area([layer]), t)).toBe('filter_panel.area_features{"count":2}');
  });

  it("says outside", () => {
    expect(areaSummary(area([VIEW], "outside"), t)).toBe(
      'filter_panel.area_outside_of{"area":"filter_panel.area_view","interpolation":{"escapeValue":false}}'
    );
  });

  describe("names the layer the features are of", () => {
    const LAYERS = new Map([
      ["layer-1", "Districts"],
      ["layer-2", "Parks"],
    ]);
    const features = (source: string, ...names: Array<string | undefined>): AreaPiece => ({
      kind: "features",
      source,
      features: names.map((name, i) => ({ id: `${source}-${i}`, ...(name && { name }), n: 1 })),
      polygons: names.map((_, i) => square(20 + i)),
    });
    const OF_DISTRICTS =
      'filter_panel.area_features_of{"count":81,"layer":"Districts","interpolation":{"escapeValue":false}}';
    const many = (source: string) => features(source, ...Array.from({ length: 81 }, () => undefined));

    it("inside and outside", () => {
      expect(areaSummary(area([many("layer-1")]), t, LAYERS)).toBe(OF_DISTRICTS);
      expect(areaSummary(area([many("layer-1")], "outside"), t, LAYERS)).toBe(
        `filter_panel.area_outside_of{"area":${JSON.stringify(OF_DISTRICTS)},"interpolation":{"escapeValue":false}}`
      );
    });

    it("beside regions and shapes, which are no layer", () => {
      expect(areaSummary(area([regions("Bayern"), many("layer-1"), VIEW]), t, LAYERS)).toBe(
        `Bayern, ${OF_DISTRICTS}, filter_panel.area_view`
      );
    });

    it("not for a layer the project does not have, one without a name, or without names", () => {
      expect(areaSummary(area([many("layer-9")]), t, LAYERS)).toBe('filter_panel.area_features{"count":81}');
      expect(areaSummary(area([many("layer-1")]), t, new Map([["layer-1", ""]]))).toBe(
        'filter_panel.area_features{"count":81}'
      );
      expect(areaSummary(area([many("layer-1")]), t)).toBe('filter_panel.area_features{"count":81}');
    });

    it("not for features of several layers", () => {
      expect(areaSummary(area([features("layer-1", "A", "B"), features("layer-2", "C")]), t, LAYERS)).toBe(
        'filter_panel.area_features{"count":2}, C'
      );
    });

    it("not for one named feature, which keeps its name alone", () => {
      expect(areaSummary(area([features("layer-1", "Old town")]), t, LAYERS)).toBe("Old town");
    });
  });
});

describe("a stale map view", () => {
  const polygons = [viewPolygon([7, 50, 8, 51])];
  it("holds while the map is where the piece was taken", () => {
    expect(viewStale(polygons, [7, 50, 8, 51])).toBe(false);
    expect(viewStale(polygons, [7.005, 50.005, 8.005, 51.005])).toBe(false);
  });
  it("is stale once an edge is off by more than a hundredth of the view's width", () => {
    expect(viewStale(polygons, [7.02, 50, 8.02, 51])).toBe(true);
    expect(viewStale(polygons, [7, 50, 9, 52])).toBe(true);
  });
  it("compares a view wider than the world as it is held to it", () => {
    const world = [viewPolygon([-200, -95, 200, 95])];
    expect(viewStale(world, [-220, -100, 230, 100])).toBe(false);
  });
});

describe("the area's pieces", () => {
  it("starts an area inside and switched on", () => {
    expect(withPiece(undefined, VIEW)).toEqual({ pieces: [VIEW], op: "inside", enabled: true });
  });
  it("puts a new shape after the other shapes", () => {
    const next = withPiece(area([POLYGON, VIEW], "outside"), CIRCLE);
    expect(next.pieces).toEqual([POLYGON, CIRCLE, VIEW]);
    expect(next.op).toBe("outside");
  });
  it("keeps one map view", () => {
    const moved: AreaPiece = { kind: "view", polygons: [viewPolygon([1, 1, 2, 2])] };
    expect(withPiece(area([POLYGON, VIEW]), moved).pieces).toEqual([POLYGON, moved]);
  });
  it("removes a piece, and the area with its last one", () => {
    expect(withoutPiece(area([POLYGON, VIEW]), 0)?.pieces).toEqual([VIEW]);
    expect(withoutPiece(area([VIEW]), 0)).toBeUndefined();
  });
  it("adds a feature to its source's piece, with its polygons", () => {
    const first = withFeature(undefined, "region", { id: "DE1", name: "Bayern", n: 2 }, [
      square(0),
      square(2),
    ]);
    const second = withFeature(first, "region", { id: "DE2", name: "Hessen", n: 1 }, [square(4)]);
    expect(second.pieces).toHaveLength(1);
    expect(second.pieces[0]).toEqual({
      kind: "features",
      source: "region",
      features: [
        { id: "DE1", name: "Bayern", n: 2 },
        { id: "DE2", name: "Hessen", n: 1 },
      ],
      polygons: [square(0), square(2), square(4)],
    });
    // Another source is another piece; a feature that is in already changes nothing.
    expect(withFeature(second, "layer-1", { id: "7", n: 1 }, [square(6)]).pieces).toHaveLength(2);
    expect(withFeature(second, "region", { id: "DE1", n: 1 }, [square(8)])).toBe(second);
  });
  it("takes a feature out with its own polygons, and the piece with its last one", () => {
    const both = withFeature(
      withFeature(undefined, "region", { id: "DE1", n: 2 }, [square(0), square(2)]),
      "region",
      { id: "DE2", n: 1 },
      [square(4)]
    );
    const left = withoutFeature(both, "region", "DE1");
    expect(left?.pieces[0]).toMatchObject({ features: [{ id: "DE2", n: 1 }], polygons: [square(4)] });
    expect(withoutFeature(left, "region", "DE2")).toBeUndefined();
  });
});

describe("an edited piece", () => {
  it("is a drawn polygon or a circle with its centre and radius, not a circle kept as its ring alone", () => {
    expect(editable(POLYGON)).toBe(true);
    expect(editable(circlePiece([11, 48], 3))).toBe(true);
    // A circle saved before circles kept their centre: its corners would no longer make a circle.
    expect(editable(CIRCLE)).toBe(false);
    expect(editable(VIEW)).toBe(false);
    expect(editable(regions("Bayern"))).toBe(false);
    // A shape read from a filter that does not say what it was.
    expect(editable({ kind: "shape", polygons: [square(0)] })).toBe(false);
  });

  it("takes the place of the piece it was, the other pieces as they were", () => {
    const edited: AreaPiece = { ...POLYGON, polygons: [square(5)] };
    const next = withReplaced(area([CIRCLE, POLYGON, VIEW], "outside"), POLYGON, edited);
    expect(next.pieces).toEqual([CIRCLE, edited, VIEW]);
    expect(next.pieces[0]).toBe(CIRCLE);
    expect(next.pieces[2]).toBe(VIEW);
    expect(next.op).toBe("outside");
  });

  it("changes nothing once the piece is no longer in the area", () => {
    const before = area([CIRCLE, VIEW]);
    expect(withReplaced(before, POLYGON, { ...POLYGON, polygons: [square(5)] })).toBe(before);
  });
});

describe("a circle around a point", () => {
  const kmFrom = (center: number[], at: number[]) => distance(center, at, { units: "kilometers" });

  it("is a closed ring around its centre at its radius, and keeps both", () => {
    const piece = circlePiece([11, 48], 3);
    expect(piece).toMatchObject({ kind: "shape", shape: "circle", center: [11, 48], km: 3 });
    expect(piece.polygons).toHaveLength(1);
    const [ring] = piece.polygons[0];
    expect(ring.length).toBeGreaterThan(32);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const at of ring) expect(kmFrom([11, 48], at)).toBeCloseTo(3, 2);
  });

  it("starts at three kilometers", () => {
    expect(circlePiece([11, 48]).km).toBe(3);
  });

  it("keeps its name", () => {
    expect(circlePiece([11, 48], 10, "School")).toMatchObject({ center: [11, 48], km: 10, label: "School" });
  });
});

describe("the outline the map draws", () => {
  it("is the area while the panel is on screen and the area has a polygon", () => {
    const shown = area([VIEW]);
    expect(drawnOutline(shown, true)).toBe(shown);
    expect(drawnOutline(shown, false)).toBeUndefined();
    expect(drawnOutline(undefined, true)).toBeUndefined();
    // The piece being edited is left out of the outline: an area of it alone has nothing to draw.
    expect(drawnOutline(area([{ ...POLYGON, polygons: [] }]), true)).toBeUndefined();
  });
});
