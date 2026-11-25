// The symbol section says what a valid style document draws, whoever wrote it (the AI assistant, an import, the JSON
// editor): a part, an icon, a fill or a value set by classes, `other` or a rule reads so, and its switch loses nothing.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";

import type { Geometry } from "@/lib/style/compile/types";
import { labelPositionSummary } from "@/lib/style/editor/labels";
import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RasterColorSection } from "@/components/map/panels/styleEditor/sections/RasterColorSection";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { choose, i18n, openGroup, renderPanel } from "./renderPanel";

beforeAll(() => {
  i18n.addResourceBundle("en", "common", {
    style_editor: { by_field: "By {{field}}", by_rules: "By rules" },
  });
});

const vector = (extra: object) =>
  ({ version: "1.0.0", kind: "vector", ...extra }) as LayerStyle & Record<string, unknown>;
const render = (doc: LayerStyle, geometry: Geometry) =>
  renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    { document: doc, data: { geometry, fields: [{ name: "kind", type: "string", label: "kind" }] } as never }
  );
/** A group's row in the section (an open popover's title repeats the label). */
const rowOf = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;
const turnOn = () => userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
const turnOff = () => userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));

const byKind = (records: object[], extra: object = {}) => [
  { id: "k", field: "kind", method: "categories", classes: records, ...extra },
];

describe("finding 1: icons set by classes, other or a rule", () => {
  const CLASS_ICONS = vector({
    symbol: { marker: { shape: "circle", color: "#5e4fa2", size: 18, icon_color: "#ffffff" } },
    classify: byKind([
      { id: "c1", values: ["playground"], marker: { icon: "goat:playground", color: "#4daf4a" } },
      { id: "c2", values: ["park"], marker: { icon: "goat:park", color: "#377eb8" } },
    ]),
  });

  it("the Icon editor reads on, and off then on brings every class icon back", async () => {
    const { store } = render(CLASS_ICONS, "point");
    await openGroup("style_editor.part_icon");
    expect(screen.queryByText("style_editor.icon_off_note")).toBeNull();
    await turnOff();
    expect(screen.getByText("style_editor.icon_off_note")).toBeDefined();
    expect(store.get("classify.0.classes.0.marker")).toEqual({ color: "#4daf4a" });
    await turnOn();
    expect(store.document).toEqual(CLASS_ICONS);
  });

  it("a class shape or a rule's icon reads as such on the Icon row", () => {
    const { unmount } = render(
      vector({
        symbol: { marker: { color: "#888888" } },
        classify: byKind([{ id: "a", values: ["x"], marker: { shape: "square" } }]),
      }),
      "point"
    );
    expect(within(rowOf("style_editor.part_icon")).getByText("By kind")).toBeDefined();
    unmount();
    render(
      vector({
        symbol: { marker: { color: "#888888" } },
        rules: [{ when: { op: "=", args: [{ property: "kind" }, "x"] }, marker: { icon: "goat:park" } }],
      }),
      "point"
    );
    expect(within(rowOf("style_editor.part_icon")).getByText("By rules")).toBeDefined();
  });
});

