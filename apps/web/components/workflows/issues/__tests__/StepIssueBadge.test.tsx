import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import StepIssueBadge, { BADGE_OPEN_DELAY_MS } from "@/components/workflows/issues/StepIssueBadge";

import { makeIssue } from "./issueFixtures";

const { issuesByNode, focusMock } = vi.hoisted(() => ({
  issuesByNode: new Map<string, unknown[]>(),
  focusMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count !== undefined ? `${key}:${options.count}` : key,
  }),
}));

vi.mock("@/components/workflows/issues/WorkflowIssuesContext", () => ({
  useStepIssues: (nodeId: string) => issuesByNode.get(nodeId) ?? [],
  useWorkflowIssuesContext: () => ({
    issues: [],
    byNode: issuesByNode,
    blockingCount: 0,
    damaged: [],
    focus: focusMock,
    focusRequest: null,
  }),
}));

vi.mock("@/lib/utils/workflowIssueText", () => ({
  issueText: (_t: unknown, issue: { message: string }) => issue.message,
}));

const error = makeIssue({
  code: "input_not_connected",
  node_ids: ["n1"],
  field: "input_layer_id",
  message: "Buffer: the input layer is not connected.",
});
const warning = makeIssue({
  code: "step_not_connected",
  level: "warning",
  node_ids: ["n1"],
  message: "Buffer is not connected to anything.",
});
const runError = makeIssue({
  code: "run_failed",
  source: "run",
  node_ids: ["n1"],
  message: "Buffer failed: Binder Error",
});

const pill = (count: number) => screen.getByRole("button", { name: `workflow_issues_count:${count}` });

describe("StepIssueBadge", () => {
  beforeEach(() => {
    issuesByNode.clear();
    focusMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing for a step without issues", () => {
    const { container } = render(<StepIssueBadge nodeId="n1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("takes the colour of the step's most serious issue and counts its issues", async () => {
    issuesByNode.set("n1", [warning, error]);
    render(<StepIssueBadge nodeId="n1" />);
    await expect(screen.getByTestId("step-issue-badge")).toHaveAttribute("data-severity", "error");
    expect(pill(2)).toHaveTextContent("2");
  });

  it("shows a failed run in red over a check error", async () => {
    issuesByNode.set("n1", [error, runError]);
    render(<StepIssueBadge nodeId="n1" />);
    await expect(screen.getByTestId("step-issue-badge")).toHaveAttribute("data-severity", "run");
  });

  it("shows no number for a single issue", () => {
    issuesByNode.set("n1", [error]);
    render(<StepIssueBadge nodeId="n1" />);
    expect(pill(1)).not.toHaveTextContent(/\d/);
  });

  // fireEvent and DOM focus, not userEvent: Testing Library's async wrapper
  // waits on a timer that Vitest's fake timers never run, so `await user.…`
  // never returns here, and real time would make the delay checks flaky.
  it("opens after a short rest of the pointer and lists the messages, most serious first", () => {
    issuesByNode.set("n1", [warning, error]);
    render(<StepIssueBadge nodeId="n1" />);

    fireEvent.mouseEnter(pill(2));
    act(() => {
      vi.advanceTimersByTime(BADGE_OPEN_DELAY_MS - 1);
    });
    expect(screen.queryByText(error.message)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const rows = screen.getAllByRole("button").filter((button) => button !== pill(2));
    expect(rows.map((row) => row.textContent)).toEqual([error.message, warning.message]);

    fireEvent.mouseLeave(pill(2));
    expect(screen.queryByText(error.message)).not.toBeInTheDocument();
  });

  it("opens on keyboard focus too", async () => {
    issuesByNode.set("n1", [error]);
    render(<StepIssueBadge nodeId="n1" />);

    act(() => {
      pill(1).focus();
    });
    await expect(pill(1)).toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(BADGE_OPEN_DELAY_MS);
    });
    expect(screen.getByText(error.message)).toBeInTheDocument();
  });

  it("goes to the most serious issue on click, without the canvas handling the click as well", () => {
    issuesByNode.set("n1", [warning, error]);
    const onCanvasClick = vi.fn();
    render(
      <div onClick={onCanvasClick}>
        <StepIssueBadge nodeId="n1" />
      </div>
    );

    fireEvent.click(pill(2));

    expect(focusMock).toHaveBeenCalledWith(error);
    expect(onCanvasClick).not.toHaveBeenCalled();
  });

  it("opens on a tap instead of leaving, and a tapped message goes to its issue", () => {
    issuesByNode.set("n1", [warning, error]);
    render(<StepIssueBadge nodeId="n1" />);

    fireEvent.pointerDown(pill(2), { pointerType: "touch" });
    fireEvent.click(pill(2));
    expect(focusMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(BADGE_OPEN_DELAY_MS);
    });
    fireEvent.click(screen.getByRole("button", { name: warning.message }));
    expect(focusMock).toHaveBeenCalledWith(warning);
  });

  it("is not a drag handle of the node it sits on", async () => {
    issuesByNode.set("n1", [error]);
    render(<StepIssueBadge nodeId="n1" />);
    await expect(screen.getByTestId("step-issue-badge")).toHaveClass("nodrag");
  });
});
