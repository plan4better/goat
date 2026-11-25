import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderPanel } from "@/components/map/panels/styleEditor/__tests__/renderPanel";

import { FieldFormatPopover } from "../blocks/FieldFormatPopover";

describe("FieldFormatPopover", () => {
  it("Percent shows the value as a percent of 1, in the preview and written to the field's format", async () => {
    const onChange = vi.fn();
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const { rerender } = renderPanel(
      <FieldFormatPopover
        open
        anchorEl={anchor}
        config={{}}
        prefix={undefined}
        suffix={undefined}
        sampleValue={0.25}
        onChange={onChange}
        onClose={vi.fn()}
      />
    );
    const row = screen.getByText("show_as_percent").parentElement as HTMLElement;
    await userEvent.click(within(row).getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith({ format_config: { percent: true } });
    rerender(
      <FieldFormatPopover
        open
        anchorEl={anchor}
        config={{ percent: true }}
        prefix={undefined}
        suffix={undefined}
        sampleValue={0.25}
        onChange={onChange}
        onClose={vi.fn()}
      />
    );
    expect(screen.getAllByText("25%").length).toBeGreaterThan(0);
  });
});
