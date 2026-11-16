import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LayerFilterPanel } from "@/components/map/panels/filter/LayerFilterPanel";

const { execute, filter, project, shown } = vi.hoisted(() => ({
  execute: vi.fn(),
  filter: { canEdit: true },
  /** The project's layers the area can be picked from. */
  project: { layers: [] as object[] },
  /** What the panel was given. */
  shown: { areaLayers: undefined as unknown },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-toastify", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/map/useLayerFilter", () => ({
  useLayerFilter: () => ({
    model: { rows: [], match: "all" },
    fields: {},
    fieldInfos: [],
    issues: { rows: {}, filter: [] },
    canEdit: filter.canEdit,
    isLoading: false,
    apply: vi.fn(),
  }),
}));
vi.mock("@/hooks/map/LayerPanelHooks", () => ({
  useFilteredProjectLayers: () => ({ layers: project.layers }),
}));
vi.mock("@/hooks/map/useMapLayers", () => ({ useMapLayers: () => ({ layers: [] }) }));
vi.mock("@/hooks/map/useOgcProcesses", () => ({ useProcessExecution: () => ({ execute }) }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => [],
}));
// The panel itself has its own tests; here it is the place its caller's foot lands in, inside the panel's popover
// stack as in the real panel.
vi.mock("@/components/map/panels/filter/FilterPanel", async () => {
  const { PopoverProvider } = await import("@/components/map/panels/styleEditor/popovers/PopoverStack");
  return {
    FilterPanel: ({
      resultAction,
      area,
      shown: onScreen,
      areaLayers,
    }: {
      resultAction?: ReactNode;
      area?: boolean;
      shown?: boolean;
      areaLayers?: unknown;
    }) => {
      shown.areaLayers = areaLayers;
      return (
        <div data-style-panel data-testid="panel" data-area={String(area)} data-shown={String(onScreen)}>
          <PopoverProvider>{resultAction}</PopoverProvider>
        </div>
      );
    },
  };
});

const CQL = { op: "and", args: [{ op: "=", args: [{ property: "name" }, "A"] }] };
const layer = (query: object | null, type = "feature") =>
  ({ id: 7, layer_id: "layer-1", name: "Shops", type, query }) as never;
const renderPanel = (query: object | null = { cql: CQL }, type?: string) =>
  render(<LayerFilterPanel projectId="p1" projectLayer={layer(query, type)} />);
const save = () => screen.getByRole("button", { name: "save_as_new_layer" });
const nameField = () => screen.getByRole("textbox", { name: "layer_name" }) as HTMLInputElement;
const confirm = () => screen.getByRole("button", { name: "filter_panel.save_layer" }) as HTMLButtonElement;

describe("a layer's filter tab", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ jobID: "job-1" });
    vi.mocked(toast.info).mockClear();
    vi.mocked(toast.error).mockClear();
    filter.canEdit = true;
    project.layers = [];
    shown.areaLayers = undefined;
  });

  describe("the layers its area can be picked from", () => {
    const polygons = (id: number, layerId: string, name: string, query: object | null = null) => ({
      id,
      layer_id: layerId,
      name,
      type: "feature",
      feature_layer_geometry_type: "polygon",
      query,
    });
    const offered = () =>
      (shown.areaLayers as Array<{ id: string; name: string; filter?: unknown }>).map(
        ({ id, name, filter }) => ({ id, name, ...(filter !== undefined && { filter }) })
      );
    const PARKS = { op: "=", args: [{ property: "kind" }, "park"] };
    const WOODS = { op: "=", args: [{ property: "kind" }, "wood"] };

    it("are the project's other polygon layers, each with the filter the map draws it with", () => {
      project.layers = [
        polygons(1, "districts", "Districts", { cql: {} }),
        polygons(2, "green", "Parks", { cql: PARKS, ui: { v: 1 } }),
        { ...polygons(3, "roads", "Roads"), feature_layer_geometry_type: "line" },
        // The filtered layer itself.
        polygons(7, "layer-1", "Shops"),
      ];
      renderPanel();
      expect(offered()).toEqual([
        { id: "districts", name: "Districts" },
        { id: "green", name: "Parks", filter: PARKS },
      ]);
    });

    it("offer a dataset in the project twice once, with what either of its layers shows", () => {
      project.layers = [
        polygons(1, "green", "Parks", { cql: PARKS }),
        polygons(2, "green", "Woods", { cql: WOODS }),
      ];
      renderPanel();
      expect(offered()).toEqual([{ id: "green", name: "Parks", filter: { op: "or", args: [PARKS, WOODS] } }]);
      cleanup();
      // One of them shows every feature: so does the list.
      project.layers = [polygons(1, "green", "Parks", { cql: PARKS }), polygons(2, "green", "All green")];
      renderPanel();
      expect(offered()).toEqual([{ id: "green", name: "Parks" }]);
    });
  });

  it("asks for the new layer's name first, this layer's name marked as filtered", () => {
    renderPanel();
    fireEvent.click(save());
    expect(nameField().value).toBe("Shops (filtered)");
    expect(execute).not.toHaveBeenCalled();
  });

  it("saves the features the saved filter keeps as a new layer, in this layer's style", async () => {
    renderPanel();
    fireEvent.click(save());
    fireEvent.click(confirm());
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("layer_create_filtered", {
      source_layer_id: "layer-1",
      cql_filter: CQL,
      project_id: "p1",
      result_layer_name: "Shops (filtered)",
      source_layer_project_id: 7,
    });
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("save_as_new_layer - job_started"));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "layer_name" })).toBeNull());
  });

  it("names the new layer as typed", async () => {
    renderPanel();
    fireEvent.click(save());
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "  Shops near the station ");
    await userEvent.click(confirm());
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0][1].result_layer_name).toBe("Shops near the station");
  });

  it("takes the name with Enter", async () => {
    renderPanel();
    fireEvent.click(save());
    await userEvent.type(nameField(), "{Enter}");
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0][1].result_layer_name).toBe("Shops (filtered)");
  });

  it("refuses an empty name", async () => {
    renderPanel();
    fireEvent.click(save());
    await userEvent.clear(nameField());
    expect(confirm().disabled).toBe(true);
    await userEvent.type(nameField(), "   {Enter}");
    expect(confirm().disabled).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("starts nothing when cancelled", async () => {
    renderPanel();
    fireEvent.click(save());
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.queryByRole("textbox", { name: "layer_name" })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("saves the filter as it is when the name is confirmed", async () => {
    const changed = { op: "and", args: [{ op: "=", args: [{ property: "name" }, "B"] }] };
    const view = renderPanel();
    fireEvent.click(save());
    view.rerender(<LayerFilterPanel projectId="p1" projectLayer={layer({ cql: changed })} />);
    fireEvent.click(confirm());
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0][1].cql_filter).toEqual(changed);
  });

  it("closes the name once the filter saves nothing", async () => {
    const view = renderPanel();
    fireEvent.click(save());
    expect(nameField()).toBeInTheDocument();
    view.rerender(<LayerFilterPanel projectId="p1" projectLayer={layer({ ui: { off: ["r0"] } })} />);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "layer_name" })).toBeNull());
  });

  it("offers nothing to save without a saved filter", () => {
    renderPanel({ ui: { off: [] } });
    expect(screen.queryByRole("button", { name: "save_as_new_layer" })).not.toBeInTheDocument();
  });

  it("says so when the job could not start, and keeps the name to try again", async () => {
    execute.mockRejectedValue(new Error("no"));
    renderPanel();
    fireEvent.click(save());
    fireEvent.click(confirm());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("save_as_new_layer_error"));
    expect(nameField().value).toBe("Shops (filtered)");
  });

  it("offers an area for a layer with geometry, none for a table", () => {
    renderPanel();
    expect(screen.getByTestId("panel").dataset.area).toBe("true");
    cleanup();
    renderPanel({ cql: CQL }, "table");
    expect(screen.getByTestId("panel").dataset.area).toBe("false");
  });

  it("tells the panel whether its tab is on screen", () => {
    render(<LayerFilterPanel projectId="p1" projectLayer={layer({ cql: CQL })} visible={false} />);
    expect(screen.getByTestId("panel").dataset.shown).toBe("false");
    cleanup();
    renderPanel();
    expect(screen.getByTestId("panel").dataset.shown).toBe("true");
  });

  it("offers a viewer no new layer", () => {
    filter.canEdit = false;
    renderPanel();
    expect(screen.queryByRole("button", { name: "save_as_new_layer" })).not.toBeInTheDocument();
  });
});
