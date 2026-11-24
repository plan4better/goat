// The panel says what a valid style document draws in the places a first pass left: class scope, `no_data` as a scope,
// offsets, the Rules section, the Visible row, clusters, the legend, the height unit and the classification editor.
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";

import type { Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { ClassificationEditor } from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { ClusterSection } from "@/components/map/panels/styleEditor/sections/ClusterSection";
import { LayerSection } from "@/components/map/panels/styleEditor/sections/LayerSection";
import { LegendSection } from "@/components/map/panels/styleEditor/sections/LegendSection";
import { RulesSection } from "@/components/map/panels/styleEditor/sections/RulesSection";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { i18n, openGroup, renderPanel } from "./renderPanel";

beforeAll(() => {
  i18n.addResourceBundle("en", "common", {
    style_editor: {
      by_field: "By {{field}}",
      by_rules: "By rules",
      scope_then_field: "{{value}}, then by {{field}}",
      scope_then_rules: "{{value}}, then by rules",
      by_zoom_stops: "By zoom · {{count}} stops",
      part_zooms: "{{part}}: {{zooms}}",
      from_zoom: "From zoom {{zoom}}",
      all_zooms: "All zooms",
      n_classifications: "{{count}} classifications",
    },
  });
});

const FIELDS = [
  { name: "kind", type: "string", label: "kind" },
  { name: "pop", type: "integer", label: "pop" },
];
const vector = (extra: object) =>
  ({ version: "1.0.0", kind: "vector", ...extra }) as LayerStyle & Record<string, unknown>;
const render = (doc: LayerStyle, geometry: Geometry, ui = <SymbolSection />) =>
  renderPanel(<PopoverProvider>{ui}</PopoverProvider>, {
    document: doc,
    data: {
      geometry,
      fields: FIELDS,
      fieldTypes: { kind: "string", pop: "integer" },
      layerName: "Layer",
    } as never,
  });
const rowOf = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;
const byKind = (records: object[], extra: object = {}) => [
  { id: "k", field: "kind", method: "categories", classes: records, ...extra },
];
const when = { op: "=", args: [{ property: "kind" }, "x"] };

describe("review 1: a classification that targets a key stays the row's", () => {
  it("the Size row reads By pop when a color class has its own size", () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc", size: 8 } },
        classify: [
          {
            id: "pop",
            field: "pop",
            method: "quantile",
            count: 2,
            target: "marker.size",
            classes: [
              { id: "p1", to: 10, marker: { size: 4 } },
              { id: "p2", from: 10, marker: { size: 12 } },
            ],
          },
          {
            id: "kind",
            field: "kind",
            method: "categories",
            count: 2,
            classes: [{ id: "park", values: ["park"], marker: { color: "#00ff00", size: 20 } }],
          },
        ],
      }),
      "point"
    );
    expect(within(rowOf("style_editor.size")).getByText("By pop")).toBeDefined();
  });
});

describe("review 3: the height unit a class holds", () => {
  const STOREYS = vector({
    symbol: { fill: { color: "#cccccc" }, extrude: { height: { field: "pop" } } },
    classify: byKind([{ id: "a", values: ["x"], extrude: { unit: "storeys" } }]),
  });

  it("reads storeys, and a unit pick writes it into the class", async () => {
    const { store } = render(STOREYS, "polygon");
    expect(within(rowOf("style_editor.height")).getByText(/height_summary_storeys/)).toBeDefined();
    await openGroup("style_editor.height");
    const unit = rowOf("style_editor.height_unit");
    await userEvent.click(within(unit).getByRole("button", { name: "style_editor.height_unit_m" }));
    expect(store.get("classify.0.classes.0.extrude.unit")).toBeUndefined();
    expect(store.get("symbol.extrude.unit")).toBeUndefined();
  });
});

describe("review 5: icons only from a class shape or a rule", () => {
  it("the Icon editor says where they come from", async () => {
    render(
      vector({
        symbol: { marker: { color: "#888888" } },
        classify: byKind([{ id: "a", values: ["x"], marker: { shape: "square" } }]),
      }),
      "point"
    );
    await openGroup("style_editor.part_icon");
    expect(screen.getByText("style_editor.icon_some_note")).toBeDefined();
    // Its "Classes" row reads By kind and opens the classification (round 3).
    expect(
      within(screen.getAllByText("style_editor.classes").at(-1)!.parentElement as HTMLElement).getByText(
        "By kind"
      )
    ).toBeDefined();
  });
});

