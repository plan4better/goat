import { ThemeProvider, getContrastRatio } from "@mui/material";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { solidOn } from "@/lib/utils/credits";

import StatusPill, { type StatusTone, statusInk, statusTint } from "@/components/common/StatusPill";

const TONES: StatusTone[] = ["primary", "info", "success", "warning", "error", "neutral"];

describe("StatusPill", () => {
  it("writes the status on its tint, after a dot screen readers skip", () => {
    render(
      <ThemeProvider theme={createAppTheme({ mode: "light", locale: "en" })}>
        <StatusPill tone="warning">Invitation pending</StatusPill>
      </ThemeProvider>
    );
    const pill = screen.getByText("Invitation pending").parentElement as HTMLElement;
    expect(pill.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(pill.textContent).toBe("Invitation pending");
  });

  it.each(["light", "dark"] as const)("reads at 4.5:1 on its own tint in every tone, %s mode", (mode) => {
    const theme = createAppTheme({ mode, locale: "en" });
    // On a card (paper) and on the page itself (a ticket's head sits on the
    // page's background).
    for (const surface of [theme.palette.background.paper, theme.palette.background.default]) {
      for (const tone of TONES) {
        // What the eye sees: the tint over the surface, the ink over that.
        const background = solidOn(statusTint(theme, tone), surface);
        const ink = solidOn(statusInk(theme, tone), background);
        expect(
          getContrastRatio(ink, background),
          `${tone} on ${surface} in ${mode} mode`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
