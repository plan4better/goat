import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import type { StyleData } from "@/components/map/panels/styleEditor/context";
import { IconRow } from "@/components/map/panels/styleEditor/editors/IconRow";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { ClusterSection } from "@/components/map/panels/styleEditor/sections/ClusterSection";
import { GeneralSection } from "@/components/map/panels/styleEditor/sections/GeneralSection";
import { HeatmapSection } from "@/components/map/panels/styleEditor/sections/HeatmapSection";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { choose, openGroup, pickColor, renderPanel } from "./renderPanel";

const render = (doc: object, data: Partial<StyleData> = {}) =>
  renderPanel(
    <PopoverProvider>
      <GeneralSection />
      <HeatmapSection />
      <ClusterSection />
      <SymbolSection />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "vector", ...doc } as LayerStyle,
      data: { geometry: "point", featureCount: 5000, ...data },
    }
  );

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;
/** A group's row in the section, while its editor (titled the same) is open. */
const groupRow = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;

describe("point parts", () => {
  // Choice labels read as their values here (no translations loaded): "square", "pin".
  // The shape sits at the top of the icon picker: its field opens the shapes in a popover, a pick closes it.
  const shapes = async () => userEvent.click(within(rowOf("style_editor.icon")).getAllByRole("button")[0]);
  const pick = async (shape: string) => {
    await userEvent.click(within(rowOf("style_editor.shape")).getByRole("button"));
    await userEvent.click(screen.getByRole("button", { name: shape }));
  };

  it("the icon picker's shape writes a shape, a pin or the icon alone; the icon alone brings an icon", async () => {
    const { store, unmount } = render({
      symbol: { marker: { icon: "goat:star-solid", icon_color: "#000000", rotation: 30, size: 8 } },
    });
    await openGroup("style_editor.part_icon");
    await shapes();
    await pick("square");
    expect(store.get("symbol.marker.shape")).toBe("square");
    await pick("hexagon");
    expect(store.get("symbol.marker.shape")).toBe("hexagon");
    await pick("icon");
    // The icon alone takes the marker color and a size it can be made out at.
    expect(store.get("symbol.marker")).toEqual({
      shape: "icon",
      icon: "goat:star-solid",
      rotation: 30,
      size: 18,
    });
    await pick("circle");
    expect(store.get("symbol.marker.shape")).toBeUndefined();
    unmount();

    // A plain circle: switching the icon on gives it the default icon, then the picker's shape takes it alone.
    const bare = render({ symbol: { marker: { size: 8 } } });
    await openGroup("style_editor.part_icon");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    await shapes();
    await pick("icon");
    expect(bare.store.get("symbol.marker")).toEqual({ shape: "icon", icon: "goat:marker", size: 18 });
  });

  it("an icon alone takes the class colors of the icon color as its own color", async () => {
    const { store } = render({
      symbol: { marker: { icon: "goat:park", icon_color: "#000000" } },
      classify: [
        {
          id: "kind",
          field: "kind",
          method: "categories",
          target: "marker.icon_color",
          classes: [{ id: "c1", values: ["cafe"], marker: { icon_color: "#66c2a5" } }],
          other: { marker: { icon_color: "#b3b3b3" } },
          computed: { generated: { target: "marker.icon_color", values: { c1: "#66c2a5" } } },
        },
      ],
    });
    await openGroup("style_editor.part_icon");
    await shapes();
    await pick("icon");
    expect(store.get("classify")).toEqual([
      {
        id: "kind",
        field: "kind",
        method: "categories",
        classes: [{ id: "c1", values: ["cafe"], marker: { color: "#66c2a5" } }],
        other: { marker: { color: "#b3b3b3" } },
        computed: { generated: { target: "marker.color", values: { c1: "#66c2a5" } } },
      },
    ]);
  });

  it("a pin stands on its tip: picking one takes off a set anchor, and its anchor row reads the bottom", async () => {
    const { store } = render({ symbol: { marker: { icon: "goat:park", anchor: "center" } } });
    await openGroup("style_editor.part_icon");
    await shapes();
    await pick("pin");
    expect(store.get("symbol.marker")).toEqual({ icon: "goat:park", shape: "pin" });
    expect(within(rowOf("style_editor.anchor")).getByText("bottom")).toBeDefined();
  });

  it("a pin symbol on its own stands on its tip: picking it sets the anchor to the bottom", async () => {
    const { store } = render({ symbol: { marker: { shape: "icon", icon: "goat:park" } } });
    await openGroup("style_editor.part_icon");
    await userEvent.click(within(rowOf("style_editor.icon")).getByText("Park"));
    await userEvent.click(screen.getByRole("button", { name: "Shape pin" }));
    expect(store.get("symbol.marker")).toEqual({ shape: "icon", icon: "goat:shape-pin", anchor: "bottom" });
  });

  it("picking a symbol writes its reference; the icon switch takes it off and brings it back", async () => {
    const { store } = render({
      symbol: { marker: { shape: "icon", icon: "goat:marker", anchor: "bottom" } },
    });
    await openGroup("style_editor.part_icon");
    // The icon row opens the picker beside the editor; the picker has symbols only.
    await userEvent.click(within(rowOf("style_editor.icon")).getByText("Marker"));
    expect(screen.queryByRole("button", { name: "style_editor.icon_none" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Park" }));
    expect(store.get("symbol.marker.icon")).toBe("goat:park");
    // Off: plain circles; the editor says so and shows nothing else.
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("symbol.marker")).toEqual({});
    expect(screen.getByText("style_editor.icon_off_note")).toBeDefined();
    expect(screen.queryByText("style_editor.icon")).toBeNull();
    expect(screen.queryByText("style_editor.shape")).toBeNull();
    // On: the icon alone comes back as it was.
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("symbol.marker")).toEqual({ shape: "icon", icon: "goat:park", anchor: "bottom" });
  });

  it("off turns a pin into a plain circle and on brings the pin back; a plain circle switched on gets an icon", async () => {
    const { store, unmount } = render({ symbol: { marker: { size: 12, shape: "pin" } } });
    await openGroup("style_editor.part_icon");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("symbol.marker")).toEqual({ size: 12 });
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("symbol.marker")).toEqual({ size: 12, shape: "pin" });
    unmount();

    const circle = render({ symbol: { marker: { size: 12 } } });
    await openGroup("style_editor.part_icon");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(circle.store.get("symbol.marker")).toEqual({ size: 12, icon: "goat:marker" });
  });

  it("emoji: search, pick with a skin tone, then find it among the recent ones", async () => {
    window.localStorage.clear();
    const { store } = render({ symbol: { marker: { icon: "goat:park" } } });
    await openGroup("style_editor.part_icon");
    await userEvent.click(within(rowOf("style_editor.icon")).getByText("Park"));
    await userEvent.click(screen.getByRole("tab", { name: "style_editor.icon_tab_emoji" }));
    const search = await screen.findByRole("textbox", { name: "style_editor.emoji_search" });
    fireEvent.change(search, { target: { value: "fire" } });
    // Tiles carry their name as a title: role queries over two thousand tiles are slow in jsdom.
    await userEvent.click((await screen.findAllByTitle("fire"))[0]);
    expect(store.get("symbol.marker.icon")).toBe("emoji:1f525");

    fireEvent.change(search, { target: { value: "" } });
    await userEvent.click(screen.getByTitle("style_editor.emoji_tone"));
    await userEvent.click(screen.getByTitle("style_editor.emoji_tone_3"));
    fireEvent.change(search, { target: { value: "waving" } });
    await userEvent.click((await screen.findAllByTitle("waving hand sign"))[0]);
    expect(store.get("symbol.marker.icon")).toBe("emoji:1f44b-1f3fd");

    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByText("style_editor.emoji_recent")).toBeDefined();
  });

  it("switching icons by classes back to fixed closes the classification's editor", async () => {
    const { store } = render(
      {
        symbol: { marker: { icon: "goat:park" } },
        classify: [
          {
            id: "kind",
            field: "kind",
            method: "categories",
            target: "marker.icon",
            classes: [{ values: ["a"], marker: { icon: "goat:bar" } }],
          },
        ],
      },
      { fields: [{ name: "kind", type: "string", label: "Kind" }] }
    );
    await openGroup("style_editor.part_icon");
    const row = rowOf("style_editor.icon");
    await userEvent.click(within(row).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.field")).toBeDefined();
    await userEvent.click(within(row).getByRole("button", { name: "style_editor.value_mode_aria" }));
    await userEvent.click(within(screen.getByRole("menu")).getByText("style_editor.mode_fixed"));
    expect(store.get("classify")).toBeUndefined();
    expect(screen.queryByText("style_editor.not_classified")).toBeNull();
    expect(screen.queryByText("style_editor.field")).toBeNull();
  });

  it("a class's icon picker sets the class's shape, a pin but not the icon alone, and has no \"no icon\"", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <IconRow label="restaurant" path="classify.0.classes.0.marker.icon" />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { marker: { icon: "goat:park" } },
          classify: [
            {
              field: "kind",
              method: "categories",
              classes: [{ values: ["a"], marker: { icon: "goat:bar" } }],
            },
          ],
        } as LayerStyle,
        data: { geometry: "point" },
      }
    );
    await userEvent.click(screen.getByText("Bar"));
    // The class shows the layer's shape until it takes its own.
    expect(within(rowOf("style_editor.shape")).getByText("circle")).toBeDefined();
    await userEvent.click(within(rowOf("style_editor.shape")).getByRole("button"));
    expect(screen.queryByRole("button", { name: "icon" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "pin" }));
    expect(store.get("classify.0.classes.0.marker")).toEqual({ icon: "goat:bar", shape: "pin" });
    expect(store.get("symbol.marker.shape")).toBeUndefined();
    expect(screen.queryByRole("button", { name: "style_editor.icon_none" })).toBeNull();
  });

  it("the icon row is a field like the others: icon, name and chevron, open while its picker shows", async () => {
    renderPanel(
      <PopoverProvider>
        <IconRow label="Icon" path="symbol.marker.icon" />
      </PopoverProvider>,
      {
        document: { version: 1, kind: "vector", symbol: { marker: { icon: "goat:bar" } } } as LayerStyle,
        data: { geometry: "point" },
      }
    );
    // Found before the picker opens: its title is the row's label.
    const row = rowOf("Icon");
    const button = within(row).getByRole("button");
    expect(button.closest(".MuiOutlinedInput-root")).not.toBeNull();
    expect(within(button).getByText("Bar")).toBeDefined();
    expect(button.hasAttribute("data-active")).toBe(false);
    await userEvent.click(button);
    expect(button.hasAttribute("data-active")).toBe(true);
    expect(row.hasAttribute("data-active")).toBe(true);
  });

  it("an emoji icon shows alone in its field, named for screen readers", () => {
    renderPanel(
      <PopoverProvider>
        <IconRow label="Icon" path="symbol.marker.icon" />
      </PopoverProvider>,
      {
        document: { version: 1, kind: "vector", symbol: { marker: { icon: "emoji:1f525" } } } as LayerStyle,
        data: { geometry: "point" },
      }
    );
    const button = within(rowOf("Icon")).getByRole("button");
    expect(button.closest(".MuiOutlinedInput-root")).not.toBeNull();
    expect(button.getAttribute("aria-label")).toMatch(/^Icon: /);
  });

  it("the Fill switch draws hollow markers and leaves the outline as it is", async () => {
    const { store } = render({ symbol: { marker: { color: "#1a6b4d", size: 10 }, outline: { width: 2 } } });
    await openGroup("style_editor.part_fill");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("symbol.marker")).toEqual({ color: "#1a6b4d", size: 10, fill: false });
    expect(store.get("symbol.outline")).toEqual({ width: 2 });
    expect(screen.getByText("style_editor.fill_off_note")).toBeDefined();
    expect(screen.queryByText("style_editor.opacity")).toBeNull();
    expect(screen.queryByText("style_editor.marker_invisible")).toBeNull();
    expect(within(groupRow("style_editor.part_fill")).getByText("style_editor.none")).toBeDefined();
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("symbol.marker")).toEqual({ color: "#1a6b4d", size: 10 });
  });

  it("a marker without fill, outline or icon draws nothing: the Fill editor and row say so, and allow it", async () => {
    const { store, unmount } = render({ symbol: { marker: { color: "#1a6b4d" } } });
    await openGroup("style_editor.part_fill");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    // Only the fill is written: the outline stays off, as the user left it.
    expect(store.get("symbol")).toEqual({ marker: { color: "#1a6b4d", fill: false } });
    expect(screen.getByText("style_editor.marker_invisible")).toBeDefined();
    expect(within(groupRow("style_editor.part_fill")).getByText("style_editor.none")).toBeDefined();
    expect(within(groupRow("style_editor.part_outline")).getByText("style_editor.none")).toBeDefined();
    // An outline makes the marker visible again.
    act(() => store.set("symbol.outline", {}));
    expect(screen.queryByText("style_editor.marker_invisible")).toBeNull();
    unmount();

    // An icon on a hollow marker still shows.
    render({ symbol: { marker: { shape: "pin", icon: "goat:park", fill: false } } });
    await openGroup("style_editor.part_fill");
    expect(screen.getByText("style_editor.fill_off_note")).toBeDefined();
    expect(screen.queryByText("style_editor.marker_invisible")).toBeNull();
  });

  it("an outline that is on stays as it is; both off is allowed and both rows read None", async () => {
    const { store } = render({
      symbol: { marker: { shape: "diamond" }, outline: { color: "#000000", width: 2 } },
    });
    await openGroup("style_editor.part_fill");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("symbol.outline")).toEqual({ color: "#000000", width: 2 });
    await openGroup("style_editor.part_outline");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("symbol.outline")).toBe(false);
    expect(store.get("symbol.marker.fill")).toBe(false);
    expect(within(groupRow("style_editor.part_fill")).getByText("style_editor.none")).toBeDefined();
    expect(within(groupRow("style_editor.part_outline")).getByText("style_editor.none")).toBeDefined();
  });

  it("the icon on a hollow marker reads the marker color until it has its own; its pictures are hollow", async () => {
    const { container } = render({
      symbol: { marker: { shape: "pin", icon: "goat:park", color: "#f28e2b", fill: false } },
    });
    const picture = container.querySelector('[data-marker-shape="pin"] path');
    expect(picture?.getAttribute("fill")).toBe("none");
    expect(picture?.getAttribute("stroke")).toBe("#f28e2b");
    await openGroup("style_editor.part_icon");
    expect(within(rowOf("style_editor.icon_color")).getByText(/f28e2b/i)).toBeDefined();
  });

  it("the icon alone has no fill to switch", async () => {
    render({ symbol: { marker: { shape: "icon", icon: "goat:park" } } });
    await openGroup("style_editor.part_fill");
    expect(screen.queryByRole("checkbox", { name: "style_editor.turn_part_off" })).toBeNull();
  });

  it("a class draws hollow markers on its own; on a hollow layer a class can be filled again", async () => {
    const classify = (base: object) => ({
      symbol: { marker: base, outline: { color: "#ffffff" } },
      classify: [
        {
          id: "kind",
          field: "kind",
          method: "categories",
          classes: [
            { id: "a", values: ["a"], marker: { color: "#e15759" } },
            { id: "b", values: ["b"], marker: { color: "#4e79a7" } },
          ],
        },
      ],
    });
    const { store, unmount } = render(classify({}));
    act(() => store.setScope({ classify: 0, key: 1 }));
    await openGroup("style_editor.part_fill");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("classify.0.classes.1.marker")).toEqual({ color: "#4e79a7", fill: false });
    expect(store.get("symbol.marker")).toEqual({});
    // The layer's outline shows around the class's hollow markers.
    expect(screen.queryByText("style_editor.marker_invisible")).toBeNull();
    // A class that also switches its outline off draws nothing.
    act(() => store.set("classify.0.classes.1.outline", false));
    expect(screen.getByText("style_editor.marker_invisible")).toBeDefined();
    expect(store.get("symbol.outline")).toEqual({ color: "#ffffff" });
    unmount();

    const hollow = render(classify({ fill: false }));
    act(() => hollow.store.setScope({ classify: 0, key: 0 }));
    await openGroup("style_editor.part_fill");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(hollow.store.get("classify.0.classes.0.marker")).toEqual({ color: "#e15759", fill: true });
  });

  it("rotation raw writes {field}", async () => {
    const { store } = render(
      { symbol: { marker: { shape: "icon", icon: "goat:marker" } } },
      { fields: [{ name: "bearing", type: "number", label: "Bearing" }] }
    );
    await openGroup("style_editor.part_icon");
    await userEvent.click(
      within(rowOf("style_editor.rotation")).getByRole("button", { name: "style_editor.value_mode_aria" })
    );
    await userEvent.click(within(screen.getByRole("menu")).getByText("style_editor.mode_raw"));
    expect(store.get("symbol.marker.rotation")).toEqual({ field: "bearing" });
  });

  it("the size row sits in the section and writes marker.size", () => {
    const { store } = render({ symbol: { marker: {} } });
    const size = within(rowOf("style_editor.size")).getByRole("textbox", { name: "style_editor.size" });
    expect((size as HTMLInputElement).value).toBe("8");
    fireEvent.change(size, { target: { value: "12" } });
    expect(store.get("symbol.marker.size")).toBe(12);
  });
});

