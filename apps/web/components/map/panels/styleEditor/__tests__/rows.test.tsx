import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { useState } from "react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChoiceRow,
  ColorField,
  GroupRow,
  NavRow,
  NumberInput,
  PanelSection,
  Row,
  SegmentedRow,
  SliderRow,
  SwitchRow,
  TextRow,
  ZoomRangeRow,
} from "@/components/map/panels/styleEditor/rows";
import { valueChars } from "@/components/map/panels/styleEditor/rows/SliderRow";

import { renderPanel } from "./renderPanel";

const box = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: 10,
  right: 100,
  width: 100,
  height: 10,
  toJSON: () => ({}),
};

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box as DOMRect);
});
afterEach(() => vi.restoreAllMocks());

describe("rows", () => {
  it("a row without actions keeps no column for them: its field ends where a mode button ends", () => {
    renderPanel(
      <>
        <Row label="Fill">
          <span>field</span>
        </Row>
        <Row label="Size" actions={<button type="button">mode</button>}>
          <span>field</span>
        </Row>
      </>
    );
    const plain = screen.getByText("Fill").parentElement as HTMLElement;
    const withMode = screen.getByText("Size").parentElement as HTMLElement;
    expect(plain.children).toHaveLength(2);
    expect(getComputedStyle(plain).gridTemplateColumns).toBe("84px minmax(0, 1fr)");
    expect(withMode.children).toHaveLength(3);
    expect(getComputedStyle(withMode).gridTemplateColumns).toBe("84px minmax(0, 1fr) auto");
  });

  it("a number is never cut: a slider's value is as wide as its digits, a box grows with its value", () => {
    renderPanel(
      <>
        <SliderRow
          label="Spacing"
          min={0}
          max={2000}
          step={10}
          value={1250}
          unit="px"
          onChange={() => undefined}
        />
        <NumberInput value={21.5} unit="px" ariaLabel="Size" onChange={() => undefined} />
      </>
    );
    const slider = screen.getByRole("textbox", { name: "Spacing" }) as HTMLInputElement;
    expect(slider.value).toBe("1250");
    // The field takes the width of its text, sized by a hidden copy of it.
    expect(slider.closest("[data-reserve]")?.querySelector("[data-sizer]")?.textContent).toBe("1250");
    // 68 px is the box's width for short values; "21.5 px" needs more.
    const box = screen.getByRole("textbox", { name: "Size" }).closest(".MuiBox-root") as HTMLElement;
    expect(parseInt(getComputedStyle(box).width, 10)).toBeGreaterThan(68);
  });

  it("a slider's value keeps the room of its longest value, so the slider does not move while it changes", () => {
    expect(valueChars(0, 60, 0.5)).toBe(4);
    expect(valueChars(0, 1, 0.01, true)).toBe(3);
    expect(valueChars(0, 2000, 10)).toBe(4);
    const { rerender } = renderPanel(
      <SliderRow label="Size" min={0} max={60} step={0.5} value={9.5} unit="px" onChange={() => undefined} />
    );
    const input = () => screen.getByRole("textbox", { name: "Size" }) as HTMLInputElement;
    const room = () => input().closest("[data-reserve]")?.getAttribute("data-reserve");
    const sizer = () => input().closest("[data-reserve]")?.querySelector("[data-sizer]")?.textContent;
    // The number is as wide as its text, right after the slider; the room around it stays.
    expect(sizer()).toBe("9.5");
    expect(room()).toBe("4");
    rerender(
      <SliderRow label="Size" min={0} max={60} step={0.5} value={12.5} unit="px" onChange={() => undefined} />
    );
    expect(sizer()).toBe("12.5");
    expect(room()).toBe("4");
    // Another range keeps the same room: the sliders of a panel line up.
    rerender(
      <SliderRow label="Size" min={0.5} max={10} step={0.5} value={2} unit="px" onChange={() => undefined} />
    );
    expect(room()).toBe("4");
  });

  it("SliderRow calls onChange per tick and onCommit once", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    renderPanel(
      <SliderRow label="Width" min={0} max={10} step={1} value={2} onChange={onChange} onCommit={onCommit} />
    );
    const root = document.querySelector(".MuiSlider-root") as HTMLElement;
    fireEvent.mouseDown(root, { clientX: 30, buttons: 1 });
    fireEvent.mouseMove(document, { clientX: 50, buttons: 1 });
    fireEvent.mouseMove(document, { clientX: 70, buttons: 1 });
    fireEvent.mouseUp(document, { clientX: 70 });
    expect(onChange.mock.calls.map(([v]) => v)).toEqual([3, 5, 7]);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(7);
  });

  it("pct shows 0 to 100 and reports 0 to 1", async () => {
    const onChange = vi.fn();
    renderPanel(
      <SliderRow label="Opacity" min={0} max={1} step={0.05} pct value={0.72} onChange={onChange} />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("72");
    await userEvent.clear(input);
    await userEvent.type(input, "50");
    expect(onChange).toHaveBeenLastCalledWith(0.5);
  });

  it("a click anywhere on a number box, its unit included, puts the number up for typing", async () => {
    renderPanel(
      <>
        <NumberInput value={14} unit="px" ariaLabel="Box" onChange={() => undefined} />
        <NumberInput value={4} unit="px" plain ariaLabel="Plain" onChange={() => undefined} />
      </>
    );
    for (const name of ["Box", "Plain"]) {
      const input = screen.getByRole("textbox", { name }) as HTMLInputElement;
      await userEvent.click(within(input.closest("[data-number]") as HTMLElement).getByText("px"));
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    }
  });

  it("NumberInput keeps a draft until valid", async () => {
    const onChange = vi.fn();
    renderPanel(<NumberInput value={2} onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "1.");
    expect(onChange).not.toHaveBeenCalledWith(Number.NaN);
    expect(onChange.mock.calls.every(([v]) => typeof v === "number" && Number.isFinite(v))).toBe(true);
    expect(input.value).toBe("1.");
    await userEvent.type(input, "5");
    expect(onChange).toHaveBeenLastCalledWith(1.5);
  });

  it("a German NumberInput shows the decimal comma and takes 1,5 as typed (1.5 too)", async () => {
    const onChange = vi.fn();
    const german = i18next.createInstance();
    void german.use(initReactI18next).init({ lng: "de", resources: {}, initImmediate: false });
    renderPanel(
      <I18nextProvider i18n={german}>
        <NumberInput value={1.5} unit="px" ariaLabel="Box" onChange={onChange} />
        <NumberInput value={2.5} unit="px" plain ariaLabel="Plain" onChange={() => undefined} />
        <NumberInput value={0.355} pct ariaLabel="Share" onChange={() => undefined} />
      </I18nextProvider>
    );
    const box = screen.getByRole("textbox", { name: "Box" }) as HTMLInputElement;
    expect(box.value).toBe("1,5");
    expect((screen.getByRole("textbox", { name: "Plain" }) as HTMLInputElement).value).toBe("2,5");
    expect((screen.getByRole("textbox", { name: "Share" }) as HTMLInputElement).value).toBe("35,5");
    await userEvent.clear(box);
    await userEvent.type(box, "2,");
    expect(box.value).toBe("2,");
    await userEvent.type(box, "5");
    expect(onChange).toHaveBeenLastCalledWith(2.5);
    await userEvent.clear(box);
    await userEvent.type(box, "0.75");
    expect(onChange).toHaveBeenLastCalledWith(0.75);
    // Leaving the box shows the number in German again.
    fireEvent.blur(box);
    expect(box.value).toBe("1,5");
  });

  it("an English NumberInput keeps the point and does not read a comma as one", async () => {
    const onChange = vi.fn();
    renderPanel(<NumberInput value={1.5} ariaLabel="Box" onChange={onChange} />);
    const box = screen.getByRole("textbox", { name: "Box" }) as HTMLInputElement;
    expect(box.value).toBe("1.5");
    await userEvent.clear(box);
    await userEvent.type(box, "2,5");
    expect(onChange).not.toHaveBeenCalledWith(2.5);
    expect(onChange).not.toHaveBeenCalledWith(25);
  });

  it("an optional NumberInput reports an emptied box and shows what applies then", async () => {
    const onChange = vi.fn();
    const onClear = vi.fn();
    function Width() {
      const [value, setValue] = useState<number | undefined>(420);
      return (
        <NumberInput
          value={value}
          unit="px"
          placeholder="Auto"
          onChange={(v) => {
            onChange(v);
            setValue(v);
          }}
          onClear={() => {
            onClear();
            setValue(undefined);
          }}
        />
      );
    }
    renderPanel(<Width />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    await userEvent.clear(input);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    // Empty stays empty on leaving, with what applies then in its place.
    fireEvent.blur(input);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Auto");
  });

  it("ColorField is one button: the swatch and the color open the picker, by click and by key", async () => {
    const onOpen = vi.fn();
    renderPanel(<ColorField value="#cc00aa" onOpenPicker={onOpen} />);
    // No typing in the row: the picker has the text box.
    expect(screen.queryByRole("textbox")).toBeNull();
    const button = screen.getByRole("button", { name: "style_editor.pick_color" });
    expect(button.textContent).toBe("#CC00AA");
    await userEvent.click(screen.getByText("#CC00AA"));
    expect(onOpen).toHaveBeenLastCalledWith(button);
    button.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("ColorField shows a color's own transparency as six digits and a percent over the checkerboard, None at 0%", () => {
    const { unmount } = renderPanel(<ColorField value="#e87ab294" onOpenPicker={vi.fn()} />);
    const button = screen.getByRole("button", { name: "style_editor.pick_color" });
    expect(button.textContent).toBe("#E87AB2 · 58%");
    const swatch = getComputedStyle(button.firstElementChild as HTMLElement);
    // The color first, the checkerboard's two layers of corners under it.
    expect(swatch.backgroundImage.match(/linear-gradient/g)).toHaveLength(3);
    unmount();
    renderPanel(<ColorField value="#cc615c00" onOpenPicker={vi.fn()} />);
    expect(screen.getByRole("button", { name: "style_editor.pick_color" }).textContent).toBe(
      "style_editor.none"
    );
  });

  it("ColorField shows Same as fill for the sentinel", () => {
    renderPanel(
      <ColorField
        value="fill"
        sentinel={{ label: "style_editor.same_as_fill", shown: true }}
        onOpenPicker={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "style_editor.pick_color" }).textContent).toBe(
      "style_editor.same_as_fill"
    );
  });

  it("ChoiceRow lists options with subs and reports the value", async () => {
    const onChange = vi.fn();
    renderPanel(
      <ChoiceRow
        label="Ends"
        value="butt"
        options={[
          { value: "butt", label: "Flat" },
          { value: "square", label: "Square", sub: "Extends past the end by half the width" },
        ]}
        onChange={onChange}
      />
    );
    const select = screen.getByRole("combobox", { name: "Ends" });
    expect(select.textContent).toBe("Flat");
    await userEvent.click(select);
    const menu = screen.getByRole("listbox");
    expect(within(menu).getByText("Extends past the end by half the width")).toBeDefined();
    await userEvent.click(within(menu).getByText("Square"));
    expect(onChange).toHaveBeenCalledWith("square");
  });

  it("ChoiceRow searches a long list (13 choices and more)", async () => {
    const onChange = vi.fn();
    const options = Array.from({ length: 13 }, (_, i) => ({ value: i, label: `Field ${i + 1}` }));
    renderPanel(<ChoiceRow label="Field" value={0} options={options} onChange={onChange} />);
    await userEvent.click(screen.getByRole("combobox", { name: "Field" }));
    await userEvent.type(screen.getByRole("textbox", { name: "search_placeholder_short" }), "12");
    await userEvent.click(within(screen.getByRole("listbox")).getByText("Field 12"));
    expect(onChange).toHaveBeenCalledWith(11);
  });

  it("ZoomRangeRow marks the map zoom with the zoom chart's pointer, inside the track", () => {
    const { container, rerender } = renderPanel(
      <ZoomRangeRow from={8} until={14} mapZoom={12} onChange={vi.fn()} />
    );
    const pointer = container.querySelector("[data-zoom-pointer]") as HTMLElement;
    expect(pointer.style.left).toBe("50%");
    expect(pointer.getAttribute("title")).toBe("12");
    rerender(<ZoomRangeRow from={8} until={14} mapZoom={30} onChange={vi.fn()} />);
    expect((container.querySelector("[data-zoom-pointer]") as HTMLElement).style.left).toBe("100%");
  });

  it("ZoomRangeRow zooms the map: a press under the track goes there, its pointer drags the map's zoom", () => {
    const map = { getZoom: () => 12, on: vi.fn(), off: vi.fn(), jumpTo: vi.fn(), easeTo: vi.fn() };
    const { container } = renderPanel(<ZoomRangeRow from={8} until={14} mapZoom={12} onChange={vi.fn()} />, {
      map: map as never,
    });
    const strip = container.querySelector("[data-zoom-strip]") as HTMLElement;
    strip.getBoundingClientRect = () => ({ left: 0, width: 240, top: 0, height: 12 }) as DOMRect;
    fireEvent.pointerMove(strip, { clientX: 180, pointerId: 1 });
    expect(container.querySelector('[data-ghost="zoom"]')?.textContent).toBe("18.0");
    fireEvent.pointerDown(strip, { clientX: 180, pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: 180, pointerId: 1 });
    expect(map.easeTo).toHaveBeenCalledWith({ zoom: 18 });
    fireEvent.pointerDown(strip, { clientX: 120, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 130, pointerId: 1 });
    expect(map.jumpTo).toHaveBeenLastCalledWith({ zoom: 13 });
  });

  it("ZoomRangeRow writes undefined at the ends", () => {
    const onChange = vi.fn();
    renderPanel(<ZoomRangeRow from={8} until={14} mapZoom={12} onChange={onChange} />);
    const [low, high] = screen.getAllByRole("slider");
    expect(high.getAttribute("aria-valuemax")).toBe("24");
    // jsdom has no keyboard behavior for range inputs: move the thumbs by changing their values.
    fireEvent.change(low, { target: { value: 0 } });
    expect(onChange).toHaveBeenLastCalledWith(undefined, 14);
    fireEvent.change(high, { target: { value: 24 } });
    expect(onChange).toHaveBeenLastCalledWith(8, undefined);
  });

  it("a group or nav row carries a note under its field and a nav row its actions", () => {
    renderPanel(
      <>
        <GroupRow label="Height" value="10 m" note={<span>flat in 2D</span>} onOpen={vi.fn()} />
        <NavRow value="Quiet" note="Hidden" actions={<button type="button">up</button>} onOpen={vi.fn()} />
      </>
    );
    // Under the field, in the control column (Row's note).
    const column = (el: HTMLElement) => getComputedStyle(el).gridColumn.replace(/\s/g, "");
    expect(column(screen.getByText("flat in 2D").parentElement as HTMLElement)).toBe("2/-1");
    // Without a label the row is the field alone, its note under it across the row.
    const rule = screen.getByText("Hidden");
    expect(column(rule)).toBe("1/-1");
    const row = rule.parentElement as HTMLElement;
    expect(getComputedStyle(row).gridTemplateColumns).toBe("minmax(0, 1fr) auto");
    expect(within(row).getByRole("button", { name: "up" })).toBeDefined();
  });

  it("a long label wraps in the label column, hyphenated, rather than being cut off", () => {
    renderPanel(<SwitchRow label="Bildunterschrift" on onToggle={() => undefined} />);
    const label = screen.getByText("Bildunterschrift");
    expect(label.className).not.toContain("MuiTypography-noWrap");
    expect(label).toHaveStyle({ hyphens: "auto", overflowWrap: "break-word" });
  });

  it("a dense row is shorter: for a list of names rather than of fields", () => {
    renderPanel(
      <>
        <Row>plain</Row>
        <Row dense>dense</Row>
        <NavRow dense value="nav" onOpen={() => undefined} />
      </>
    );
    // The row is the grid around its value.
    const rowOf = (text: string) => {
      let element: HTMLElement | null = screen.getByText(text);
      while (element && getComputedStyle(element).display !== "grid") element = element.parentElement;
      return element as HTMLElement;
    };
    expect(rowOf("plain")).toHaveStyle({ minHeight: "48px" });
    expect(rowOf("dense")).toHaveStyle({ minHeight: "36px" });
    expect(rowOf("nav")).toHaveStyle({ minHeight: "36px" });
  });

  it("a disabled field shows its value but does not open; only its swatch dims, MUI greys the text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onOpen = vi.fn();
    renderPanel(
      <NavRow
        label="Colors"
        value="Continuous"
        swatch={{ background: "#ff0000", wide: true }}
        tooltip="Continuous colors"
        disabled
        onOpen={onOpen}
      />
    );
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onOpen).not.toHaveBeenCalled();
    // The field is not dimmed as a whole: its text takes MUI's disabled color, the swatch alone is dimmed.
    expect(getComputedStyle(button.closest(".MuiInputBase-root") as HTMLElement).opacity).not.toBe("0.55");
    expect(getComputedStyle(button.firstElementChild as HTMLElement).opacity).toBe("0.5");
    // A tooltip on a disabled button listens on a wrapper (MUI warns otherwise).
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/disabled `button` child/);
    error.mockRestore();
  });

  it("a section's add button can wait", () => {
    const onClick = vi.fn();
    renderPanel(<PanelSection title="Categories" add={{ label: "Add a class", onClick, disabled: true }} />);
    expect((screen.getByRole("button", { name: "Add a class" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("rows have accessible names", () => {
    renderPanel(
      <PanelSection title="Polygons" add={{ label: "style_editor.add_rule", onClick: vi.fn() }}>
        <GroupRow label="Fill" value="#CCCCCC · 72%" onOpen={vi.fn()} />
        <NavRow label="Contents" value="None" onOpen={vi.fn()} />
        <ColorField value="#cccccc" onOpenPicker={vi.fn()} />
        <SwitchRow label="Show" on onToggle={vi.fn()} />
        <TextRow label="Title" value="" onChange={vi.fn()} />
        <SegmentedRow
          label="Mode"
          value="simple"
          options={[
            { value: "simple", label: "Simple" },
            { value: "html", label: "HTML" },
          ]}
          onChange={vi.fn()}
        />
      </PanelSection>
    );
    for (const button of screen.getAllByRole("button")) {
      expect(
        button.getAttribute("aria-label") || button.textContent?.trim(),
        button.outerHTML.slice(0, 80)
      ).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "style_editor.add_rule" })).toBeDefined();
    expect(screen.getByRole("button", { name: "style_editor.pick_color" })).toBeDefined();
  });
});
