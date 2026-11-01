import { configureStore } from "@reduxjs/toolkit";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Node } from "@xyflow/react";
import React, { useMemo, useState } from "react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { workflowReducer } from "@/lib/store/workflow/slice";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import CanvasToolbar from "@/components/workflows/canvas/CanvasToolbar";
import { WorkflowIssuesProvider, summarizeIssues } from "@/components/workflows/issues/WorkflowIssuesContext";

vi.mock("react-i18next", async () => {
  const { commonI18n } = await import("@/i18n/__tests__/commonI18n");
  const i18n = commonI18n("en");
  const t = i18n.getFixedT("en", "common");
  return { useTranslation: () => ({ t, i18n }) };
});

const NODES: Node[] = [
  { id: "dataset-1", type: "dataset", position: { x: 0, y: 0 }, data: { type: "dataset", label: "Schools" } },
  {
    id: "tool-1",
    type: "tool",
    position: { x: 300, y: 0 },
    data: { type: "tool", processId: "buffer", label: "buffer", config: {} },
  },
  {
    id: "tool-2",
    type: "tool",
    position: { x: 600, y: 0 },
    data: { type: "tool", processId: "clip", label: "clip", config: {} },
  },
];

const make = (
  code: string,
  level: WorkflowIssue["level"],
  nodeIds: string[],
  params: Record<string, unknown> = {},
  source: WorkflowIssue["source"] = "check"
): WorkflowIssue => ({ code, level, node_ids: nodeIds, field: null, message: code, params, source });

const noDistance = make("setting_required", "error", ["tool-1"], { step: "Buffer", label: "Distance" });
const notConnected = make("input_not_connected", "error", ["tool-2"], {
  step: "Clip",
  label: "Overlay layer",
});
const lonely = make("step_not_connected", "warning", ["dataset-1"], { step: "Schools" });
const removedStep = make("connection_to_removed_step", "error", []);
const runError = make("run_failed", "error", ["tool-1"], { step: "Buffer", error: "Out of memory" }, "run");

interface HarnessProps {
  initial: WorkflowIssue[];
  /** The issues processes answers a run with; none = the run starts. */
  refusal?: WorkflowIssue[];
  focus: (issue: WorkflowIssue) => void;
  checkFailed?: boolean;
  recheck?: () => void;
}

/** The toolbar with an issue list it can be refused into, as WorkflowsLayout wires it. */
function Harness({ initial, refusal = [], focus, checkFailed, recheck }: HarnessProps) {
  const [issues, setIssues] = useState(initial);
  const value = useMemo(
    () => ({ ...summarizeIssues(issues), issues, focus, focusRequest: null, checkFailed, recheck }),
    [issues, focus, checkFailed, recheck]
  );
  const onRun = async () => {
    if (refusal.length === 0) return false;
    setIssues(refusal);
    return true;
  };
  return (
    <WorkflowIssuesProvider value={value}>
      <CanvasToolbar
        activeTool="select"
        onToolChange={vi.fn()}
        canUndo={false}
        canRedo={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onRun={onRun}
        canRun
      />
    </WorkflowIssuesProvider>
  );
}

const renderToolbar = (props: Omit<HarnessProps, "focus"> & { focus?: HarnessProps["focus"] }) => {
  const store = configureStore({
    reducer: { workflow: workflowReducer },
    preloadedState: { workflow: { ...workflowReducer(undefined, { type: "init" }), nodes: NODES } },
  });
  const focus = props.focus ?? vi.fn();
  render(
    <Provider store={store}>
      <Harness {...props} focus={focus} />
    </Provider>
  );
  return focus;
};

describe("CanvasToolbar issues", () => {
  it("disables Run while issues block it and says how many to fix", async () => {
    renderToolbar({ initial: [notConnected, noDistance, lonely] });
    await expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByLabelText("Fix 2 issues to run")).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "3 issues" })).toHaveAttribute("data-tone", "blocking");
  });

  it("keeps Run enabled with warnings only and shows them muted", async () => {
    renderToolbar({ initial: [lonely] });
    await expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    await expect(screen.getByRole("button", { name: "1 issue" })).toHaveAttribute("data-tone", "warning");
  });

  it("keeps Run enabled after a failed run and shows its errors in red", async () => {
    renderToolbar({ initial: [runError] });
    await expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    await expect(screen.getByRole("button", { name: "1 issue" })).toHaveAttribute("data-tone", "run");
  });

  it("shows no chip without issues", () => {
    renderToolbar({ initial: [] });
    expect(screen.queryByRole("button", { name: /issue/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not checked" })).not.toBeInTheDocument();
  });

  it("says the steps are not checked when the check failed and checks again on a click", async () => {
    const recheck = vi.fn();
    renderToolbar({ initial: [], checkFailed: true, recheck });

    await userEvent.setup().click(screen.getByRole("button", { name: "Not checked" }));

    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it("opens the list: workflow-wide issues first, then each step in canvas order", async () => {
    renderToolbar({ initial: [notConnected, lonely, removedStep, noDistance] });
    await userEvent.setup().click(screen.getByRole("button", { name: "4 issues" }));
    const headings = await screen.findAllByRole("heading");
    expect(headings.map((h) => h.textContent)).toEqual(["Whole workflow", "Schools", "Buffer", "Clip"]);
  });

  it("takes the editor to the step of a clicked row and closes the list", async () => {
    const user = userEvent.setup();
    const focus = renderToolbar({ initial: [noDistance] });
    await user.click(screen.getByRole("button", { name: "1 issue" }));
    await user.click(await screen.findByRole("button", { name: "Distance needs a value." }));
    expect(focus).toHaveBeenCalledWith(noDistance);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Buffer" })).not.toBeInTheDocument());
  });

  it("opens the list on the issues of a run processes refused", async () => {
    renderToolbar({ initial: [], refusal: [notConnected] });
    await userEvent.setup().click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("heading", { name: "Clip" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Overlay layer is not connected." })
    ).toBeInTheDocument();
  });
});
