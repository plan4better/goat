import { ThemeProvider } from "@mui/material/styles";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { registerSurface, resetAssistantStore } from "@/lib/assistant/store";
import { aiCreditsLevelColors } from "@/lib/utils/credits";

import type { AiCreditsPool } from "@/hooks/assistant/useAiCredits";

import { AiCreditsRing, AiCreditsUsedUp } from "@/components/assistant/AiCreditsRing";

const theme = createAppTheme({ mode: "light", locale: "en" });

const POOL: AiCreditsPool = {
  used: 412,
  total: 1000,
  left: 588,
  percent: 41,
  level: "ok",
  resetsOn: "2026-12-01T12:00:00",
  onTrial: false,
  tiers: [
    { max_steps: 10, credits: 1 },
    { max_steps: 20, credits: 2 },
    { max_steps: null, credits: 3 },
  ],
};
const LOW: AiCreditsPool = { ...POOL, used: 962, left: 38, percent: 96, level: "low" };

const wrap = (node: ReactNode, language: "en" | "de" = "en") =>
  render(
    <ThemeProvider theme={theme}>
      <I18nextProvider i18n={commonI18n(language)}>{node}</I18nextProvider>
    </ThemeProvider>
  );

const ring = () => screen.getByRole("button", { name: /AI credits used|KI-Credits/ });
/** The arc of the ring: the second circle, drawn in the level's colour. */
const arc = (button: HTMLElement) => button.querySelectorAll("circle")[1];

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
});