describe("draw as", () => {
  it("Draw as heatmap writes render.type only", async () => {
    const { store } = render({ symbol: { marker: {} } });
    await choose("style_editor.draw_as", "features", "heatmap");
    expect(store.get("render")).toEqual({ type: "heatmap" });
    await choose("style_editor.draw_as", "heatmap", "features");
    expect(store.get("render")).toBeUndefined();
  });

  it("heatmap without points hides the symbol section", () => {
    const { store } = render({ render: { type: "heatmap" }, symbol: { marker: {} } });
    expect(screen.getByText("style_editor.section_heatmap")).toBeDefined();
    expect(screen.queryByText("style_editor.geometry_point")).toBeNull();
    act(() => store.set("render.points_from_zoom", 15));
    expect(screen.getByText("style_editor.geometry_point")).toBeDefined();
  });

  it("clusters are disabled above 100,000 features", async () => {
    render({}, { featureCount: 150000 });
    await userEvent.click(within(rowOf("style_editor.draw_as")).getByRole("combobox"));
    const option = within(screen.getByRole("listbox")).getByText("cluster").closest("li") as HTMLElement;
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(within(option).getByText("style_editor.clusters_too_many")).toBeDefined();
  });

  it("a cluster color keeps the default cluster symbol", async () => {
    const { store } = render({ render: { type: "cluster" } });
    await pickColor(rowOf("style_editor.color"), "#283593");
    expect(store.get("render.symbol.marker.color")).toBe("#283593");
    expect(store.get("render.symbol.label.text")).toBe("{count}");
  });

  it("heatmap points write points_from_zoom and Never removes it", async () => {
    const { store } = render({ render: { type: "heatmap" } });
    const row = rowOf("style_editor.points");
    await userEvent.click(within(row).getByRole("combobox"));
    await userEvent.click(
      within(screen.getByRole("listbox")).getAllByText("style_editor.points_from_zoom")[0]
    );
    expect(store.get("render.points_from_zoom")).toBe(10);
    await choose("style_editor.points", "style_editor.points_from_zoom", "style_editor.points_never");
    expect(store.get("render.points_from_zoom")).toBeUndefined();
  });
});
