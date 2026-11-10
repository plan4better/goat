import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Space } from "@/lib/validations/content";

import SpaceSettingsDialog from "@/components/modals/content/SpaceSettingsDialog";

const { useSpacesMock, updateSpaceDefaultRoleMock } = vi.hoisted(() => ({
  useSpacesMock: vi.fn(),
  updateSpaceDefaultRoleMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
}));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/content", () => ({
  useSpaces: useSpacesMock,
  updateSpaceDefaultRole: updateSpaceDefaultRoleMock,
}));

const teamSpace: Space = {
  id: "space-1",
  kind: "team",
  name: "Design Team",
  default_role: "viewer",
  my_role: "owner",
  team_id: "team-1",
  organization_id: null,
};

const noop = () => {};

/** A role's card: named by the role, then its line. */
const radio = (role: string) => screen.getByRole("radio", { name: new RegExp(`^${role}`) });

describe("SpaceSettingsDialog", () => {
  beforeEach(() => {
    updateSpaceDefaultRoleMock.mockReset().mockResolvedValue(undefined);
    useSpacesMock.mockReturnValue({
      spaces: [teamSpace],
      isLoading: false,
      isError: undefined,
      mutate: vi.fn(),
    });
  });

  it("offers the space's default content role, with the one in force selected", () => {
    render(<SpaceSettingsDialog space={teamSpace} onClose={noop} />);

    expect(screen.getByText("default_content_role")).toBeInTheDocument();
    // The roles are the settings' radio cards, each with its line.
    expect(screen.getByRole("radiogroup", { name: "default_content_role" })).toBeInTheDocument();
    expect(radio("viewer").getAttribute("aria-checked")).toBe("true");
    expect(radio("editor").getAttribute("aria-checked")).toBe("false");
    expect(radio("editor").textContent).toContain("space_default_editor_hint");
  });

  it("saves only once the role actually changed", async () => {
    render(<SpaceSettingsDialog space={teamSpace} onClose={noop} />);

    expect((screen.getByRole("button", { name: "save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(radio("editor"));
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(updateSpaceDefaultRoleMock).toHaveBeenCalledWith("space-1", "editor"));
  });

  it("shows no storage figures — quota is not part of the space's settings", () => {
    render(<SpaceSettingsDialog space={teamSpace} onClose={noop} />);

    expect(screen.queryByText("storage_used")).not.toBeInTheDocument();
    expect(document.querySelector(".MuiSkeleton-root")).toBeNull();
  });
});
