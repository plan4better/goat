import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ProjectMenuButton from "@/components/header/ProjectMenuButton";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

describe("ProjectMenuButton", () => {
  it("names the project menu's button, so it can be found without its logo", () => {
    render(<ProjectMenuButton />);
    expect(screen.getByRole("button", { name: "common:project_menu" })).toBeInTheDocument();
  });

  it("leaves the placeholder out of the accessibility tree while the menu loads", () => {
    render(<ProjectMenuButton placeholder />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
