import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CustomColorPicker from "@/components/map/panels/style/color/CustomColorPicker";
import { ColorPicker, noneChoice } from "@/components/map/panels/styleEditor/pickers/ColorPicker";

import { renderPanel, renderWithProviders } from "./renderPanel";

// The color picker's transparency (spec 4.6): a bar under the hue bar and a percent beside the
// six-digit value; Auto and None as buttons in front of the swatches. The style stores eight digits, people never
// see them.

beforeEach(() => window.localStorage.removeItem("goat.color-format"));
afterEach(() => vi.restoreAllMocks());

const slider = (name: string) => screen.getByRole("slider", { name });
const hue = () => slider("Hue");
const bar = () => slider("style_editor.transparency");
const percent = () =>
  screen.getByRole("textbox", { name: "style_editor.transparency_percent" }) as HTMLInputElement;
const hexBox = () => screen.getByRole("textbox", { name: "color_value" }) as HTMLInputElement;
/** One step of the transparency bar (a range input: in jsdom its arrow keys are the browser's, so the step is sent as
 * the input's change). */
const stepBar = (by: number) =>
  fireEvent.change(bar(), { target: { value: String(Number((bar() as HTMLInputElement).value) + by) } });
const key = (el: HTMLElement, k: "ArrowLeft" | "ArrowRight") =>
  fireEvent.keyDown(el, { key: k, keyCode: k === "ArrowLeft" ? 37 : 39 });

