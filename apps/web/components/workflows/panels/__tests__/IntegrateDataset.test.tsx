import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { ToolNodeData } from "@/lib/validations/workflow";
import {
  type DatasetConnection,
  integrationColumns,
  integrationNeedsArea,
} from "@/lib/workflows/datasetConnection";

import IntegrateDatasetSettings from "@/components/workflows/panels/IntegrateDatasetSettings";
import WorkflowsNodesPanel from "@/components/workflows/panels/WorkflowsNodesPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ projectId: "p1" }) }));

const dispatch = vi.fn();
// Stable values: fresh ones per render would re-run the panel's effects forever.
const { selected, described, layers, bundles, edges } = vi.hoisted(() => ({
  selected: [] as unknown[],
  described: {
    process: { id: "fetch_data", title: "Fetch data", description: "docstring", inputs: {} },
    isLoading: false,
  },
  layers: { layers: [] },
  bundles: {},
  edges: [],
}));
vi.mock("react-redux", () => ({ useDispatch: () => dispatch, useSelector: () => selected }));
vi.mock("@/hooks/map/useOgcProcesses", () => ({
  useCategorizedProcesses: () => ({ processes: [], isLoading: false, error: null }),
  useProcessDescription: () => described,
}));
vi.mock("@/hooks/map/LayerPanelHooks", () => ({ useFilteredProjectLayers: () => layers }));
vi.mock("@/hooks/map/useProjectBundleKinds", () => ({ useProjectBundleKinds: () => bundles }));
vi.mock("@/lib/api/workflows", () => ({
  predictNodeSchema: vi.fn(),
  useTempLayerFeatures: () => ({ data: undefined }),
  useWorkflowMetadata: () => ({ metadata: undefined }),
}));
vi.mock("@/components/workflows/context/WorkflowExecutionContext", () => ({
  useWorkflowExecutionContext: () => ({ nodeStatuses: {}, nodeExecutionInfo: {}, tempLayerIds: {} }),
}));
vi.mock("@xyflow/react", () => ({ useEdges: () => edges }));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));
vi.mock("@/lib/api/processes", () => ({ useJobs: () => ({ jobs: undefined }), dismissJob: vi.fn() }));
vi.mock("@/components/workflows/panels/WorkflowNodeSettings", () => ({ default: () => null }));

const dialogProps = vi.hoisted(() => ({ last: undefined as Record<string, unknown> | undefined }));
vi.mock("@/components/addLayer/AddLayerDialog", () => ({
  default: (props: Record<string, unknown>) => {
    dialogProps.last = props;
    return null;
  },
}));

const area = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  ],
};
const empty: ToolNodeData = {
  type: "tool",
  processId: "fetch_data",
  label: "fetch_data",
  config: {},
  status: "idle",
};
const chosen: ToolNodeData = {
  ...empty,
  label: "OSM points",
  config: {
    source: "osm",
    feature_type: "points",
    area,
    tag_filters: [{ key: "amenity", values: ["school"] }],
  },
  outputGeometryType: "point",
  outputFields: [{ name: "amenity", type: "VARCHAR" }],
  areaChoice: { kind: "region", nutsIds: ["DE2"], names: { DE2: "Bayern" } },
};

describe("Integrate dataset node", () => {
  it("is dragged from Data I/O as a fetch_data tool", () => {
    const onDragStart = vi.fn();
    render(<WorkflowsNodesPanel config={null} selectedNodeId={null} onDragStart={onDragStart} />);
    const tile = screen.getByText("fetch_data").parentElement!;
    // Add layer › Connect service's icon
    const { container } = render(<Icon iconName={ICON_NAME.LINK} />);
    expect(container.querySelector("svg")?.innerHTML).toBeTruthy();
    expect(tile.querySelector("svg")?.innerHTML).toBe(container.querySelector("svg")?.innerHTML);
    fireEvent.dragStart(screen.getByText("fetch_data"));
    expect(onDragStart).toHaveBeenCalledWith(expect.anything(), "tool", "fetch_data");
  });

  it("describes itself in the panel, not with the tool docstring", async () => {
    const { default: Settings } = await vi.importActual<
      typeof import("@/components/workflows/panels/WorkflowNodeSettings")
    >("@/components/workflows/panels/WorkflowNodeSettings");
    render(
      <Settings node={{ id: "n1", type: "tool", position: { x: 0, y: 0 }, data: empty }} onBack={vi.fn()} />
    );
    expect(screen.getByText("fetch_data")).toBeInTheDocument();
    expect(screen.getByText("fetch_data_description")).toBeInTheDocument();
    expect(screen.queryByText("docstring")).not.toBeInTheDocument();
    expect(screen.queryByText("execution_status")).not.toBeInTheDocument();
  });

  it("asks for an area until a choice is saved, then predicts its columns", () => {
    expect(integrationNeedsArea(empty)).toBe(true);
    expect(integrationNeedsArea(chosen)).toBe(false);
    expect(integrationNeedsArea({ ...empty, processId: "buffer" })).toBe(false);
    expect(integrationColumns(empty)).toBeUndefined();
    expect(integrationColumns(chosen)).toEqual({ amenity: "VARCHAR", geometry: "GEOMETRY(POINT)" });
  });

  it("saves the dialog's choice on the node and reopens on it", async () => {
    render(<IntegrateDatasetSettings nodeId="n1" data={empty} />);
    expect(dialogProps.last?.source).toBeNull();
    expect(screen.getByText("source")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "fetch_data_choose_button" }));
    expect(dialogProps.last?.source).toBe("connect");
    const workflow = dialogProps.last?.workflow as {
      initial?: DatasetConnection;
      onUse: (c: DatasetConnection) => void;
    };
    expect(workflow.initial).toBeUndefined();

    workflow.onUse({
      processId: "fetch_data",
      params: chosen.config,
      summary: "OSM points",
      geometryType: "point",
      fields: chosen.outputFields!,
      areaChoice: chosen.areaChoice,
    });
    const action = dispatch.mock.calls.at(-1)?.[0];
    expect(action.payload.changes.data).toMatchObject({
      label: "OSM points",
      config: chosen.config,
      outputGeometryType: "point",
      outputFields: chosen.outputFields,
      areaChoice: chosen.areaChoice,
    });

    render(<IntegrateDatasetSettings nodeId="n1" data={chosen} />);
    expect(screen.getByText("details")).toBeInTheDocument();
    expect(screen.getByText("OSM points")).toBeInTheDocument();
    expect(screen.getByText("fetch_features_area: Bayern")).toBeInTheDocument();
    expect(screen.getByText("amenity = school")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "edit" }));
    expect((dialogProps.last?.workflow as { initial?: DatasetConnection }).initial).toMatchObject({
      params: chosen.config,
      summary: "OSM points",
      geometryType: "point",
      fields: chosen.outputFields,
      areaChoice: chosen.areaChoice,
    });
  });
});