describe("finding 2: parts switched on by classes or rules", () => {
  const OUTLINE = vector({
    symbol: { marker: { color: "#888888" } },
    classify: byKind([{ id: "a", values: ["x"], outline: { color: "#ff0000", width: 2 } }]),
  });

  it("reads By <field>, says so in its editor, and on then off leaves the classes' outline", async () => {
    const { store } = render(OUTLINE, "point");
    expect(within(rowOf("style_editor.part_outline")).getByText("By kind")).toBeDefined();
    await openGroup("style_editor.part_outline");
    expect(screen.getByText("style_editor.part_some_note")).toBeDefined();
    expect(screen.queryByText("style_editor.part_off_note")).toBeNull();
    await turnOn();
    // The class's outline has its own color, so the layer's starts with Auto (spec 18.10).
    expect(store.get("symbol.outline")).toEqual({ color: "auto", width: 1 });
    await turnOff();
    expect(store.document).toEqual(OUTLINE);
  });

  it("a part a rule turns on reads By rules; a label set in a class only reads By <field>", () => {
    const { unmount } = render(
      vector({
        symbol: { line: { color: "#333333" } },
        rules: [{ when: { op: "=", args: [{ property: "kind" }, "x"] }, casing: { width: 2 } }],
      }),
      "line"
    );
    expect(within(rowOf("style_editor.part_casing")).getByText("By rules")).toBeDefined();
    unmount();
    render(
      vector({
        symbol: { fill: { color: "#cccccc" } },
        classify: byKind([{ id: "a", values: ["x"], label: { text: "{kind}" } }]),
      }),
      "polygon"
    );
    expect(within(rowOf("style_editor.part_label")).getByText("By kind")).toBeDefined();
  });

  it("a height set in a class only reads By <field>; the switch on then off leaves it to the class", async () => {
    const HEIGHT = vector({
      symbol: { fill: { color: "#cccccc" } },
      classify: byKind([{ id: "a", values: ["x"], extrude: { height: 30 } }]),
    });
    const { store } = render(HEIGHT, "polygon");
    expect(within(rowOf("style_editor.height")).getByText("By kind")).toBeDefined();
    await openGroup("style_editor.height");
    expect(screen.getByText("style_editor.part_some_note")).toBeDefined();
    await turnOn();
    expect(store.get("symbol.extrude")).toEqual({});
    await turnOff();
    expect(store.get("symbol.extrude")).toBeUndefined();
    expect(store.get("classify")).toEqual(HEIGHT.classify);
  });

  it("heights switched off after a Fixed pick over class heights can be allowed per class again", async () => {
    const { store } = render(
      vector({
        symbol: { fill: { color: "#cccccc" }, extrude: false },
        classify: byKind([{ id: "a", values: ["x"], extrude: { height: 30 } }]),
      }),
      "polygon"
    );
    await openGroup("style_editor.height");
    await userEvent.click(screen.getByRole("button", { name: "style_editor.allow_per_class" }));
    expect(store.get("symbol.extrude")).toBeUndefined();
    expect(store.get("classify.0.classes.0.extrude")).toEqual({ height: 30 });
  });

  it("a part the layer switches off while classes carry it can be allowed per class again", async () => {
    const { store } = render(
      vector({
        symbol: { marker: { color: "#888888" }, outline: false },
        classify: byKind([{ id: "a", values: ["x"], outline: { width: 2 } }]),
      }),
      "point"
    );
    await openGroup("style_editor.part_outline");
    await userEvent.click(screen.getByRole("button", { name: "style_editor.allow_per_class" }));
    expect(store.get("symbol.outline")).toBeUndefined();
    expect(store.get("classify.0.classes.0.outline")).toEqual({ width: 2 });
  });
});

describe("finding 3: a classification without target that sets other keys only", () => {
  const ROUTES = vector({
    symbol: { line: { color: "#2166ac", width: 3 }, casing: { color: "#ffffff", width: 1.5 } },
    classify: [
      {
        title: "Route status",
        field: "kind",
        method: "categories",
        classes: [
          { values: ["existing"], name: "Existing" },
          {
            values: ["planned"],
            name: "Planned",
            min_zoom: 13,
            line: { dash: "dashed", opacity: 0.6 },
            casing: false,
          },
        ],
      },
    ],
  });

  it("the line color reads as the fixed color it draws, not By <field>", async () => {
    render(ROUTES, "line");
    await openGroup("style_editor.part_line");
    // The Color row is the fixed color field (Dash and Opacity, which the classes set, read By kind).
    const color = screen.getAllByText("style_editor.color").at(-1)!.parentElement as HTMLElement;
    expect(within(color).getByRole("button", { name: "style_editor.pick_color" })).toBeDefined();
  });

  it("the points' Fill row of an outline-only classification shows its color", () => {
    render(
      vector({
        symbol: { marker: { color: "#888888" } },
        classify: byKind([{ id: "a", values: ["x"], outline: { color: "#ff0000", width: 2 } }]),
      }),
      "point"
    );
    expect(within(rowOf("style_editor.part_fill")).getByText("#888888 · 100%")).toBeDefined();
  });
});

describe("finding 4: two classifications set the same key", () => {
  it("the Fill row names the later one, which the map draws", () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" } },
        classify: [
          {
            id: "a",
            field: "category",
            method: "categories",
            classes: [{ id: "a1", values: ["x"], marker: { color: "#ff0000" } }],
          },
          {
            id: "b",
            field: "kind",
            method: "categories",
            classes: [{ id: "b1", values: ["y"], marker: { color: "#00ff00" } }],
            other: { marker: { color: "#0000ff" } },
          },
        ],
      }),
      "point"
    );
    expect(within(rowOf("style_editor.part_fill")).getByText("By kind")).toBeDefined();
  });
});

