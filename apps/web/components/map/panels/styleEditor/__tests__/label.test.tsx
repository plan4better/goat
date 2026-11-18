import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import type { StyleData } from "@/components/map/panels/styleEditor/context";
import { LabelEditor } from "@/components/map/panels/styleEditor/editors/LabelEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { choose, openGroup, renderPanel } from "./renderPanel";

const FIELDS = [
  { name: "name", type: "string" as const, label: "name" },
  { name: "population", type: "integer" as const, label: "population" },
  { name: "Einwohner 2020", type: "integer" as const, label: "Einwohner 2020" },
  { name: "a{b}", type: "string" as const, label: "a{b}" },
];

function render(
  label: object,
  geometry: Geometry = "polygon",
  data: Partial<StyleData> = {},
  extra: object = {}
) {
  const result = renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "vector", symbol: { label }, ...extra } as LayerStyle,
      data: {
        geometry,
        fields: FIELDS,
        fieldTypes: Object.fromEntries(FIELDS.map((f) => [f.name, f.type])),
        sample: { name: "Berlin", population: 3850000 },
        ...data,
      },
    }
  );
  return result;
}

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;
/** The row of the panel or of the label editor, not the popover it opened (whose title has the same text). */
const firstRowOf = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;
const level = (n: number) => document.querySelector(`[data-popover-level='${n}']`) as HTMLElement | null;
/** The Width row of the Halo popover. */
const haloWidth = () => within(level(2)!).getByText("style_editor.width").parentElement as HTMLElement;
/** Opens one of the label editor's popovers by its row: Halo, Text style or Position. */
const openRow = (label: string) => userEvent.click(within(firstRowOf(label)).getAllByRole("button")[0]);
const pickMode = async (label: string, mode: string) => {
  await userEvent.click(within(rowOf(label)).getByRole("button", { name: "style_editor.value_mode_aria" }));
  await userEvent.click(within(screen.getByRole("menu")).getByText(mode));
};

/** The Font menu's eight fonts by their whole names, in menu order (texts are keys without copy: a choice's name falls
 * back to its value). Regular under Italic is named "Regular italic", so the name holds the row's text. */
const FONTS = [
  "regular",
  "bold",
  "medium",
  "light",
  "regular_italic",
  "bold_italic",
  "medium_italic",
  "light_italic",
];
/** The open Font menu: its headings, its options as shown (each by its weight, under its group) and as named. */
function fontMenu() {
  const list = screen.getByRole("listbox");
  const options = within(list).getAllByRole("option");
  return {
    headings: [...list.querySelectorAll("li:not([role])")].map((li) => li.textContent),
    shown: options.map((o) => o.textContent),
    names: options.map((o) => o.getAttribute("aria-label") ?? o.textContent),
  };
}
/** Opens a Font field and picks a font by its whole name. */
async function pickFont(field: HTMLElement, font: string) {
  await userEvent.click(field);
  await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: font }));
}
/** The Font menu as it opens: two groups of four weights, upright, then italic. */
const FONT_MENU = {
  headings: ["normal", "italic"],
  shown: ["regular", "bold", "medium", "light", "regular", "bold", "medium", "light"],
  names: FONTS,
};

