import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import SeatTiles from "@/components/settings/common/SeatTiles";
import { seatsOf } from "@/components/settings/members/seats";

const renderTiles = (props: Partial<Parameters<typeof SeatTiles>[0]> = {}) =>
  render(
    <I18nextProvider i18n={commonI18n("de")}>
      <SeatTiles
        seats={seatsOf({ used_editors: 3, total_editors: 5, used_viewers: 10, total_viewers: 10 })}
        pendingInvitations={2}
        value={null}
        onChange={vi.fn()}
        {...props}
      />
    </I18nextProvider>
  );

describe("SeatTiles", () => {
  it("shows used of total, what is free, and a full pool", () => {
    renderTiles();
    const editors = screen.getByRole("button", { name: /^Bearbeiter/ });
    expect(editors).toHaveTextContent("3 / 5");
    expect(editors).toHaveTextContent("2 frei, inklusive Eigentümer und Admins");
    const viewers = screen.getByRole("button", { name: /^Betrachter/ });
    expect(viewers).toHaveTextContent("Alle belegt");
    expect(viewers).toHaveTextContent("braucht Aufmerksamkeit");
    expect(screen.getByRole("button", { name: /^Offene Einladungen/ })).toHaveTextContent(
      "Halten ihren Platz frei"
    );
  });

  it("says Kein Limit, without a bar, for a pool without a limit", () => {
    renderTiles({
      seats: seatsOf({ used_editors: 12, total_editors: null, used_viewers: 0, total_viewers: null }),
      pendingInvitations: 0,
    });
    const editors = screen.getByRole("button", { name: /^Bearbeiter/ });
    expect(editors).toHaveTextContent("Kein Limit");
    expect(editors.querySelector(".MuiLinearProgress-root")).toBeNull();
    expect(screen.getByRole("button", { name: /^Offene Einladungen/ })).toHaveTextContent("Keine offen");
  });

  it("marks a pool only once every seat is taken, and never one without a limit", () => {
    renderTiles({
      seats: seatsOf({ used_editors: 9, total_editors: 10, used_viewers: 4, total_viewers: null }),
    });
    const editors = screen.getByRole("button", { name: /^Bearbeiter/ });
    expect(editors).toHaveTextContent("9 / 10");
    expect(editors).toHaveTextContent("1 frei, inklusive Eigentümer und Admins");
    expect(within(editors).queryByText("braucht Aufmerksamkeit")).toBeNull();
    const viewers = screen.getByRole("button", { name: /^Betrachter/ });
    expect(viewers).toHaveTextContent("Kein Limit");
    expect(within(viewers).queryByText("braucht Aufmerksamkeit")).toBeNull();
  });

  it("leaves a pool of no seats that nobody uses alone: no dot, an empty bar, neutral ink", () => {
    const { unmount } = renderTiles();
    // The colours of a pool within its limit (Bearbeiter, 3 / 5) and of a full one (Betrachter, 10 / 10).
    const figureColor = (name: RegExp, used: string) =>
      getComputedStyle(within(screen.getByRole("button", { name })).getByText(used)).color;
    const okFigure = figureColor(/^Bearbeiter/, "3");
    const fullFigure = figureColor(/^Betrachter/, "10");
    const fullNote = getComputedStyle(
      within(screen.getByRole("button", { name: /^Betrachter/ })).getByText("Alle belegt")
    ).color;
    expect(fullFigure).not.toBe(okFigure);
    unmount();

    renderTiles({
      seats: seatsOf({ used_editors: 3, total_editors: 5, used_viewers: 0, total_viewers: 0 }),
    });
    const viewers = screen.getByRole("button", { name: /^Betrachter/ });
    expect(viewers).toHaveTextContent("0 / 0");
    expect(within(viewers).queryByText("braucht Aufmerksamkeit")).toBeNull();
    expect(within(viewers).getByRole("progressbar", { hidden: true }).getAttribute("aria-valuenow")).toBe(
      "0"
    );
    expect(figureColor(/^Betrachter/, "0")).toBe(okFigure);
    expect(getComputedStyle(within(viewers).getByText("Alle belegt")).color).not.toBe(fullNote);
  });

  it("toggles its filter", async () => {
    const onChange = vi.fn();
    const { rerender } = renderTiles({ onChange });
    await userEvent.click(screen.getByRole("button", { name: /^Betrachter/ }));
    expect(onChange).toHaveBeenLastCalledWith("viewers");
    rerender(
      <I18nextProvider i18n={commonI18n("de")}>
        <SeatTiles
          seats={seatsOf({ used_editors: 3, total_editors: 5, used_viewers: 10, total_viewers: 10 })}
          pendingInvitations={2}
          value="viewers"
          onChange={onChange}
        />
      </I18nextProvider>
    );
    const viewers = screen.getByRole("button", { name: /^Betrachter/ });
    await expect(viewers).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(viewers);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("draws skeletons while the organization loads", () => {
    renderTiles({ seats: undefined, pendingInvitations: undefined });
    expect(document.querySelectorAll(".MuiSkeleton-root").length).toBeGreaterThanOrEqual(3);
  });
});