describe("finding 5: a key set once for the layer, held by a class or a rule", () => {
  const ARROWS = vector({
    symbol: { line: { color: "#333333" }, arrows: { size: 10 } },
    rules: [{ when: { op: "=", args: [{ property: "kind" }, "x"] }, arrows: { placement: "center" } }],
  });

  it("the arrows read the rule's placement, and a pick writes it there", async () => {
    const { store } = render(ARROWS, "line");
    expect(within(rowOf("style_editor.part_arrows")).getByText("center")).toBeDefined();
    await openGroup("style_editor.part_arrows");
    await choose("style_editor.placement", "center", "start");
    expect(store.get("rules.0.arrows.placement")).toBe("start");
    expect(store.get("symbol.arrows")).toEqual({ size: 10 });
  });

  it("a label priority a rule holds is read and written there", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <SymbolSection />
      </PopoverProvider>,
      {
        document: vector({
          symbol: { marker: { color: "#cccccc" }, label: { text: "{kind}" } },
          rules: [
            {
              when: { op: "=", args: [{ property: "kind" }, "x"] },
              label: { priority: { field: "pop", top: "largest" } },
            },
          ],
        }),
        data: {
          geometry: "point",
          fields: [
            { name: "kind", type: "string", label: "kind" },
            { name: "pop", type: "integer", label: "pop" },
          ],
        } as never,
      }
    );
    await openGroup("style_editor.part_label");
    await userEvent.click(within(rowOf("style_editor.label_position")).getAllByRole("button")[0]);
    await choose("style_editor.priority", "style_editor.priority_largest", "style_editor.priority_smallest");
    expect(store.get("rules.0.label.priority")).toEqual({ field: "pop", top: "smallest" });
    expect(store.get("symbol.label.priority")).toBeUndefined();
  });

  it("the label's Position reads the class's placement", () => {
    const doc = vector({
      symbol: { marker: { color: "#cccccc" }, label: { text: "{kind}" } },
      classify: byKind([{ id: "a", values: ["x"], label: { placement: "above" } }]),
    });
    const t = ((key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key) as never;
    expect(
      labelPositionSummary(doc, "symbol.label", t, {
        fields: [],
        mapZoom: 12,
        geometry: "point",
        language: "en",
      }).placement
    ).toBe("above");
  });
});

describe("finding 6: hollow markers with a filled class", () => {
  it("the Fill row reads By <field> without the invisible warning", async () => {
    render(
      vector({
        symbol: { marker: { color: "#888888", fill: false } },
        classify: byKind([{ id: "a", values: ["x"], marker: { fill: true, color: "#ff0000" } }]),
      }),
      "point"
    );
    const row = rowOf("style_editor.part_fill");
    expect(within(row).getByText("By kind")).toBeDefined();
    expect(within(row).queryByLabelText("style_editor.marker_invisible")).toBeNull();
    await openGroup("style_editor.part_fill");
    expect(screen.getByText("style_editor.fill_some_note")).toBeDefined();
    expect(screen.queryByText("style_editor.marker_invisible")).toBeNull();
  });
});

describe("finding 7: markers switched off on points", () => {
  it("the Fill editor has the marker switch its note points at; the Size row is hidden", async () => {
    const { store } = render(vector({ symbol: { marker: false, label: { text: "{kind}" } } }), "point");
    expect(screen.queryByText("style_editor.size")).toBeNull();
    await openGroup("style_editor.part_fill");
    expect(screen.getByText("style_editor.part_off_note")).toBeDefined();
    await turnOn();
    expect(store.get("symbol.marker")).toEqual({});
  });

  it("the Icon editor says the markers are off instead of offering an icon", async () => {
    render(vector({ symbol: { marker: false, label: { text: "{kind}" } } }), "point");
    await openGroup("style_editor.part_icon");
    expect(screen.getByText("style_editor.marker_off_icon_note")).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" })).toHaveProperty(
      "disabled",
      true
    );
  });
});

describe("finding 8: hillshade with palette null", () => {
  it("the Colors row says shading only", () => {
    renderPanel(
      <PopoverProvider>
        <RasterColorSection />
      </PopoverProvider>,
      {
        document: {
          version: "1.0.0",
          kind: "raster",
          render: { type: "hillshade", palette: null },
        } as LayerStyle,
        data: { raster: { dataset: "d1" } } as never,
      }
    );
    expect(screen.getByText("style_editor.hillshade_colors_off")).toBeDefined();
  });
});

describe("minor findings in the same rows", () => {
  it("9: an opacity by classes leaves the percent out of the Fill row", () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc", opacity: 0.9 } },
        classify: [
          {
            id: "a",
            field: "pop",
            method: "manual",
            target: "marker.opacity",
            classes: [
              { id: "a1", to: 10, marker: { opacity: 0.2 } },
              { id: "a2", from: 10, marker: { opacity: 0.6 } },
            ],
          },
        ],
      }),
      "point"
    );
    expect(within(rowOf("style_editor.part_fill")).getByText("#CCCCCC")).toBeDefined();
  });

  it("11: a part a class switches off says it is off for some", () => {
    render(
      vector({
        symbol: { fill: { color: "#cccccc" }, outline: { width: 1 } },
        classify: byKind([{ id: "a", values: ["x"], outline: false }]),
      }),
      "polygon"
    );
    expect(
      within(rowOf("style_editor.part_outline")).getByText("1 px · style_editor.part_off_for_some")
    ).toBeDefined();
  });

  it("12: a label text a class sets reads By <field>", () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" }, label: { text: "{kind}" } },
        classify: byKind([{ id: "a", values: ["x"], label: { text: "{pop}" } }]),
      }),
      "point"
    );
    expect(within(rowOf("style_editor.part_label")).getByText(/^By kind · /)).toBeDefined();
  });
});