describe("label part", () => {
  it("the label row shows the field and the size", () => {
    render({ text: "{population}", size: 14 });
    expect(screen.getByText("population · 14 px")).toBeDefined();
  });

  it("picking a field writes {field}", async () => {
    const { store } = render({ text: "{name}" });
    await openGroup("style_editor.part_label");
    await userEvent.click(within(rowOf("style_editor.text")).getByRole("combobox"));
    await userEvent.click(screen.getByText("Einwohner 2020"));
    expect(store.get("symbol.label.text")).toBe("{Einwohner 2020}");
    await userEvent.click(within(rowOf("style_editor.text")).getByRole("combobox"));
    await userEvent.click(screen.getByText("a{b}"));
    expect(store.get("symbol.label.text")).toBe("{a\\{b\\}}");
  });

  it("the preview fills the template from the sample feature", async () => {
    render({ text: "{name}, {population} inhabitants {gone}" });
    await openGroup("style_editor.part_label");
    expect(screen.getByText("Berlin, 3,850,000 inhabitants {gone?}")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "style_editor.template" })).toBeDefined();
  });

  it("Numbers appears only for number fields", async () => {
    const { store } = render({ text: "{name}" });
    await openGroup("style_editor.part_label");
    expect(screen.queryByText("style_editor.numbers")).toBeNull();
    await userEvent.click(within(rowOf("style_editor.text")).getByRole("combobox"));
    await userEvent.click(screen.getByText("population"));
    expect(store.get("symbol.label.text")).toBe("{population}");
    expect(screen.getByText("style_editor.numbers")).toBeDefined();
    expect(screen.getByText("style_editor.as_in_dataset")).toBeDefined();
  });

  /** The options of the Position popover's Placement menu, opened. */
  const placementOptions = async () => {
    const row = screen.getByText("style_editor.placement").parentElement as HTMLElement;
    await userEvent.click(within(row).getByRole("combobox"));
    return within(screen.getByRole("listbox")).getAllByRole("option");
  };
  /** The grid's large dot of an option: where the label sits. */
  const bigDot = (option: HTMLElement) => {
    const dot = [...option.querySelectorAll("circle")].find((c) => Number(c.getAttribute("r")) > 1.5);
    return dot && [dot.getAttribute("cx"), dot.getAttribute("cy")];
  };

  it("polygons offer automatic, the eight sides and the middle around their marker", async () => {
    const { store } = render({ text: "{name}" }, "polygon");
    await openGroup("style_editor.part_label");
    expect(within(firstRowOf("style_editor.label_position")).getByRole("button").textContent).toBe("auto");
    await openRow("style_editor.label_position");
    const options = await placementOptions();
    // One entry for the middle: `inside`, the polygons' word for it.
    expect(options.map((o) => o.textContent)).toEqual([
      "auto",
      "above_left",
      "above",
      "above_right",
      "left",
      "inside",
      "right",
      "below_left",
      "below",
      "below_right",
    ]);
    expect(bigDot(options[5])).toEqual(["6", "6"]);
    await userEvent.click(within(screen.getByRole("listbox")).getByText("below"));
    expect(store.get("symbol.label.placement")).toBe("below");
  });

  it("lines offer along the line, and at the center automatic, the eight sides and the middle", async () => {
    const { store } = render({ text: "{name}" }, "line");
    await openGroup("style_editor.part_label");
    await openRow("style_editor.label_position");
    const options = await placementOptions();
    expect(options.map((o) => o.textContent)).toEqual([
      "line",
      "auto",
      "above_left",
      "above",
      "above_right",
      "left",
      "center",
      "right",
      "below_left",
      "below",
      "below_right",
    ]);
    await userEvent.click(within(screen.getByRole("listbox")).getByText("above_right"));
    expect(store.get("symbol.label.placement")).toBe("above_right");
    expect(
      within(firstRowOf("style_editor.label_position")).getByRole("button").querySelectorAll("circle")
    ).toHaveLength(9);
  });

  it("points offer automatic, the eight sides and center, each side with its place in the grid", async () => {
    const { store } = render({ text: "{name}" }, "point");
    await openGroup("style_editor.part_label");
    await openRow("style_editor.label_position");
    const options = await placementOptions();
    expect(options.map((o) => o.textContent)).toEqual([
      "auto",
      "above_left",
      "above",
      "above_right",
      "left",
      "center",
      "right",
      "below_left",
      "below",
      "below_right",
    ]);
    // The grid's large dot is where the label sits: right of the center for "right", lower left for "below_left".
    expect(bigDot(options[6])).toEqual(["10", "6"]);
    expect(bigDot(options[7])).toEqual(["2", "10"]);
    expect(bigDot(options[5])).toEqual(["6", "6"]);
    await userEvent.click(within(screen.getByRole("listbox")).getByText("below_right"));
    expect(store.get("symbol.label.placement")).toBe("below_right");
  });

  it("along the line shows no grid; the positions at the line's center show theirs", async () => {
    render({ text: "{name}" }, "line");
    await openGroup("style_editor.part_label");
    expect(
      within(firstRowOf("style_editor.label_position")).getByRole("button").querySelectorAll("circle")
    ).toHaveLength(0);
    await openRow("style_editor.label_position");
    const [along, auto, , , , , center] = await placementOptions();
    expect(along.querySelectorAll("circle")).toHaveLength(0);
    expect(auto.querySelectorAll("circle")).toHaveLength(9);
    expect(bigDot(center)).toEqual(["6", "6"]);
  });

  it("an empty number format removes label.format", async () => {
    const { store } = render({ text: "{population}", format: { decimals: 1 } });
    await openGroup("style_editor.part_label");
    await userEvent.click(within(rowOf("style_editor.numbers")).getByRole("button"));
    await choose("style_editor.decimals", "1", "style_editor.auto");
    expect(store.get("symbol.label.format")).toBeUndefined();
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.abbreviate" }));
    expect(store.get("symbol.label.format")).toEqual({ abbreviate: true });
  });

  it("Numbers, Numbers in a field and Line styles open the level after the editor's, wherever it is", async () => {
    // The label editor in the panel itself: its rows open level 1.
    renderPanel(
      <PopoverProvider>
        <LabelEditor base="symbol.label" />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { label: { text: "{population}\n{Einwohner 2020}" } },
        } as LayerStyle,
        data: {
          geometry: "point",
          fields: FIELDS,
          fieldTypes: Object.fromEntries(FIELDS.map((f) => [f.name, f.type])),
        },
      }
    );
    for (const [row, title] of [
      ["style_editor.numbers", "style_editor.number_format"],
      ["style_editor.numbers_in", "style_editor.numbers_in"],
      ["style_editor.line_styles", "style_editor.line_styles"],
    ]) {
      await userEvent.click(within(firstRowOf(row)).getAllByRole("button")[0]);
      expect(level(1), row).not.toBeNull();
      expect(within(level(1)!).getAllByText(title).length, row).toBeGreaterThan(0);
      expect(level(2), row).toBeNull();
    }
  });

  it("priority hides while overlap is on", async () => {
    const { store } = render({ text: "{name}", allow_overlap: true }, "polygon", {
      fields: FIELDS.slice(0, 2),
    });
    await openGroup("style_editor.part_label");
    await openRow("style_editor.label_position");
    expect(screen.queryByText("style_editor.priority")).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.overlap" }));
    expect(store.get("symbol.label.allow_overlap")).toBe(false);
    await choose("style_editor.priority", "style_editor.no_priority", "style_editor.priority_largest");
    expect(store.get("symbol.label.priority")).toEqual({ field: "population", top: "largest" });
  });

  it("a two-line label picks each line's font; the label's own font removes the line's", async () => {
    const { store } = render({ text: "{name}\n{population}", font: { weight: "bold" } });
    await openGroup("style_editor.part_label");
    await userEvent.click(within(rowOf("style_editor.line_styles")).getAllByRole("button")[0]);
    const fonts = () =>
      within(level(2)!)
        .getAllByText("style_editor.font")
        .map((el) => el.parentElement!);
    // A line without a font of its own draws the label's.
    expect(fonts().map((row) => within(row).getByRole("combobox").textContent)).toEqual(["bold", "bold"]);
    await userEvent.click(within(fonts()[1]).getByRole("combobox"));
    expect(fontMenu()).toEqual(FONT_MENU);
    await userEvent.click(
      within(screen.getByRole("listbox")).getByRole("option", { name: "regular_italic" })
    );
    expect(store.get("symbol.label.lines")).toEqual([{}, { font: { weight: "regular", style: "italic" } }]);
    await pickFont(within(fonts()[1]).getByRole("combobox"), "medium_italic");
    expect(store.get("symbol.label.lines")).toEqual([{}, { font: { weight: "medium", style: "italic" } }]);
    // The field names the whole font.
    expect(within(fonts()[1]).getByRole("combobox").textContent).toBe("medium_italic");
    await pickFont(within(fonts()[1]).getByRole("combobox"), "bold");
    expect(store.get("symbol.label.lines")).toBeUndefined();
  });

  it("while the label's font varies, a line shows no font of the label's and keeps the one picked", async () => {
    const weight = {
      zoom: [
        [9, "regular"],
        [15, "bold"],
      ],
      interpolate: "step",
    };
    const { store } = render({ text: "{name}\n{population}", font: { weight } });
    await openGroup("style_editor.part_label");
    await userEvent.click(within(rowOf("style_editor.line_styles")).getAllByRole("button")[0]);
    const fonts = () =>
      within(level(2)!)
        .getAllByText("style_editor.font")
        .map((el) => el.parentElement!);
    expect(fonts().map((row) => within(row).getByRole("combobox").textContent)).toEqual(["", ""]);
    await pickFont(within(fonts()[0]).getByRole("combobox"), "regular");
    expect(store.get("symbol.label.lines")).toEqual([{ font: { weight: "regular", style: "normal" } }]);
  });

  it("two number fields get a number format each", async () => {
    const { store } = render({ text: "{population} ({Einwohner 2020})" });
    await openGroup("style_editor.part_label");
    expect(screen.getAllByText("style_editor.numbers_in")).toHaveLength(2);
    await userEvent.click(
      within(screen.getAllByText("style_editor.numbers_in")[1].parentElement as HTMLElement).getAllByRole(
        "button"
      )[0]
    );
    await choose("style_editor.decimals", "style_editor.auto", "2");
    expect(store.get("symbol.label.formats")).toEqual({ "Einwohner 2020": { decimals: 2 } });
  });

  it("case, letter spacing and line height write transform, letter_spacing and line_height", async () => {
    const { store } = render({ text: "{name}" });
    await openGroup("style_editor.part_label");
    expect(screen.getByText("Berlin")).toBeDefined();
    await openRow("style_editor.text_style");
    await choose("style_editor.letter_case", "none", "uppercase");
    expect(store.get("symbol.label.transform")).toBe("uppercase");
    // The preview shows the case the map draws.
    expect(screen.getByText("BERLIN")).toBeDefined();
    fireEvent.change(within(rowOf("style_editor.letter_spacing")).getByRole("slider"), {
      target: { value: 0.1 },
    });
    expect(store.get("symbol.label.letter_spacing")).toBe(0.1);
    fireEvent.change(within(rowOf("style_editor.line_height")).getByRole("slider"), {
      target: { value: 1.5 },
    });
    expect(store.get("symbol.label.line_height")).toBe(1.5);
  });

  it("the wrap width writes max_width", async () => {
    const { store } = render({ text: "{name}" });
    await openGroup("style_editor.part_label");
    await openRow("style_editor.text_style");
    const slider = within(rowOf("style_editor.max_width")).getByRole("slider");
    fireEvent.change(slider, { target: { value: 160 } });
    expect(store.get("symbol.label.max_width")).toBe(160);
  });
});

