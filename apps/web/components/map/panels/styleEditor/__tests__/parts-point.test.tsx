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
      document: { version: "1.0.0", kind: "vector", ...doc } as LayerStyle,
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

  it("an upload or an emoji keeps its own colors: no icon color row, a note in its place", async () => {
    const OWN = "style_editor.note_icon_own_colors";
    const emoji = render({ symbol: { marker: { icon: "emoji:1f525", shape: "square" } } });
    await openGroup("style_editor.part_icon");
    expect(screen.queryByText("style_editor.icon_color")).toBeNull();
    expect(screen.getByText(OWN)).toBeDefined();
    emoji.unmount();

    const upload = render({ symbol: { marker: { icon: "asset:abc", shape: "icon" } } });
    await openGroup("style_editor.part_icon");
    expect(screen.queryByText("style_editor.color")).toBeNull();
    expect(screen.getByText(OWN)).toBeDefined();
    upload.unmount();

    render({ symbol: { marker: { icon: "goat:park", shape: "square" } } });
    await openGroup("style_editor.part_icon");
    expect(screen.getByText("style_editor.icon_color")).toBeDefined();
    expect(screen.queryByText(OWN)).toBeNull();
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
    expect(circle.store.get("symbol.marker")).toEqual({ size: 12, icon: "goat:marker", icon_color: "auto" });
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
          version: "1.0.0",
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
        document: {
          version: "1.0.0",
          kind: "vector",
          symbol: { marker: { icon: "goat:bar" } },
        } as LayerStyle,
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
        document: {
          version: "1.0.0",
          kind: "vector",
          symbol: { marker: { icon: "emoji:1f525" } },
        } as LayerStyle,
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

  it("a point outline has no dash and no position: only polygon outlines take them", async () => {
    render({ symbol: { marker: { shape: "circle" }, outline: { color: "#000000", width: 2 } } });
    await openGroup("style_editor.part_outline");
    expect(screen.getByText("style_editor.width")).toBeDefined();
    expect(screen.queryByText("style_editor.dash")).toBeNull();
    expect(screen.queryByText("style_editor.outline_position")).toBeNull();
  });

  it("an outline that is on stays as it is; both off is allowed: Fill reads None, the outline Off for all", async () => {
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

  /** The Clusters section's rows. */
  const clusterSection = () =>
    screen.getByText("style_editor.section_clusters").closest("section") as HTMLElement;
  const sizeThumbs = () => within(clusterSection()).getAllByRole("slider").slice(0, 2);

  it("the cluster size sets the smallest and the largest circle and keeps the default cluster symbol", () => {
    const { store } = render({ render: { type: "cluster" } });
    const section = clusterSection();
    expect(within(section).getByText("style_editor.size")).toBeDefined();
    const [smallest, largest] = sizeThumbs();
    expect(smallest.getAttribute("aria-label")).toBe("style_editor.range_smallest");
    expect(largest.getAttribute("aria-label")).toBe("style_editor.range_largest");
    // The default cluster symbol's sizes, within the panel's marker size limits.
    expect(smallest.getAttribute("aria-valuenow")).toBe("16");
    expect(largest.getAttribute("aria-valuenow")).toBe("40");
    expect(largest.getAttribute("aria-valuemax")).toBe("60");
    // jsdom has no keyboard behavior for range inputs: move the thumbs by changing their values.
    fireEvent.change(largest, { target: { value: 50 } });
    expect(store.get("render.symbol.marker.size")).toEqual({
      field: "count",
      range: [16, 50],
      scale: "sqrt",
    });
    expect(store.get("render.symbol.label.text")).toBe("{count}");
    fireEvent.change(sizeThumbs()[0], { target: { value: 10 } });
    expect(store.get("render.symbol.marker.size.range")).toEqual([10, 50]);
  });

  it("a fixed cluster size shows as both ends and an edit sizes the clusters by count again", () => {
    const { store } = render({
      render: { type: "cluster", symbol: { marker: { color: "#283593", size: 20 } } },
    });
    const [smallest, largest] = sizeThumbs();
    expect(smallest.getAttribute("aria-valuenow")).toBe("20");
    expect(largest.getAttribute("aria-valuenow")).toBe("20");
    fireEvent.change(largest, { target: { value: 36 } });
    expect(store.get("render.symbol.marker")).toEqual({
      color: "#283593",
      size: { field: "count", range: [20, 36], scale: "sqrt" },
    });
  });

  it("the cluster size keeps the scale and domain the style gives", () => {
    const { store } = render({
      render: {
        type: "cluster",
        symbol: { marker: { size: { field: "count", range: [12, 30], scale: "log", domain: [2, 500] } } },
      },
    });
    fireEvent.change(sizeThumbs()[1], { target: { value: 44 } });
    expect(store.get("render.symbol.marker.size")).toEqual({
      field: "count",
      range: [12, 44],
      scale: "log",
      domain: [2, 500],
    });
  });

  it("the clusters' merge distance is not called a radius", () => {
    const { store } = render({ render: { type: "cluster" } });
    const section = clusterSection();
    expect(within(section).queryByText("style_editor.radius")).toBeNull();
    const row = within(section).getByText("style_editor.merge_distance").parentElement as HTMLElement;
    fireEvent.change(within(row).getByRole("slider"), { target: { value: 80 } });
    expect(store.get("render.radius")).toBe(80);
  });

  /** A cluster menu's options, and which one is selected. */
  async function clusterMenu(label: string) {
    const row = within(clusterSection()).getByText(label).parentElement as HTMLElement;
    await userEvent.click(within(row).getByRole("combobox"));
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    return { options, selected: options.findIndex((o) => o.getAttribute("aria-selected") === "true") };
  }

  it("Until offers every zoom from 0 to 24 and shows a converted zoom 21", async () => {
    const { store } = render({ render: { type: "cluster", cluster_until_zoom: 21 } });
    const { options, selected } = await clusterMenu("style_editor.until");
    expect(options).toHaveLength(25);
    expect(selected).toBe(21);
    await userEvent.click(options[24]);
    expect(store.get("render.cluster_until_zoom")).toBe(24);
  });

  it("Until keeps a zoom between whole zooms as picked", async () => {
    const { store } = render({ render: { type: "cluster", cluster_until_zoom: 14.5 } });
    const { options, selected } = await clusterMenu("style_editor.until");
    expect(options).toHaveLength(26);
    expect(selected).toBe(15);
    expect(store.get("render.cluster_until_zoom")).toBe(14.5);
  });

  it("Smallest offers 2 to 20 points and shows converted counts such as 13", async () => {
    const { store } = render({ render: { type: "cluster", min_points: 13 } });
    const { options, selected } = await clusterMenu("style_editor.smallest");
    expect(options).toHaveLength(19);
    expect(selected).toBe(11);
    await userEvent.click(options[2]);
    expect(store.get("render.min_points")).toBe(4);
  });

  it("Smallest shows a count above 20 as picked and keeps it", async () => {
    const { store } = render({ render: { type: "cluster", min_points: 25 } });
    const { options, selected } = await clusterMenu("style_editor.smallest");
    expect(options).toHaveLength(20);
    expect(selected).toBe(19);
    expect(store.get("render.min_points")).toBe(25);
  });

  it("clusters of icons and shapes are drawn like the points with a count badge, plain circles as circles", async () => {
    const switched = async (symbol: object, classify?: object[]) => {
      const { store, unmount } = render({ symbol, ...(classify ? { classify } : {}) });
      await choose("style_editor.draw_as", "features", "cluster");
      const out = store.get("render");
      unmount();
      return out;
    };
    // Either way with the default cluster symbol, its number on Auto.
    const symbol = {
      marker: { shape: "circle", size: { field: "count", range: [16, 40], scale: "sqrt" } },
      label: { text: "{count}", color: "auto" },
    };
    const likeThePoints = { type: "cluster", look: "points", count: "badge", symbol };
    expect(await switched({ marker: {} })).toEqual({ type: "cluster", symbol });
    expect(await switched({ marker: { shape: "circle", color: "#ff0000" } })).toEqual({
      type: "cluster",
      symbol,
    });
    expect(await switched({ marker: { shape: "icon", icon: "goat:shop" } })).toEqual(likeThePoints);
    expect(await switched({ marker: { shape: "pin" } })).toEqual(likeThePoints);
    expect(await switched({ marker: { shape: "circle", icon: "goat:shop" } })).toEqual(likeThePoints);
    // Icons set by a classification.
    expect(
      await switched({ marker: {} }, [
        {
          id: "k",
          field: "kind",
          method: "categories",
          classes: [{ values: ["a"], marker: { icon: "goat:shop" } }],
        },
      ])
    ).toEqual(likeThePoints);
  });

  it("the clusters' look and count rows write render.look and render.count", async () => {
    const { store } = render({ render: { type: "cluster" } });
    await choose("style_editor.look", "circle", "points");
    expect(store.get("render.look")).toBe("points");
    await choose("style_editor.count", "center", "badge");
    expect(store.get("render.count")).toBe("badge");
    await choose("style_editor.look", "points", "circle");
    expect(store.get("render.look")).toBe("circle");
  });

  it("clusters drawn like the points have no cluster size: the points' size applies", () => {
    const { store } = render({ render: { type: "cluster" } });
    expect(within(clusterSection()).getByText("style_editor.size")).toBeDefined();
    act(() => store.set("render.look", "points"));
    expect(within(clusterSection()).queryByText("style_editor.size")).toBeNull();
  });

  it("the number's color row is not called count, next to the count row", async () => {
    const { store } = render({ render: { type: "cluster" } });
    await pickColor(rowOf("style_editor.cluster_number_color"), "#ffff00");
    expect(store.get("render.symbol.label.color")).toBe("#ffff00");
  });

  describe("the clusters' value", () => {
    const TURNOVER = { name: "turnover", type: "number" as const, label: "Turnover" };
    const profiles = {
      get: (field: string) => (field === "turnover" ? { min: 5, max: 2000 } : undefined),
      load: () => undefined,
      subscribe: () => () => undefined,
    };
    const clusters = (extra: object = {}) =>
      render({ render: { type: "cluster", ...extra } }, { fields: [TURNOVER], profiles });

    it("a sum of a field labels and sizes the clusters by it, from the field's range", async () => {
      const { store } = clusters();
      await choose("style_editor.h3_value", "style_editor.h3_value_count", "style_editor.h3_value_sum");
      expect(store.get("render.value")).toEqual({ op: "sum", field: "turnover" });
      expect(store.get("render.symbol.label.text")).toBe("{value}");
      expect(store.get("render.symbol.marker.size")).toEqual({
        field: "value",
        range: [16, 40],
        scale: "sqrt",
        domain: [5, 20000],
      });
      // Back to the number of points: the count again, its domain the map's.
      await choose("style_editor.h3_value", "style_editor.h3_value_sum", "style_editor.h3_value_count");
      expect(store.get("render.value")).toBeUndefined();
      expect(store.get("render.symbol.label.text")).toBe("{count}");
      expect(store.get("render.symbol.marker.size")).toEqual({
        field: "count",
        range: [16, 40],
        scale: "sqrt",
      });
    });

    it("until the field's range arrives the circles keep their size by count, so the style stays valid", async () => {
      const arrived: { profile?: { min: number; max: number } } = {};
      const listeners = new Set<() => void>();
      const waiting = {
        get: () => arrived.profile,
        load: () => undefined,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const { store } = render({ render: { type: "cluster" } }, { fields: [TURNOVER], profiles: waiting });
      await choose("style_editor.h3_value", "style_editor.h3_value_count", "style_editor.h3_value_mean");
      expect(store.get("render.value")).toEqual({ op: "mean", field: "turnover" });
      expect(store.get("render.symbol.label.text")).toBe("{value}");
      expect(store.get("render.symbol.marker.size.field")).toBe("count");
      arrived.profile = { min: 5, max: 2000 };
      act(() => listeners.forEach((listener) => listener()));
      expect(store.get("render.symbol.marker.size")).toEqual({
        field: "value",
        range: [16, 40],
        scale: "sqrt",
        domain: [5, 2000],
      });
    });

    it("a mean, smallest or largest value spans the field's range", async () => {
      const { store } = clusters();
      await choose("style_editor.h3_value", "style_editor.h3_value_count", "style_editor.h3_value_max");
      expect(store.get("render.value")).toEqual({ op: "max", field: "turnover" });
      expect(store.get("render.symbol.marker.size.domain")).toEqual([5, 2000]);
    });

    it("the range row sets the value's domain for the circles' size", () => {
      const { store } = clusters({
        value: { op: "mean", field: "turnover" },
        symbol: {
          marker: { shape: "circle", size: { field: "value", range: [16, 40], domain: [5, 2000] } },
          label: { text: "{value}" },
        },
      });
      const highest = screen.getByRole("textbox", { name: "style_editor.range_highest" });
      fireEvent.change(highest, { target: { value: "500" } });
      fireEvent.blur(highest);
      expect(store.get("render.symbol.marker.size.domain")).toEqual([5, 500]);
      // The count has no range of its own to set.
      act(() => store.set("render.value", undefined));
      expect(screen.queryByRole("textbox", { name: "style_editor.range_highest" })).toBeNull();
    });

    it("the cluster size by the value keeps the value and its typed range while dragged", async () => {
      const { store } = clusters();
      await choose("style_editor.h3_value", "style_editor.h3_value_count", "style_editor.h3_value_sum");
      const highest = screen.getByRole("textbox", { name: "style_editor.range_highest" });
      fireEvent.change(highest, { target: { value: "500" } });
      fireEvent.blur(highest);
      fireEvent.change(sizeThumbs()[1], { target: { value: 50 } });
      expect(store.get("render.symbol.marker.size")).toEqual({
        field: "value",
        range: [16, 50],
        scale: "sqrt",
        domain: [5, 500],
      });
      expect(screen.getByRole("textbox", { name: "style_editor.range_highest" })).toBeDefined();
    });

    /** Profiles that arrive only when the test says so, with the listeners still waiting for them. */
    function waitingProfiles() {
      const arrived: Record<string, { min: number; max: number }> = {};
      const listeners = new Set<() => void>();
      return {
        arrived,
        listeners,
        profiles: {
          get: (field: string) => arrived[field],
          load: () => undefined,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      };
    }
    const VISITORS = { name: "visitors", type: "integer" as const, label: "Visitors" };
    /** Picks the Value menu's option at `index`: the count, then each op of each number field in order. */
    const pickValue = async (index: number) => {
      const row = screen.getByText("style_editor.h3_value").parentElement as HTMLElement;
      await userEvent.click(within(row).getByRole("combobox"));
      await userEvent.click(within(screen.getByRole("listbox")).getAllByRole("option")[index]);
    };

    it("a value by a field whose range has not arrived sizes and colors by the count, not the last range", async () => {
      const waiting = waitingProfiles();
      waiting.arrived.turnover = { min: 5, max: 2000 };
      const { store } = render(
        {
          render: {
            type: "cluster",
            symbol: {
              marker: {
                size: { field: "count", range: [16, 40], scale: "sqrt" },
                color: { field: "count", palette: "goat:green" },
              },
              label: { text: "{count}" },
            },
          },
        },
        { fields: [TURNOVER, VISITORS], profiles: waiting.profiles }
      );
      // Sum of turnover, then the mean of visitors, whose range is still loading.
      await pickValue(1);
      expect(store.get("render.symbol.marker.size.domain")).toEqual([5, 20000]);
      await pickValue(6);
      expect(store.get("render.value")).toEqual({ op: "mean", field: "visitors" });
      expect(store.get("render.symbol.label.text")).toBe("{value}");
      expect(store.get("render.symbol.marker.size")).toEqual({
        field: "count",
        range: [16, 40],
        scale: "sqrt",
      });
      expect(store.get("render.symbol.marker.color")).toEqual({ field: "count", palette: "goat:green" });
      // Its range arrives: the circles follow the value from it.
      waiting.arrived.visitors = { min: 1, max: 80 };
      act(() => waiting.listeners.forEach((listener) => listener()));
      expect(store.get("render.symbol.marker.size")).toEqual({
        field: "value",
        range: [16, 40],
        scale: "sqrt",
        domain: [1, 80],
      });
    });

    it("waits for one field's range at a time and stops waiting when the section goes", async () => {
      const waiting = waitingProfiles();
      const { unmount } = render(
        { render: { type: "cluster" } },
        { fields: [TURNOVER], profiles: waiting.profiles }
      );
      await pickValue(2);
      await pickValue(4);
      expect(waiting.listeners.size).toBe(1);
      await pickValue(0);
      expect(waiting.listeners.size).toBe(0);
      await pickValue(3);
      expect(waiting.listeners.size).toBe(1);
      unmount();
      expect(waiting.listeners.size).toBe(0);
    });
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
