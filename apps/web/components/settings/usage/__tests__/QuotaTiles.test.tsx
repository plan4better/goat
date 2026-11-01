import { ThemeProvider } from "@mui/material/styles";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import type { CreditBalance } from "@/lib/api/usage";

import { QUOTA_KEYS, type QuotaKey, QuotaTiles } from "@/components/settings/usage/QuotaTiles";

const theme = createAppTheme({ mode: "light", locale: "en" });

const balanceAllOk: CreditBalance = {
  used_credits: 2204,
  total_credits: 10000,
  over_budget: false,
  used_ai_credits: 412,
  total_ai_credits: 2000,
  ai_credits_per_editor: 200,
  ai_credit_tiers: [],
  plan_renewal_date: "2026-11-30T12:00:00",
  on_trial: false,
  credits_reset_at: "2026-11-30T12:00:00",
  period_start: "2026-10-31T12:00:00",
  used_storage: 40000,
  total_storage: 51200,
  used_projects: 661,
  total_projects: 1000,
  used_editors: 8,
  total_editors: 10,
  used_viewers: 2,
  total_viewers: 50,
};
/** Storage over its limit, and the credits and the editors at 90 % or more before it. */
const balanceStorageOver: CreditBalance = {
  ...balanceAllOk,
  used_credits: 9500,
  used_storage: 59187,
  used_editors: 10,
};
/** All editor seats taken, the rest well within. */
const balanceEditorsFull: CreditBalance = { ...balanceAllOk, used_editors: 10 };

const renderTiles = (props: {
  balance?: CreditBalance;
  isLoading?: boolean;
  value?: QuotaKey;
  onChange?: (key: QuotaKey) => void;
  language?: "en" | "de";
}) =>
  render(
    <ThemeProvider theme={theme}>
      <I18nextProvider i18n={commonI18n(props.language ?? "en")}>
        <QuotaTiles
          balance={props.balance}
          isLoading={props.isLoading ?? false}
          value={props.value ?? "credits"}
          onChange={props.onChange ?? vi.fn()}
          panelId="usage-panel"
        />
      </I18nextProvider>
    </ThemeProvider>
  );

const tab = (name: RegExp) => screen.getByRole("tab", { name });

const realMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe("QuotaTiles", () => {
  it("lists the five quotas in order", () => {
    renderTiles({ balance: balanceAllOk });
    expect(QUOTA_KEYS).toEqual(["credits", "ai", "storage", "projects", "editors"]);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      expect.stringMatching(/^Credits/),
      expect.stringMatching(/^AI credits\s*Beta/),
      expect.stringMatching(/^Storage/),
      expect.stringMatching(/^Projects/),
      expect.stringMatching(/^Editors/),
    ]);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  it("names the tiles as the quotas and the storage tile as storage in German", () => {
    const { unmount } = renderTiles({ balance: balanceAllOk });
    expect(screen.getByRole("tablist", { name: "Quotas" })).toBeInTheDocument();
    unmount();

    renderTiles({ balance: balanceAllOk, language: "de" });
    expect(screen.getByRole("tablist", { name: "Kontingente" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs[2].textContent).toMatch(/^Speicher\d/);
  });

  it("leaves a pool of nothing that nothing used alone, and marks one that is used", () => {
    // AI switched off: a limit of 0 and nothing used needs no attention, and its bar stays empty.
    const { unmount } = renderTiles({
      balance: { ...balanceAllOk, total_ai_credits: 0, used_ai_credits: 0 },
    });
    const ai = tab(/AI credits/);
    expect(within(ai).queryByText("needs attention")).not.toBeInTheDocument();
    expect(within(ai).getByRole("progressbar", { hidden: true }).getAttribute("aria-valuenow")).toBe("0");
    unmount();

    renderTiles({ balance: { ...balanceAllOk, total_ai_credits: 0, used_ai_credits: 3 } });
    expect(within(tab(/AI credits/)).getByText("needs attention")).toBeInTheDocument();
    expect(
      within(tab(/AI credits/))
        .getByRole("progressbar", { hidden: true })
        .getAttribute("aria-valuenow")
    ).toBe("100");
  });

  it("makes each tile a plain button, not one that submits", () => {
    renderTiles({ balance: balanceAllOk });
    for (const tile of screen.getAllByRole("tab")) expect(tile.getAttribute("type")).toBe("button");
  });

  it("marks a quota that needs attention and the open one", () => {
    renderTiles({ balance: balanceStorageOver, value: "storage" });
    const storage = tab(/Storage/);
    // DOM properties rather than jest-dom's attribute, state and focus matchers: the
    // repo's ESLint setup reads those as Playwright's (async) matchers.
    expect(storage.getAttribute("aria-selected")).toBe("true");
    expect(storage.getAttribute("aria-controls")).toBe("usage-panel");
    expect(storage.tabIndex).toBe(0);
    expect(within(storage).getByText("needs attention")).toBeInTheDocument();
    expect(within(storage).getByText("57.8 GB")).toBeInTheDocument();
    expect(storage).toHaveTextContent("/ 50 GB");
    expect(within(storage).getByText("Over by 7.8 GB")).toBeInTheDocument();
    const credits = tab(/^Credits/);
    expect(credits.getAttribute("aria-selected")).toBe("false");
    expect(credits.tabIndex).toBe(-1);
    // 95 % of the credits: amber, and it needs attention too.
    expect(within(credits).getByText("needs attention")).toBeInTheDocument();
    expect(within(tab(/Projects/)).queryByText("needs attention")).not.toBeInTheDocument();
  });

  it("writes each quota's note", () => {
    const { unmount } = renderTiles({ balance: balanceEditorsFull });
    expect(within(tab(/^Credits/)).getByText("Resets on 30 Nov")).toBeInTheDocument();
    expect(within(tab(/AI credits/)).getByText("Resets on 30 Nov")).toBeInTheDocument();
    expect(within(tab(/Storage/)).getByText("Fixed by your plan")).toBeInTheDocument();
    expect(within(tab(/Projects/)).getByText("Fixed by your plan")).toBeInTheDocument();
    expect(within(tab(/Editors/)).getByText("All in use. Viewers 2 of 50")).toBeInTheDocument();
    unmount();

    renderTiles({ balance: { ...balanceAllOk, on_trial: true } });
    expect(within(tab(/^Credits/)).getByText("For the whole trial")).toBeInTheDocument();
    expect(within(tab(/Storage/)).getByText("Trial limit")).toBeInTheDocument();
    expect(within(tab(/Editors/)).getByText("Viewers 2 of 50")).toBeInTheDocument();
  });

  it("lets a note wrap to two lines and keeps the figure on one", () => {
    renderTiles({ balance: balanceEditorsFull, language: "de" });
    const note = within(tab(/^Bearbeiter/)).getByText("Alle belegt. Betrachter 2 von 50");
    // A long note (German, a narrow tile beside the settings menu) wraps
    // instead of losing its end, and stops after two lines.
    expect(getComputedStyle(note).whiteSpace).not.toBe("nowrap");
    expect(getComputedStyle(note).getPropertyValue("-webkit-line-clamp")).toBe("2");
    const figure = within(tab(/^Bearbeiter/)).getByText("10").parentElement as HTMLElement;
    expect(getComputedStyle(figure).whiteSpace).toBe("nowrap");
  });

  it("gives a phone's narrow tiles a smaller figure and lets the label row wrap", () => {
    const { unmount } = renderTiles({ balance: balanceStorageOver });
    const figureOf = (name: RegExp, text: string) => within(tab(name)).getByText(text);
    const labelRow = (name: RegExp, text: string) =>
      within(tab(name)).getByText(text).parentElement as HTMLElement;
    expect(getComputedStyle(figureOf(/Storage/, "57.8 GB")).fontSize).toBe("22px");
    expect(getComputedStyle(labelRow(/AI credits/, "AI credits")).flexWrap).not.toBe("wrap");
    unmount();

    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    renderTiles({ balance: balanceStorageOver });
    const figure = figureOf(/Storage/, "57.8 GB");
    expect(getComputedStyle(figure).fontSize).toBe("18px");
    // The figure and its limit stay on one line.
    expect(getComputedStyle(figure.parentElement as HTMLElement).whiteSpace).toBe("nowrap");
    // The Beta chip may go under "AI credits" rather than cut it.
    expect(getComputedStyle(labelRow(/AI credits/, "AI credits")).flexWrap).toBe("wrap");
  });

  it("says No limit without a bar", () => {
    renderTiles({ balance: { ...balanceAllOk, total_credits: null } });
    const credits = tab(/^Credits/);
    expect(within(credits).getByText("No limit")).toBeInTheDocument();
    expect(credits).toHaveTextContent("used");
    expect(within(credits).queryByRole("progressbar", { hidden: true })).not.toBeInTheDocument();
    expect(within(tab(/AI credits/)).getByRole("progressbar", { hidden: true })).toBeInTheDocument();
  });

  it("shows skeletons while the balance loads", () => {
    const { container } = renderTiles({ isLoading: true });
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(container.querySelectorAll(".MuiSkeleton-root")).toHaveLength(15);
  });

  it("opens a quota by a click", async () => {
    const onChange = vi.fn();
    renderTiles({ balance: balanceAllOk, onChange });
    await userEvent.click(tab(/Projects/));
    expect(onChange).toHaveBeenCalledWith("projects");
  });

  it("moves between tabs with the arrow keys", async () => {
    const onChange = vi.fn();
    renderTiles({ balance: balanceAllOk, onChange });
    tab(/^Credits/).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("ai");
    expect(document.activeElement).toBe(tab(/AI credits/));
    tab(/^Credits/).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("editors");
    expect(document.activeElement).toBe(tab(/Editors/));
    await userEvent.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith("credits");
    await userEvent.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("editors");
  });
});
