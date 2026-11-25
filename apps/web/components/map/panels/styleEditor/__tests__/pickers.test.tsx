import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { classPaletteColors } from "@/lib/style/editor/classify";
import { paletteColors } from "@/lib/style/palettes";

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

  it("the science ramps come first in All palettes, under their heading; a kind lists them in their place", async () => {
    renderPanel(
      <PalettePicker value="goat:elevation" onChange={vi.fn()} kinds={["sequential", "diverging"]} />
    );
    const strips = () =>
      screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed") && b.getAttribute("title"));
    const headings = () =>
      // The grid's headings, not the name line above it.
      within(strips()[0].parentElement as HTMLElement)
        .getAllByText(/^style_editor\.palette_(group|kind)_/)
        .map((el) => el.textContent);
    expect(headings()[0]).toBe("style_editor.palette_group_science");
    expect(
      strips()
        .slice(0, 9)
        .map((b) => b.getAttribute("aria-label"))
    ).toEqual([
      "Viridis",
      "Elevation",
      "Magma",
      "Cividis",
      "Inferno",
      "Plasma",
      "Terrain",
      "Hypsometric tints",
      "NDVI",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.palette_kind_sequential" }));
    expect(screen.queryByText("style_editor.palette_group_science")).toBeNull();
    expect(strips()[0].getAttribute("aria-label")).toBe("BuGn");
  });

  const tabs = () =>
    screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? "")
      .filter((name) => name.startsWith("style_editor.palette_kind_"));
  /** The palette grid as [heading, strips under it] in order. */
  const sections = () => {
    const strip = screen
      .getAllByRole("button")
      .find((b) => b.hasAttribute("aria-pressed") && b.getAttribute("title"));
    const out: Array<[string, number]> = [];
    for (const el of Array.from((strip?.parentElement as HTMLElement).children)) {
      if (el.tagName === "BUTTON") out[out.length - 1][1] += 1;
      else out.push([el.textContent ?? "", 0]);
    }
    return out;
  };

  it("the numeric picker lists sequential and diverging palettes: the science ramps, then the catalogue's runs", () => {
    renderPanel(
      <PalettePicker value="goat:green" steps={5} onChange={vi.fn()} kinds={["sequential", "diverging"]} />
    );
    expect(tabs()).toEqual([
      "style_editor.palette_kind_all",
      "style_editor.palette_kind_sequential",
      "style_editor.palette_kind_diverging",
    ]);
    expect(sections()).toEqual([
      ["style_editor.palette_group_science", 9],
      ["style_editor.palette_kind_sequential", 18],
      ["style_editor.palette_kind_diverging", 9],
      ["style_editor.palette_kind_sequential", 6],
      ["style_editor.palette_kind_diverging", 23],
      ["style_editor.palette_kind_sequential", 31],
    ]);
  });

  it("the categories' picker offers every palette: the qualitative ones first, then sequential, then diverging", async () => {
    const onChange = vi.fn();
    const onReverse = vi.fn();
    renderPanel(
      <PalettePicker
        value={["#111111", "#222222", "#333333"]}
        steps={5}
        categories
        onChange={onChange}
        onReverse={onReverse}
        kinds={["qualitative", "sequential", "diverging"]}
      />
    );
    expect(tabs()).toEqual([
      "style_editor.palette_kind_all",
      "style_editor.palette_kind_qualitative",
      "style_editor.palette_kind_sequential",
      "style_editor.palette_kind_diverging",
    ]);
    expect(sections()).toEqual([
      ["style_editor.palette_yours", 1],
      ["style_editor.palette_kind_qualitative", 9],
      ["style_editor.palette_group_science", 9],
      ["style_editor.palette_kind_sequential", 55],
      ["style_editor.palette_kind_diverging", 32],
    ]);
    await userEvent.click(screen.getByRole("button", { name: "OrRd" }));
    expect(onChange).toHaveBeenCalledWith("colorbrewer:OrRd");
    await userEvent.click(screen.getByRole("button", { name: "style_editor.reverse" }));
    expect(onReverse).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.palette_kind_diverging" }));
    expect(screen.queryByRole("button", { name: "Set2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "OrRd" })).toBeNull();
    expect(screen.getByRole("button", { name: "RdBu" })).toBeDefined();
  });

  /** The colors a strip draws, in order (the computed style writes them as rgb). */
  const stripColors = (name: string) =>
    Array.from(
      getComputedStyle(screen.getByRole("button", { name })).background.matchAll(
        /rgb\((\d+), (\d+), (\d+)\)/g
      ),
      (m) =>
        `#${m
          .slice(1, 4)
          .map((v) => Number(v).toString(16).padStart(2, "0"))
          .join("")}`
    );

  it("in classes, a strip shows the colors that many classes get from the palette, reversed as they are", () => {
    const mine = ["#111111", "#222222", "#333333"];
    renderPanel(
      <PalettePicker
        value={mine}
        reverse
        steps={10}
        categories
        onChange={vi.fn()}
        kinds={["qualitative", "sequential", "diverging"]}
      />
    );
    // Ten categories of a qualitative palette repeat its colors in order, the palette turned round first.
    const categories = { method: "categories", reverse: true };
    expect(stripColors("Set2")).toEqual(classPaletteColors(categories, "colorbrewer:Set2", 10));
    expect(stripColors("Set2")).toHaveLength(10);
    // One's own colors repeat in order too, never blended.
    expect(stripColors("style_editor.my_colors")).toEqual(classPaletteColors(categories, mine, 10));
    expect(stripColors("style_editor.my_colors")).toEqual([
      "#333333",
      "#222222",
      "#111111",
      "#333333",
      "#222222",
      "#111111",
      "#333333",
      "#222222",
      "#111111",
      "#333333",
    ]);
    // A sequential or diverging palette gives categories the colors it gives as many ordered classes, reversed.
    expect(stripColors("OrRd")).toEqual(classPaletteColors(categories, "colorbrewer:OrRd", 10));
    expect(stripColors("OrRd")).toEqual(
      classPaletteColors({ method: "quantile", reverse: true }, "colorbrewer:OrRd", 10)
    );
    expect(stripColors("RdBu")).toEqual(classPaletteColors(categories, "colorbrewer:RdBu", 10));
  });

  it("in the numeric picker, one's own colors are blended for that many classes", () => {
    const mine = ["#000000", "#ffffff"];
    renderPanel(
      <PalettePicker value={mine} steps={3} onChange={vi.fn()} kinds={["sequential", "diverging"]} />
    );
    expect(stripColors("style_editor.my_colors")).toEqual(
      classPaletteColors({ method: "quantile" }, mine, 3)
    );
    expect(stripColors("style_editor.my_colors")).toHaveLength(3);
    expect(stripColors("style_editor.my_colors")[1]).not.toBe("#000000");
  });

  it("in classes of numbers, a strip shows the colors blended for that many classes; without classes, the ramp", () => {
    const { unmount } = renderPanel(
      <PalettePicker value="goat:elevation" steps={4} onChange={vi.fn()} kinds={["sequential"]} />
    );
    expect(stripColors("Viridis")).toEqual(classPaletteColors({ method: "quantile" }, "d3:viridis", 4));
    expect(stripColors("Viridis")).toHaveLength(4);
    unmount();
    renderPanel(<PalettePicker value="goat:elevation" reverse onChange={vi.fn()} kinds={["sequential"]} />);
    expect(stripColors("Viridis")).toEqual([...paletteColors("d3:viridis")].reverse());
  });

  it("an inline palette shows as yours; its colors are edited in the list under the Palette row, not here", async () => {
    const onChange = vi.fn();
    renderPanel(<PalettePicker value={["#000000", "#ffffff"]} onChange={onChange} kinds={["sequential"]} />);
    const mine = screen.getByRole("button", { name: "style_editor.my_colors" });
    expect(mine.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Blues" }));
    expect(onChange).toHaveBeenCalledWith("colorbrewer:Blues");
  });

  const fields: FieldInfo[] = [
    { name: "Einwohner 2020", type: "integer", label: "Einwohner 2020" },
    { name: "Straße", type: "string", label: "Straße" },
    { name: "density", type: "number", label: "Inhabitants per km²" },
  ];
  /** Enough fields for the menu's search (9). */
  const padded: FieldInfo[] = [
    ...fields,
    ...Array.from({ length: 6 }, (_, i) => ({
      name: `extra_${i}`,
      type: "string" as const,
      label: `extra_${i}`,
    })),
  ];
  const anchor = () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    return button;
  };

  it("FieldPicker is a menu at its control: a short list has no search, each field shows its kind", () => {
    renderPanel(<FieldPicker anchorEl={anchor()} onClose={vi.fn()} fields={fields} onChange={vi.fn()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    // The kind's badge before the name (123 for numbers, A for text), the field's name under a display name.
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "123Einwohner 2020",
      "AStraße",
      "123Inhabitants per km²density",
    ]);
  });

  it("FieldPicker finds Einwohner 2020 and Straße by search and filters numbers", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const at = anchor();
    const { rerender } = renderPanel(
      <FieldPicker anchorEl={at} onClose={onClose} fields={padded} onChange={onChange} />
    );
    await userEvent.type(screen.getByRole("textbox", { name: "style_editor.search_fields" }), "straß");
    expect(screen.getByText("Straße")).toBeDefined();
    expect(screen.queryByText("Einwohner 2020")).toBeNull();
    await userEvent.click(screen.getByText("Straße"));
    expect(onChange).toHaveBeenCalledWith("Straße");
    expect(onClose).toHaveBeenCalled();
    rerender(
      <FieldPicker anchorEl={at} onClose={onClose} fields={padded} onChange={onChange} filter="number" />
    );
    expect(screen.getByText("Einwohner 2020")).toBeDefined();
    expect(screen.getByText("Inhabitants per km²")).toBeDefined();
    expect(screen.queryByText("Straße")).toBeNull();
  });

  it("FieldPicker searches by a field's name under its display name and takes the first match on Enter", async () => {
    const onChange = vi.fn();
    renderPanel(<FieldPicker anchorEl={anchor()} onClose={vi.fn()} fields={padded} onChange={onChange} />);
    await userEvent.keyboard("dens");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "123Inhabitants per km²density",
    ]);
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("density");
  });

  it("FieldPicker renders 500 fields and searches without delay", async () => {
    const many: FieldInfo[] = Array.from({ length: 500 }, (_, i) => ({
      name: `field_${i}`,
      type: "string",
      label: `Field ${i}`,
    }));
    renderPanel(<FieldPicker anchorEl={anchor()} onClose={vi.fn()} fields={many} onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "style_editor.search_fields" }), {
      target: { value: "field_499" },
    });
    expect(screen.getByText("Field 499")).toBeDefined();
    expect(screen.queryByText("Field 1")).toBeNull();
  });
});
