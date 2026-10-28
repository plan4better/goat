import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FieldInfo } from "@/components/map/panels/styleEditor/context";
import { ColorPicker } from "@/components/map/panels/styleEditor/pickers/ColorPicker";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { PalettePicker } from "@/components/map/panels/styleEditor/pickers/PalettePicker";

import { renderPanel } from "./renderPanel";

afterEach(() => vi.restoreAllMocks());

describe("pickers", () => {
  it("ColorPicker reports hex live while dragging and offers the presets", async () => {
    const onChange = vi.fn();
    renderPanel(<ColorPicker value="#2166ac" onChange={onChange} docColors={["#ff0000"]} />);
    // react-colorful's saturation area moves by keyboard as it does by drag; every step reports at once.
    const saturation = screen.getAllByRole("slider")[0];
    fireEvent.keyDown(saturation, { key: "ArrowLeft", keyCode: 37 });
    fireEvent.keyDown(saturation, { key: "ArrowLeft", keyCode: 37 });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls.every(([hex]) => /^#[0-9a-f]{6}$/.test(hex))).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "#2bb381" }));
    expect(onChange).toHaveBeenLastCalledWith("#2bb381");
    expect(screen.getByRole("button", { name: "#ff0000" })).toBeDefined();
    expect(screen.getAllByRole("button", { name: /^#[0-9a-f]{6}$/ }).length).toBeGreaterThanOrEqual(21);
  });

  it("ColorPicker shows and reads the color as Hex, RGB or HSL, and has no opacity", async () => {
    window.localStorage.removeItem("goat.color-format");
    const onChange = vi.fn();
    renderPanel(<ColorPicker value="#833b21" onChange={onChange} docColors={[]} />);
    const box = screen.getByRole("textbox", { name: "color_value" }) as HTMLInputElement;
    expect(box.value).toBe("#833B21");
    await userEvent.click(screen.getByRole("button", { name: "color_format" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "RGB" }));
    expect(box.value).toBe("131, 59, 33");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "0, 128, 255" } });
    expect(onChange).toHaveBeenLastCalledWith("#0080ff");
    await userEvent.click(screen.getByRole("button", { name: "color_format" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "HSL" }));
    expect(window.localStorage.getItem("goat.color-format")).toBe("hsl");
    // Opacity is the part's own row, not the picker's.
    expect(screen.queryByText("style_editor.opacity")).toBeNull();
  });

  it("Same as fill is the picker's first choice, pressed while it is the value", async () => {
    const onPick = vi.fn();
    const sentinel = { label: "style_editor.same_as_fill", onPick };
    const { unmount } = renderPanel(
      <ColorPicker
        value="#2bb381"
        onChange={vi.fn()}
        docColors={["#ff0000"]}
        sentinel={{ ...sentinel, selected: false }}
      />
    );
    const option = screen.getByRole("button", { name: "style_editor.same_as_fill" });
    // Before the swatches: a choice of value, not a section of its own.
    const firstTitle = screen.getByText("style_editor.colors_in_this_style");
    expect(option.compareDocumentPosition(firstTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(option.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getAllByRole("button", { name: "#2bb381" })[0].getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(option);
    expect(onPick).toHaveBeenCalledTimes(1);
    unmount();

    // Taken from the fill, the color the picker starts at is not a pick of its own: no swatch is pressed.
    renderPanel(
      <ColorPicker
        value="#2bb381"
        onChange={vi.fn()}
        docColors={["#ff0000"]}
        sentinel={{ ...sentinel, selected: true }}
      />
    );
    expect(
      screen.getByRole("button", { name: "style_editor.same_as_fill" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
  });

  it("recent colors survive without localStorage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { unmount } = renderPanel(<ColorPicker value="#2166ac" onChange={vi.fn()} docColors={[]} />);
    expect(screen.getByText("style_editor.goat_colors")).toBeDefined();
    expect(() => unmount()).not.toThrow();
  });

  it("a color listed twice among the style's colors shows as one swatch", () => {
    renderPanel(
      <ColorPicker value="#145c42" onChange={vi.fn()} docColors={["#145c42", "#145C42", "#e6f6ef"]} />
    );
    expect(screen.getAllByRole("button", { name: "#145c42" })).toHaveLength(1);
  });

  it("PalettePicker filters by kind and reverses; strips carry their names for hover and screen readers", async () => {
    const onChange = vi.fn();
    const onReverse = vi.fn();
    renderPanel(
      <PalettePicker
        value="colorbrewer:OrRd"
        reverse={false}
        onChange={onChange}
        onReverse={onReverse}
        kinds={["sequential", "qualitative"]}
      />
    );
    const orRd = screen.getByRole("button", { name: "OrRd" });
    expect(orRd.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("style_editor.palette_in_use")).toBeDefined();
    await userEvent.hover(screen.getByRole("button", { name: "Blues" }));
    expect(screen.getByText("Blues")).toBeDefined();
    expect(screen.queryByText("style_editor.palette_in_use")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.palette_kind_qualitative" }));
    expect(screen.queryByRole("button", { name: "OrRd" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Set2" }));
    expect(onChange).toHaveBeenCalledWith("colorbrewer:Set2");
    await userEvent.click(screen.getByRole("button", { name: "style_editor.reverse" }));
    expect(onReverse).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("button", { name: "RdBu" })).toBeNull();
  });

  it("my own palette: pick a color to change it, add and remove, then apply it", async () => {
    const onChange = vi.fn();
    renderPanel(<PalettePicker value={["#000000", "#ffffff"]} onChange={onChange} kinds={["sequential"]} />);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.make_my_own_palette" }));
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_color" }));
    expect(screen.getAllByRole("button", { name: "style_editor.palette_color" })).toHaveLength(3);
    const [first] = screen.getAllByRole("button", { name: "style_editor.palette_color" });
    await userEvent.click(first);
    await userEvent.click(screen.getByRole("button", { name: "#d7301f" }));
    await userEvent.click(screen.getAllByRole("button", { name: "style_editor.remove_color" })[1]);
    await userEvent.click(screen.getByRole("button", { name: "apply" }));
    expect(onChange).toHaveBeenCalledWith(["#d7301f", "#ffffff"]);
  });

  const fields: FieldInfo[] = [
    { name: "Einwohner 2020", type: "integer", label: "Einwohner 2020" },
    { name: "Straße", type: "string", label: "Straße" },
    { name: "density", type: "number", label: "Inhabitants per km²" },
  ];

  it("FieldPicker finds Einwohner 2020 and Straße by search and filters numbers", async () => {
    const onChange = vi.fn();
    const { rerender } = renderPanel(<FieldPicker fields={fields} onChange={onChange} />);
    await userEvent.type(screen.getByRole("textbox", { name: "style_editor.search_fields" }), "straß");
    expect(screen.getByText("Straße")).toBeDefined();
    expect(screen.queryByText("Einwohner 2020")).toBeNull();
    await userEvent.click(screen.getByText("Straße"));
    expect(onChange).toHaveBeenCalledWith("Straße");
    rerender(<FieldPicker fields={fields} onChange={onChange} filter="number" />);
    await userEvent.clear(screen.getByRole("textbox", { name: "style_editor.search_fields" }));
    expect(screen.getByText("Einwohner 2020")).toBeDefined();
    expect(screen.getByText("Inhabitants per km²")).toBeDefined();
    expect(screen.queryByText("Straße")).toBeNull();
  });

  it("FieldPicker renders 500 fields and searches without delay", async () => {
    const many: FieldInfo[] = Array.from({ length: 500 }, (_, i) => ({
      name: `field_${i}`,
      type: "string",
      label: `Field ${i}`,
    }));
    renderPanel(<FieldPicker fields={many} onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "style_editor.search_fields" }), {
      target: { value: "field_499" },
    });
    expect(screen.getByText("Field 499")).toBeDefined();
    expect(screen.queryByText("Field 1")).toBeNull();
  });
});
