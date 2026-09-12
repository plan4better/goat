import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ReplaceDatasetsDialog from "@/components/workflows/dialogs/ReplaceDatasetsDialog";

const { dispatchMock, storeState, layersMock, processesMock, fieldsMock, toastSuccessMock } = vi.hoisted(
  () => ({
    dispatchMock: vi.fn(),
    storeState: { nodes: [] as Node[], edges: [] as Edge[] },
    layersMock: vi.fn(),
    processesMock: vi.fn(),
    fieldsMock: vi.fn(),
    toastSuccessMock: vi.fn(),
  })
);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
}));
vi.mock("react-toastify", () => ({ toast: { success: toastSuccessMock } }));
vi.mock("react-redux", () => ({
  useDispatch: () => dispatchMock,
  useSelector: (selector: (state: unknown) => unknown) => selector({ workflow: storeState }),
}));
vi.mock("@/lib/store/workflow/slice", () => ({
  updateNode: (payload: unknown) => ({ type: "workflow/updateNode", payload }),
}));
vi.mock("@/hooks/map/LayerPanelHooks", () => ({ useFilteredProjectLayers: layersMock }));
vi.mock("@/hooks/map/useOgcProcesses", () => ({ useProcessDescriptions: processesMock }));
vi.mock("@/hooks/map/useLayerFieldNames", () => ({ useLayerFieldNames: fieldsMock }));

const dataset = (id: string, layerId: string, projectLayerId: number, label: string, geometry = "point") =>
  ({
    id,
    type: "dataset",
    position: { x: 0, y: 0 },
    data: {
      type: "dataset",
      label,
      layerId,
      projectLayerId,
      layerName: label,
      geometryType: geometry,
      layerType: "feature",
    },
  }) as Node;

const tool = (id: string, label: string, config: Record<string, unknown>) =>
  ({
    id,
    type: "tool",
    position: { x: 0, y: 0 },
    data: { type: "tool", processId: "aggregate_point", label, config, status: "idle" },
  }) as Node;

const layer = (id: number, layerId: string, name: string, geometry = "point") => ({
  id,
  layer_id: layerId,
  name,
  type: "feature",
  feature_layer_geometry_type: geometry,
  locked: false,
});

const aggregate = {
  id: "aggregate_point",
  inputs: {
    source_layer_id: { title: "Source", schema: { "x-ui": { widget: "layer-selector" } }, minOccurs: 1 },
    group_by_field: {
      title: "Group by",
      schema: {
        type: "string",
        "x-ui": { widget: "field-selector", widget_options: { source_layer: "source_layer_id" } },
      },
      minOccurs: 0,
    },
  },
  outputs: {},
};

const openPicker = (nodeId: string) => {
  fireEvent.mouseDown(within(screen.getByTestId(`replace-dataset-row-${nodeId}`)).getByRole("combobox"));
  return screen.getByRole("listbox");
};

describe("ReplaceDatasetsDialog", () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    toastSuccessMock.mockReset();
    storeState.nodes = [
      dataset("d1", "L1", 11, "Stops (old)"),
      dataset("d2", "L2", 12, "Districts", "polygon"),
      tool("t1", "Aggregate points", { group_by_field: "name" }),
    ];
    storeState.edges = [{ id: "e1", source: "d1", target: "t1", targetHandle: "source_layer_id" }];
    layersMock.mockReturnValue({
      layers: [
        layer(11, "L1", "Stops (old)"),
        layer(12, "L2", "Districts", "polygon"),
        layer(13, "L3", "Stops (mine)"),
      ],
    });
    processesMock.mockReturnValue({ processes: { aggregate_point: aggregate }, isLoading: false });
    fieldsMock.mockReturnValue({ fieldsByLayerId: { L3: ["id", "stop_name"] }, isLoading: false });
  });

  it("lists every dataset node with what it feeds and what it runs on", async () => {
    render(<ReplaceDatasetsDialog projectId="p1" workflowName="WF" onClose={() => {}} />);

    const row1 = screen.getByTestId("replace-dataset-row-d1");
    expect(within(row1).getByText("Stops (old)")).toBeInTheDocument();
    expect(
      within(row1).getByText(`point · feeds_tools:${JSON.stringify({ tools: "Aggregate points" })}`)
    ).toBeInTheDocument();
    // The layer name equals the node label, so no "now …" line repeats it.
    expect(within(row1).queryByText(`now_layer:${JSON.stringify({ layer: "Stops (old)" })}`)).toBeNull();
    // Districts is the only polygon layer, so there is nothing to swap it for.
    expect(
      within(screen.getByTestId("replace-dataset-row-d2")).getByText("no_other_matching_layer")
    ).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "replace" })).toBeDisabled();
  });

  it("offers same-geometry project layers other than the current one", () => {
    render(<ReplaceDatasetsDialog projectId="p1" workflowName="WF" onClose={() => {}} />);

    const menu = openPicker("d1");
    expect(within(menu).getByRole("option", { name: "keep" })).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: "Stops (mine)" })).toBeInTheDocument();
    expect(within(menu).queryByRole("option", { name: "Stops (old)" })).toBeNull();
    expect(within(menu).queryByRole("option", { name: "Districts" })).toBeNull();
  });

  it("warns about a field the picked layer lacks and applies the node changes on Replace", async () => {
    const onClose = vi.fn();
    render(<ReplaceDatasetsDialog projectId="p1" workflowName="WF" onClose={onClose} />);

    fireEvent.click(within(openPicker("d1")).getByRole("option", { name: "Stops (mine)" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      `field_missing_in_layer:${JSON.stringify({ tool: "Aggregate points", field: "name", param: "Group by", layer: "Stops (mine)" })}`
    );

    fireEvent.click(screen.getByRole("button", { name: "replace" }));

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const payload = dispatchMock.mock.calls[0][0].payload;
    expect(payload.id).toBe("d1");
    expect(payload.changes.data).toMatchObject({ layerId: "L3", projectLayerId: 13, label: "Stops (mine)" });
    expect(toastSuccessMock).toHaveBeenCalledWith("datasets_replaced");
    expect(onClose).toHaveBeenCalled();
  });
});
