import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CopyButton from "@/components/common/CopyButton";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("react-toastify", () => ({ toast: { error: toastError } }));

const setExecCommand = (execCommand: unknown) =>
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

afterEach(() => {
  setExecCommand(undefined);
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  toastError.mockClear();
});

describe("CopyButton", () => {
  it("copies on plain http, where the browser has no Clipboard API, and says so", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const copied: string[] = [];
    setExecCommand(
      vi.fn(() => {
        copied.push(document.getSelection()?.toString() ?? "");
        return true;
      })
    );
    render(<CopyButton value="https://example.org/a.tif" label="Copy address" />);
    const button = screen.getByRole("button", { name: "Copy address" });
    // Pointed at and focused, as a click leaves it: its tooltip is open.
    fireEvent.mouseOver(button);
    button.focus();
    expect((await screen.findByRole("tooltip")).textContent).toBe("Copy address");

    fireEvent.click(button);

    await waitFor(() => expect(copied).toEqual(["https://example.org/a.tif"]));
    // The same tooltip says it worked: the copy moved no focus that would have closed it. No error is shown.
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("copied"));
    expect(document.activeElement).toBe(button);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says it could not copy only when no way worked", async () => {
    setExecCommand(vi.fn(() => false));
    render(<CopyButton value="x" label="Copy address" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("settings_card_copy_failed"));
  });
});
