import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CanvasErrorBoundary from "@/components/workflows/issues/CanvasErrorBoundary";
import DamagedWorkflowNotice from "@/components/workflows/issues/DamagedWorkflowNotice";
import SaveStatusNotice from "@/components/workflows/issues/SaveStatusNotice";

import { makeIssue } from "./issueFixtures";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/utils/workflowIssueText", () => ({
  issueText: (_t: unknown, issue: { message: string }) => issue.message,
}));

const duplicate = makeIssue({
  code: "node_duplicate_id",
  level: "damaged",
  message: "Two steps in the saved workflow share the id a.",
});

/** A step that throws while it draws. */
function Broken(): never {
  throw new Error("cannot draw");
}

describe("DamagedWorkflowNotice", () => {
  it("says the workflow opens read-only and lists what is broken", () => {
    render(<DamagedWorkflowNotice issues={[duplicate]} />);
    expect(screen.getByRole("region", { name: "workflow_damaged_title" })).toBeInTheDocument();
    expect(screen.getByText("workflow_damaged_body")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent(duplicate.message);
  });

  it("names the cause in one line when the check could not list anything", () => {
    const { rerender } = render(<DamagedWorkflowNotice issues={[]} />);
    expect(screen.getByRole("listitem")).toHaveTextContent("workflow_damaged_saved");

    rerender(<DamagedWorkflowNotice issues={[]} cause="drawing" />);
    expect(screen.getByRole("listitem")).toHaveTextContent("workflow_damaged_drawing");
  });
});

describe("CanvasErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the damaged notice in place of a canvas whose step fails to draw", () => {
    render(
      <CanvasErrorBoundary resetKey="wf-1">
        <Broken />
      </CanvasErrorBoundary>
    );
    expect(screen.getByText("workflow_damaged_title")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("workflow_damaged_drawing");
  });

  it("keeps the notice while the same workflow stays open", () => {
    const { rerender } = render(
      <CanvasErrorBoundary resetKey="wf-1">
        <Broken />
      </CanvasErrorBoundary>
    );
    rerender(
      <CanvasErrorBoundary resetKey="wf-1">
        <p>canvas</p>
      </CanvasErrorBoundary>
    );
    expect(screen.queryByText("canvas")).not.toBeInTheDocument();
  });

  it("draws again once another workflow opens", () => {
    const { rerender } = render(
      <CanvasErrorBoundary resetKey="wf-1">
        <Broken />
      </CanvasErrorBoundary>
    );
    rerender(
      <CanvasErrorBoundary resetKey="wf-2">
        <p>canvas</p>
      </CanvasErrorBoundary>
    );
    expect(screen.getByText("canvas")).toBeInTheDocument();
  });
});

describe("SaveStatusNotice", () => {
  it("shows nothing while saves go through", () => {
    render(<SaveStatusNotice status="saving" issues={[]} onRetry={vi.fn()} />);
    expect(screen.queryByText("workflow_not_saved")).not.toBeInTheDocument();
  });

  it("says the workflow is not saved and saves again on Retry", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<SaveStatusNotice status="failed" issues={[]} onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toHaveTextContent("workflow_not_saved");
    await user.click(screen.getByRole("button", { name: "workflow_save_retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("lists what core found when it refused the config", () => {
    render(<SaveStatusNotice status="failed" issues={[duplicate]} onRetry={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(duplicate.message);
  });
});
