import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import NameDialog from "@/components/dashboard/common/NameDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const cta = () => screen.getByRole("button", { name: "create_folder" }) as HTMLButtonElement;

const renderDialog = (overrides?: { onSubmit?: (name: string) => Promise<void>; onClose?: () => void }) => {
  const onSubmit = overrides?.onSubmit ?? vi.fn().mockResolvedValue(undefined);
  const onClose = overrides?.onClose ?? vi.fn();
  render(
    <NameDialog
      title="new_folder"
      icon={ICON_NAME.FOLDER}
      placeholder="folder_name_placeholder"
      cta="create_folder"
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
  // The field by its role: the dialog is named by the same title.
  return { onSubmit, onClose, field: screen.getByRole("textbox", { name: "new_folder" }) };
};

describe("NameDialog", () => {
  it("renders the title, the placeholder and both buttons, with the CTA disabled while empty", () => {
    renderDialog();

    expect(screen.getByText("new_folder")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("folder_name_placeholder")).toBeInTheDocument();
    // Read off the DOM property rather than a matcher: the repo's ESLint
    // setup reads jest-dom's `toBeDisabled`/`toBeEnabled` as Playwright's
    // (async) matchers of the same name.
    expect(cta().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "cancel" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the CTA disabled while the caller is not ready, even with a name", async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(
      <NameDialog
        title="new_project"
        icon={ICON_NAME.MAP}
        cta="create_project"
        onClose={vi.fn()}
        onSubmit={onSubmit}
        ready={false}
      />
    );
    await userEvent.type(screen.getByRole("textbox"), "Roads");
    expect((screen.getByRole("button", { name: "create_project" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the trimmed name when the CTA is clicked", async () => {
    const { onSubmit, field } = renderDialog();

    await userEvent.type(field, "  Field surveys  ");
    await userEvent.click(screen.getByRole("button", { name: "create_folder" }));

    expect(onSubmit).toHaveBeenCalledWith("Field surveys");
  });

  it("submits on Enter", async () => {
    const { onSubmit, field } = renderDialog();

    await userEvent.type(field, "Drafts{Enter}");

    expect(onSubmit).toHaveBeenCalledWith("Drafts");
  });

  it("closes on Escape without submitting", async () => {
    const { onSubmit, onClose, field } = renderDialog();

    await userEvent.type(field, "Drafts");
    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps itself open and shows the reason when the submit is refused", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("error_creating_folder"));
    const { onClose, field } = renderDialog({ onSubmit });

    await userEvent.type(field, "Drafts{Enter}");

    await waitFor(() => expect(screen.getByText("error_creating_folder")).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(cta().disabled).toBe(false);
  });

  it("disables the header close button while the submit is in flight", async () => {
    let resolveSubmit: () => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        })
    );
    const { field } = renderDialog({ onSubmit });

    await userEvent.type(field, "Drafts{Enter}");

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "close" }) as HTMLButtonElement).disabled).toBe(true)
    );

    resolveSubmit();
    // Lets the resolved promise's `setBusy(false)` land inside `act` before
    // the test tears the tree down, so it does not fire as a stray update on
    // an unmounted component.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "close" }) as HTMLButtonElement).disabled).toBe(false)
    );
  });
});