describe("a color with its own transparency in the picker", () => {
  it.each([
    ["#cc615c81", "51"],
    ["#cc615c01", "1"],
    ["#cc615cfe", "99"],
  ])(
    "%s shows six digits and its percent (%s), and keeps its exact alpha when the hue changes",
    (value, shown) => {
      const onChange = vi.fn();
      renderPanel(<ColorPicker value={value} onChange={onChange} docColors={[]} />);
      expect(hexBox().value).toBe("#CC615C");
      expect(percent().value).toBe(shown);
      key(hue(), "ArrowRight");
      expect(onChange).toHaveBeenCalledTimes(1);
      const [written] = onChange.mock.calls[0];
      expect(written.slice(0, 7)).not.toBe("#cc615c");
      expect(written.slice(7)).toBe(value.slice(7));
    }
  );

  it("the bar changes the transparency alone, the color kept", () => {
    const onChange = vi.fn();
    renderPanel(<ColorPicker value="#cc615c80" onChange={onChange} docColors={[]} />);
    stepBar(-1);
    const [written] = onChange.mock.lastCall!;
    expect(written.slice(0, 7)).toBe("#cc615c");
    expect(parseInt(written.slice(7), 16)).toBeLessThan(0x80);
  });

  it("the percent field writes the transparency, 100 as six digits", () => {
    const onChange = vi.fn();
    renderPanel(<ColorPicker value="#cc615c" onChange={onChange} docColors={[]} />);
    expect(percent().value).toBe("100");
    fireEvent.focus(percent());
    fireEvent.change(percent(), { target: { value: "40" } });
    expect(onChange).toHaveBeenLastCalledWith("#cc615c66");
    fireEvent.change(percent(), { target: { value: "100" } });
    expect(onChange).toHaveBeenLastCalledWith("#cc615c");
    fireEvent.change(percent(), { target: { value: "140" } });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("a pasted eight-digit hex is split into the color and the percent; six digits keep the percent", () => {
    const onChange = vi.fn();
    const { rerender } = renderPanel(<ColorPicker value="#cc615c80" onChange={onChange} docColors={[]} />);
    fireEvent.focus(hexBox());
    fireEvent.change(hexBox(), { target: { value: "#11223333" } });
    expect(onChange).toHaveBeenLastCalledWith("#11223333");
    // Split at once, while the field still has the focus: six digits in the field, never eight.
    expect(hexBox().value).toBe("#112233");
    fireEvent.change(hexBox(), { target: { value: "#445566" } });
    expect(onChange).toHaveBeenLastCalledWith("#44556680");
    rerender(<ColorPicker value="#11223333" onChange={onChange} docColors={[]} />);
    fireEvent.blur(hexBox());
    expect(hexBox().value).toBe("#112233");
    expect(percent().value).toBe("20");
  });

  it("RGB and HSL keep working beside the percent", async () => {
    const onChange = vi.fn();
    renderPanel(<ColorPicker value="#833b2180" onChange={onChange} docColors={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "color_format" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "RGB" }));
    expect(hexBox().value).toBe("131, 59, 33");
    expect(percent().value).toBe("50");
    fireEvent.focus(hexBox());
    fireEvent.change(hexBox(), { target: { value: "0, 128, 255" } });
    expect(onChange).toHaveBeenLastCalledWith("#0080ff80");
    fireEvent.blur(hexBox());
    await userEvent.click(screen.getByRole("button", { name: "color_format" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "HSL" }));
    expect(hexBox().value).toBe("16, 60%, 32%");
  });

  it("the format switch lies inside the value field, the percent beside it", () => {
    renderPanel(<ColorPicker value="#833b21" onChange={vi.fn()} docColors={[]} />);
    const field = hexBox().closest(".MuiInputBase-root") as HTMLElement;
    expect(within(field).getByRole("button", { name: "color_format" })).toBeTruthy();
    expect(field.contains(percent())).toBe(false);
  });

  it("a swatch keeps the percent, and gives 100 from None", async () => {
    const onChange = vi.fn();
    const { rerender } = renderPanel(<ColorPicker value="#cc615c80" onChange={onChange} docColors={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "#2BB381" }));
    expect(onChange).toHaveBeenLastCalledWith("#2bb38180");
    rerender(<ColorPicker value="#cc615c00" onChange={onChange} docColors={[]} />);
    // GOAT's colors, then the recent ones, which now hold it too.
    await userEvent.click(screen.getAllByRole("button", { name: "#2BB381" })[0]);
    expect(onChange).toHaveBeenLastCalledWith("#2bb381");
    // A color chosen in the square or the hue bar from None is visible again too.
    key(hue(), "ArrowRight");
    expect(onChange.mock.lastCall![0]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("never names a color by eight digits, and leaves a None color of the style out of the swatches", () => {
    renderPanel(
      <ColorPicker value="#145c4280" onChange={vi.fn()} docColors={["#145c4280", "#e6f6ef", "#cc615c00"]} />
    );
    expect(screen.getByRole("button", { name: "#145C42 · 50%" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /cc615c/i })).toBeNull();
    for (const el of document.querySelectorAll("[aria-label]"))
      expect(el.getAttribute("aria-label")).not.toMatch(/#[0-9a-f]{8}/i);
  });

  it("keeps the colors picked as recent colors, without their transparency", async () => {
    window.localStorage.removeItem("goat.style.recent-colors");
    renderPanel(<ColorPicker value="#cc615c80" onChange={vi.fn()} docColors={["#145c4280"]} />);
    await userEvent.click(screen.getByRole("button", { name: "#145C42 · 50%" }));
    expect(JSON.parse(window.localStorage.getItem("goat.style.recent-colors") ?? "[]")).toEqual(["#145c42"]);
  });
});

describe("Auto and None in the picker", () => {
  const choices = (selected: "auto" | "none" | null, onAuto = vi.fn(), onNone = vi.fn()) => [
    { label: "style_editor.auto", selected: selected === "auto", onPick: onAuto },
    { label: "style_editor.none", selected: selected === "none", onPick: onNone, none: true },
  ];

  it("are two buttons in front of the swatches, pressed while they are the value", () => {
    renderPanel(
      <ColorPicker value="#592a63" onChange={vi.fn()} docColors={["#ff0000"]} sentinels={choices("auto")} />
    );
    const auto = screen.getByRole("button", { name: "style_editor.auto" });
    const none = screen.getByRole("button", { name: "style_editor.none" });
    expect(auto.getAttribute("aria-pressed")).toBe("true");
    expect(none.getAttribute("aria-pressed")).toBe("false");
    const firstTitle = screen.getByText("style_editor.colors_in_this_style");
    expect(none.compareDocumentPosition(firstTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
  });

  it("on Auto the percent and the bar are inactive, and a color chosen leaves Auto", () => {
    const onChange = vi.fn();
    renderPanel(
      <ColorPicker value="#592a63" onChange={onChange} docColors={[]} sentinels={choices("auto")} />
    );
    expect(percent().disabled).toBe(true);
    expect((bar() as HTMLInputElement).disabled).toBe(true);
    fireEvent.keyDown(bar(), { key: "PageDown" });
    stepBar(-1);
    expect(onChange).not.toHaveBeenCalled();
    key(hue(), "ArrowRight");
    expect(onChange.mock.lastCall![0]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("are reached and chosen with the keyboard", async () => {
    const onAuto = vi.fn();
    const onNone = vi.fn();
    renderPanel(
      <ColorPicker
        value="#592a63"
        onChange={vi.fn()}
        docColors={[]}
        sentinels={choices(null, onAuto, onNone)}
      />
    );
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "style_editor.auto" }));
    await userEvent.keyboard("{Enter}");
    expect(onAuto).toHaveBeenCalledTimes(1);
    await userEvent.tab();
    await userEvent.keyboard(" ");
    expect(onNone).toHaveBeenCalledTimes(1);
  });

  it("the bar is reached with the keyboard and moves by the arrow keys", () => {
    const onChange = vi.fn();
    renderPanel(<ColorPicker value="#cc615c" onChange={onChange} docColors={[]} />);
    expect(bar().tabIndex).toBe(0);
    expect((bar() as HTMLInputElement).disabled).toBe(false);
    expect(bar().getAttribute("aria-valuenow")).toBe("100");
    // The slider's own keys: Page Down is ten percent.
    fireEvent.keyDown(bar(), { key: "PageDown" });
    expect(onChange).toHaveBeenLastCalledWith("#cc615ce6");
  });
});

describe("the old style panel's picker", () => {
  it("has no transparency: no bar, no percent", () => {
    renderWithProviders(<CustomColorPicker selectedColor="#ff0000" onSelectColor={vi.fn()} />);
    expect(screen.queryByRole("slider", { name: "style_editor.transparency" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "style_editor.transparency_percent" })).toBeNull();
  });
});

describe("what the picker writes", () => {
  it("a click on the transparency bar changes the transparency only, the color kept to the digit", () => {
    const onChange = vi.fn();
    renderPanel(<ColorPicker value="#cc615cfe" onChange={onChange} docColors={[]} />);
    const root = bar().closest(".MuiSlider-root") as HTMLElement;
    const rect = { left: 0, top: 0, width: 200, height: 12, right: 200, bottom: 12, x: 0, y: 0 } as DOMRect;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ ...rect, toJSON: () => rect });
    // Near the opaque end, then at the middle: the transparency moves, the color stays to the digit.
    fireEvent.mouseDown(root, { clientX: 199.5, clientY: 6, button: 0 });
    fireEvent.mouseUp(document, { clientX: 199.5, clientY: 6, button: 0 });
    expect(onChange.mock.lastCall![0]).toBe("#cc615c");
    fireEvent.mouseDown(root, { clientX: 100, clientY: 6, button: 0 });
    fireEvent.mouseUp(document, { clientX: 100, clientY: 6, button: 0 });
    expect(onChange.mock.lastCall![0]).toBe("#cc615c80");
  });

  it("an opaque color is written with six digits, also when typed or listed with eight", async () => {
    window.localStorage.removeItem("goat.style.recent-colors");
    const onChange = vi.fn();
    renderPanel(<ColorPicker value="#cc615c" onChange={onChange} docColors={["#145c42ff"]} />);
    fireEvent.focus(hexBox());
    fireEvent.change(hexBox(), { target: { value: "#112233ff" } });
    expect(onChange).toHaveBeenLastCalledWith("#112233");
    fireEvent.blur(hexBox());
    await userEvent.click(screen.getByRole("button", { name: "#145C42" }));
    expect(onChange).toHaveBeenLastCalledWith("#145c42");
  });

  it("a stored opaque eight-digit color presses the swatch of its six digits", () => {
    window.localStorage.removeItem("goat.style.recent-colors");
    renderPanel(<ColorPicker value="#145c42ff" onChange={vi.fn()} docColors={["#145c42ff"]} />);
    expect(screen.getByRole("button", { name: "#145C42" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("a live color keeps its exact alpha through hue, square, format and swatch, and the bar at 0 % presses None", async () => {
    window.localStorage.removeItem("goat.style.recent-colors");
    const writes: string[] = [];
    function Live() {
      const [value, setValue] = useState("#4daf4a81");
      const write = (hex: string) => {
        writes.push(hex);
        setValue(hex);
      };
      return (
        <ColorPicker
          value={value}
          onChange={write}
          docColors={[]}
          sentinels={[noneChoice("style_editor.none", value, write)]}
        />
      );
    }
    renderPanel(<Live />);
    key(hue(), "ArrowRight");
    key(screen.getAllByRole("slider")[0], "ArrowLeft");
    await userEvent.click(screen.getByRole("button", { name: "color_format" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "HSL" }));
    await userEvent.click(screen.getAllByRole("button", { name: "#2BB381" })[0]);
    key(hue(), "ArrowLeft");
    expect(writes.length).toBe(4);
    for (const hex of writes) expect(hex.slice(7)).toBe("81");
    fireEvent.change(bar(), { target: { value: "0" } });
    expect(writes.at(-1)!.slice(7)).toBe("00");
    expect(screen.getByRole("button", { name: "style_editor.none" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
  });
});
