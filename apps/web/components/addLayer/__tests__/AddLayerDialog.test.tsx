import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeProcessAsync, getMirrorColumns, getMirrorSize, getMirrorValues } from "@/lib/api/processes";
import type { DatasetConnection } from "@/lib/workflows/datasetConnection";

import AddLayerDialog from "@/components/addLayer/AddLayerDialog";

/** Keys as text, but for the two that name the layer Add layer suggests. */
const names: Record<string, string> = {
  fetch_features_source_short_osm: "OSM",
  fetch_features_type_points: "Points",
};
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => names[key] ?? key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

/** The project's map, when a test puts one behind the dialog. */
const mapState = vi.hoisted(() => ({ map: undefined as unknown }));
const mapProps = vi.hoisted(() => ({ opened: [] as unknown[], fitBounds: vi.fn() }));
vi.mock("react-map-gl/maplibre", () => ({
  useMap: () => ({ map: mapState.map }),
  Map: forwardRef(function MapMock(
    {
      onMoveEnd,
      onClick,
      initialViewState,
      children,
    }: {
      onMoveEnd?: (event: unknown) => void;
      onClick?: (event: unknown) => void;
      initialViewState?: unknown;
      children?: React.ReactNode;
    },
    ref
  ) {
    useImperativeHandle(ref, () => ({ fitBounds: mapProps.fitBounds }));
    mapProps.opened.push(initialViewState);
    return (
      <>
        <button
          data-testid="pan"
          onClick={() =>
            onMoveEnd?.({
              originalEvent: {},
              target: {
                getContainer: () => ({ clientWidth: 400, clientHeight: 300 }),
                unproject: ([x, y]: number[]) => ({ lng: x / 100, lat: 50 - y / 100 }),
              },
            })
          }
        />
        <button data-testid="tap" onClick={() => onClick?.({ lngLat: { lng: 11, lat: 48 } })} />
        {children}
      </>
    );
  }),
  Source: ({ id }: { id: string }) => <i data-testid={`source-${id}`} />,
  Layer: () => null,
}));

const controller = { action: { label: "add", disabled: false, run: vi.fn() }, isBusy: false, reset: vi.fn() };
const selection = { selectedItems: [], toggle: vi.fn(), clear: vi.fn() };

vi.mock("@/hooks/addLayer/useDatasetPickerFlow", () => ({
  useDatasetPickerFlow: () => ({ ...controller, selection }),
}));
vi.mock("@/hooks/addLayer/useCatalogFlow", () => ({ useCatalogFlow: () => controller }));
vi.mock("@/hooks/addLayer/useCreateFlow", () => ({ useCreateFlow: () => controller }));
vi.mock("@/hooks/addLayer/useConnectFlow", () => ({ useConnectFlow: () => controller }));
vi.mock("@/hooks/addLayer/useUploadFlow", () => ({ useUploadFlow: () => controller }));

/** The shelf as the frame renders it, reduced to the one prop under test. */
const shelfProps: { fullHeight?: boolean }[] = [];
vi.mock("@/components/addLayer/DatasetPickerBody", () => ({
  default: (props: { fullHeight?: boolean }) => {
    shelfProps.push(props);
    return <div data-testid="shelf">{String(props.fullHeight)}</div>;
  },
}));
vi.mock("@/components/addLayer/CatalogBody", () => ({ default: () => <div /> }));
vi.mock("@/components/addLayer/CreateBody", () => ({ default: () => <div /> }));
vi.mock("@/components/addLayer/ConnectBody", () => ({ default: () => <div /> }));
vi.mock("@/components/addLayer/UploadBody", () => ({ default: () => <div /> }));
vi.mock("@/components/addLayer/ConnectPreview", () => ({ default: () => null }));
vi.mock("@/components/dashboard/common/DetailMapAttribution", () => ({ default: () => null }));

// The OpenStreetMap / Overture flow runs for real; only what they ask the server is answered here.
vi.mock("@/lib/api/processes", () => ({
  useJobs: () => ({ mutate: vi.fn() }),
  executeProcessAsync: vi.fn(),
  getMirrorSize: vi.fn(),
  getMirrorValues: vi.fn(),
  getMirrorColumns: vi.fn(),
}));
vi.mock("@/lib/api/content", () => ({ refreshContentFeed: vi.fn(), useSpaces: () => ({ spaces: [] }) }));
vi.mock("@/lib/api/folders", () => ({
  useFolders: () => ({ folders: undefined }),
  getWritableFolders: () => [],
  getWritableDestinations: () => [],
}));
vi.mock("@/lib/api/projects", () => ({
  useProject: () => ({ project: undefined, mutate: vi.fn() }),
  useProjectLayers: () => ({ mutate: vi.fn() }),
  addProjectLayers: vi.fn(),
}));
vi.mock("@/lib/api/users", () => ({ useUserProfile: () => ({ userProfile: { id: "u1" } }) }));
vi.mock("@/lib/api/layers", () => ({ createLayer: vi.fn(), createRasterLayer: vi.fn() }));
vi.mock("@/hooks/addLayer/useShareNotice", () => ({ useShareNotice: () => "shared" }));
vi.mock("@/hooks/catalog/useCatalogBasemapStyle", () => ({ useCatalogBasemapStyle: () => undefined }));
vi.mock("@/hooks/store/ContextHooks", () => ({ useAppDispatch: () => vi.fn() }));