/** The labels of the label editor's rows, top to bottom. */
const editorRows = () =>
  [...(level(1)?.querySelectorAll("[data-popover-body] .MuiTypography-caption") ?? [])].map(
    (el) => el.textContent
  );

const CATEGORIES = {
  classify: [{ id: "k", field: "name", method: "categories", classes: [{ id: "a", values: ["Berlin"] }] }],
};
const RULES = {
  rules: [{ id: "r1", when: { op: "isNull", args: [{ property: "name" }] } }],
};

describe("label editor rows and popovers", () => {
  it("shows Text, Size, Color, Halo, Text style and Position; the other rows are in their popovers", async () => {
    render({ text: "{name}" }, "point");
    await openGroup("style_editor.part_label");
    const shown = [
      "style_editor.text",
      "style_editor.size",
      "style_editor.color",
      "style_editor.halo",
      "style_editor.text_style",
      "style_editor.label_position",
    ];
    expect(editorRows().filter((label) => shown.includes(label ?? ""))).toEqual(shown);
    for (const inside of [
      "style_editor.font",
      "style_editor.letter_case",
      "style_editor.width",
      "style_editor.placement",
      "style_editor.priority",
      "style_editor.overlap",
    ])
      expect(editorRows()).not.toContain(inside);
  });

  it("Halo shows its color and width and opens them as Color and Width", async () => {
    const { store } = render({ text: "{name}", halo: { color: "#000000", width: 3 } }, "point");
    await openGroup("style_editor.part_label");
    expect(within(firstRowOf("style_editor.halo")).getByText("3 px")).toBeDefined();
    await openRow("style_editor.halo");
    // The popover's title says Halo; its rows need not say it again.
    expect(within(level(2)!).getByText("style_editor.color")).toBeDefined();
    expect(within(level(2)!).queryByText("style_editor.halo_color")).toBeNull();
    expect(within(level(2)!).queryByText("style_editor.halo_width")).toBeNull();
    fireEvent.change(within(haloWidth()).getByRole("slider"), { target: { value: 0 } });
    expect(store.get("symbol.label.halo.width")).toBe(0);
    expect(within(firstRowOf("style_editor.halo")).getByText("style_editor.halo_none")).toBeDefined();
  });

  it("the halo's width steps by half a pixel and its box takes 1.5 px too", async () => {
    const { store } = render({ text: "{name}" }, "point");
    await openGroup("style_editor.part_label");
    expect(within(firstRowOf("style_editor.halo")).getByText("1.5 px")).toBeDefined();
    await openRow("style_editor.halo");
    const slider = within(haloWidth()).getByRole("slider");
    expect(slider.getAttribute("step")).toBe("0.5");
    fireEvent.change(slider, { target: { value: 3 } });
    const box = within(haloWidth()).getByRole("textbox", { name: "style_editor.width" });
    fireEvent.change(box, { target: { value: "1.5" } });
    expect(store.get("symbol.label.halo.width")).toBe(1.5);
    expect(within(firstRowOf("style_editor.halo")).getByText("1.5 px")).toBeDefined();
  });

  it("Text style names the font and what differs, and opens Font, Case, Letter spacing, Line height and Wrap at", async () => {
    const { store } = render({ text: "{name}" }, "point");
    await openGroup("style_editor.part_label");
    const summary = () => within(firstRowOf("style_editor.text_style")).getByRole("button").textContent;
    // The font always leads (the choice labels fall back to their values without copy).
    expect(summary()).toBe("Regular");
    await openRow("style_editor.text_style");
    expect(
      ["font", "letter_case", "letter_spacing", "line_height", "max_width"].every((row) =>
        within(level(2)!).queryByText(`style_editor.${row}`)
      )
    ).toBe(true);
    // Font: four weights, upright and italic, as one choice over the weight and the style.
    const field = () => within(rowOf("style_editor.font")).getByRole("combobox");
    await userEvent.click(field());
    expect(fontMenu()).toEqual(FONT_MENU);
    await userEvent.click(
      within(screen.getByRole("listbox")).getByRole("option", { name: "regular_italic" })
    );
    expect(store.get("symbol.label.font")).toEqual({ style: "italic" });
    expect(summary()).toBe("Italic");
    await pickFont(field(), "bold_italic");
    expect(store.get("symbol.label.font")).toEqual({ weight: "bold", style: "italic" });
    expect(field().textContent).toBe("bold_italic");
    await pickFont(field(), "light");
    expect(store.get("symbol.label.font")).toEqual({ weight: "light" });
    expect(summary()).toBe("Light");
    await pickFont(field(), "medium");
    expect(store.get("symbol.label.font")).toEqual({ weight: "medium" });
    await pickFont(field(), "bold");
    expect(store.get("symbol.label.font")).toEqual({ weight: "bold" });
    await choose("style_editor.letter_case", "none", "uppercase");
    expect(summary()).toBe("Bold, style_editor.ts_uppercase");
    await pickFont(field(), "regular");
    expect(store.get("symbol.label.font")).toBeUndefined();
    expect(summary()).toBe("Regular, style_editor.ts_uppercase");
  });

  it("Text style shows its whole summary as the row's tooltip", async () => {
    render({ text: "{name}", transform: "uppercase", letter_spacing: 0.2, max_width: 160 }, "point");
    await openGroup("style_editor.part_label");
    const text =
      "Regular, style_editor.ts_uppercase, style_editor.ts_letter_spacing, style_editor.ts_max_width";
    const value = within(firstRowOf("style_editor.text_style")).getByText(text);
    await userEvent.hover(value);
    expect((await screen.findByRole("tooltip")).textContent).toBe(text);
  });

  it("Text style shows its whole summary when the keyboard reaches the row", async () => {
    // A browser matches :focus-visible on an element the keyboard focused; jsdom never does.
    const matches = Element.prototype.matches;
    const focusVisible = vi.spyOn(Element.prototype, "matches").mockImplementation(function (
      this: Element,
      selector: string
    ) {
      return selector === ":focus-visible" ? this === document.activeElement : matches.call(this, selector);
    });
    try {
      render({ text: "{name}", transform: "uppercase", letter_spacing: 0.2, max_width: 160 }, "point");
      await openGroup("style_editor.part_label");
      const text =
        "Regular, style_editor.ts_uppercase, style_editor.ts_letter_spacing, style_editor.ts_max_width";
      const button = within(firstRowOf("style_editor.text_style")).getByRole("button");
      for (let i = 0; i < 60 && document.activeElement !== button; i++) await userEvent.tab();
      expect(document.activeElement).toBe(button);
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe(text);
      // The button keeps its own name, the summary; the tooltip describes it.
      expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
    } finally {
      focusVisible.mockRestore();
    }
  });

  it("a row inside a popover opens its own editor beside it: letter spacing by zoom", async () => {
    const { store } = render({ text: "{name}" }, "point");
    await openGroup("style_editor.part_label");
    await openRow("style_editor.text_style");
    await pickMode("style_editor.letter_spacing", "style_editor.mode_zoom");
    expect(level(3)).not.toBeNull();
    expect(store.get("symbol.label.letter_spacing")).toMatchObject({ zoom: expect.any(Array) });
    expect(within(firstRowOf("style_editor.text_style")).getByRole("button").textContent).toBe(
      "Regular, style_editor.ts_letter_spacing_varies"
    );
  });

  it("the Font by zoom keeps italic, and each stop picks one of the eight fonts", async () => {
    const { store } = render({ text: "{name}", font: { style: "italic" } }, "point");
    await openGroup("style_editor.part_label");
    await openRow("style_editor.text_style");
    await pickMode("style_editor.font", "style_editor.mode_zoom");
    // Both keys by zoom on the same stops, three zooms either side of the map's (12).
    expect(store.get("symbol.label.font")).toEqual({
      weight: {
        zoom: [
          [9, "regular"],
          [15, "regular"],
        ],
        interpolate: "step",
      },
      style: {
        zoom: [
          [9, "italic"],
          [15, "italic"],
        ],
        interpolate: "step",
      },
    });
    const zoomEditor = level(3)!;
    expect(zoomEditor.querySelectorAll("text[font-style='italic']")).toHaveLength(2);
    const value = within(within(zoomEditor).getByText("style_editor.value").parentElement as HTMLElement);
    expect(value.getByRole("combobox").textContent).toBe("italic");
    await userEvent.click(value.getByRole("combobox"));
    expect(fontMenu()).toEqual(FONT_MENU);
    await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "bold" }));
    expect(store.get("symbol.label.font")).toEqual({
      weight: {
        zoom: [
          [9, "bold"],
          [15, "regular"],
        ],
        interpolate: "step",
      },
      style: {
        zoom: [
          [9, "normal"],
          [15, "italic"],
        ],
        interpolate: "step",
      },
    });
    expect(within(firstRowOf("style_editor.font")).getByText("bold → italic")).toBeDefined();
    // The stop's "Aa" draws in the stop's weight and style: Medium italic.
    await pickFont(value.getByRole("combobox"), "medium_italic");
    expect(within(firstRowOf("style_editor.font")).getByText("medium_italic → italic")).toBeDefined();
    const glyphs = [...zoomEditor.querySelectorAll("text")].filter((el) => el.textContent === "Aa");
    expect(glyphs.map((el) => [el.getAttribute("font-weight"), el.getAttribute("font-style")])).toEqual([
      ["500", "italic"],
      ["400", "italic"],
    ]);
    await pickFont(value.getByRole("combobox"), "bold");
    // Back to one font: the one at the map zoom.
    await pickMode("style_editor.font", "style_editor.mode_fixed");
    expect(store.get("symbol.label.font")).toEqual({ weight: "bold" });
  });

  it("the Font by zoom shows stops of the style alone as fonts too", async () => {
    const style = {
      zoom: [
        [10, "normal"],
        [14, "italic"],
      ],
      interpolate: "step",
    };
    const { store } = render({ text: "{name}", font: { weight: "bold", style } }, "point");
    await openGroup("style_editor.part_label");
    await openRow("style_editor.text_style");
    expect(within(firstRowOf("style_editor.font")).getByText("bold → bold_italic")).toBeDefined();
    await pickMode("style_editor.font", "style_editor.mode_fixed");
    // At the map zoom (12) the label is bold.
    expect(store.get("symbol.label.font")).toEqual({ weight: "bold" });
  });

  it("the Font by classes keeps the layer's font, and each class picks Regular, Bold or Italic", async () => {
    const byZoom = {
      weight: {
        zoom: [
          [9, "regular"],
          [15, "bold"],
        ],
        interpolate: "step",
      },
      style: {
        zoom: [
          [9, "italic"],
          [15, "normal"],
        ],
        interpolate: "step",
      },
    };
    const { store } = render({ text: "{name}", font: byZoom }, "point");
    await openGroup("style_editor.part_label");
    await openRow("style_editor.text_style");
    await pickMode("style_editor.font", "style_editor.mode_classes");
    await userEvent.click(screen.getByText("population"));
    expect(store.get("classify.0.target")).toBe("label.font.weight");
    // The font at the map zoom stays the layer's: classes without a font of their own draw it.
    expect(store.get("symbol.label.font")).toEqual({ style: "italic" });
  });

  it("a class of the Font classification picks one of the eight fonts and writes both keys", async () => {
    const classify = [
      {
        id: "k",
        field: "name",
        method: "categories",
        target: "label.font.weight",
        classes: [{ id: "a", values: ["Berlin"] }],
      },
    ];
    const { store } = render({ text: "{name}" }, "point", {}, { classify });
    await openGroup("style_editor.part_label");
    await openRow("style_editor.text_style");
    await userEvent.click(within(firstRowOf("style_editor.font")).getAllByRole("button")[0]);
    const list = within(level(3)!);
    await userEvent.click(list.getByRole("combobox", { name: "Berlin" }));
    expect(fontMenu()).toEqual(FONT_MENU);
    await userEvent.click(
      within(screen.getByRole("listbox")).getByRole("option", { name: "regular_italic" })
    );
    expect(store.get("classify.0.classes.0.label.font")).toEqual({ weight: "regular", style: "italic" });
    expect(list.getByRole("combobox", { name: "Berlin" }).textContent).toBe("italic");
    await pickFont(list.getByRole("combobox", { name: "Berlin" }), "light_italic");
    expect(store.get("classify.0.classes.0.label.font")).toEqual({ weight: "light", style: "italic" });
    await pickFont(list.getByRole("combobox", { name: "Berlin" }), "bold");
    expect(store.get("classify.0.classes.0.label.font")).toEqual({ weight: "bold", style: "normal" });
  });

  it("a class of the Font classification without a font of its own shows the layer's, none while it varies", async () => {
    const classify = [
      {
        id: "k",
        field: "name",
        method: "categories",
        target: "label.font.weight",
        classes: [{ id: "a", values: ["Berlin"] }],
      },
    ];
    const { store } = render({ text: "{name}", font: { weight: "bold" } }, "point", {}, { classify });
    await openGroup("style_editor.part_label");
    await openRow("style_editor.text_style");
    await userEvent.click(within(firstRowOf("style_editor.font")).getAllByRole("button")[0]);
    const berlin = () => within(level(3)!).getByRole("combobox", { name: "Berlin" });
    expect(berlin().textContent).toBe("bold");
    act(() => store.set("symbol.label.font", { style: "italic" }));
    expect(berlin().textContent).toBe("italic");
    act(() => store.set("symbol.label.font", undefined));
    expect(berlin().textContent).toBe("regular");
    // By zoom the class draws more than one font: its box stays empty.
    act(() =>
      store.set("symbol.label.font.weight", {
        zoom: [
          [9, "regular"],
          [15, "bold"],
        ],
        interpolate: "step",
      })
    );
    expect(berlin().textContent).toBe("");
  });

  it("in a rule, picking the Font's mode it already has changes nothing", async () => {
    const { store } = render({ text: "{name}", font: { style: "italic" } }, "point", {}, RULES);
    act(() => store.setScope({ rule: "r1", index: 0 }));
    await openGroup("style_editor.part_label");
    await openRow("style_editor.text_style");
    await pickMode("style_editor.font", "style_editor.mode_fixed");
    expect(store.get("rules.0.label")).toBeUndefined();
  });

  it("in a rule the Font by zoom keeps the rule's italic", async () => {
    const { store } = render({ text: "{name}", font: { weight: "bold" } }, "point", {}, RULES);
    act(() => store.setScope({ rule: "r1", index: 0 }));
    await openGroup("style_editor.part_label");
    await openRow("style_editor.text_style");
    await pickFont(within(rowOf("style_editor.font")).getByRole("combobox"), "regular_italic");
    await pickMode("style_editor.font", "style_editor.mode_zoom");
    expect(store.get("rules.0.label.font")).toEqual({
      weight: {
        zoom: [
          [9, "regular"],
          [15, "regular"],
        ],
        interpolate: "step",
      },
      style: {
        zoom: [
          [9, "italic"],
          [15, "italic"],
        ],
        interpolate: "step",
      },
    });
    expect(store.get("symbol.label.font")).toEqual({ weight: "bold" });
  });

  it("in a class the Font writes both keys into the class, and the row shows the class's style", async () => {
    const { store } = render({ text: "{name}", font: { weight: "bold" } }, "point", {}, CATEGORIES);
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_label");
    const row = () => firstRowOf("style_editor.text_style");
    expect(within(row()).getByRole("button").textContent).toBe("Bold");
    expect(within(row()).queryByLabelText("style_editor.differs_for_some_features")).toBeNull();
    await openRow("style_editor.text_style");
    await pickFont(within(rowOf("style_editor.font")).getByRole("combobox"), "regular_italic");
    expect(store.get("classify.0.classes.0.label.font")).toEqual({ weight: "regular", style: "italic" });
    expect(store.get("symbol.label.font")).toEqual({ weight: "bold" });
    expect(within(row()).getByRole("button").textContent).toBe("Italic");
    expect(within(row()).getByLabelText("style_editor.differs_for_some_features")).toBeDefined();
  });

  it("in a class the halo width is the class's own", async () => {
    const { store } = render({ text: "{name}" }, "point", {}, CATEGORIES);
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_label");
    await openRow("style_editor.halo");
    fireEvent.change(within(haloWidth()).getByRole("slider"), { target: { value: 4 } });
    expect(store.get("classify.0.classes.0.label.halo.width")).toBe(4);
    expect(store.get("symbol.label.halo")).toBeUndefined();
    expect(within(firstRowOf("style_editor.halo")).getByText("4 px")).toBeDefined();
    expect(
      within(firstRowOf("style_editor.halo")).getByLabelText("style_editor.differs_for_some_features")
    ).toBeDefined();
  });

  it("in a rule the halo width is the rule's own", async () => {
    const { store } = render({ text: "{name}" }, "point", {}, RULES);
    act(() => store.setScope({ rule: "r1", index: 0 }));
    await openGroup("style_editor.part_label");
    await openRow("style_editor.halo");
    fireEvent.change(within(haloWidth()).getByRole("slider"), { target: { value: 3 } });
    expect(store.get("rules.0.label.halo.width")).toBe(3);
    expect(store.get("symbol.label.halo")).toBeUndefined();
    expect(within(firstRowOf("style_editor.halo")).getByText("3 px")).toBeDefined();
  });

  it("Position names the placement with its grid and opens placement, offset, priority, overlap and space", async () => {
    const { store } = render({ text: "{name}" }, "point", { fields: FIELDS.slice(0, 2) });
    await openGroup("style_editor.part_label");
    const position = () => within(firstRowOf("style_editor.label_position")).getByRole("button");
    expect(position().textContent).toBe("auto");
    expect(position().querySelectorAll("circle")).toHaveLength(9);
    await openRow("style_editor.label_position");
    for (const row of ["placement", "offset_x", "offset_y", "priority", "overlap", "label_padding"])
      expect(within(level(2)!).getByText(`style_editor.${row}`)).toBeDefined();
    // Points do not repeat along a line.
    expect(screen.queryByText("style_editor.label_spacing")).toBeNull();
    await choose("style_editor.placement", "auto", "below_right");
    expect(position().textContent).toBe("below_right");
    fireEvent.change(within(rowOf("style_editor.label_padding")).getByRole("slider"), {
      target: { value: 6 },
    });
    expect(store.get("symbol.label.padding")).toBe(6);
  });

  it("lines repeat their labels along the line at the repeat distance", async () => {
    const { store } = render({ text: "{name}" }, "line");
    await openGroup("style_editor.part_label");
    expect(within(firstRowOf("style_editor.label_position")).getByRole("button").textContent).toBe("line");
    await openRow("style_editor.label_position");
    fireEvent.change(within(rowOf("style_editor.label_spacing")).getByRole("slider"), {
      target: { value: 400 },
    });
    expect(store.get("symbol.label.spacing")).toBe(400);
    await choose("style_editor.placement", "line", "center");
    expect(screen.queryByText("style_editor.label_spacing")).toBeNull();
  });

  it("polygons in 3D say in Position that the labels sit on the roofs", async () => {
    render(
      { text: "{name}" },
      "polygon",
      {},
      { symbol: { fill: {}, extrude: { height: 20 }, label: { text: "{name}" } } }
    );
    await openGroup("style_editor.part_label");
    expect(within(firstRowOf("style_editor.label_position")).getByRole("button").textContent).toBe(
      "style_editor.placement_roof"
    );
    await openRow("style_editor.label_position");
    // The positions around the marker hold on the roofs too; a note under them says where the labels sit.
    expect(within(level(2)!).getAllByText("style_editor.placement")).toHaveLength(1);
    expect(within(level(2)!).getByText("style_editor.note_label_roof")).toBeDefined();
  });

  it("in a class Position holds the class's offset only", async () => {
    const { store } = render({ text: "{name}" }, "point", {}, CATEGORIES);
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_label");
    await openRow("style_editor.label_position");
    expect(within(level(2)!).queryByText("style_editor.placement")).toBeNull();
    expect(within(level(2)!).queryByText("style_editor.label_padding")).toBeNull();
    fireEvent.change(within(rowOf("style_editor.offset_y")).getByRole("slider"), { target: { value: 4 } });
    expect(store.get("classify.0.classes.0.label.offset")).toEqual([0, 4]);
    expect(
      within(firstRowOf("style_editor.label_position")).getByLabelText(
        "style_editor.differs_for_some_features"
      )
    ).toBeDefined();
  });
});
