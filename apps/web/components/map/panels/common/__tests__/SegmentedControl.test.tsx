import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SegmentedControl from "@/components/map/panels/common/SegmentedControl";
import SwitchRow from "@/components/map/panels/common/SwitchRow";

const items = [
  { value: "tree", label: "Tree" },
  { value: "tabs", label: "Tabs" },
];

describe("SegmentedControl", () => {
  it("shows every option and marks the current one", () => {
    render(<SegmentedControl label="Layout" value="tabs" onChange={vi.fn()} items={items} />);

    expect(screen.getByText("Layout")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tree" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Tabs" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("reports the picked option", () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="tabs" onChange={onChange} items={items} />);

    fireEvent.click(screen.getByRole("button", { name: "Tree" }));
    expect(onChange).toHaveBeenCalledWith("tree");
  });

  it("keeps the value when the selected option is clicked again", () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="tabs" onChange={onChange} items={items} />);

    fireEvent.click(screen.getByRole("button", { name: "Tabs" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SwitchRow", () => {
  it("toggles with its label", () => {
    const onChange = vi.fn();
    render(<SwitchRow label="Scalebar" checked onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Scalebar"));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
