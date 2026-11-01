import { createTheme, getContrastRatio } from "@mui/material/styles";
import { describe, expect, it } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import {
  type AiCreditsLevel,
  aiCreditsLevelColors,
  aiCreditsPercent,
  formatCreditsDay,
  readableText,
} from "@/lib/utils/credits";

const LEVELS: AiCreditsLevel[] = ["unlimited", "ok", "low", "empty"];

describe("aiCreditsLevelColors", () => {
  it.each(["light", "dark"] as const)("gives every level a text that reads on paper in %s mode", (mode) => {
    const theme = createAppTheme({ mode, locale: "en" });
    for (const level of LEVELS) {
      const { text } = aiCreditsLevelColors(theme, level);
      expect(getContrastRatio(text, theme.palette.background.paper), level).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the bar in the theme's colour of the level", () => {
    const theme = createAppTheme({ mode: "light", locale: "en" });
    expect(aiCreditsLevelColors(theme, "ok").bar).toBe(theme.palette.primary.main);
    expect(aiCreditsLevelColors(theme, "unlimited").bar).toBe(theme.palette.primary.main);
    expect(aiCreditsLevelColors(theme, "low").bar).toBe(theme.palette.warning.main);
    expect(aiCreditsLevelColors(theme, "empty").bar).toBe(theme.palette.error.main);
  });

  it("darkens a light colour in light mode and lightens a dark one in dark mode", () => {
    // The theme's warning (#FFB400) is far below 4.5:1 on white as text.
    const light = createAppTheme({ mode: "light", locale: "en" });
    expect(getContrastRatio(light.palette.warning.main, "#FFF")).toBeLessThan(4.5);
    const warning = aiCreditsLevelColors(light, "low").text;
    expect(getContrastRatio(warning, "#000")).toBeLessThan(
      getContrastRatio(light.palette.warning.main, "#000")
    );
    // A dark primary of a branded theme on dark paper is lightened instead.
    const dark = createTheme({
      palette: { mode: "dark", primary: { main: "#1A3D2F" }, background: { paper: "#283648" } },
    });
    const text = aiCreditsLevelColors(dark, "ok").text;
    expect(getContrastRatio(text, "#283648")).toBeGreaterThanOrEqual(4.5);
    expect(getContrastRatio(text, "#FFF")).toBeLessThan(getContrastRatio("#1A3D2F", "#FFF"));
  });
});

describe("aiCreditsPercent", () => {
  it("rounds the used share and never passes 100", () => {
    expect(aiCreditsPercent(412, 1000)).toBe(41);
    expect(aiCreditsPercent(962, 1000)).toBe(96);
    expect(aiCreditsPercent(1200, 1000)).toBe(100);
    expect(aiCreditsPercent(1000, 1000)).toBe(100);
    expect(aiCreditsPercent(0, 1000)).toBe(0);
    // No allowance at all is used up.
    expect(aiCreditsPercent(0, 0)).toBe(100);
  });

  it("reads neither full while some are left nor empty once some are used", () => {
    expect(aiCreditsPercent(996, 1000)).toBe(99);
    expect(aiCreditsPercent(999.9, 1000)).toBe(99);
    expect(aiCreditsPercent(4, 1000)).toBe(1);
    expect(aiCreditsPercent(0.1, 1000)).toBe(1);
  });
});

describe("formatCreditsDay", () => {
  it("writes a reset date as day and short month in the reader's time", () => {
    // Midday UTC is the same calendar day from UTC-11 to UTC+11.
    expect(formatCreditsDay("2026-12-01T12:00:00", "en")).toBe("1 Dec");
    expect(formatCreditsDay("2026-12-01T12:00:00", "de")).toBe("1. Dez.");
    expect(formatCreditsDay("2026-11-30T12:00:00Z", "en")).toBe("30 Nov");
    expect(formatCreditsDay(null, "en")).toBeNull();
    expect(formatCreditsDay("not a date", "en")).toBeNull();
  });

  it("names the year where the page asks for it", () => {
    expect(formatCreditsDay("2026-12-01T12:00:00", "en", { year: true })).toBe("1 Dec 2026");
    expect(formatCreditsDay("2026-12-01T12:00:00", "de", { year: true })).toBe("1. Dez. 2026");
  });

  it("names the day the reader's clock is on", () => {
    // The reset at midnight UTC as the reader's clock shows it.
    const reset = new Date("2026-12-01T00:00:00Z");
    const local = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(reset);
    expect(formatCreditsDay("2026-12-01T00:00:00", "en")).toBe(local);
  });
});

describe("readableText", () => {
  it.each(["light", "dark"] as const)(
    "gives any palette colour a shade that reads on paper in %s mode",
    (mode) => {
      const theme = createAppTheme({ mode, locale: "en" });
      for (const color of [theme.palette.info.main, theme.palette.primary.main, theme.palette.warning.main]) {
        expect(
          getContrastRatio(readableText(theme, color), theme.palette.background.paper)
        ).toBeGreaterThanOrEqual(4.5);
      }
      // A colour that reads already stays as it is.
      expect(readableText(theme, theme.palette.text.primary)).toBe(theme.palette.text.primary);
    }
  );
});
