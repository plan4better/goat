import { act, fireEvent, screen } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import CustomColorPicker from "@/components/map/panels/style/color/CustomColorPicker";

import { renderWithProviders } from "./renderPanel";

// A drag on a page that draws slowly: the style's answer to one move reaches the picker together with the next move.
// The picker must then neither take the older answer for a new color nor report it again, or the two values are sent
// back and forth without end.

beforeEach(() => window.localStorage.removeItem("goat.color-format"));

const bar = () => screen.getByRole("slider", { name: "style_editor.transparency" });
const hue = () => screen.getByRole("slider", { name: "Hue" });
/** One step down on the hue bar, react-colorful's own slider, by its arrow key. */
const left = (el: HTMLElement) => fireEvent.keyDown(el, { key: "ArrowLeft", keyCode: 37 });
/** The transparency bar moved to `percent`, as a drag sends it: an absolute position, the range input's change. */
const barTo = (percent: number) => fireEvent.change(bar(), { target: { value: String(percent) } });
/** The percent a color's alpha shows, and the alpha a percent writes. */
const percentOfHex = (hex: string) => Math.round((parseInt(hex.slice(7) || "ff", 16) / 255) * 100);
const alphaOf = (percent: number) => Math.round((percent / 100) * 255);

/** A style that answers late while `held`: writes wait in `queue` until the test hands one back. */
function harness(start: string, strict = false) {
  const state = { held: true, queue: [] as string[], writes: [] as string[], set: (_: string) => {} };
  function Parent() {
    const [value, setValue] = useState(start);
    state.set = setValue;
    return (
      <CustomColorPicker
        value={value}
        transparency={{}}
        onChange={(hex) => {
          state.writes.push(hex);
          // A runaway exchange stops here, so the test fails on the count instead of hanging.
          if (state.writes.length > 40) return;
          if (state.held) state.queue.push(hex);
          else setValue(hex);
        }}
      />
    );
  }
  renderWithProviders(
    strict ? (
      <StrictMode>
        <Parent />
      </StrictMode>
    ) : (
      <Parent />
    )
  );
  return state;
}

describe("a drag whose answers arrive late", () => {
  // A color that does not survive the picker's own rounding (hue, saturation and value as whole numbers).
  it.each(["#4daf4a80", "#cc615c80", "#11a5c9cc"])(
    "%s: the transparency bar writes each move once and ends on the last one",
    (start) => {
      const state = harness(start);
      const p = percentOfHex(start);
      barTo(p - 1);
      expect(state.writes).toHaveLength(1);
      const first = state.queue.shift()!;
      // The first answer and the second move in one render; from here the style answers at once.
      act(() => {
        state.held = false;
        state.set(first);
        barTo(p - 2);
      });
      expect(state.writes).toHaveLength(2);
      const [one, two] = state.writes;
      expect(parseInt(one.slice(7), 16)).toBe(alphaOf(p - 1));
      expect(parseInt(two.slice(7), 16)).toBe(alphaOf(p - 2));
      expect(one.slice(0, 7)).toBe(start.slice(0, 7));
      expect(two.slice(0, 7)).toBe(start.slice(0, 7));
      expect(parseInt(two.slice(7), 16)).toBeLessThan(parseInt(one.slice(7), 16));
      expect(Number(bar().getAttribute("aria-valuenow"))).toBe(
        Math.round((parseInt(two.slice(7), 16) / 255) * 100)
      );
    }
  );

  it("the hue bar writes each move once and ends on the last one", () => {
    const state = harness("#4daf4a80");
    left(hue());
    const first = state.queue.shift()!;
    act(() => {
      state.held = false;
      state.set(first);
      left(hue());
    });
    expect(state.writes).toHaveLength(2);
    expect(state.writes[1].slice(7)).toBe("80");
  });

  it("a color set from outside while nothing is dragged moves the picker", () => {
    const state = harness("#4daf4a80");
    act(() => state.set("#11223340"));
    expect(Number(bar().getAttribute("aria-valuenow"))).toBe(25);
    expect(state.writes).toHaveLength(0);
  });

  it("in StrictMode too, the transparency bar writes each move once and ends on the last one", () => {
    const state = harness("#4daf4a80", true);
    barTo(49);
    const first = state.queue.shift()!;
    act(() => {
      state.held = false;
      state.set(first);
      barTo(48);
    });
    expect(state.writes).toHaveLength(2);
    expect(parseInt(state.writes[1].slice(7), 16)).toBeLessThan(parseInt(state.writes[0].slice(7), 16));
    expect(Number(bar().getAttribute("aria-valuenow"))).toBe(
      Math.round((parseInt(state.writes[1].slice(7), 16) / 255) * 100)
    );
  });

  it("three moves whose answers each arrive one move late: one write per move, ending on the last", () => {
    const state = harness("#4daf4a80");
    barTo(49);
    for (const percent of [48, 47]) {
      const answer = state.queue.shift()!;
      act(() => {
        state.set(answer);
        barTo(percent);
      });
    }
    expect(state.writes).toHaveLength(3);
    const alphas = state.writes.map((w) => parseInt(w.slice(7), 16));
    expect(alphas).toEqual([49, 48, 47].map(alphaOf));
    for (const w of state.writes) expect(w.slice(0, 7)).toBe("#4daf4a");
    expect(alphas[1]).toBeLessThan(alphas[0]);
    expect(alphas[2]).toBeLessThan(alphas[1]);
    // The last answer arrives: the bar stands where the last move put it, and nothing more is written.
    act(() => state.set(state.queue.at(-1)!));
    expect(state.writes).toHaveLength(3);
    expect(Number(bar().getAttribute("aria-valuenow"))).toBe(Math.round((alphas[2] / 255) * 100));
  });

  it("a stored alpha between two whole percents stays through a color move; the bar writes a whole percent", () => {
    const state = harness("#4daf4a81");
    state.held = false;
    left(hue());
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].slice(7)).toBe("81");
    barTo(50);
    expect(state.writes).toHaveLength(2);
    const alpha = parseInt(state.writes[1].slice(7), 16);
    // 50 %, one percent below the 51 % the stored 0x81 shows.
    expect(alpha).toBe(Math.round(0.5 * 255));
  });

  it("a drag that goes back over its own values: after its answers, a color from outside shows in bar and percent", () => {
    const state = harness("#4daf4a80");
    // Three moves while the answers are on their way, then the answers in order.
    for (const percent of [49, 48, 49]) barTo(percent);
    expect(state.writes.map((w) => parseInt(w.slice(7), 16))).toEqual([49, 48, 49].map(alphaOf));
    for (const answer of [...state.queue]) act(() => state.set(answer));
    expect(Number(bar().getAttribute("aria-valuenow"))).toBe(49);
    // The value before the drag comes back (an undo): bar and percent both show it.
    act(() => state.set("#4daf4a80"));
    expect(Number(bar().getAttribute("aria-valuenow"))).toBe(50);
    expect(
      (screen.getByRole("textbox", { name: "style_editor.transparency_percent" }) as HTMLInputElement).value
    ).toBe("50");
    expect(state.writes).toHaveLength(3);
  });
});
