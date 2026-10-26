/**
 * Entry points added for templates (T7/T8): the kebab gains "Save as
 * template" (4 items total), and "Add workflow"'s split arrow menu opens the
 * template browser locked to the "workflow" kind.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { ChangedElsewhereError } from "@/lib/api/changedElsewhere";
import { createWorkflow } from "@/lib/api/workflows";
import type { Project } from "@/lib/validations/project";
import type { Workflow } from "@/lib/validations/workflow";

import { useWorkflowCreation } from "@/hooks/workflows/useWorkflowCreation";

import WorkflowsConfigPanel from "@/components/workflows/panels/WorkflowsConfigPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

const mockWorkflow: Workflow = {
  id: "w1",
  name: "Workflow 1",
  description: null,
  is_default: false,
  project_id: "p1",
  config: { nodes: [], edges: [] },
} as unknown as Workflow;

const { workflowsMock, renameMock, listMutateMock, toastErrorMock } = vi.hoisted(() => ({
  workflowsMock: { list: [] as unknown[] },
  renameMock: vi.fn(),
  listMutateMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("react-toastify", () => ({ toast: { error: toastErrorMock, success: vi.fn() } }));

vi.mock("@/lib/api/workflows", () => ({
  useWorkflows: () => ({ workflows: workflowsMock.list, isLoading: false, mutate: listMutateMock }),
  createWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  duplicateWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
}));

vi.mock("@/components/map/panels/layer/ProjectLayerTree", () => ({
  AddLayerButton: () => null,
  ProjectLayerTree: () => null,
}));

vi.mock("@/components/modals/Confirm", () => ({ default: () => null }));
vi.mock("@/components/modals/WorkflowRename", () => ({
  default: ({ open, onRename }: { open: boolean; onRename: (name: string) => void }) =>
    open ? <button onClick={() => onRename("Renamed workflow")}>confirm-rename</button> : null,
}));
vi.mock("@/components/templates/SaveTemplateDialog", () => ({ default: () => null }));
vi.mock("@/components/workflows/dialogs/ReplaceDatasetsDialog", () => ({ default: () => null }));
vi.mock("@/components/templates/UseTemplateFlow", () => ({ default: () => null }));

const templateBrowserProps = vi.fn();
vi.mock("@/components/templates/TemplateBrowser", () => ({
  default: (props: { open?: boolean; lockedKind?: string }) => {
    templateBrowserProps(props);
    return (
      <div
        data-testid="template-browser"
        data-open={String(!!props.open)}
        data-locked-kind={props.lockedKind}
      />
    );
  },
}));

const project = { id: "p1" } as unknown as Project;

workflowsMock.list = [mockWorkflow];

/** The panel as the layout hosts it: creating a workflow is lifted out of it, and its dialogs mount next to it. */
function Harness({
  selectedWorkflow,
  onSelectWorkflow,
}: {
  selectedWorkflow: Workflow | null;
  onSelectWorkflow: (workflow: Workflow | null) => void;
}) {
  const creation = useWorkflowCreation({
    project,
    workflows: workflowsMock.list as Workflow[],
    mutateWorkflows: async () => undefined,
    onSelectWorkflow,
  });
  return (
    <>
      <WorkflowsConfigPanel
        project={project}
        selectedWorkflow={selectedWorkflow}
        onSelectWorkflow={onSelectWorkflow}
        onRenameWorkflow={renameMock}
        creation={creation}
      />
      {creation.dialogs}
    </>
  );
}

const renderPanel = () => render(<Harness selectedWorkflow={null} onSelectWorkflow={vi.fn()} />);

describe("WorkflowsConfigPanel template entry points", () => {
  it("does not mount the template browser until it is opened", () => {
    // A mounted-but-closed browser still runs its own template/space/pin
    // requests, on every panel mount.
    renderPanel();
    expect(screen.queryByTestId("template-browser")).not.toBeInTheDocument();
    expect(templateBrowserProps).not.toHaveBeenCalled();
  });

  it("opens the template browser (still locked to workflow) from the New menu", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "new" }));
    await user.click(await screen.findByRole("menuitem", { name: "from_template" }));

    const browser = screen.getByTestId("template-browser");
    expect(browser.dataset.open).toBe("true");
    expect(browser.dataset.lockedKind).toBe("workflow");
  });

  it("offers from scratch and from template from one New menu", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "new" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["from_scratch", "from_template"]);
  });

  it("gives the workflow's kebab 5 actions, including Save as template and Replace datasets", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "more_options" }));

    expect(await screen.findByText("rename")).toBeInTheDocument();
    expect(screen.getByText("duplicate")).toBeInTheDocument();
    expect(screen.getByText("save_as_template")).toBeInTheDocument();
    expect(screen.getByText("replace_datasets")).toBeInTheDocument();
    expect(screen.getByText("delete")).toBeInTheDocument();
  });

  it("follows the workflow the store already selected instead of opening the first one", async () => {
    // The map page's `?workflow=` intent selects a workflow in the store
    // before this panel mounts; the panel must not override it with its
    // own default of "the first in the list".
    const second = { ...mockWorkflow, id: "wf-2", name: "Workflow 4" } as unknown as Workflow;
    workflowsMock.list = [mockWorkflow, second];
    const onSelectWorkflow = vi.fn();
    try {
      render(<Harness selectedWorkflow={second} onSelectWorkflow={onSelectWorkflow} />);
      await expect(screen.getByText("Workflow 4").closest(".MuiListItemButton-root")).toHaveClass(
        "Mui-selected"
      );
      expect(onSelectWorkflow).not.toHaveBeenCalledWith(expect.objectContaining({ id: mockWorkflow.id }));
    } finally {
      workflowsMock.list = [mockWorkflow];
    }
  });

  it("opens the first workflow only when nothing is selected anywhere", () => {
    const onSelectWorkflow = vi.fn();
    render(<Harness selectedWorkflow={null} onSelectWorkflow={onSelectWorkflow} />);
    expect(onSelectWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: mockWorkflow.id }));
  });

  it("renames with the new name only, through the editor's saves", async () => {
    // Sending the list's copy of the config could revert newer canvas edits,
    // and core refuses a damaged config: such a workflow could not be renamed.
    // A rename moves the workflow to a new revision, so it goes in turn with
    // the autosave (`useWorkflowAutosave().rename`).
    renameMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "more_options" }));
    await user.click(await screen.findByText("rename"));
    await user.click(screen.getByRole("button", { name: "confirm-rename" }));

    expect(renameMock).toHaveBeenCalledWith("w1", "Renamed workflow");
  });

  it("says when a workflow it renames changed elsewhere, and reads the list again", async () => {
    renameMock.mockRejectedValueOnce(new ChangedElsewhereError(8, null, null));
    listMutateMock.mockClear();
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "more_options" }));
    await user.click(await screen.findByText("rename"));
    await user.click(screen.getByRole("button", { name: "confirm-rename" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("workflow_changed_elsewhere"));
    expect(listMutateMock).toHaveBeenCalledWith();
  });

  it("creates from scratch through the same flow the empty-project card uses", async () => {
    vi.mocked(createWorkflow).mockResolvedValueOnce({ id: "w-new" } as Workflow);
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "new" }));
    await user.click(await screen.findByRole("menuitem", { name: "from_scratch" }));

    expect(createWorkflow).toHaveBeenCalledWith("p1", expect.objectContaining({ name: "workflow 2" }));
  });
});
