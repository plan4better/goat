import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import AddTeamMembersDialog from "@/components/settings/team/AddTeamMembersDialog";

const api = vi.hoisted(() => ({ createTeamMember: vi.fn() }));
vi.mock("@/lib/api/teams", () => ({ createTeamMember: api.createTeamMember }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PEOPLE = [
  { id: "u2", name: "Ben Muster", email: "ben@x.de", roleWord: "Editor" },
  { id: "u3", name: "cara@x.de", email: "cara@x.de", roleWord: "Viewer" },
  { id: "u4", name: "Dora Muster", email: "dora@x.de", roleWord: "Editor" },
];

const renderDialog = (reload?: (show: (candidates: typeof PEOPLE) => void) => Promise<unknown>) => {
  const onClose = vi.fn();
  const onChanged = vi.fn(() => (reload ? reload(show) : Promise.resolve()));
  const ui = (candidates: typeof PEOPLE) => (
    <I18nextProvider i18n={commonI18n("en")}>
      <AddTeamMembersDialog
        teamId="t1"
        teamName="Stadtplanung"
        candidates={candidates}
        onClose={onClose}
        onChanged={onChanged}
      />
    </I18nextProvider>
  );
  const { rerender } = render(ui(PEOPLE));
  // What the page does once the members reload: the candidates without those now in the team.
  function show(candidates: typeof PEOPLE) {
    rerender(ui(candidates));
  }
  return { onClose, onChanged };
};

describe("AddTeamMembersDialog", () => {
  beforeEach(() => {
    api.createTeamMember.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("adds the people chosen one after the other and closes", async () => {
    api.createTeamMember.mockResolvedValue({});
    const { onClose, onChanged } = renderDialog();
    await userEvent.click(screen.getByRole("checkbox", { name: "Ben Muster" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "cara@x.de" }));
    await userEvent.click(screen.getByRole("button", { name: "Add 2" }));
    expect(api.createTeamMember.mock.calls).toEqual([
      ["t1", "u2"],
      ["t1", "u3"],
    ]);
    expect(onChanged).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("2 people are now in the team.");
    expect(onClose).toHaveBeenCalled();
  });

  it("names the people who were not added and keeps them chosen", async () => {
    api.createTeamMember.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("400"));
    const { onClose } = renderDialog();
    await userEvent.click(screen.getByRole("checkbox", { name: "Ben Muster" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Dora Muster" }));
    await userEvent.click(screen.getByRole("button", { name: "Add 2" }));
    expect(toast.success).toHaveBeenCalledWith("Ben Muster is now in the team.");
    expect(toast.error).toHaveBeenCalledWith("Not added: Dora Muster.");
    expect(onClose).not.toHaveBeenCalled();
    await expect(
      within(screen.getByRole("dialog")).getByRole("checkbox", { name: "Dora Muster" })
    ).toBeChecked();
    await expect(
      within(screen.getByRole("dialog")).getByRole("checkbox", { name: "Ben Muster" })
    ).not.toBeChecked();
  });

  it("goes on after a failure half way, reports who was added and keeps only the one who was not", async () => {
    api.createTeamMember
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("400"))
      .mockResolvedValueOnce({});
    const { onClose, onChanged } = renderDialog();
    for (const name of ["Ben Muster", "cara@x.de", "Dora Muster"]) {
      await userEvent.click(screen.getByRole("checkbox", { name }));
    }
    await userEvent.click(screen.getByRole("button", { name: "Add 3" }));
    expect(api.createTeamMember.mock.calls).toEqual([
      ["t1", "u2"],
      ["t1", "u3"],
      ["t1", "u4"],
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("2 people are now in the team.");
    expect(toast.error).toHaveBeenCalledWith("Not added: cara@x.de.");
    expect(onClose).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    await expect(within(dialog).getByRole("checkbox", { name: "cara@x.de" })).toBeChecked();
    await expect(within(dialog).getByRole("checkbox", { name: "Ben Muster" })).not.toBeChecked();
    await expect(within(dialog).getByRole("checkbox", { name: "Dora Muster" })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("drops a failed person from the choice when the reload shows them in the team already", async () => {
    // Dora was added from elsewhere meanwhile: her request fails, the reload no longer offers her.
    api.createTeamMember.mockRejectedValueOnce(new Error("400")).mockRejectedValueOnce(new Error("400"));
    const { onClose } = renderDialog(async (show) => show(PEOPLE.filter((person) => person.id !== "u4")));
    await userEvent.click(screen.getByRole("checkbox", { name: "Ben Muster" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Dora Muster" }));
    await userEvent.click(screen.getByRole("button", { name: "Add 2" }));
    expect(toast.error).toHaveBeenCalledWith("Not added: Ben Muster, Dora Muster.");
    expect(onClose).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("checkbox", { name: "Dora Muster" })).toBeNull();
    await expect(within(dialog).getByRole("checkbox", { name: "Ben Muster" })).toBeChecked();
    await expect(within(dialog).getByRole("button", { name: "Add" })).toBeEnabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent("1 selected, 2 not in the team");
  });

  it("is no longer busy when the reload fails, and still says who was added", async () => {
    api.createTeamMember.mockResolvedValue({});
    const { onClose } = renderDialog(() => Promise.reject(new Error("HTTP 500")));
    await userEvent.click(screen.getByRole("checkbox", { name: "Ben Muster" }));
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(toast.success).toHaveBeenCalledWith("Ben Muster is now in the team.");
    expect(onClose).toHaveBeenCalled();
    await expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});
