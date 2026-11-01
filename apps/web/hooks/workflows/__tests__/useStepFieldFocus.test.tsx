import { render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STEP_ISSUES_FIELD, useStepFieldFocus } from "@/hooks/workflows/useStepFieldFocus";

const { focusState } = vi.hoisted(() => ({
  focusState: { request: null as null | { nodeId: string; field: string | null; seq: number } },
}));

vi.mock("@/components/workflows/issues/WorkflowIssuesContext", () => ({
  useWorkflowIssuesContext: () => ({ focusRequest: focusState.request }),
}));

/** A step's settings panel in miniature: the step's issues, a setting, and a
 * second setting that shows only once its section is opened. */
function Panel({ nodeId, onReveal }: { nodeId: string; onReveal?: (field: string) => void }) {
  const [noteShown, setNoteShown] = useState(false);
  const reveal = useCallback(
    (field: string) => {
      onReveal?.(field);
      if (field === "note") setNoteShown(true);
    },
    [onReveal]
  );
  const ref = useStepFieldFocus(nodeId, reveal);
  return (
    <div ref={ref}>
      <ul data-field={STEP_ISSUES_FIELD} data-testid="step-issues" />
      <div data-field="distance">
        <span>Distance</span>
        <input aria-label="Distance" />
      </div>
      {noteShown && (
        <div data-field="note">
          <input aria-label="Note" />
        </div>
      )}
    </div>
  );
}

const scrollIntoView = vi.fn();

describe("useStepFieldFocus", () => {
  beforeEach(() => {
    scrollIntoView.mockReset();
    Element.prototype.scrollIntoView = scrollIntoView;
    focusState.request = null;
  });

  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });

  // Focus is read off document.activeElement rather than jest-dom's
  // `toHaveFocus`: the repo's ESLint setup reads it as Playwright's (async)
  // matcher of the same name.
  it("scrolls to the requested setting and puts the cursor in it", () => {
    focusState.request = { nodeId: "tool-1", field: "distance", seq: 1 };
    render(<Panel nodeId="tool-1" />);
    expect(document.activeElement).toBe(screen.getByLabelText("Distance"));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("ignores a request for another step", () => {
    focusState.request = { nodeId: "tool-2", field: "distance", seq: 1 };
    render(<Panel nodeId="tool-1" />);
    expect(document.activeElement).not.toBe(screen.getByLabelText("Distance"));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("opens what hides the setting first, then focuses it", () => {
    const onReveal = vi.fn();
    focusState.request = { nodeId: "tool-1", field: "note", seq: 1 };
    render(<Panel nodeId="tool-1" onReveal={onReveal} />);
    expect(onReveal).toHaveBeenCalledWith("note");
    expect(document.activeElement).toBe(screen.getByLabelText("Note"));
  });

  it("shows the step's issues for a request without a setting", () => {
    focusState.request = { nodeId: "tool-1", field: null, seq: 1 };
    render(<Panel nodeId="tool-1" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByTestId("step-issues"));
  });

  it("does not jump again when the same step's panel opens later for the same request", () => {
    focusState.request = { nodeId: "tool-1", field: "distance", seq: 1 };
    const first = render(<Panel nodeId="tool-1" />);
    expect(document.activeElement).toBe(screen.getByLabelText("Distance"));
    first.unmount();
    scrollIntoView.mockReset();

    render(<Panel nodeId="tool-1" />);
    expect(document.activeElement).not.toBe(screen.getByLabelText("Distance"));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
