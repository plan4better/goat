import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ElementWrapper } from "@/components/common/ElementWrapper";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@p4b/ui/components/Icon", () => ({
  ICON_NAME: { GRIP_VERTICAL: "grip", TRASH: "trash", EXPAND: "expand" },
  Icon: () => <span />,
}));

describe("ElementWrapper select parent", () => {
  it("selects the parent without selecting the element", () => {
    const onSelect = vi.fn();
    const onSelectParent = vi.fn();
    render(
      <ElementWrapper isSelected onSelect={onSelect} onSelectParent={onSelectParent}>
        content
      </ElementWrapper>
    );

    fireEvent.click(screen.getByRole("button", { name: "select_panel" }));

    expect(onSelectParent).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hides the action when the element is not selected or no handler is given", () => {
    const { rerender } = render(
      <ElementWrapper isSelected={false} onSelectParent={vi.fn()}>
        content
      </ElementWrapper>
    );
    expect(screen.queryByRole("button", { name: "select_panel" })).toBeNull();

    rerender(<ElementWrapper isSelected>content</ElementWrapper>);
    expect(screen.queryByRole("button", { name: "select_panel" })).toBeNull();
  });
});