describe("AiCreditsRing", () => {
  it("names the used share and the reset day, and fills in GOAT green", async () => {
    wrap(<AiCreditsRing pool={POOL} isAdmin />);
    const button = screen.getByRole("button", {
      name: "41 % of this month's AI credits used · resets on 1 Dec",
    });
    expect(arc(button).getAttribute("stroke")).toBe(theme.palette.primary.main);
    // 41 % of the circle's length is drawn.
    const [drawn, length] = (arc(button).getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
    expect(drawn / length).toBeCloseTo(0.41, 2);
    expect(within(button).queryByText(/left/)).toBeNull();
    await expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("turns orange under a tenth left and says how many are left, in a readable shade", () => {
    wrap(<AiCreditsRing pool={LOW} isAdmin />);
    // What it shows is the start of its name, so it can be named by what it says.
    const button = screen.getByRole("button", {
      name: "38 left · 96 % of this month's AI credits used · resets on 1 Dec",
    });
    expect(arc(button).getAttribute("stroke")).toBe(theme.palette.warning.main);
    const left = within(button).getByText("38 left");
    expect(getComputedStyle(left.closest("button") as HTMLElement).color).toBe(
      toRgb(aiCreditsLevelColors(theme, "low").text)
    );
  });

  it("names a trial's end instead of a reset", () => {
    wrap(<AiCreditsRing pool={{ ...POOL, onTrial: true, resetsOn: "2026-11-30T12:00:00" }} isAdmin />);
    expect(
      screen.getByRole("button", { name: "41 % of your trial's AI credits used · valid until 30 Nov" })
    ).toBeTruthy();
  });

  it("leaves the date out when there is none", () => {
    wrap(<AiCreditsRing pool={{ ...POOL, resetsOn: null }} isAdmin />);
    expect(screen.getByRole("button", { name: "41 % of this month's AI credits used" })).toBeTruthy();
  });

  it("opens the organization's pool above the ring for an admin, with the way to Usage", async () => {
    wrap(<AiCreditsRing pool={POOL} isAdmin />);
    const button = ring();
    fireEvent.click(button);
    await expect(button).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "AI credits · your organization" });
    for (const text of [
      "AI credits · your organization",
      "This month",
      "Resets on 1 Dec",
      "41 %",
      "588 of 1,000 AI credits left",
      "An answer costs 1 AI credit, 2 if it takes more than 10 steps, 3 if more than 20.",
    ])
      expect(within(dialog).getByText(text)).toBeTruthy();
    await expect(within(dialog).getByRole("link", { name: "See usage →" })).toHaveAttribute(
      "href",
      "/settings/usage?quota=ai"
    );
    expect(within(dialog).queryByText(/admins of your organization/)).toBeNull();
    // The percent in the text colour; only the bar carries the level's colour.
    expect(getComputedStyle(within(dialog).getByText("41 %")).color).toBe(toRgb(theme.palette.text.primary));
    // Not a modal: the page behind keeps its scrolling.
    expect(document.body.style.overflow).not.toBe("hidden");
    // Nothing about the person's own use or how many questions are left.
    expect(within(dialog).queryByText(/you this month|questions/i)).toBeNull();
  });

  it("tells a member who manages the AI credits, without the Usage link", () => {
    wrap(<AiCreditsRing pool={POOL} isAdmin={false} />);
    fireEvent.click(ring());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("The admins of your organization manage its AI credits.")).toBeTruthy();
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("names the trial in the pool", () => {
    wrap(<AiCreditsRing pool={{ ...POOL, onTrial: true, resetsOn: "2026-11-30T12:00:00" }} isAdmin />);
    fireEvent.click(ring());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Your trial")).toBeTruthy();
    expect(within(dialog).getByText("Valid until 30 Nov")).toBeTruthy();
  });

  it("opens Usage in a new tab inside a project, so the project stays open", async () => {
    registerSurface({
      surface: "project.map",
      project: { id: "p1", name: "Nord" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
    });
    wrap(<AiCreditsRing pool={POOL} isAdmin />);
    fireEvent.click(ring());
    await expect(screen.getByRole("link", { name: "See usage →" })).toHaveAttribute("target", "_blank");
  });

  it("closes with Escape and gives the focus back to the ring", async () => {
    wrap(<AiCreditsRing pool={POOL} isAdmin />);
    ring().focus();
    fireEvent.click(ring());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await expect(ring()).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(ring());
  });

  it("speaks German", () => {
    wrap(<AiCreditsRing pool={LOW} isAdmin={false} />, "de");
    const button = screen.getByRole("button", {
      name: "38 übrig · 96 % der KI-Credits dieses Monats genutzt · erneuert am 1. Dez.",
    });
    expect(within(button).getByText("38 übrig")).toBeTruthy();
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "KI-Credits · Ihre Organisation" });
    for (const text of [
      "Dieser Monat",
      "Erneuert am 1. Dez.",
      "38 von 1.000 KI-Credits übrig",
      "Eine Antwort kostet 1 KI-Credit, 2 bei mehr als 10 Schritten, 3 bei mehr als 20.",
      "Die Administratoren Ihrer Organisation verwalten deren KI-Credits.",
    ])
      expect(within(dialog).getByText(text)).toBeTruthy();
  });
});

describe("AiCreditsUsedUp", () => {
  const USED_UP = { resetsOn: "2026-12-01T12:00:00", onTrial: false };

  it("says when the AI credits reset and links an admin to Usage", async () => {
    wrap(<AiCreditsUsedUp usedUp={USED_UP} isAdmin />);
    const line = screen.getByRole("status");
    expect(within(line).getByText("This month's AI credits are used up. Resets on 1 Dec.")).toBeTruthy();
    await expect(within(line).getByRole("link", { name: "Usage" })).toHaveAttribute(
      "href",
      "/settings/usage?quota=ai"
    );
    expect(screen.queryByText(/can ask for more/)).toBeNull();
  });

  it("tells a member that an admin can ask for more, without a link", () => {
    wrap(<AiCreditsUsedUp usedUp={USED_UP} isAdmin={false} />);
    expect(screen.getByText("An admin of your organization can ask for more.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("takes the focus when asked, so the reason is read out where the input was", () => {
    wrap(<AiCreditsUsedUp usedUp={USED_UP} isAdmin={false} autoFocus />);
    expect(document.activeElement).toBe(screen.getByRole("status"));
  });

  it("is named by its sentence, which a status does not take from its content", () => {
    wrap(<AiCreditsUsedUp usedUp={USED_UP} isAdmin={false} autoFocus />);
    expect(screen.getByRole("status")).toHaveAccessibleName(
      "This month's AI credits are used up. Resets on 1 Dec."
    );
  });

  it("leaves the focus where it is otherwise, as when it shows on load", () => {
    wrap(<AiCreditsUsedUp usedUp={USED_UP} isAdmin={false} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("words a trial and a pool without a date", () => {
    const { unmount } = wrap(
      <AiCreditsUsedUp usedUp={{ resetsOn: "2026-11-30T12:00:00", onTrial: true }} isAdmin />
    );
    expect(screen.getByText("The AI credits of your trial are used up.")).toBeTruthy();
    unmount();
    wrap(<AiCreditsUsedUp usedUp={{ resetsOn: null, onTrial: false }} isAdmin />);
    expect(screen.getByText("This month's AI credits are used up.")).toBeTruthy();
  });

  it("speaks German", () => {
    wrap(<AiCreditsUsedUp usedUp={USED_UP} isAdmin={false} />, "de");
    expect(
      screen.getByText("Die KI-Credits dieses Monats sind aufgebraucht. Sie werden am 1. Dez. erneuert.")
    ).toBeTruthy();
    expect(
      screen.getByText("Ein Administrator Ihrer Organisation kann weitere KI-Credits anfragen.")
    ).toBeTruthy();
  });
});

/** jsdom reports computed colours as rgb(); the helper may return either form. */
function toRgb(color: string): string {
  const probe = document.createElement("span");
  probe.style.color = color;
  return probe.style.color;
}
