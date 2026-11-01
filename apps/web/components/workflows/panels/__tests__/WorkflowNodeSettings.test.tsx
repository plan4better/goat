/**
 * The step settings panel shows the issues of its step: a setting's message
 * under that setting, everything else at the top. Asked by the issue list or a
 * step badge, it opens the setting's section and puts the cursor in it.
 */
import { configureStore } from "@reduxjs/toolkit";
import { render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { workflowReducer } from "@/lib/store/workflow/slice";
import type { WorkflowNode } from "@/lib/validations/workflow";

import { makeIssue } from "@/components/workflows/issues/__tests__/issueFixtures";
import WorkflowNodeSettings from "@/components/workflows/panels/WorkflowNodeSettings";

const { issuesByNode, focusState, processState } = vi.hoisted(() => ({
  issuesByNode: new Map<string, unknown[]>(),
  focusState: { request: null as null | { nodeId: string; field: string | null; seq: number } },
  processState: { process: undefined as unknown },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ projectId: "p1" }) }));
vi.mock("@xyflow/react", () => ({ useEdges: () => [] }));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));
vi.mock("@/lib/api/workflows", () => ({
  predictNodeSchema: vi.fn(),
  useTempLayerFeatures: () => ({ data: undefined }),
  useWorkflowMetadata: () => ({ metadata: undefined }),
}));
vi.mock("@/hooks/map/LayerPanelHooks", () => ({ useFilteredProjectLayers: () => ({ layers: [] }) }));
vi.mock("@/hooks/map/useOgcProcesses", () => ({
  useProcessDescription: () => ({ process: processState.process, isLoading: false }),
}));
vi.mock("@/hooks/map/useProjectBundleKinds", () => ({ useProjectBundleKinds: () => ({}) }));
vi.mock("@/components/workflows/context/WorkflowExecutionContext", () => ({
  useWorkflowExecutionContext: () => ({
    nodeStatuses: {},
    nodeExecutionInfo: {},
    tempLayerIds: {},
    onSaveNode: undefined,
  }),
}));
// The inputs themselves are covered elsewhere; here each is a plain field named by its title.
vi.mock("@/components/workflows/inputs/VariableAwareInput", () => ({
  default: ({ input }: { input: { title: string } }) => <input aria-label={input.title} />,
}));
vi.mock("@/components/workflows/panels/DatasetNodeSettings", () => ({ default: () => null }));
vi.mock("@/components/workflows/panels/IfNodeSettings", () => ({ default: () => null }));
vi.mock("@/components/workflows/panels/SqlToolSettings", () => ({ default: () => null }));
vi.mock("@/components/workflows/dialogs/SaveDatasetDialog", () => ({ default: () => null }));
vi.mock("@/components/map/panels/Container", () => ({
  default: ({ header, body }: { header?: React.ReactNode; body?: React.ReactNode }) => (
    <div>
      {header}
      {body}
    </div>
  ),
}));
vi.mock("@/components/map/panels/common/ToolsHeader", () => ({
  default: ({ title }: { title?: string }) => <h2>{title}</h2>,
}));
vi.mock("@/components/map/panels/common/SectionHeader", () => ({
  default: ({ label }: { label: string }) => <div>{label}</div>,
}));
// Like the real one, but closed advanced options are not mounted, so "opens them first" is observable.
vi.mock("@/components/map/panels/common/SectionOptions", () => ({
  default: ({
    baseOptions,
    advancedOptions,
    collapsed,
  }: {
    baseOptions: React.ReactNode;
    advancedOptions?: React.ReactNode;
    collapsed?: boolean;
  }) => (
    <div>
      {baseOptions}
      {!collapsed && advancedOptions}
    </div>
  ),
}));
vi.mock("@/components/map/panels/toolbox/generic/inputs/BundleInput", () => ({
  DEFAULT_NETWORK_BUNDLE: "default_network",
}));
vi.mock("@/components/map/panels/toolbox/generic/inputs/OevStationConfigInput", () => ({
  default: () => null,
}));
vi.mock("@/components/map/panels/toolbox/generic/inputs/RepeatableObjectInput", () => ({
  getObjectDefaults: () => ({}),
  processObjectProperties: () => [],
}));
vi.mock("@/components/workflows/issues/WorkflowIssuesContext", () => ({
  useStepIssues: (nodeId: string) => issuesByNode.get(nodeId) ?? [],
  useWorkflowIssuesContext: () => ({
    issues: [],
    byNode: issuesByNode,
    blockingCount: 0,
    damaged: [],
    focus: vi.fn(),
    focusRequest: focusState.request,
  }),
}));
vi.mock("@/lib/utils/workflowIssueText", () => ({
  issueText: (_t: unknown, issue: { message: string }) => issue.message,
}));

