import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { STEP_ISSUES_FIELD } from "@/hooks/workflows/useStepFieldFocus";

import StepIssuesSummary from "@/components/workflows/issues/StepIssuesSummary";
import StepSettingField from "@/components/workflows/issues/StepSettingField";

import { makeIssue } from "./issueFixtures";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/utils/workflowIssueText", () => ({
  issueText: (_t: unknown, issue: { message: string }) => issue.message,
}));
vi.mock("@/components/workflows/issues/WorkflowIssuesContext", () => ({
  useWorkflowIssuesContext: () => ({ focusRequest: null }),
}));

const distanceRequired = makeIssue({
  code: "setting_required",
  field: "distance",
  message: "Distance needs a value.",
});
const unitsInvalid = makeIssue({
  code: "setting_invalid",
  field: "units",
  message: "The value of Units is not accepted.",
});
const distanceRun = makeIssue({
  code: "run_failed",
  source: "run",
  field: "distance",
  message: "The last run failed at this step: negative distance",
});
const loose = makeIssue({
  code: "step_not_connected",
  level: "warning",
  message: "This step is not connected.",
});
const noTool = makeIssue({ code: "tool_missing", message: "No tool is chosen for this step." });

describe("StepSettingField", () => {
  it("shows a setting's own issues under it, and none of the other settings'", async () => {
    render(
      <StepSettingField name="distance" issues={[distanceRequired, unitsInvalid]}>
        <input aria-label="Distance" />
      </StepSettingField>
    );
    const field = screen.getByLabelText("Distance").closest("[data-field]");
    await expect(field).toHaveAttribute("data-field", "distance");
    expect(field).toHaveTextContent("Distance needs a value.");
    expect(field).not.toHaveTextContent("The value of Units is not accepted.");
  });

  it("shows a failed run's message in red, above a check message", () => {
    render(
      <StepSettingField name="distance" issues={[distanceRequired, distanceRun]}>
        <input aria-label="Distance" />
      </StepSettingField>
    );
    const messages = Array.from(
      (screen.getByLabelText("Distance").closest("[data-field]") as HTMLElement).querySelectorAll(
        "[data-severity]"
      )
    );
    expect(messages.map((message) => message.getAttribute("data-severity"))).toEqual(["run", "error"]);
  });
});

describe("StepIssuesSummary", () => {
  it("lists the step's issues most serious first, where the focus hook can scroll to them", async () => {
    render(<StepIssuesSummary issues={[loose, noTool]} />);
    const summary = screen.getByTestId("step-issues");
    await expect(summary).toHaveAttribute("data-field", STEP_ISSUES_FIELD);
    expect(
      within(summary)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual([noTool.message, loose.message]);
  });

  it("shows nothing for a step without issues", () => {
    render(<StepIssuesSummary issues={[]} />);
    expect(screen.queryByTestId("step-issues")).not.toBeInTheDocument();
  });
});
