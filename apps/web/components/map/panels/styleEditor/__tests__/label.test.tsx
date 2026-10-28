import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import type { StyleData } from "@/components/map/panels/styleEditor/context";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { choose, openGroup, renderPanel } from "./renderPanel";

const FIELDS = [
  { name: "name", type: "string" as const, label: "name" },
  { name: "population", type: "integer" as const, label: "population" },
  { name: "Einwohner 2020", type: "integer" as const, label: "Einwohner 2020" },
  { name: "a{b}", type: "string" as const, label: "a{b}" },
];

function render(label: object, geometry: Geometry = "polygon", data: Partial<StyleData> = {}) {
  const result = renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "vector", symbol: { label } } as LayerStyle,
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

describe("label part", () => {
  it("the label row shows the field and the size", () => {
    render({ text: "{population}", size: 14 });
    expect(screen.getByText("population · 14 px")).toBeDefined();
  });

  it("picking a field writes {field}", async () => {
    const { store } = render({ text: "{name}" });
    await openGroup("style_editor.part_label");
    await userEvent.click(within(rowOf("style_editor.text")).getByRole("button"));
    await userEvent.click(screen.getByText("Einwohner 2020"));
    expect(store.get("symbol.label.text")).toBe("{Einwohner 2020}");
    await userEvent.click(within(rowOf("style_editor.text")).getByRole("button"));
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
    await userEvent.click(within(rowOf("style_editor.text")).getByRole("button"));
    await userEvent.click(screen.getByText("population"));
    expect(store.get("symbol.label.text")).toBe("{population}");
    expect(screen.getByText("style_editor.numbers")).toBeDefined();
    expect(screen.getByText("style_editor.as_in_dataset")).toBeDefined();
  });

  it("polygons offer no placement choice", async () => {
    render({ text: "{name}" }, "polygon");
    await openGroup("style_editor.part_label");
    expect(screen.queryByText("style_editor.placement")).toBeNull();
  });

  it("lines offer along the line and center", async () => {
    const { store } = render({ text: "{name}" }, "line");
    await openGroup("style_editor.part_label");
    await choose("style_editor.placement", "line", "center");
    expect(store.get("symbol.label.placement")).toBe("center");
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

  it("priority hides while overlap is on", async () => {
    const { store } = render({ text: "{name}", allow_overlap: true }, "polygon", {
      fields: FIELDS.slice(0, 2),
    });
    await openGroup("style_editor.part_label");
    expect(screen.queryByText("style_editor.priority")).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.overlap" }));
    expect(store.get("symbol.label.allow_overlap")).toBe(false);
    await choose("style_editor.priority", "style_editor.no_priority", "style_editor.priority_largest");
    expect(store.get("symbol.label.priority")).toEqual({ field: "population", top: "largest" });
  });

  it("a two-line label styles each line; clearing the last style removes lines", async () => {
    const { store } = render({ text: "{name}\n{population}" });
    await openGroup("style_editor.part_label");
    await userEvent.click(within(rowOf("style_editor.line_styles")).getAllByRole("button")[0]);
    const bold = screen.getAllByRole("checkbox", { name: "style_editor.line_bold" });
    await userEvent.click(bold[1]);
    expect(store.get("symbol.label.lines")).toEqual([{}, { font: { weight: "bold" } }]);
    await userEvent.click(screen.getAllByRole("checkbox", { name: "style_editor.line_bold" })[1]);
    expect(store.get("symbol.label.lines")).toBeUndefined();
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

  it("the wrap width writes max_width", async () => {
    const { store } = render({ text: "{name}" });
    await openGroup("style_editor.part_label");
    const slider = within(rowOf("style_editor.max_width")).getByRole("slider");
    fireEvent.change(slider, { target: { value: 160 } });
    expect(store.get("symbol.label.max_width")).toBe(160);
  });
});
