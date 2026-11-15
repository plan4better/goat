import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useHomeCreate } from "@/hooks/dashboard/home/useHomeCreate";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("swr", () => ({ mutate: vi.fn() }));
vi.mock("@/lib/api/content", () => ({
  refreshContentFeed: vi.fn(),
  useSpaces: () => ({ spaces: [{ id: "space-1", kind: "personal" }] }),
}));
vi.mock("@/lib/api/folders", () => ({ useFolders: () => ({ folders: [] }) }));
vi.mock("@/lib/api/users", () => ({ USERS_API_BASE_URL: "http://core/api/v2/users" }));
vi.mock("@/lib/utils/content", () => ({ homeFolderOf: () => ({ id: "home-1" }) }));
vi.mock("@/components/dashboard/common/NewProjectMenu", () => ({ NewProjectFlows: () => null }));
// Code a deploy removed (a tab opened before it): every load of it fails.
vi.mock("@/components/addLayer/AddLayerDialog", () => {
  throw new Error("Failed to load chunk");
});

const Harness = () => {
  const { addDataset, dialogs } = useHomeCreate();
  return (
    <>
      <button onClick={addDataset}>open-upload</button>
      {dialogs}
    </>
  );
};

describe("useHomeCreate when the Add Layer dialog's code does not load", () => {
  it("shows a notice with a reload in place of the dialog", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("open-upload"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert").textContent).toBe("assistant_part_load_failed");
    fireEvent.click(within(dialog).getByRole("button", { name: "close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("open-upload")).toBeTruthy();
  });
});
