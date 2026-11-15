import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import RolePicker from "@/components/modals/content/RolePicker";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("RolePicker", () => {
  it("announces its menu and whether the menu is open", () => {
    render(<RolePicker value="layer-viewer" prefix="layer" onChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "viewer" });
    // getAttribute rather than jest-dom's `toHaveAttribute`: the repo's ESLint
    // setup reads it as Playwright's (async) matcher of the same name.
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});