describe("review 6 and audit 10: class scope summaries", () => {
  const SIZE = vector({
    symbol: { marker: { color: "#cccccc", size: 8 }, label: { text: "{kind}" } },
    classify: [
      {
        id: "s",
        field: "pop",
        method: "manual",
        target: "marker.size",
        classes: [
          { id: "s1", to: 10, marker: { size: 4, opacity: 0.5 }, label: { text: "{pop}" } },
          { id: "s2", from: 10, marker: { size: 12, opacity: 0.8 } },
        ],
      },
    ],
  });

  it("the scoped Fill row keeps the class's opacity, the Label row its text", () => {
    const { store } = render(SIZE, "point");
    act(() => store.setScope({ classify: 0, key: 0 }));
    expect(within(rowOf("style_editor.part_fill")).getByText("#CCCCCC · 50%")).toBeDefined();
    expect(within(rowOf("style_editor.part_label")).getByText(/^pop · /)).toBeDefined();
  });

  it("a class's own line width reads as such, not By <field>", () => {
    const { store } = render(
      vector({
        symbol: { line: { color: "#333333", width: 2 } },
        classify: byKind([{ id: "a", values: ["x"], line: { width: 6 } }]),
      }),
      "line"
    );
    act(() => store.setScope({ classify: 0, key: 0 }));
    expect(within(rowOf("style_editor.part_line")).getByText("6 px")).toBeDefined();
  });

  it("a later classification that sets the class's value says so", () => {
    const { store } = render(
      vector({
        symbol: { line: { color: "#333333", width: 2 } },
        classify: [
          ...byKind([{ id: "a", values: ["x"], line: { width: 6 } }]),
          {
            id: "p",
            field: "pop",
            method: "manual",
            target: "line.width",
            classes: [{ id: "p1", to: 5, line: { width: 1 } }],
          },
        ],
      }),
      "line"
    );
    act(() => store.setScope({ classify: 0, key: 0 }));
    expect(within(rowOf("style_editor.part_line")).getByText("6 px, then by pop")).toBeDefined();
  });
});

describe("review 7: a classification that sets no color", () => {
  it("its editor says the classes keep only their other settings", () => {
    render(
      vector({
        symbol: { line: { color: "#2166ac" } },
        classify: byKind([{ id: "a", values: ["planned"], line: { dash: "dashed" } }]),
      }),
      "line",
      <ClassificationEditor ci={0} />
    );
    expect(screen.getByText("style_editor.sets_no_color")).toBeDefined();
  });
});

describe("review 8: a part only rules carry while the layer switches it off", () => {
  it("names the rules, not classes", async () => {
    const { store } = render(
      vector({
        symbol: { line: { color: "#333333" }, casing: false },
        rules: [{ when, casing: { width: 2 } }],
      }),
      "line"
    );
    await openGroup("style_editor.part_casing");
    expect(screen.getByText("style_editor.part_off_for_layer_allow_rules")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.allow_for_rules" }));
    expect(store.get("symbol.casing")).toBeUndefined();
  });
});

describe("audit 16: no data as a scope", () => {
  const NO_DATA = vector({
    symbol: { fill: { color: "#cccccc" } },
    classify: byKind([{ id: "a", values: ["x"], fill: { color: "#ff0000" } }], {
      no_data: { fill: { pattern: "hatch_45" }, outline: { color: "#000000", width: 2 } },
    }),
  });

  it("the scope menu offers No data, and its scope reads its own outline", async () => {
    const { store } = render(NO_DATA, "polygon");
    await userEvent.click(screen.getByRole("button", { name: /style_editor.style_one_class/ }));
    await userEvent.click(screen.getByText("style_editor.no_data"));
    expect(store.scope).toEqual({ classify: 0, key: "no_data" });
    expect(within(rowOf("style_editor.part_outline")).getByText("2 px")).toBeDefined();
  });
});

describe("audit 13: offsets by zoom or by classes", () => {
  it("the label's offset by zoom reads as such", async () => {
    render(
      vector({
        symbol: {
          marker: { color: "#cccccc" },
          label: {
            text: "{kind}",
            offset: {
              zoom: [
                [8, [0, 0]],
                [14, [0, 4]],
              ],
            },
          },
        },
      }),
      "point"
    );
    await openGroup("style_editor.part_label");
    await userEvent.click(within(rowOf("style_editor.label_position")).getAllByRole("button")[0]);
    expect(within(rowOf("style_editor.offset")).getByText("By zoom · 2 stops")).toBeDefined();
  });

  it("an offset classes set keeps the layer's sliders with a note", async () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" }, label: { text: "{kind}" } },
        classify: byKind([{ id: "a", values: ["x"], label: { offset: [0, 4] } }]),
      }),
      "point"
    );
    await openGroup("style_editor.part_label");
    await userEvent.click(within(rowOf("style_editor.label_position")).getAllByRole("button")[0]);
    // The layer's own offset stays editable; a note names the classes with their own (round 3).
    expect(screen.getByText("style_editor.offset_x")).toBeDefined();
    expect(screen.getByText("style_editor.offset_classes_note")).toBeDefined();
  });
});

