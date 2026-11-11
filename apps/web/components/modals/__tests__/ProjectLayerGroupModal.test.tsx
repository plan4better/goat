import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ProjectLayerGroupModal from "@/components/modals/ProjectLayerGroupModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("ProjectLayerGroupModal", () => {
  it("names a new group in a field with its label above it, and creates it", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectLayerGroupModal open mode="create" projectId="p1" onClose={vi.fn()} onSubmit={onSubmit} />
    );
    const field = screen.getByRole("textbox", { name: "group_name" });
    // The app's field: a label of its own above it, not one floating in its border.
    expect(document.querySelector(".MuiInputLabel-root")).toBeNull();
    expect(field.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(field, { target: { value: " Schulen " } });
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: "Schulen" }));
  });
});
