import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getMirrorColumns, getMirrorSize } from "@/lib/api/processes";
import type { AreaPiece, FilterArea, PolygonCoords } from "@/lib/filter/area";
import type { DatasetConnection } from "@/lib/workflows/datasetConnection";

import { type Bbox, useFetchFlow } from "@/hooks/addLayer/useFetchFlow";

import { circlePiece, withPiece } from "@/components/map/panels/filter/area/pieces";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-toastify", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/content", () => ({ refreshContentFeed: vi.fn(), useSpaces: () => ({ spaces: [] }) }));
vi.mock("@/lib/api/folders", () => ({
  useFolders: () => ({ folders: undefined }),
  getWritableDestinations: () => [],
}));
vi.mock("@/lib/api/processes", () => ({
  useJobs: () => ({ mutate: vi.fn() }),
  executeProcessAsync: vi.fn(),
  getMirrorSize: vi.fn(),
  getMirrorColumns: vi.fn(),
}));
vi.mock("@/lib/api/projects", () => ({ useProject: () => ({ project: undefined }) }));
vi.mock("@/lib/api/users", () => ({ useUserProfile: () => ({ userProfile: { id: "u1" } }) }));
vi.mock("@/hooks/addLayer/useShareNotice", () => ({ useShareNotice: () => undefined }));
vi.mock("@/hooks/store/ContextHooks", () => ({ useAppDispatch: () => vi.fn() }));

const square = (x: number, y = 48): PolygonCoords => [
  [
    [x, y],
    [x + 1, y],
    [x + 1, y + 1],
    [x, y + 1],
    [x, y],
  ],
];
const outlines = vi.hoisted(() => ({ shapes: {} as Record<string, { geometry?: unknown; name?: string }> }));
vi.mock("@/hooks/catalog/useCatalogNutsGeometries", () => ({
  useCatalogNutsGeometries: (ids: string[]) => ({
    shapes: Object.fromEntries(
      ids.flatMap((id) => (id in outlines.shapes ? [[id, outlines.shapes[id]]] : []))
    ),
  }),
}));

const VIEWPORT: Bbox = [11.004, 48.002, 11.996, 48.998];
const BAYERN: AreaPiece = {
  kind: "features",
  source: "region",
  features: [{ id: "DE2", name: "Bayern", n: 2 }],
  polygons: [square(10), square(12)],
};
const POLYGON: AreaPiece = { kind: "shape", shape: "polygon", polygons: [square(20)] };

const open = (props: Parameters<typeof useFetchFlow>[0] = {}) => renderHook(() => useFetchFlow(props));
type Flow = ReturnType<typeof open>["result"];
const setArea = (result: Flow, change: (area: FilterArea | undefined) => FilterArea | undefined) =>
  act(() => result.current.fetch.areaHost.setArea(change(result.current.fetch.areaHost.read())));

/** Reopened from a workflow node that saved `areaChoice`. */
const saved = (
  areaChoice?: DatasetConnection["areaChoice"],
  area: unknown = { type: "Polygon", coordinates: square(1) }
) => {
  const onUse = vi.fn();
  const initial: DatasetConnection = {
    processId: "fetch_data",
    params: {
      source: "osm",
      feature_type: "points",
      overture_type: "places",
      area,
      match_mode: "all",
      tag_filters: [],
    },
    summary: "OSM points",
    geometryType: "point",
    fields: [],
    ...(areaChoice && { areaChoice }),
  };
  return { ...open({ workflow: { initial, onUse } }), onUse };
};

/** Uses the choice in the workflow once the size check has answered; what the node was handed. */
const use = async (result: Flow, onUse: ReturnType<typeof vi.fn>) => {
  await waitFor(() => expect(result.current.action.disabled).toBe(false), { timeout: 3000 });
  await act(() => result.current.action.run());
  return onUse.mock.calls[0][0] as DatasetConnection;
};

beforeEach(() => {
  vi.clearAllMocks();
  outlines.shapes = {};
  vi.mocked(getMirrorSize).mockResolvedValue({ estimate: 100, tooLarge: false } as never);
  vi.mocked(getMirrorColumns).mockResolvedValue({ columns: [], geometryType: "point" });
});

