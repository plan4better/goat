import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  Histogram,
  type HistogramBin,
  type HistogramHandle,
  niceStep,
} from "@/components/map/panels/styleEditor/editors/Histogram";

import { renderWithProviders } from "./renderPanel";

// Ten bins over 0 to 100: a step of 1 (a hundredth of the span, rounded).
const BINS: HistogramBin[] = Array.from({ length: 10 }, (_, i) => ({
  range: [i * 10, i * 10 + 10],
  count: i + 1,
}));
const WIDTH = 200;

function draw(handles?: HistogramHandle[], format?: (n: number) => string) {
  const view = renderWithProviders(
    <Histogram bins={BINS} breaks={[]} colorAt={() => "#000000"} format={format} handles={handles} />
  );
  // The bars' box spans 0 to 200 px: one px is half a unit.
  const box = view.container.querySelector("[data-histogram]") as HTMLElement | null;
  if (box)
    box.getBoundingClientRect = () =>
      ({ left: 0, right: WIDTH, width: WIDTH, top: 0, bottom: 50, height: 50, x: 0, y: 0 }) as DOMRect;
  return view;
}

const handle = (over: Partial<HistogramHandle> = {}): HistogramHandle => ({
  id: "lo",
  value: 30,
  kind: "end",
  label: "Lowest value",
  onChange: vi.fn(),
  ...over,
});

