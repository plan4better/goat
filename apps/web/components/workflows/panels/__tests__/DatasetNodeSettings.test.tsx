/**
 * Workflows take feature layers and tables, not raster layers (a raster file or a map service): a dataset step's
 * pickers offer none, and a step that already holds one asks geoapi and processes nothing about it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentItem } from "@/lib/validations/content";
import type { WorkflowNode } from "@/lib/validations/workflow";

import DatasetNodeSettings from "@/components/workflows/panels/DatasetNodeSettings";

const { asked, projectLayers, datasets, picker } = vi.hoisted(() => ({
  // The datasets the panel asks about ("" or undefined asks nothing): their fields and their feature count.
  asked: { fields: [] as Array<string | undefined>, count: [] as Array<string | undefined> },
  projectLayers: { current: [] as unknown[] },
  datasets: new Map<string, unknown>(),
  picker: { canPick: undefined as ((item: ContentItem) => boolean) | undefined, label: "" },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next/navigation", () => ({ useParams: () => ({ projectId: "p1" }) }));
vi.mock("react-redux", () => ({ useDispatch: () => vi.fn(), useSelector: () => undefined }));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));
vi.mock("@/lib/api/layers", () => ({ useDataset: (id: string) => ({ dataset: datasets.get(id) }) }));
vi.mock("@/lib/api/processes", () => ({
  useFeatureCount: (id?: string) => {
    asked.count.push(id);
    return { featureCount: undefined };
  },
}));
vi.mock("@/hooks/map/useFilterFields", () => ({
  useFilterFields: (id?: string) => {
    asked.fields.push(id);
    return { fields: [], fieldInfos: {}, isLoading: false };
  },
}));
vi.mock("@/hooks/map/LayerPanelHooks", () => ({
  useFilteredProjectLayers: () => ({ layers: projectLayers.current }),
}));
vi.mock("@/hooks/workflows/useStepFieldFocus", () => ({ useStepFieldFocus: () => undefined }));
vi.mock("@/components/workflows/issues/WorkflowIssuesContext", () => ({ useStepIssues: () => [] }));
vi.mock("@/components/workflows/issues/StepIssuesSummary", () => ({ default: () => null }));
vi.mock("@/components/map/panels/filter/FilterPanel", () => ({ FilterPanel: () => null }));
vi.mock("@/components/map/panels/common/Selector", () => ({
  default: ({ items }: { items: Array<{ label: string }> }) => (
    <ul data-testid="layer-selector">
      {items.map((item) => (
        <li key={item.label}>{item.label}</li>
      ))}
    </ul>
  ),
}));
vi.mock("@/components/addLayer/DatasetPickerDialog", () => ({
  default: (props: { canPick?: (item: ContentItem) => boolean; cannotPickLabel?: string }) => {
    picker.canPick = props.canPick;
    picker.label = props.cannotPickLabel ?? "";
    return null;
  },
}));

const RASTER_ID = "22222222-2222-4222-8222-222222222222";
const STOPS_ID = "11111111-1111-4111-8111-111111111111";

const step = (data: Record<string, unknown> = {}) =>
  ({
    id: "dataset-1",
    type: "dataset",
    position: { x: 0, y: 0 },
    data: { type: "dataset", label: "Dataset", ...data },
  }) as unknown as WorkflowNode;

beforeEach(() => {
  asked.fields = [];
  asked.count = [];
  datasets.clear();
  picker.canPick = undefined;
  picker.label = "";
  projectLayers.current = [
    { id: 5, layer_id: STOPS_ID, name: "Stops", type: "feature", feature_layer_geometry_type: "point" },
    { id: 7, layer_id: "33333333-3333-4333-8333-333333333333", name: "Visits", type: "table" },
    { id: 6, layer_id: RASTER_ID, name: "DEM", type: "raster" },
    { id: 8, layer_id: "44444444-4444-4444-8444-444444444444", name: "Orthophoto", type: "raster" },
  ];
});

describe("DatasetNodeSettings and raster layers", () => {
  it("the From project picker offers feature layers and tables, no raster layer", async () => {
    const user = userEvent.setup();
    render(<DatasetNodeSettings node={step()} onBack={() => {}} />);
    await user.click(screen.getByRole("button", { name: "add_dataset" }));
    await user.click(screen.getByRole("menuitem", { name: "from_project" }));
    const offered = screen.getByTestId("layer-selector").textContent;
    expect(offered).toContain("Stops");
    expect(offered).toContain("Visits");
    expect(offered).not.toContain("DEM");
    expect(offered).not.toContain("Orthophoto");
  });

  it("My datasets refuses a raster dataset and says why", () => {
    render(<DatasetNodeSettings node={step()} onBack={() => {}} />);
    expect(picker.canPick?.({ id: RASTER_ID, layer_type: "raster" } as ContentItem)).toBe(false);
    expect(picker.canPick?.({ id: STOPS_ID, layer_type: "feature" } as ContentItem)).toBe(true);
    expect(picker.canPick?.({ id: STOPS_ID, layer_type: "table" } as ContentItem)).toBe(true);
    expect(picker.label).toBe("workflow_raster_not_supported");
  });

  it("a step that holds a raster layer asks for no fields and no feature count", () => {
    datasets.set(RASTER_ID, { id: RASTER_ID, name: "DEM", type: "raster" });
    render(
      <DatasetNodeSettings
        node={step({ layerId: RASTER_ID, projectLayerId: 6, layerType: "raster" })}
        onBack={() => {}}
      />
    );
    expect(screen.getByText("DEM")).toBeInTheDocument();
    expect(asked.fields.filter(Boolean)).toEqual([]);
    expect(asked.count.filter(Boolean)).toEqual([]);
  });

  it("a feature layer's step asks for both", () => {
    datasets.set(STOPS_ID, {
      id: STOPS_ID,
      name: "Stops",
      type: "feature",
      feature_layer_geometry_type: "point",
    });
    render(
      <DatasetNodeSettings
        node={step({ layerId: STOPS_ID, projectLayerId: 5, layerType: "feature" })}
        onBack={() => {}}
      />
    );
    expect(asked.fields).toContain(STOPS_ID);
    expect(asked.count).toContain(STOPS_ID);
  });
});
