import { ThemeProvider } from "@mui/material/styles";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonT } from "@/i18n/__tests__/commonI18n";

import { UNDO_TOAST_MS, undoToast } from "@/lib/toasts";

vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Content = (props: { closeToast?: () => void }) => ReactNode;
const shown = () => {
  const [content, options] = vi.mocked(toast.success).mock.calls.at(-1) as unknown as [
    Content,
    { autoClose: number },
  ];
  const closeToast = vi.fn();
  render(<>{content({ closeToast })}</>);
  return { options, closeToast };
};

describe("undoToast", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("says what happened, stays 7 seconds and undoes once", async () => {
    const onUndo = vi.fn().mockResolvedValue(undefined);
    undoToast("Anna ist jetzt Betrachter.", onUndo, commonT("de"));
    const { options, closeToast } = shown();
    expect(options.autoClose).toBe(UNDO_TOAST_MS);
    expect(UNDO_TOAST_MS).toBe(7000);
    expect(screen.getByText("Anna ist jetzt Betrachter.")).toBeInTheDocument();
    const undo = screen.getByRole("button", { name: "Rückgängig" });
    await userEvent.click(undo);
    await userEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(closeToast).toHaveBeenCalled();
  });

  it("offers the undo as a text button, not a filled one", () => {
    undoToast("Anna ist jetzt Betrachter.", vi.fn(), commonT("de"));
    const [content] = vi.mocked(toast.success).mock.calls.at(-1) as unknown as [Content];
    // GOAT's theme fills a Button that names no variant.
    render(
      <ThemeProvider theme={createAppTheme({ mode: "light", locale: "de" })}>
        {content({ closeToast: vi.fn() })}
      </ThemeProvider>
    );
    expect(screen.getByRole("button", { name: "Rückgängig" }).className).toContain("MuiButton-text");
  });

  it("says so when the undo fails", async () => {
    undoToast("KI ist für die Organisation an.", vi.fn().mockRejectedValue(new Error("400")), commonT("de"));
    shown();
    await userEvent.click(screen.getByRole("button", { name: "Rückgängig" }));
    expect(toast.error).toHaveBeenCalledWith("Das ließ sich nicht rückgängig machen.");
  });
});