describe("audit 14: what a rule changes", () => {
  it("a height rule reads Height, a polygon marker rule Marker", () => {
    render(
      vector({
        symbol: { fill: { color: "#cccccc" } },
        rules: [
          { id: "r1", name: "Tall", when, extrude: { height: 30 } },
          { id: "r2", name: "Pin", when, marker: { icon: "goat:park" } },
        ],
      }),
      "polygon",
      <RulesSection />
    );
    expect(screen.getByText("style_editor.height")).toBeDefined();
    expect(screen.getByText("style_editor.part_marker")).toBeDefined();
    expect(screen.queryByText("style_editor.effect_none")).toBeNull();
  });
});

describe("audit 15: the Visible row", () => {
  it("names a polygon's marker and its height, and says when classes change zooms", () => {
    render(
      vector({
        symbol: {
          fill: { color: "#cccccc" },
          marker: { icon: "goat:park", min_zoom: 12 },
          extrude: { height: 10, min_zoom: 14 },
        },
        classify: byKind([{ id: "a", values: ["x"], min_zoom: 13 }]),
      }),
      "polygon",
      <LayerSection />
    );
    expect(
      within(rowOf("style_editor.visible")).getByText(
        "All zooms · style_editor.part_marker: From zoom 12 · style_editor.height: From zoom 14 · style_editor.zooms_vary"
      )
    ).toBeDefined();
  });
});

describe("audits 18 and 20: clusters", () => {
  it("no Color row while clusters draw like the points with the count in the middle", () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" } },
        render: { type: "cluster", look: "points", count: "center" },
      }),
      "point",
      <ClusterSection />
    );
    expect(screen.queryByText("style_editor.color")).toBeNull();
    expect(screen.getByText("style_editor.cluster_number_color")).toBeDefined();
  });

  it("a cluster size by zoom reads its stops", () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" } },
        render: {
          type: "cluster",
          symbol: {
            marker: {
              size: {
                zoom: [
                  [4, 20],
                  [12, 40],
                ],
              },
              color: "#123456",
            },
          },
        },
      }),
      "point",
      <ClusterSection />
    );
    expect(within(rowOf("style_editor.size")).getByText("20 → 40 px")).toBeDefined();
  });
});

describe("audit 19: the legend", () => {
  it("a heatmap lists no classification", () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" } },
        render: { type: "heatmap" },
        classify: byKind([{ id: "a", values: ["x"], marker: { color: "#ff0000" } }]),
      }),
      "point",
      <LegendSection />
    );
    expect(within(rowOf("style_editor.contents")).getByText("style_editor.none")).toBeDefined();
  });

  it("two classifications of one field are one block", async () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" } },
        classify: [
          {
            id: "c",
            field: "kind",
            method: "categories",
            title: "Colors",
            classes: [{ id: "c1", values: ["x"], marker: { color: "#ff0000" } }],
          },
          {
            id: "s",
            field: "kind",
            method: "categories",
            title: "Sizes",
            target: "marker.size",
            classes: [{ id: "s1", values: ["x"], marker: { size: 20 } }],
          },
        ],
      }),
      "point",
      <LegendSection />
    );
    expect(within(rowOf("style_editor.contents")).getByText("1 classifications")).toBeDefined();
    await userEvent.click(within(rowOf("style_editor.contents")).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.legend_merged")).toBeDefined();
    expect(screen.getAllByRole("textbox", { name: "style_editor.heading" })).toHaveLength(1);
  });
});

describe("review 3: label number formats a class holds", () => {
  it("the Numbers row reads the class's format", async () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" }, label: { text: "{pop}" } },
        classify: byKind([{ id: "a", values: ["x"], label: { format: { decimals: 2 } } }]),
      }),
      "point"
    );
    await openGroup("style_editor.part_label");
    expect(within(rowOf("style_editor.numbers")).getByText("style_editor.example")).toBeDefined();
  });
});

describe("audit 10: a class's own value a later classification overrides", () => {
  it("its slider says so", async () => {
    const { store } = render(
      vector({
        symbol: { line: { color: "#333333", width: 2 } },
        classify: [
          ...byKind([{ id: "a", values: ["x"], line: { width: 6 } }]),
          {
            id: "p",
            field: "pop",
            method: "manual",
            target: "line.width",
            classes: [{ id: "p1", to: 5, line: { width: 1 } }],
          },
        ],
      }),
      "line"
    );
    act(() => store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_line");
    expect(screen.getByText("style_editor.scope_over_note_field")).toBeDefined();
  });
});

describe("audit 20: the cluster size by zoom opens its stops", () => {
  it("opens the zoom editor", async () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" } },
        render: {
          type: "cluster",
          symbol: {
            marker: {
              size: {
                zoom: [
                  [4, 20],
                  [12, 40],
                ],
              },
              color: "#123456",
            },
          },
        },
      }),
      "point",
      <ClusterSection />
    );
    await userEvent.click(within(rowOf("style_editor.size")).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.by_zoom_title")).toBeDefined();
  });
});
