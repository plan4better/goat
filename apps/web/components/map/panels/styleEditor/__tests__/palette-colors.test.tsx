import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { PaletteColors, type PaletteSource } from "@/components/map/panels/styleEditor/editors/PaletteColors";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";

import { dragRow } from "./dragRows";
import { renderPanel } from "./renderPanel";

/** The list over a source that keeps what is written, as a store would. */
function draw(start: string[], extra: Partial<PaletteSource> = {}) {
  const writes: string[][] = [];
  let colors = start;
  const listeners = new Set<() => void>();
  const write = vi.fn((next: string[]) => {
    writes.push(next);
    colors = next;
    listeners.forEach((l) => l());
  });
  function Harness() {
    // A source that renders again on each write, as one reading the store does.
    const [, tick] = useTick(listeners);
    void tick;
    return (
      <PaletteColors useSource={() => ({ colors, write, ...extra })} args={undefined} pickerKey="test" />
    );
  }
  renderPanel(
    <PopoverProvider>
      <Harness />
    </PopoverProvider>
  );
  return { writes, write };
}

function useTick(listeners: Set<() => void>): [number, () => void] {
  const [n, setN] = useState(0);
  useEffect(() => {
    const listener = () => setN((k) => k + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, [listeners]);
  return [n, () => setN((k) => k + 1)];
}

const group = () => screen.getByRole("group", { name: "style_editor.palette" });
const rows = () => Array.from(group().querySelectorAll<HTMLElement>("[data-class-row]"));
const swatches = () => within(group()).getAllByRole("button", { name: "style_editor.palette_color" });

describe("a continuous palette's colors on the class grid", () => {
  it("is the class list's grid: a head of Color and Value, a row per color with its swatch", () => {
    draw(["#2f6b3a", "#e8dc8f", "#f2f2f2"]);
    // The shared grid of the class lists: its head and its rows.
    expect(within(group()).getByText("style_editor.color")).toBeDefined();
    expect(within(group()).getByText("style_editor.value")).toBeDefined();
    expect(rows()).toHaveLength(3);
    expect(swatches().map((s) => getComputedStyle(s).backgroundColor)).toEqual([
      "rgb(47, 107, 58)",
      "rgb(232, 220, 143)",
      "rgb(242, 242, 242)",
    ]);
    // Without a range, a row names its color.
    expect(rows().map((r) => r.textContent)).toEqual(["#2F6B3A", "#E8DC8F", "#F2F2F2"]);
    // No hint line.
    expect(screen.queryByText("style_editor.palette_edit_note")).toBeNull();
  });

  it("over a range, a row names where its color sits, spread evenly, as the class bounds read with the unit", () => {
    draw(["#000000", "#808080", "#aaaaaa", "#ffffff"], { valueAt: (t) => 36 + t * 62, unit: "m" });
    // Two decimals at most, in the reader's language, as the bound boxes of the class lists.
    expect(rows().map((r) => r.textContent)).toEqual(["36 m", "56.67 m", "77.33 m", "98 m"]);
    // The hex stays as the row's tooltip.
    expect(rows()[1].getAttribute("title")).toBe("#808080");
  });

  it("a swatch opens the panel's color picker, which writes the color in its place", async () => {
    const { writes } = draw(["#2f6b3a", "#e8dc8f", "#f2f2f2"]);
    await userEvent.click(swatches()[1]);
    expect(screen.getByText("style_editor.palette_color_title")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "#d7301f" }));
    expect(writes.at(-1)).toEqual(["#2f6b3a", "#d7301f", "#f2f2f2"]);
  });

  it("a row's bin removes its color, as a stop's; it is disabled while two colors are left", async () => {
    const { writes } = draw(["#000000", "#808080", "#ffffff"]);
    const bins = () =>
      within(group()).queryAllByRole("button", { name: "style_editor.remove_color" }) as HTMLButtonElement[];
    expect(bins()).toHaveLength(3);
    // Shown on hover or focus, and in the tab order.
    expect(bins()[0].closest("[data-row-actions]")).not.toBeNull();
    expect(bins()[0].tabIndex).not.toBe(-1);
    await userEvent.click(bins()[1]);
    expect(writes.at(-1)).toEqual(["#000000", "#ffffff"]);
    expect(bins().map((b) => b.disabled)).toEqual([true, true]);
  });

  it("after a removal by keyboard the focus goes to the color that took its place, never to the page", async () => {
    draw(["#000000", "#808080", "#ffffff", "#ff0000"]);
    const bins = () => within(group()).getAllByRole("button", { name: "style_editor.remove_color" });
    bins()[1].focus();
    await userEvent.keyboard("{Enter}");
    // Color 2 is gone: the white that is second now has the focus.
    expect(document.activeElement).toBe(swatches()[1]);
    expect(swatches()[1].getAttribute("aria-label")).toBe("style_editor.palette_color");
    // The last color removed: the one before it.
    bins()[2].focus();
    await userEvent.keyboard("{Enter}");
    expect(swatches()).toHaveLength(2);
    expect(document.activeElement).toBe(swatches()[1]);
  });

  it("a color's open picker closes when a color is added, removed or moved: it never writes to another color", async () => {
    const title = () => screen.queryByText("style_editor.palette_color_title");
    const { writes } = draw(["#000000", "#808080", "#ffffff", "#ff0000"]);
    const open = async () => {
      await userEvent.click(swatches()[1]);
      expect(title()).not.toBeNull();
    };
    await open();
    await userEvent.click(within(group()).getAllByRole("button", { name: "style_editor.remove_color" })[0]);
    expect(writes.at(-1)).toEqual(["#808080", "#ffffff", "#ff0000"]);
    expect(title()).toBeNull();
    await open();
    await userEvent.click(
      within(group()).getAllByRole("button", { name: "style_editor.add_color_after" })[0]
    );
    expect(title()).toBeNull();
    await open();
    await dragRow(rows()[0], rows()[2]);
    expect(title()).toBeNull();
    await open();
    swatches()[1].focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(title()).toBeNull();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_color" }));
    expect(title()).toBeNull();
  });

  it("a row's plus, before its bin, adds a copy of its color after it; it is disabled at 12 colors", async () => {
    const { writes } = draw(["#000000", "#808080", "#ffffff"]);
    const pluses = () => within(group()).queryAllByRole("button", { name: "style_editor.add_color_after" });
    expect(pluses()).toHaveLength(3);
    // In the same group as the bin, before it, and in the tab order.
    const controls = rows()[1].querySelector("[data-row-actions]")!;
    expect(Array.from(controls.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))).toEqual([
      "style_editor.add_color_after",
      "style_editor.remove_color",
    ]);
    expect(pluses()[1].tabIndex).not.toBe(-1);
    await userEvent.click(pluses()[1]);
    expect(writes.at(-1)).toEqual(["#000000", "#808080", "#808080", "#ffffff"]);
    document.body.innerHTML = "";
    draw(Array.from({ length: 12 }, () => "#000000"));
    expect(pluses().map((b) => (b as HTMLButtonElement).disabled)).toEqual(Array(12).fill(true));
    expect(within(group()).getAllByRole("button", { name: "style_editor.remove_color" })).toHaveLength(12);
  });

  it("the plus that fills the list gives the focus to the new color, never to the page", async () => {
    draw(Array.from({ length: 11 }, () => "#000000"));
    const plus = within(group()).getAllByRole("button", { name: "style_editor.add_color_after" })[3];
    plus.focus();
    await userEvent.keyboard("{Enter}");
    expect(swatches()).toHaveLength(12);
    expect(document.activeElement).toBe(swatches()[4]);
  });

  it("Add a color under the grid copies the last color; at 12 colors nothing can be added", async () => {
    const { writes } = draw(["#000000", "#ffffff"]);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_color" }));
    expect(writes.at(-1)).toEqual(["#000000", "#ffffff", "#ffffff"]);
    document.body.innerHTML = "";
    draw(Array.from({ length: 12 }, () => "#000000"));
    expect(
      (screen.getByRole("button", { name: "style_editor.add_color" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("a row dragged to another row's place moves there, as the categories' rows; Alt and an arrow move one", async () => {
    const { writes } = draw(["#000000", "#ff0000", "#ffffff"]);
    await dragRow(within(rows()[0]).getByText("#000000"), rows()[2]);
    expect(writes.at(-1)).toEqual(["#ff0000", "#ffffff", "#000000"]);
    // From the moved color's swatch: the focus stays on it at its new place.
    swatches()[2].focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(writes.at(-1)).toEqual(["#ff0000", "#000000", "#ffffff"]);
    expect(document.activeElement).toBe(swatches()[1]);
  });

  it("a row is dragged without the browser's drag: it carries nothing a text box could take", () => {
    draw(["#000000", "#ff0000", "#ffffff"]);
    expect(rows()[0].getAttribute("draggable")).toBeNull();
    // Pressed, the browser's own drag of the row (or of text in it) is held back.
    fireEvent.pointerDown(rows()[0], { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    expect(fireEvent.dragStart(rows()[0])).toBe(false);
    fireEvent.pointerUp(document, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
  });
});
