import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProcessedInput } from "@/types/map/ogc-processes";

import FormLabelHelper from "@/components/common/FormLabelHelper";
import StringInput from "@/components/map/panels/toolbox/generic/inputs/StringInput";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const stringInput = (required: boolean) =>
  ({
    name: "result_name",
    title: "Result name",
    inputType: "string",
    required,
    schema: { type: "string" },
    isLayerInput: false,
    metadata: [],
    fieldOrder: 1,
  }) as unknown as ProcessedInput;

describe("FormLabelHelper required marker", () => {
  it("follows a required field's label with an asterisk that screen readers hear as required", () => {
    render(<FormLabelHelper label="Distance" color="inherit" required />);
    // The label itself keeps its text.
    expect(screen.getByText("Distance")).toBeInTheDocument();
    // getAttribute rather than jest-dom's `toHaveAttribute`: the repo's ESLint
    // setup reads it as Playwright's (async) matcher of the same name.
    expect(screen.getByText("*").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("required_field_marker")).toBeInTheDocument();
  });

  it("leaves an optional field's label alone", () => {
    render(<FormLabelHelper label="Distance" color="inherit" />);
    expect(screen.queryByText("*")).not.toBeInTheDocument();
    expect(screen.queryByText("required_field_marker")).not.toBeInTheDocument();
  });

  it("is what a generic tool input shows for a required setting", () => {
    const { rerender } = render(
      <StringInput input={stringInput(true)} value={undefined} onChange={vi.fn()} />
    );
    expect(screen.getByText("required_field_marker")).toBeInTheDocument();

    rerender(<StringInput input={stringInput(false)} value={undefined} onChange={vi.fn()} />);
    expect(screen.queryByText("required_field_marker")).not.toBeInTheDocument();
  });
});
