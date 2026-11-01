import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/validations/project";
import type { Workflow } from "@/lib/validations/workflow";

import { useWorkflowCreation } from "@/hooks/workflows/useWorkflowCreation";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/api/workflows", () => ({ createWorkflow: createMock }));
vi.mock("@/components/templates/TemplateBrowser", () => ({
  default: (props: { lockedKind?: string; onUse: (template: unknown) => void }) => (
    <div data-testid="template-browser" data-locked-kind={props.lockedKind}>
      <button onClick={() => props.onUse({ id: "t1", name: "Template" })}>use-template</button>
    </div>
  ),
}));
vi.mock("@/components/templates/UseTemplateFlow", () => ({
  default: (props: { onDone: (result: { workflow_id: string | null }) => void }) => (
    <button onClick={() => props.onDone({ workflow_id: "w-tpl" })}>template-done</button>
  ),
}));

const project = { id: "p1" } as unknown as Project;
const listed = (id: string) => ({ id, name: id }) as unknown as Workflow;

describe("useWorkflowCreation", () => {
  it("creates an empty workflow and opens it once the project's list carries it", async () => {
    createMock.mockResolvedValue({ id: "w-new" });
    const onSelect = vi.fn();
    const mutate = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(
      ({ workflows }: { workflows: Workflow[] }) =>
        useWorkflowCreation({ project, workflows, mutateWorkflows: mutate, onSelectWorkflow: onSelect }),
      { initialProps: { workflows: [] as Workflow[] } }
    );

    await act(async () => {
      await result.current.createFromScratch();
    });

    expect(createMock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        name: "workflow 1",
        config: expect.objectContaining({ nodes: [], edges: [] }),
      })
    );
    expect(mutate).toHaveBeenCalled();
    expect(result.current.pendingSelectId).toBe("w-new");
    expect(onSelect).not.toHaveBeenCalled();

    rerender({ workflows: [listed("w-new")] });
    expect(onSelect).toHaveBeenCalledWith(listed("w-new"));
    expect(result.current.pendingSelectId).toBeNull();
  });

  it("offers workflow templates only and opens the workflow a template made", async () => {
    const onSelect = vi.fn();
    const mutate = vi.fn(async () => undefined);
    function Host({ workflows }: { workflows: Workflow[] }) {
      const creation = useWorkflowCreation({
        project,
        workflows,
        mutateWorkflows: mutate,
        onSelectWorkflow: onSelect,
      });
      return (
        <>
          <button onClick={creation.openTemplateBrowser}>open-templates</button>
          {creation.dialogs}
        </>
      );
    }
    const user = userEvent.setup();
    const { rerender } = render(<Host workflows={[]} />);
    expect(screen.queryByTestId("template-browser")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "open-templates" }));
    // getAttribute rather than jest-dom's `toHaveAttribute`: the repo's ESLint
    // setup reads it as Playwright's (async) matcher of the same name.
    expect(screen.getByTestId("template-browser").getAttribute("data-locked-kind")).toBe("workflow");

    await user.click(screen.getByRole("button", { name: "use-template" }));
    expect(screen.queryByTestId("template-browser")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "template-done" }));
    expect(mutate).toHaveBeenCalled();

    rerender(<Host workflows={[listed("w-tpl")]} />);
    expect(onSelect).toHaveBeenCalledWith(listed("w-tpl"));
  });
});
