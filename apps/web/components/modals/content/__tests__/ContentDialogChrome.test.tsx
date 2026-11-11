import { getContrastRatio } from "@mui/material";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { readableText } from "@/lib/utils/credits";

import { DialogSearchField, textInk, warningTextInk } from "@/components/modals/content/ContentDialogChrome";

describe("textInk", () => {
  it.each(["light", "dark"] as const)("is the shade of the colour that reads on paper, %s mode", (mode) => {
    const theme = createAppTheme({ mode, locale: "en" });
    // One helper for text in a palette colour: the usage pages' `readableText`.
    expect(warningTextInk(theme)).toBe(readableText(theme, theme.palette.warning.main));
    for (const color of ["primary", "info", "success", "warning", "error"] as const) {
      expect(getContrastRatio(textInk(theme, color), theme.palette.background.paper)).toBeGreaterThanOrEqual(
        4.5
      );
    }
  });
});

describe("DialogSearchField", () => {
  it("is named by its placeholder and clears what was typed", () => {
    const onChange = vi.fn();
    render(
      <DialogSearchField value="rad" onChange={onChange} placeholder="Filter by name" clearLabel="Clear" />
    );
    expect(screen.getByRole("textbox", { name: "Filter by name" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("disabled: takes no input nor a clear, and its band dims as a disabled tool pill does", () => {
    const { rerender } = render(
      <DialogSearchField value="rad" onChange={vi.fn()} placeholder="Filter by name" clearLabel="Clear" />
    );
    const field = () => screen.getByRole("textbox").closest(".MuiInputBase-root") as HTMLElement;
    const band = () => field().parentElement as HTMLElement;
    const clear = () => screen.getByRole("button", { name: "Clear" });
    expect(getComputedStyle(band()).opacity).not.toBe("0.45");
    const inks = [getComputedStyle(field()).color, getComputedStyle(clear()).color];

    rerender(
      <DialogSearchField
        value="rad"
        onChange={vi.fn()}
        placeholder="Filter by name"
        clearLabel="Clear"
        disabled
      />
    );
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(true);
    // ToolPill's disabled opacity, once: the text and the clear keep their ink
    // instead of greying out under the dimmed band as well.
    expect(getComputedStyle(band()).opacity).toBe("0.45");
    expect([getComputedStyle(field()).color, getComputedStyle(clear()).color]).toEqual(inks);
  });
});
