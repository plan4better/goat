// Every classification the panel keeps has a row that opens it, rule scope reads what the layer draws for a rule's
// features, and the per-layer, offset, cluster and icon details a second review found.
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";

import type { Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { ClusterSection } from "@/components/map/panels/styleEditor/sections/ClusterSection";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { i18n, openGroup, renderPanel } from "./renderPanel";

beforeAll(() => {
  i18n.addResourceBundle("en", "common", {
    style_editor: { by_field: "By {{field}}", by_rules: "By rules" },
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
    data: { geometry, fields: FIELDS, fieldTypes: { kind: "string", pop: "integer" } } as never,
  });
const rowOf = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;
const lastRowOf = (label: string) => screen.getAllByText(label).at(-1)!.parentElement as HTMLElement;
const pickMode = async (row: HTMLElement, mode: string) => {
  await userEvent.click(within(row).getByRole("button", { name: "style_editor.value_mode_aria" }));
  await userEvent.click(within(screen.getByRole("menu")).getByText(mode));
};

describe("review 1: rule scope reads what the layer draws for the rule's features", () => {
  it("a color by classes stays By <field> in a rule's scope", () => {
    const { store } = render(
      vector({
        symbol: { fill: { color: "#cccccc" }, outline: { width: 1 } },
        classify: [
          {
            id: "k",
            field: "kind",
            method: "categories",
            classes: [
              { id: "a", values: ["park"], fill: { color: "#00ff00" } },
              { id: "b", values: ["shop"], fill: { color: "#ff0000" } },
            ],
          },
        ],
        rules: [{ id: "r1", when: { op: ">", args: [{ property: "pop" }, 10] }, outline: { width: 3 } }],
      }),
      "polygon"
    );
    act(() => store.setScope({ rule: "r1", index: 0 }));
    expect(within(rowOf("style_editor.part_fill")).getByText("By kind")).toBeDefined();
  });
});

describe("review 2: a classification only classes turn a part on with stays reachable", () => {
  const OUTLINE_IN_CLASS = vector({
    symbol: { fill: { color: "#cccccc" } },
    classify: [
      {
        id: "k",
        field: "kind",
        method: "categories",
        count: 2,
        classes: [
          { id: "a", values: ["park"], fill: { color: "#00ff00" }, outline: { color: "#000000" } },
          { id: "b", values: ["shop"], fill: { color: "#ff0000" } },
        ],
      },
    ],
  });

  it("after Fixed, the Outline editor has a By <field> row that opens the classification", async () => {
    const { store } = render(OUTLINE_IN_CLASS, "polygon");
    await openGroup("style_editor.part_fill");
    await pickMode(lastRowOf("style_editor.color"), "style_editor.mode_fixed");
    expect(store.get("classify.0.classes.0.outline")).toEqual({ color: "#000000" });
    await userEvent.keyboard("{Escape}");
    await openGroup("style_editor.part_outline");
    const row = lastRowOf("style_editor.classes");
    expect(within(row).getByText("By kind")).toBeDefined();
    await userEvent.click(within(row).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.by_classes_title")).toBeDefined();
  });

  it("Undo brings a removed classification back in one step", async () => {
    const PLACEMENT = vector({
      symbol: { marker: { color: "#cccccc" }, label: { text: "{kind}" } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          count: 2,
          classes: [
            {
              id: "a",
              values: ["park"],
              name: "Parks",
              marker: { color: "#00ff00" },
              label: { placement: "above" },
            },
            { id: "b", values: ["shop"], visible: false, marker: { color: "#ff0000" } },
          ],
        },
      ],
    });
    const { store } = render(PLACEMENT, "point");
    await openGroup("style_editor.part_fill");
    await pickMode(lastRowOf("style_editor.color"), "style_editor.mode_fixed");
    expect(store.get("classify")).toBeUndefined();
    act(() => store.undo());
    expect(store.document).toEqual(PLACEMENT);
  });
});

describe("minor: offsets classes set keep the layer's own editable", () => {
  it("the base sliders stay, with a note naming the classes", async () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" }, label: { text: "{kind}", offset: [0, 2] } },
        classify: [
          {
            id: "k",
            field: "kind",
            method: "categories",
            classes: [{ id: "a", values: ["park"], label: { offset: [0, 6] } }],
          },
        ],
      }),
      "point"
    );
    await openGroup("style_editor.part_label");
    await userEvent.click(within(rowOf("style_editor.label_position")).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.offset_y")).toBeDefined();
    expect(screen.getByText("style_editor.offset_classes_note")).toBeDefined();
  });
});

