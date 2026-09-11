/**
 * Entry points added for templates (T7/T8): the kebab gains "Save as
 * template" (4 items total), and "Add workflow"'s split arrow menu opens the
 * template browser locked to the "workflow" kind.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/validations/project";
import type { Workflow } from "@/lib/validations/workflow";

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

const { workflowsMock } = vi.hoisted(() => ({ workflowsMock: { list: [] as unknown[] } }));

vi.mock("@/lib/api/workflows", () => ({
  useWorkflows: () => ({ workflows: workflowsMock.list, isLoading: false, mutate: vi.fn() }),
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
vi.mock("@/components/modals/WorkflowRename", () => ({ default: () => null }));
vi.mock("@/components/templates/SaveTemplateDialog", () => ({ default: () => null }));
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

const renderPanel = () =>
  render(<WorkflowsConfigPanel project={project} selectedWorkflow={null} onSelectWorkflow={vi.fn()} />);

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

  it("gives the workflow's kebab 4 actions, including Save as template", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "more_options" }));

    expect(await screen.findByText("rename")).toBeInTheDocument();
    expect(screen.getByText("duplicate")).toBeInTheDocument();
    expect(screen.getByText("save_as_template")).toBeInTheDocument();
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
      render(<WorkflowsConfigPanel project={project} selectedWorkflow={second} onSelectWorkflow={onSelectWorkflow} />);
      await expect(screen.getByText("Workflow 4").closest(".MuiListItemButton-root")).toHaveClass("Mui-selected");
      expect(onSelectWorkflow).not.toHaveBeenCalledWith(expect.objectContaining({ id: mockWorkflow.id }));
    } finally {
      workflowsMock.list = [mockWorkflow];
    }
  });

  it("opens the first workflow only when nothing is selected anywhere", () => {
    const onSelectWorkflow = vi.fn();
    render(<WorkflowsConfigPanel project={project} selectedWorkflow={null} onSelectWorkflow={onSelectWorkflow} />);
    expect(onSelectWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: mockWorkflow.id }));
  });
});