const BAVARIA: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [10, 48],
      [12, 48],
      [12, 49],
      [10, 49],
      [10, 48],
    ],
  ],
};
const SAXONY: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [12, 50],
      [14, 50],
      [14, 51],
      [12, 51],
      [12, 50],
    ],
  ],
};
const outlines = { geometries: { DE2: BAVARIA, DED: SAXONY }, names: {} };
vi.mock("@/hooks/catalog/useCatalogNutsGeometries", () => ({ useCatalogNutsGeometries: () => outlines }));

/** The region search, answering with Bayern. */
vi.mock("@/lib/api/catalog", () => ({
  useCatalogNutsRegions: (query?: string) => ({
    regions: query && query.length >= 2 ? [{ nuts_id: "DE2", nuts_name: "Bayern", level: 1 }] : [],
    isLoading: false,
  }),
}));

/** jsdom has no matchMedia; the frame full-screens below `sm` and the shelf
 * reads the same split, so one answer drives both. */
const setViewport = (mobile: boolean) => {
  window.matchMedia = ((query: string) =>
    ({
      matches: mobile,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
};

describe("AddLayerDialog — My datasets", () => {
  beforeEach(() => {
    shelfProps.length = 0;
  });

  it("fills a full-screen dialog with the shelf, so nothing is left empty above the footer", () => {
    setViewport(true);
    render(<AddLayerDialog source="explorer" projectId="p1" onClose={vi.fn()} />);

    expect(screen.getByTestId("shelf")).toBeInTheDocument();
    expect(shelfProps.at(-1)?.fullHeight).toBe(true);
  });

  it("leaves the shelf at its own height on a windowed dialog", () => {
    setViewport(false);
    render(<AddLayerDialog source="explorer" projectId="p1" onClose={vi.fn()} />);

    expect(shelfProps.at(-1)?.fullHeight).toBe(false);
  });
});

describe("AddLayerDialog — Connect service in a workflow", () => {
  // Read off DOM properties rather than jest-dom matchers: the repo's ESLint setup reads
  // `toBeDisabled`/`toHaveAttribute` as Playwright's async matchers of the same name.
  const useButton = () =>
    screen.getByRole("button", { name: "connect_service_use_in_workflow" }) as HTMLButtonElement;
  const attribute = (role: string, name: string, key: string) =>
    screen.getByRole(role, { name }).getAttribute(key);

  const openOsm = async (workflow: { initial?: DatasetConnection; onUse: () => void }) => {
    const user = userEvent.setup();
    render(<AddLayerDialog source="connect" projectId="p1" workflow={workflow} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "fetch_features_source_osm" }));
    return user;
  };

  // Picked inline: the search sits over the map in the same dialog.
  const pickBayern = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("radio", { name: "catalog_mode_region" }));
    await user.type(screen.getByPlaceholderText("catalog_search_region"), "Bay");
    await user.click(await screen.findByRole("option", { name: /Bayern/ }));
  };

  beforeEach(() => {
    setViewport(false);
    vi.mocked(getMirrorSize).mockResolvedValue({ estimate: 100, tooLarge: false } as never);
    vi.mocked(getMirrorValues).mockResolvedValue({ values: [], complete: true } as never);
    vi.mocked(getMirrorColumns).mockResolvedValue({
      columns: [{ name: "amenity", type: "VARCHAR" }],
      geometryType: "point",
    });
  });

  afterEach(() => {
    mapState.map = undefined;
    mapProps.opened.length = 0;
    vi.clearAllMocks();
  });

  it("uses the choice in a workflow", async () => {
    const onUse = vi.fn();
    const user = await openOsm({ onUse });
    await pickBayern(user);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Bayern" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "fetch_features_add_filter" }));
    await user.type(screen.getByLabelText("fetch_features_tag"), "amenity");
    await user.type(screen.getByLabelText("fetch_features_values"), "school{enter}");

    expect(screen.queryByText("layer_name")).not.toBeInTheDocument();
    expect(screen.queryByText("connect_service_save_to")).not.toBeInTheDocument();
    expect(screen.queryByText("shared")).not.toBeInTheDocument();
    await waitFor(() => expect(useButton().disabled).toBe(false));
    await user.click(useButton());

    await waitFor(() => expect(onUse).toHaveBeenCalledTimes(1));
    const connection = onUse.mock.calls[0][0] as DatasetConnection;
    expect(connection).toMatchObject({
      processId: "fetch_data",
      params: {
        source: "osm",
        feature_type: "points",
        tag_filters: [{ key: "amenity", values: ["school"] }],
      },
      geometryType: "point",
      fields: [{ name: "amenity", type: "VARCHAR" }],
      summary: "OSM points",
    });
    for (const key of ["user_id", "project_id", "folder_id", "result_layer_name"])
      expect(connection.params).not.toHaveProperty(key);
    expect(connection.areaChoice).toEqual({ kind: "region", nutsIds: ["DE2"], names: { DE2: "Bayern" } });
    expect(executeProcessAsync).not.toHaveBeenCalled();
  });

  it("keeps the button disabled while the area is too large", async () => {
    vi.mocked(getMirrorSize).mockResolvedValue({ estimate: 9e9, tooLarge: true } as never);
    const user = await openOsm({ onUse: vi.fn() });
    await pickBayern(user);

    await waitFor(() =>
      expect(screen.getAllByLabelText("fetch_features_area_too_large")[0]).toContainElement(useButton())
    );
    expect(useButton().disabled).toBe(true);
    // Filters cannot help here, so they wait for a smaller area.
    expect(screen.getByText("fetch_features_filters_paused")).toBeInTheDocument();
    expect(
      (screen.getByRole("button", { name: "fetch_features_add_filter" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("keeps filters open when only narrowing helps", async () => {
    vi.mocked(getMirrorSize).mockResolvedValue({ estimate: 9e9, tooLarge: false } as never);
    const user = await openOsm({ onUse: vi.fn() });
    await pickBayern(user);

    await waitFor(() => expect(useButton().disabled).toBe(true));
    expect(screen.queryByText("fetch_features_filters_paused")).not.toBeInTheDocument();
    expect(
      (screen.getByRole("button", { name: "fetch_features_add_filter" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("reopens with the saved connection", async () => {
    const area: GeoJSON.MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [BAVARIA.coordinates, SAXONY.coordinates],
    };
    const areaChoice = {
      kind: "region" as const,
      nutsIds: ["DE2", "DED"],
      names: { DE2: "Bayern", DED: "Sachsen" },
    };
    const initial: DatasetConnection = {
      processId: "fetch_data",
      params: {
        source: "osm",
        feature_type: "lines",
        overture_type: "places",
        area,
        match_mode: "all",
        tag_filters: [{ key: "highway", values: ["primary"] }],
      },
      summary: "OSM lines",
      geometryType: "line",
      fields: [],
      areaChoice,
    };
    const onUse = vi.fn();
    const user = userEvent.setup();
    render(<AddLayerDialog source="connect" workflow={{ initial, onUse }} onClose={vi.fn()} />);

    expect(attribute("button", "fetch_features_source_osm", "aria-current")).toBe("true");
    expect(attribute("radio", "fetch_features_type_lines", "aria-checked")).toBe("true");
    expect((screen.getByLabelText("fetch_features_tag") as HTMLInputElement).value).toBe("highway");
    expect(screen.getByText("primary")).toBeInTheDocument();
    expect(attribute("radio", "catalog_mode_region", "aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Bayern" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sachsen" })).toBeInTheDocument();

    await waitFor(() => expect(useButton().disabled).toBe(false));
    await user.click(useButton());
    await waitFor(() => expect(onUse).toHaveBeenCalledTimes(1));
    expect(onUse.mock.calls[0][0]).toMatchObject({ params: { area }, areaChoice });
  });

  it("starts on OpenStreetMap and Map view, without OGC services, and panning sets the area", async () => {
    const onUse = vi.fn();
    const user = await openOsm({ onUse });

    expect(attribute("radio", "fetch_features_area_view", "aria-checked")).toBe("true");
    expect(screen.getByText("fetch_data")).toBeInTheDocument();
    expect(screen.queryByText("connect_service")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect_data_ogc/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /street_network/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fetch_features_source_overture/ })).toBeInTheDocument();

    await user.click(screen.getByTestId("pan"));
    await waitFor(() => expect(useButton().disabled).toBe(false));
    await user.click(useButton());
    await waitFor(() => expect(onUse).toHaveBeenCalledTimes(1));
    expect(onUse.mock.calls[0][0].areaChoice).toEqual({ kind: "view", bbox: [0.28, 47.28, 3.72, 49.72] });
  });

  const saved = (areaChoice?: DatasetConnection["areaChoice"], area: GeoJSON.Polygon = BAVARIA) =>
    ({
      processId: "fetch_data",
      params: {
        source: "osm",
        feature_type: "points",
        overture_type: "places",
        area,
        match_mode: "all",
        tag_filters: [{ key: "amenity", values: ["school"] }],
      },
      summary: "OSM points",
      geometryType: "point",
      fields: [],
      areaChoice,
    }) as DatasetConnection;

  const reopen = (initial: DatasetConnection) => {
    const onUse = vi.fn();
    render(<AddLayerDialog source="connect" workflow={{ initial, onUse }} onClose={vi.fn()} />);
    return onUse;
  };

  it("fetches the box the map shows after another mode moved it", async () => {
    const onUse = vi.fn();
    const user = await openOsm({ onUse });
    await user.click(screen.getByRole("radio", { name: "catalog_mode_region" }));
    await user.click(screen.getByTestId("pan"));
    await user.click(screen.getByRole("radio", { name: "fetch_features_area_view" }));
    await waitFor(() => expect(useButton().disabled).toBe(false));
    await user.click(useButton());
    await waitFor(() => expect(onUse).toHaveBeenCalledTimes(1));
    expect(onUse.mock.calls[0][0].areaChoice).toEqual({ kind: "view", bbox: [0.28, 47.28, 3.72, 49.72] });
  });

  it("does not take the starting view as an area until the map is moved", async () => {
    const user = await openOsm({ onUse: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(getMirrorSize).not.toHaveBeenCalled();
    expect(useButton().disabled).toBe(true);
    expect(screen.queryByText("fetch_features_filters_paused")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("pan"));
    await waitFor(() => expect(getMirrorSize).toHaveBeenCalled());
  });

  it("frames the map on a reopened point, and draws the saved area once", async () => {
    reopen(saved({ kind: "point", lng: 20, lat: 40, km: 5 }));
    const view = mapProps.opened[0] as { bounds: number[] };
    expect(view.bounds[0]).toBeLessThanOrEqual(20);
    expect(view.bounds[2]).toBeGreaterThanOrEqual(20);
    expect(view.bounds[1]).toBeGreaterThan(39);

    cleanup();
    reopen(saved());
    expect(screen.queryByTestId("source-fetch-area")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("source-spatial-draft")).toHaveLength(1);
  });

  it("keeps a saved area when a polygon is only started", async () => {
    const onUse = reopen(saved());
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tap"));
    await waitFor(() => expect(useButton().disabled).toBe(false));
    await user.click(useButton());
    await waitFor(() => expect(onUse).toHaveBeenCalledTimes(1));
    expect(onUse.mock.calls[0][0].params.area).toEqual(BAVARIA);
  });

  it("lets filters be deleted while the area is too large", async () => {
    vi.mocked(getMirrorSize).mockResolvedValue({ estimate: 9e9, tooLarge: true } as never);
    reopen(saved({ kind: "point", lng: 11, lat: 48, km: 5 }));
    await waitFor(() => expect(screen.getByText("fetch_features_filters_paused")).toBeInTheDocument());

    expect((screen.getByRole("button", { name: "delete" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("fetch_features_tag") as HTMLInputElement).disabled).toBe(false);
  });

  it("says what is chosen, hints at the region search, and clears and frames a placed point", async () => {
    const user = await openOsm({ onUse: vi.fn() });
    await user.click(screen.getByRole("radio", { name: "catalog_mode_region" }));
    expect(screen.getByText("fetch_features_area_none")).toBeInTheDocument();
    expect(screen.getByText("catalog_spatial_hint_region")).toBeInTheDocument();
    await pickBayern(user);
    expect(screen.queryByText("fetch_features_area_none")).not.toBeInTheDocument();
    expect(screen.getAllByText("Bayern").length).toBeGreaterThan(1);

    mapProps.fitBounds.mockClear();
    await user.click(screen.getByRole("radio", { name: "catalog_mode_point" }));
    await user.click(screen.getByTestId("tap"));
    expect(mapProps.fitBounds).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/catalog_spatial_point/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "clear_all" }));
    expect(screen.queryByRole("button", { name: "clear_all" })).not.toBeInTheDocument();
    expect(screen.getByText("fetch_features_area_none")).toBeInTheDocument();
  });
});