describe("the fetch's area", () => {
  it("is picked with the picker: the map view, drawn polygons, points with a radius and regions, without limits", () => {
    const { result } = open({ viewport: VIEWPORT });
    const host = result.current.fetch.areaHost;
    expect(host.ways).toEqual(["view", "polygon", "point", "regions"]);
    expect(host.limits).toBeUndefined();
    expect(host.ops).toBe(false);
    expect(host.map).toEqual({ id: "fetch-features-preview", main: false });
  });

  it("starts as the map view, the box widened to the next hundredth", () => {
    const { result } = open({ viewport: VIEWPORT });
    expect(result.current.fetch.areaHost.area?.pieces.map((p) => p.kind)).toEqual(["view"]);
    expect(result.current.fetch.area).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [11, 48],
          [12, 48],
          [12, 49],
          [11, 49],
          [11, 48],
        ],
      ],
    });
  });

  it("follows the map with the map view, but without a map behind only once a person moves it", () => {
    const { result } = open();
    expect(result.current.fetch.area).toBeUndefined();
    act(() => result.current.fetch.setViewBox([1, 2, 3, 4]));
    expect(result.current.fetch.area).toBeUndefined();
    act(() => result.current.fetch.setViewBox([1, 2, 3, 4], true));
    expect(result.current.fetch.area).toMatchObject({
      type: "Polygon",
      coordinates: [
        [
          [1, 2],
          [3, 2],
          [3, 4],
          [1, 4],
          [1, 2],
        ],
      ],
    });
  });

  it("drops the map view for a piece that stays where it is, and the map view replaces the pieces again", () => {
    const { result } = open({ viewport: VIEWPORT });
    setArea(result, (area) => withPiece(area, BAYERN));
    expect(result.current.fetch.areaHost.area?.pieces).toEqual([BAYERN]);
    setArea(result, (area) => withPiece(area, { kind: "view", polygons: [square(0)] }));
    expect(result.current.fetch.areaHost.area?.pieces.map((p) => p.kind)).toEqual(["view"]);
  });

  it("takes a map view that is added as chosen, with no map behind too", () => {
    const { result } = open();
    setArea(result, () => undefined);
    setArea(result, (area) => withPiece(area, { kind: "view", polygons: [square(0)] }));
    expect(result.current.fetch.area).toMatchObject({ type: "Polygon" });
  });

  it("sends one piece as it is, and every polygon of several pieces together", () => {
    const { result } = open({ viewport: VIEWPORT });
    setArea(result, (area) => withPiece(area, POLYGON));
    expect(result.current.fetch.area).toEqual({ type: "Polygon", coordinates: square(20) });
    setArea(result, (area) => withPiece(area, BAYERN));
    expect(result.current.fetch.area).toEqual({
      type: "MultiPolygon",
      coordinates: [square(20), square(10), square(12)],
    });
    setArea(result, () => undefined);
    expect(result.current.fetch.area).toBeUndefined();
    expect(result.current.action.reason).toBe("fetch_features_area_needed");
  });

  it("asks for the size of the area once it has settled", async () => {
    const { result } = open({ viewport: VIEWPORT });
    setArea(result, (area) => withPiece(area, circlePiece([11, 48], 2)));
    await waitFor(() => expect(getMirrorSize).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(vi.mocked(getMirrorSize).mock.calls[0][0]).toEqual(result.current.fetch.area);
  });
});

describe("the fetch's area in a workflow node", () => {
  it("keeps an area of one piece as that piece's choice", async () => {
    const { result, onUse } = saved({
      kind: "polygon",
      ring: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    });
    setArea(result, () => ({ pieces: [circlePiece([11, 48], 4)], op: "inside", enabled: true }));
    expect((await use(result, onUse)).areaChoice).toEqual({ kind: "point", lng: 11, lat: 48, km: 4 });
  });

  it("keeps an area of several pieces as the list of their choices", async () => {
    const { result, onUse } = saved({
      kind: "polygon",
      ring: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    });
    setArea(result, (area) => withPiece(area, circlePiece([11, 48], 4)));
    expect((await use(result, onUse)).areaChoice).toEqual({
      kind: "pieces",
      pieces: [
        {
          kind: "polygon",
          ring: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
        { kind: "point", lng: 11, lat: 48, km: 4 },
      ],
    });
  });

  it("reads each kind saved before an area had pieces back as one piece", () => {
    outlines.shapes = { DE2: { geometry: { type: "MultiPolygon", coordinates: [square(10), square(12)] } } };
    expect(
      saved({ kind: "region", nutsIds: ["DE2"], names: { DE2: "Bayern" } }).result.current.fetch.areaHost.area
        ?.pieces
    ).toEqual([BAYERN]);
    expect(
      saved({ kind: "point", lng: 11, lat: 48, km: 5 }).result.current.fetch.areaHost.area?.pieces
    ).toEqual([circlePiece([11, 48], 5)]);
    expect(
      saved({
        kind: "polygon",
        ring: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      }).result.current.fetch.areaHost.area?.pieces
    ).toEqual([
      {
        kind: "shape",
        shape: "polygon",
        polygons: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
    ]);
    const view = saved({ kind: "view", bbox: [1, 2, 3, 4] }).result.current.fetch;
    expect(view.areaHost.area?.pieces.map((p) => p.kind)).toEqual(["view"]);
    expect(view.viewBox).toEqual([1, 2, 3, 4]);
  });

  it("reads a list of pieces back", () => {
    outlines.shapes = { DE2: { geometry: { type: "MultiPolygon", coordinates: [square(10), square(12)] } } };
    const { result } = saved({
      kind: "pieces",
      pieces: [
        { kind: "region", nutsIds: ["DE2"], names: { DE2: "Bayern" } },
        { kind: "point", lng: 11, lat: 48, km: 5 },
      ],
    });
    expect(result.current.fetch.areaHost.area?.pieces).toEqual([BAYERN, circlePiece([11, 48], 5)]);
  });

  it("saves a reopened map view as the box it was until a person moves the map", async () => {
    const { result, onUse } = saved({ kind: "view", bbox: [1, 2, 3, 4] });
    // The preview opening on it measures a box of its own size.
    act(() => result.current.fetch.setViewBox([0.9, 2, 3.1, 4]));
    expect((await use(result, onUse)).areaChoice).toEqual({ kind: "view", bbox: [1, 2, 3, 4] });
  });

  it("keeps a saved area without a choice as one shape, sent as it was, and saves no choice for it", async () => {
    const area = { type: "MultiPolygon", coordinates: [square(1), square(3)] };
    const { result, onUse } = saved(undefined, area);
    expect(result.current.fetch.areaHost.area?.pieces).toEqual([
      { kind: "shape", polygons: [square(1), square(3)] },
    ]);
    const connection = await use(result, onUse);
    expect(connection.params.area).toEqual(area);
    expect(connection.areaChoice).toBeUndefined();
  });

  it("keeps the saved area as it was when a region's outline does not load", () => {
    outlines.shapes = { DE2: {} };
    const area = { type: "Polygon", coordinates: square(1) };
    const { result } = saved({ kind: "region", nutsIds: ["DE2"] }, area);
    expect(result.current.fetch.areaHost.area?.pieces).toEqual([{ kind: "shape", polygons: [square(1)] }]);
    expect(result.current.fetch.area).toEqual(area);
  });
});
