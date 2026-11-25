import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Toolbar } from "@/components/header/Toolbar";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe("Toolbar menu button", () => {
  it("is named after what it opens and says whether that is open", async () => {
    const onMenuIconClick = vi.fn();
    const view = render(<Toolbar height={52} showHambugerMenu onMenuIconClick={onMenuIconClick} />);
    const button = screen.getByRole("button", { name: "main_navigation" });
    await expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(onMenuIconClick).toHaveBeenCalledTimes(1);
    view.rerender(<Toolbar height={52} showHambugerMenu menuOpen onMenuIconClick={onMenuIconClick} />);
    await expect(screen.getByRole("button", { name: "main_navigation" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });
});