describe("minor: a cluster size by zoom goes back to a size by count", () => {
  it("the mode button writes the size by count over the stops' ends", async () => {
    const { store } = render(
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
    await pickMode(rowOf("style_editor.size"), "style_editor.cluster_size_by_count");
    expect(store.get("render.symbol.marker.size")).toMatchObject({ field: "count", range: [20, 40] });
  });
});

describe("minor: in class scope a row opens the classification it names", () => {
  it("the Size row reads and opens the earlier classification that sets the class's size", async () => {
    i18n.addResourceBundle(
      "en",
      "common",
      { style_editor: { by_classes_title: "Classes: {{label}}" } },
      true,
      true
    );
    const { store } = render(
      vector({
        symbol: { marker: { color: "#cccccc", size: 8 } },
        classify: [
          {
            id: "k",
            field: "kind",
            method: "categories",
            classes: [{ id: "a", values: ["park"], marker: { color: "#00ff00", size: 20 } }],
          },
          { id: "p", field: "pop", method: "manual", target: "marker.size", classes: [{ id: "p1", to: 10 }] },
        ],
      }),
      "point"
    );
    act(() => store.setScope({ classify: 1, key: 0 }));
    const row = rowOf("style_editor.size");
    expect(within(row).getByText("By kind")).toBeDefined();
    await userEvent.click(within(row).getAllByRole("button")[0]);
    expect(screen.queryByText(/^Classes: .*size/i)).toBeNull();
  });
});

describe("follow-up: a label text set by classes", () => {
  it("the label editor has a Classes row that opens the classification", async () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" }, label: { text: "{kind}" } },
        classify: [
          {
            id: "k",
            field: "kind",
            method: "categories",
            classes: [{ id: "a", values: ["park"], label: { text: "{pop}" } }],
          },
        ],
      }),
      "point"
    );
    await openGroup("style_editor.part_label");
    const row = lastRowOf("style_editor.classes");
    expect(within(row).getByText("By kind")).toBeDefined();
    await userEvent.click(within(row).getAllByRole("button")[0]);
    // The classification editor's title (an earlier test gives it a resource).
    expect(screen.getByText(/by_classes_title|^Classes: /)).toBeDefined();
  });
});

describe("follow-up: a base offset by zoom beside a class's own offset", () => {
  it("still reads By zoom, with the classes note", async () => {
    i18n.addResourceBundle(
      "en",
      "common",
      { style_editor: { by_zoom_stops: "By zoom · {{count}} stops" } },
      true,
      true
    );
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
        classify: [
          {
            id: "k",
            field: "kind",
            method: "categories",
            classes: [{ id: "a", values: ["park"], label: { offset: [0, 6] } }],
          },
        ],
      }),
      "point"
    );
    await openGroup("style_editor.part_label");
    await userEvent.click(within(rowOf("style_editor.label_position")).getAllByRole("button")[0]);
    expect(within(rowOf("style_editor.offset")).getByText("By zoom · 2 stops")).toBeDefined();
    expect(screen.getByText("style_editor.offset_classes_note")).toBeDefined();
  });
});

describe("follow-up: an icon classification on a marker without icon", () => {
  it("the Icon editor shows the Icon row's By <field> only, no Classes row", async () => {
    render(
      vector({
        symbol: { marker: { color: "#cccccc" } },
        classify: [
          {
            id: "k",
            field: "kind",
            method: "categories",
            target: "marker.icon",
            classes: [{ id: "a", values: ["park"], marker: { icon: "goat:park" } }],
          },
        ],
      }),
      "point"
    );
    await openGroup("style_editor.part_icon");
    expect(screen.queryByText("style_editor.classes")).toBeNull();
    expect(within(lastRowOf("style_editor.icon")).getByText("By kind")).toBeDefined();
  });
});