const buffer = {
  id: "buffer",
  title: "Buffer",
  description: "Buffers features.",
  "x-ui-sections": [{ id: "configuration", order: 1, label: "Configuration", icon: "settings" }],
  inputs: {
    input_layer_id: {
      title: "Input layer",
      schema: { type: "string", "x-ui": { widget: "layer-selector", section: "input", field_order: 1 } },
      minOccurs: 1,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
    distance: {
      title: "Distance",
      schema: { type: "number", "x-ui": { section: "configuration", field_order: 1 } },
      minOccurs: 1,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
    note: {
      title: "Note",
      schema: { type: "string", "x-ui": { section: "configuration", field_order: 2, advanced: true } },
      minOccurs: 0,
      maxOccurs: 1,
      keywords: [],
      metadata: [],
    },
  },
  outputs: {},
};

const toolNode = {
  id: "tool-1",
  type: "tool",
  position: { x: 0, y: 0 },
  data: { type: "tool", processId: "buffer", label: "Buffer", config: {}, status: "idle" },
} as WorkflowNode;

const exportNode = {
  id: "export-1",
  type: "export",
  position: { x: 0, y: 0 },
  data: {
    type: "export",
    label: "Export",
    datasetName: "",
    addToProject: true,
    overwritePrevious: false,
    status: "idle",
  },
} as WorkflowNode;

const renderSettings = (node: WorkflowNode) =>
  render(
    <Provider store={configureStore({ reducer: { workflow: workflowReducer } })}>
      <WorkflowNodeSettings node={node} onBack={vi.fn()} />
    </Provider>
  );

const distanceRequired = makeIssue({
  code: "setting_required",
  node_ids: ["tool-1"],
  field: "distance",
  message: "Distance needs a value.",
});

describe("WorkflowNodeSettings issues", () => {
  beforeEach(() => {
    issuesByNode.clear();
    focusState.request = null;
    processState.process = buffer;
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows a setting's issue under that setting", async () => {
    issuesByNode.set("tool-1", [distanceRequired]);
    renderSettings(toolNode);
    const field = screen.getByLabelText("Distance").closest("[data-field]");
    await expect(field).toHaveAttribute("data-field", "distance");
    expect(field).toHaveTextContent("Distance needs a value.");
    expect(screen.queryByTestId("step-issues")).not.toBeInTheDocument();
  });

  it("lists at the top what no setting on screen carries", () => {
    issuesByNode.set("tool-1", [
      makeIssue({
        code: "setting_invalid",
        node_ids: ["tool-1"],
        message: "The settings of this step are not accepted.",
      }),
      makeIssue({
        code: "input_not_connected",
        node_ids: ["tool-1"],
        field: "input_layer_id",
        message: "Input layer is not connected.",
      }),
      makeIssue({
        code: "setting_required",
        node_ids: ["tool-1"],
        field: "note",
        message: "Note needs a value.",
      }),
    ]);
    renderSettings(toolNode);

    // Note sits in the closed advanced options.
    expect(screen.queryByLabelText("Note")).not.toBeInTheDocument();
    const summary = screen.getByTestId("step-issues");
    expect(within(summary).getByText("The settings of this step are not accepted.")).toBeInTheDocument();
    expect(within(summary).getByText("Input layer is not connected.")).toBeInTheDocument();
    expect(within(summary).getByText("Note needs a value.")).toBeInTheDocument();
  });

  it("goes to the setting a focus request names", async () => {
    issuesByNode.set("tool-1", [distanceRequired]);
    focusState.request = { nodeId: "tool-1", field: "distance", seq: 1 };
    renderSettings(toolNode);
    await waitFor(() => expect(screen.getByLabelText("Distance")).toHaveFocus());
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("opens the advanced options to reach a setting there", async () => {
    focusState.request = { nodeId: "tool-1", field: "note", seq: 1 };
    renderSettings(toolNode);
    await waitFor(() => expect(screen.getByLabelText("Note")).toHaveFocus());
  });

  it("leaves the panel alone for a request about another step", async () => {
    focusState.request = { nodeId: "tool-2", field: "distance", seq: 1 };
    renderSettings(toolNode);
    await expect(screen.getByLabelText("Distance")).not.toHaveFocus();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("shows an export's missing name under the name field, which is marked required", async () => {
    issuesByNode.set("export-1", [
      makeIssue({
        code: "export_name_missing",
        node_ids: ["export-1"],
        field: "datasetName",
        message: "The dataset to save has no name.",
      }),
    ]);
    renderSettings(exportNode);
    const field = screen.getByPlaceholderText("enter_dataset_name").closest("[data-field]");
    await expect(field).toHaveAttribute("data-field", "datasetName");
    expect(field).toHaveTextContent("The dataset to save has no name.");
    expect(within(field as HTMLElement).getByText("required_field_marker")).toBeInTheDocument();
    // The panel's own empty-name check is gone: the issue is the one message.
    expect(screen.queryByText("dataset_name_required")).not.toBeInTheDocument();
  });

  it("shows a missing target under the dataset picker when adding to an existing dataset", async () => {
    issuesByNode.set("export-1", [
      makeIssue({
        code: "export_target_missing",
        node_ids: ["export-1"],
        field: "targetLayerId",
        message: "Pick the dataset the rows are added to.",
      }),
    ]);
    renderSettings({ ...exportNode, data: { ...exportNode.data, destination: "existing" } } as WorkflowNode);
    const field = screen.getByText("append_choose_target").closest("[data-field]");
    await expect(field).toHaveAttribute("data-field", "targetLayerId");
    expect(field).toHaveTextContent("Pick the dataset the rows are added to.");
    expect(screen.queryByTestId("step-issues")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("enter_dataset_name")).not.toBeInTheDocument();
  });
});
