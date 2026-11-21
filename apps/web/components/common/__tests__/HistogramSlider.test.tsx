import { createTheme } from "@mui/material";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HistogramSlider, type HistogramSliderProps } from "@/components/common/HistogramSlider";

import { renderWithProviders } from "../../map/panels/styleEditor/__tests__/renderPanel";

const PRIMARY = createTheme().palette.primary.main;

/** Ten bins over 0 to 100. */
const BINS = Array.from({ length: 10 }, (_, i) => ({
  range: [i * 10, i * 10 + 10] as [number, number],
  count: i + 1,
}));

function show(props: Partial<HistogramSliderProps> = {}) {
  const onChange = vi.fn();
  const view = renderWithProviders(
    <HistogramSlider bins={BINS} mode="above" value={50} integer onChange={onChange} {...props} />
  );
  return { ...view, onChange };
}

/** How many bars are drawn as chosen. */
const chosen = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("rect")).filter((r) => r.getAttribute("fill") === PRIMARY).length;

const root = (container: HTMLElement) => container.querySelector(".MuiSlider-root") as HTMLElement;

describe("the histogram slider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("draws a bar per bin and marks the ones the comparison keeps", () => {
    expect(chosen(show({ mode: "above", value: 50 }).container)).toBe(5);
    expect(chosen(show({ mode: "below", value: 30 }).container)).toBe(3);
    expect(chosen(show({ mode: "between", value: 20, value2: 60 }).container)).toBe(4);
    expect(chosen(show({ mode: "outside", value: 20, value2: 60 }).container)).toBe(6);
  });

  it("fills the track from the thumb to the end the comparison keeps", () => {
    expect(root(show({ mode: "above" }).container).className).toMatch(/trackInverted/);
    expect(root(show({ mode: "below" }).container).className).not.toMatch(/trackInverted/);
    expect(root(show({ mode: "outside", value: 20, value2: 60 }).container).className).toMatch(
      /trackInverted/
    );
  });

  it("names its thumbs as the number boxes are named", () => {
    show({ mode: "between", value: 20, value2: 60 });
    expect(screen.getByRole("slider", { name: "style_editor.condition_value" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "style_editor.condition_value_to" })).toBeDefined();
  });

  it("shows the field's minimum and maximum under the track", () => {
    show();
    expect(screen.getByText("0")).toBeDefined();
    expect(screen.getByText("100")).toBeDefined();
  });

  it("follows a drag without saving and saves once on release", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 100,
      top: 0,
      height: 20,
      right: 100,
      bottom: 20,
    } as DOMRect);
    const { container, onChange } = show({ mode: "above", value: 30 });
    fireEvent.mouseDown(root(container), { button: 0, clientX: 50, clientY: 10 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 80, clientY: 10 });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("80");
    expect(chosen(container)).toBe(2);
    fireEvent.mouseUp(document, { clientX: 80, clientY: 10 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(80, undefined);
  });

  it("a press on the thumb that moves nothing saves nothing", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 100,
      top: 0,
      height: 20,
      right: 100,
      bottom: 20,
    } as DOMRect);
    const { container, onChange } = show({ mode: "above", value: 50 });
    fireEvent.mouseDown(root(container), { button: 0, clientX: 50, clientY: 10 });
    fireEvent.mouseUp(document, { clientX: 50, clientY: 10 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a keyboard step saves at once", () => {
    const { onChange } = show({ mode: "below", value: 50 });
    // jsdom has no keyboard behavior for range inputs: a step is a change of the thumb's value.
    fireEvent.change(screen.getByRole("slider"), { target: { value: 51 } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(51, undefined);
  });

  it("a typed value outside the data stays as typed, its thumb at the end", () => {
    const { onChange } = show({ mode: "between", value: -20, value2: 50 });
    const low = screen.getByRole("slider", { name: "style_editor.condition_value" });
    const high = screen.getByRole("slider", { name: "style_editor.condition_value_to" });
    expect(low.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.change(high, { target: { value: 60 } });
    expect(onChange).toHaveBeenCalledWith(-20, 60);
  });

  it("a range without its upper end takes the thumb's place for it", () => {
    const { onChange } = show({ mode: "between", value: 10, value2: undefined });
    fireEvent.change(screen.getByRole("slider", { name: "style_editor.condition_value" }), {
      target: { value: 20 },
    });
    expect(onChange).toHaveBeenCalledWith(20, 100);
  });

  it("steps by 1 on whole numbers and by a round share of the range on decimals", () => {
    show({ integer: true });
    expect(screen.getByRole("slider").getAttribute("step")).toBe("1");
  });

  it("steps a wide range of whole numbers by a round share of it, never by less than 1", () => {
    const bins = [
      { range: [0, 500000] as [number, number], count: 3 },
      { range: [500000, 1000000] as [number, number], count: 1 },
    ];
    show({ bins, integer: true, value: undefined });
    expect(screen.getByRole("slider").getAttribute("step")).toBe("10000");
  });

  it.each([
    // 0.37 to 12.3: a tenth, the ends on tenths.
    [0.37, 12.3, "0.1", "0.3", "12.3"],
    [0, 2500, "20", "0", "2500"],
    [0, 1, "0.01", "0", "1"],
  ])("from %s to %s steps by %s between %s and %s", (min, max, step, low, high) => {
    const bins = [
      { range: [min, (min + max) / 2] as [number, number], count: 3 },
      { range: [(min + max) / 2, max] as [number, number], count: 1 },
    ];
    show({ bins, integer: false, value: undefined });
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("step")).toBe(step);
    expect(slider.getAttribute("min")).toBe(low);
    expect(slider.getAttribute("max")).toBe(high);
  });

  it("draws nothing without a range", () => {
    expect(show({ bins: [] }).container.textContent).toBe("");
    expect(show({ bins: [{ range: [5, 5], count: 4 }] }).container.querySelector("svg")).toBeNull();
  });

  it("a disabled slider takes no change", () => {
    show({ disabled: true });
    expect((screen.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
  });
});
