import { ThemeProvider } from "@mui/material/styles";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import SearchableMenu, { type SearchableMenuItem } from "@/components/common/SearchableMenu";

const theme = createAppTheme({ mode: "light", locale: "en" });

function draw(role: "menu" | "listbox", items: SearchableMenuItem[], searchFrom?: number) {
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  render(
    <ThemeProvider theme={theme}>
      <SearchableMenu
        anchorEl={anchor}
        onClose={() => undefined}
        items={items}
        role={role}
        searchFrom={searchFrom}
      />
    </ThemeProvider>
  );
}

describe("SearchableMenu dividers", () => {
  it("in a list of options, a divider is no option nor separator, and the arrow keys go past it", () => {
    const picked = vi.fn();
    draw("listbox", [
      { label: "Alpha", onClick: () => picked("Alpha") },
      { label: "", divider: true },
      { label: "Beta", onClick: () => picked("Beta") },
    ]);
    const list = screen.getByRole("listbox");
    // A listbox holds options (and groups) only: the divider is left out of what assistive tech reads.
    expect(within(list).queryByRole("separator")).toBeNull();
    const divider = list.querySelector("hr, li:not([role='option'])") as HTMLElement;
    expect(divider.getAttribute("role")).toBe("presentation");
    expect(divider.getAttribute("aria-hidden")).toBe("true");
    expect(list.querySelectorAll(".MuiDivider-root")).toHaveLength(1);
    const [alpha, beta] = within(list).getAllByRole("option");
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowDown" });
    expect(document.activeElement).toBe(beta);
    fireEvent.keyDown(beta, { key: "ArrowUp" });
    expect(document.activeElement).toBe(alpha);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(beta);
  });

  it("in a menu, a divider is a separator; the search skips it and Enter takes the first match", () => {
    const picked = vi.fn();
    draw(
      "menu",
      [
        { label: "", divider: true },
        { label: "Alpha", onClick: () => picked("Alpha") },
        { label: "", divider: true },
        { label: "Beta", onClick: () => picked("Beta") },
      ],
      2
    );
    expect(within(screen.getByRole("menu")).getAllByRole("separator")).toHaveLength(2);
    const search = screen.getByRole("textbox");
    fireEvent.change(search, { target: { value: "be" } });
    expect(within(screen.getByRole("menu")).queryByRole("separator")).toBeNull();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(picked).toHaveBeenCalledWith("Beta");
  });
});

describe("SearchableMenu whose control leaves the view", () => {
  // jsdom lays nothing out: the window's size and the control's place are given here, as a browser measures them.
  const html = document.documentElement;
  const sized = (key: "clientWidth" | "clientHeight", value: number) =>
    Object.defineProperty(html, key, { configurable: true, value });
  afterEach(() => {
    delete (html as unknown as Record<string, unknown>).clientWidth;
    delete (html as unknown as Record<string, unknown>).clientHeight;
  });

  function open(onClose: () => void) {
    sized("clientWidth", 1000);
    sized("clientHeight", 800);
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const place = { top: 100 };
    anchor.getBoundingClientRect = () =>
      ({
        x: 600,
        y: place.top,
        top: place.top,
        left: 600,
        right: 700,
        bottom: place.top + 30,
        width: 100,
        height: 30,
      }) as DOMRect;
    render(
      <ThemeProvider theme={theme}>
        <SearchableMenu anchorEl={anchor} onClose={onClose} items={[{ label: "Alpha" }, { label: "Beta" }]} />
      </ThemeProvider>
    );
    return { anchor, place };
  }

  it("closes once its control is scrolled out of view and gives the focus back to it", async () => {
    const onClose = vi.fn();
    const { anchor, place } = open(onClose);
    await act(async () => undefined);
    expect(onClose).not.toHaveBeenCalled();
    // The page (or a panel around the control) scrolls the control above the window's top.
    place.top = -200;
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(anchor);
  });

  it("stays open while its control is scrolled but still in view", async () => {
    const onClose = vi.fn();
    const { place } = open(onClose);
    await act(async () => undefined);
    place.top = 20;
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
    });
    await act(async () => undefined);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});