describe("the histogram's handles", () => {
  it("without handles it is the bars alone, as before", () => {
    const { container } = draw();
    expect(container.querySelectorAll("rect")).toHaveLength(10);
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("a handle is a slider named and placed at its value", () => {
    draw([handle(), handle({ id: "break-1", value: 55.5, kind: "break", label: "Break 1" })]);
    const [end, cut] = screen.getAllByRole("slider");
    expect(end.getAttribute("aria-label")).toBe("Lowest value");
    expect(end.getAttribute("aria-valuenow")).toBe("30");
    expect(end.style.left).toBe("30%");
    expect(end.getAttribute("data-handle")).toBe("end");
    expect(cut.getAttribute("data-handle")).toBe("break");
    expect(cut.style.left).toBe("55.5%");
    expect(end.tabIndex).toBe(0);
  });

  it("the arrow keys move a handle by a step, page keys by ten, never past its neighbours", () => {
    const onChange = vi.fn();
    draw([handle({ onChange, min: 25, max: 40 })]);
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(31);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(29);
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(39);
    fireEvent.keyDown(slider, { key: "PageUp" });
    // 40 is the next handle: the step stops short of it.
    expect(onChange).toHaveBeenLastCalledWith(39);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(26);
    fireEvent.keyDown(slider, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(39);
  });

  it("a drag moves the handle and writes once it is let go, at a step, within the bars", () => {
    const onChange = vi.fn();
    draw([handle({ onChange, max: 80 })]);
    const slider = screen.getByRole("slider");
    fireEvent.pointerDown(slider, { clientX: 60, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 101.3, pointerId: 1 });
    // While it moves, the handle shows where it is; nothing is written yet.
    expect(slider.getAttribute("aria-valuenow")).toBe("51");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerMove(slider, { clientX: -40, pointerId: 1 });
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.pointerMove(slider, { clientX: 190, pointerId: 1 });
    expect(slider.getAttribute("aria-valuenow")).toBe("79");
    fireEvent.pointerUp(slider, { clientX: 190, pointerId: 1 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(79);
    expect(slider.getAttribute("aria-valuenow")).toBe("30");
  });

  it("a press without a move writes nothing", () => {
    const onChange = vi.fn();
    draw([handle({ onChange })]);
    const slider = screen.getByRole("slider");
    fireEvent.pointerDown(slider, { clientX: 60, pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: 60, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the end labels and a handle's value read in the given format", () => {
    const format = (n: number) => `${n.toFixed(1)} m`;
    const { container } = draw([handle()], format);
    expect(Array.from(container.querySelectorAll("text")).map((t) => t.textContent)).toEqual([
      "0.0 m",
      "100.0 m",
    ]);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("30.0 m");
  });

  it("a cancelled drag ends without writing", () => {
    const onChange = vi.fn();
    draw([handle({ onChange })]);
    const slider = screen.getByRole("slider");
    fireEvent.pointerDown(slider, { clientX: 60, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 120, pointerId: 1 });
    fireEvent.pointerCancel(slider, { clientX: 120, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
    expect(slider.getAttribute("aria-valuenow")).toBe("30");
  });

  it("an end beyond the bars stays where it is on a step away from them, and steps toward them", () => {
    // A byte band's range, 0 to 255, over bars of 0 to 100: the ends stand at the edges.
    const low = vi.fn();
    const high = vi.fn();
    draw([
      handle({ value: -20, onChange: low, max: 255 }),
      handle({ id: "hi", value: 255, label: "Highest value", onChange: high, min: -20 }),
    ]);
    const [lo, hi] = screen.getAllByRole("slider");
    expect(lo.style.left).toBe("0%");
    expect(hi.style.left).toBe("100%");
    fireEvent.keyDown(lo, { key: "ArrowLeft" });
    fireEvent.keyDown(lo, { key: "Home" });
    fireEvent.keyDown(hi, { key: "ArrowRight" });
    fireEvent.keyDown(hi, { key: "End" });
    expect(low).not.toHaveBeenCalled();
    expect(high).not.toHaveBeenCalled();
    expect([lo.getAttribute("aria-valuemin"), hi.getAttribute("aria-valuemax")]).toEqual(["-20", "255"]);
    fireEvent.keyDown(lo, { key: "ArrowRight" });
    expect(low).toHaveBeenLastCalledWith(-19);
  });

  it("a break beyond the bars has no handle; an end does", () => {
    draw([
      handle({ id: "break-1", kind: "break", value: 140, label: "Break 1" }),
      handle({ id: "break-2", kind: "break", value: 50, label: "Break 2" }),
      handle({ id: "hi", value: 140, label: "Highest value" }),
    ]);
    expect(screen.getAllByRole("slider").map((s) => s.getAttribute("aria-label"))).toEqual([
      "Break 2",
      "Highest value",
    ]);
  });

  it("a break stops a step inside the bars, so it keeps its handle; an end reaches their edge", () => {
    const cut = vi.fn();
    const end = vi.fn();
    const handles = (value: number) => [
      handle({ id: "break-1", kind: "break", value, label: "Break 1", onChange: cut }),
      handle({ id: "hi", value: 60, label: "Highest value", onChange: end }),
    ];
    const view = draw(handles(30));
    const slider = screen.getAllByRole("slider")[0];
    expect([slider.getAttribute("aria-valuemin"), slider.getAttribute("aria-valuemax")]).toEqual(["1", "99"]);
    // A drag past the left edge of the bars.
    fireEvent.pointerDown(slider, { clientX: 60, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: -5, pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: -5, pointerId: 1 });
    expect(cut).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(cut).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(slider, { key: "End" });
    expect(cut).toHaveBeenLastCalledWith(99);
    // Where the break was taken to, it still has its handle.
    for (const value of [1, 99]) {
      view.rerender(<Histogram bins={BINS} breaks={[]} colorAt={() => "#000000"} handles={handles(value)} />);
      expect(screen.getAllByRole("slider")).toHaveLength(2);
    }
    const hi = screen.getAllByRole("slider")[1];
    fireEvent.keyDown(hi, { key: "End" });
    expect(end).toHaveBeenLastCalledWith(100);
    fireEvent.keyDown(hi, { key: "Home" });
    expect(end).toHaveBeenLastCalledWith(0);
  });

  it("on whole-number data a handle steps and snaps by whole numbers", () => {
    // Ten bins over 0 to 50: a hundredth of the span is half a unit.
    const bins: HistogramBin[] = Array.from({ length: 10 }, (_, i) => ({
      range: [i * 5, i * 5 + 5],
      count: 1,
    }));
    const onChange = vi.fn();
    const handles = [handle({ id: "break-1", kind: "break", value: 20, label: "Break 1", onChange })];
    const fractional = renderWithProviders(
      <Histogram bins={bins} breaks={[]} colorAt={() => "#000000"} handles={handles} />
    );
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(20.5);
    fractional.unmount();
    const view = renderWithProviders(
      <Histogram bins={bins} breaks={[]} colorAt={() => "#000000"} handles={handles} integer />
    );
    const box = view.container.querySelector("[data-histogram]") as HTMLElement;
    box.getBoundingClientRect = () =>
      ({ left: 0, right: WIDTH, width: WIDTH, top: 0, bottom: 50, height: 50, x: 0, y: 0 }) as DOMRect;
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(21);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(1);
    // 49.5 px of 200 over 0 to 50: 12.375.
    fireEvent.pointerDown(slider, { clientX: 80, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 49.5, pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: 49.5, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(12);
  });

  it("the step is a hundredth of the span, rounded to 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(100)).toBe(1);
    expect(niceStep(228)).toBe(2);
    expect(niceStep(0.4)).toBe(0.005);
  });
});
