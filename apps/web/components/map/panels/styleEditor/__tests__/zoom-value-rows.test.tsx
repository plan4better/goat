import { configureStore } from "@reduxjs/toolkit";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { initView, mapReducer } from "@/lib/store/map/slice";
import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { ClusterSection } from "@/components/map/panels/styleEditor/sections/ClusterSection";
import { H3Section } from "@/components/map/panels/styleEditor/sections/H3Section";
import { HeatmapSection } from "@/components/map/panels/styleEditor/sections/HeatmapSection";
import { LayerSection } from "@/components/map/panels/styleEditor/sections/LayerSection";

import { i18n, renderPanel } from "./renderPanel";

vi.mock("react-toastify", () => ({ toast: Object.assign(() => 0, { info: () => 0, dismiss: () => 0 }) }));

beforeAll(() => {
  i18n.addResourceBundle("en", "common", {
    style_editor: {
      zoom_n: "Zoom {{zoom}}",
      points_from_zoom: "From zoom {{zoom}}",
      points_never: "Never, density only",
      points_never_h3: "Never, hexagons only",
    },
  });
});

/** A map that tells its zoom and calls back on its zoom event, as the editor's map does. */
function fakeMap(start = 12) {
  const handlers: Record<string, () => void> = {};
  const map = {
    zoom: start,
    on: (event: string, handler: () => void) => (handlers[event] = handler),
    off: vi.fn(),
    getZoom: () => map.zoom,
    jumpTo: vi.fn(),
    easeTo: vi.fn(),
    zoomTo(next: number) {
      map.zoom = next;
      act(() => handlers.zoom?.());
    },
  };
  return map;
}

function setup(render: object, map: unknown = null) {
  const redux = configureStore({ reducer: { map: mapReducer } });
  redux.dispatch(initView({ projectId: "p1", mode: "2d", projection: "mercator" }));
  return renderPanel(
    <Provider store={redux}>
      <PopoverProvider>
        <ClusterSection />
        <HeatmapSection />
        <H3Section />
      </PopoverProvider>
    </Provider>,
    {
      document: { version: "1.0.0", kind: "vector", render } as LayerStyle,
      data: { geometry: "point", featureCount: 5000 },
      mapZoom: 12,
      map,
    }
  );
}

/** The panel's row of `label` (an open editor's title says it too, after it in the page). */
const sectionRow = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;
const summary = (label: string) => within(sectionRow(label)).getByRole("button").textContent;
const open = (label: string) => userEvent.click(within(sectionRow(label)).getByRole("button"));
const dimmed = (label: string) => getComputedStyle(sectionRow(label)).opacity === "0.55";
const untilSlider = () => screen.queryByRole("slider", { name: "style_editor.zoom_until" });
const pointsSlider = () => screen.queryByRole("slider", { name: "style_editor.zoom_from" });
const pointer = () => document.querySelector("[data-zoom-pointer]") as HTMLElement;
/** The zoom the slider's row reads beside the track, as stored. */
const caption = (zoom: number) => screen.getByText(String(zoom)).tagName;

describe("Until and Points: a zoom on the slider that marks the map's zoom", () => {
  it("the panel shows Until and Points as one row each, with no zoom dropdown", () => {
    const cluster = setup({ type: "cluster" });
    expect(summary("style_editor.until")).toBe("Zoom 14");
    expect(within(sectionRow("style_editor.until")).queryByRole("combobox")).toBeNull();
    expect(untilSlider()).toBeNull();
    cluster.unmount();

    const between = setup({ type: "cluster", cluster_until_zoom: 14.5 });
    expect(summary("style_editor.until")).toBe("Zoom 14.5");
    between.unmount();

    const heatmap = setup({ type: "heatmap" });
    expect(summary("style_editor.points")).toBe("Never, density only");
    expect(within(sectionRow("style_editor.points")).queryByRole("combobox")).toBeNull();
    expect(dimmed("style_editor.points")).toBe(true);
    heatmap.unmount();

    const from = setup({ type: "heatmap", points_from_zoom: 12 });
    expect(summary("style_editor.points")).toBe("From zoom 12");
    expect(dimmed("style_editor.points")).toBe(false);
    from.unmount();

    setup({ type: "h3" });
    expect(summary("style_editor.points")).toBe("Never, hexagons only");
    expect(within(sectionRow("style_editor.points")).queryByRole("combobox")).toBeNull();
  });

  it("Until's editor sets the zoom on one thumb over every whole zoom; a drag is one undo step", async () => {
    const { store } = setup({ type: "cluster" });
    await open("style_editor.until");
    const slider = untilSlider() as HTMLElement;
    expect(screen.getAllByRole("slider", { name: "style_editor.zoom_until" })).toHaveLength(1);
    expect(slider.getAttribute("aria-valuemin")).toBe("0");
    expect(slider.getAttribute("aria-valuemax")).toBe("24");
    expect(slider.getAttribute("step")).toBe("1");
    expect(slider.getAttribute("aria-valuenow")).toBe("14");
    expect(screen.getByText("style_editor.cluster_until_note")).toBeDefined();
    // Opening writes nothing.
    expect(store.document).toEqual({ version: "1.0.0", kind: "vector", render: { type: "cluster" } });
    expect(store.canUndo).toBe(false);
    for (const value of [16, 17, 18]) fireEvent.change(slider, { target: { value } });
    expect(store.get("render.cluster_until_zoom")).toBe(18);
    expect(summary("style_editor.until")).toBe("Zoom 18");
    act(() => store.undo());
    expect(store.get("render")).toEqual({ type: "cluster" });
    expect(store.canUndo).toBe(false);
  });

  it("Until shows a stored zoom between whole zooms or past the bounds as stored and keeps it", async () => {
    for (const [stored, thumb] of [
      [14.5, "14.5"],
      [30, "24"],
    ] as const) {
      const { store, unmount } = setup({ type: "cluster", cluster_until_zoom: stored });
      await open("style_editor.until");
      const slider = untilSlider() as HTMLElement;
      expect(slider.getAttribute("aria-valuenow")).toBe(thumb);
      expect(caption(stored)).toBeDefined();
      expect(store.get("render.cluster_until_zoom")).toBe(stored);
      expect(store.canUndo).toBe(false);
      unmount();
    }
  });

  it("a press or a key on an end writes that end over a stored zoom past it", async () => {
    const { store, unmount } = setup({ type: "cluster", cluster_until_zoom: 30 });
    await open("style_editor.until");
    // The thumb sits at 24 already: a press on the track's end takes 24 and writes it.
    const root = (untilSlider() as HTMLElement).closest(".MuiSlider-root") as HTMLElement;
    root.getBoundingClientRect = () =>
      ({ left: 0, width: 240, top: 0, height: 20, bottom: 20, right: 240 }) as DOMRect;
    fireEvent.mouseDown(root, { button: 0, clientX: 240, clientY: 10 });
    fireEvent.mouseUp(document, { clientX: 240, clientY: 10 });
    expect(store.get("render.cluster_until_zoom")).toBe(24);
    act(() => store.undo());
    expect(store.get("render.cluster_until_zoom")).toBe(30);
    expect(store.canUndo).toBe(false);
    unmount();

    const keyed = setup({ type: "cluster", cluster_until_zoom: 30 });
    await open("style_editor.until");
    fireEvent.keyDown(untilSlider() as HTMLElement, { key: "PageUp" });
    expect(keyed.store.get("render.cluster_until_zoom")).toBe(24);
    // On the end the stored zoom already is, nothing is written.
    const before = keyed.store.document;
    fireEvent.keyDown(untilSlider() as HTMLElement, { key: "PageUp" });
    expect(keyed.store.document).toBe(before);
  });

  it("Points' switch: on starts at zoom 10 on a slider over 0 to 24, off removes the key, on brings it back", async () => {
    const { store } = setup({ type: "heatmap" });
    await open("style_editor.points");
    // Off: the editor shows what an editor whose part is off shows, and no slider.
    expect(screen.getByText("style_editor.part_off_note")).toBeDefined();
    expect(pointsSlider()).toBeNull();
    expect(store.canUndo).toBe(false);
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("render.points_from_zoom")).toBe(10);
    const slider = pointsSlider() as HTMLElement;
    expect(slider.getAttribute("aria-valuemin")).toBe("0");
    expect(slider.getAttribute("aria-valuemax")).toBe("24");
    expect(slider.getAttribute("aria-valuenow")).toBe("10");
    expect(screen.getByText("style_editor.points_note")).toBeDefined();
    fireEvent.change(slider, { target: { value: 14 } });
    expect(store.get("render.points_from_zoom")).toBe(14);
    expect(summary("style_editor.points")).toBe("From zoom 14");
    // The switch and the slider are separate undo steps.
    act(() => store.undo());
    expect(store.get("render.points_from_zoom")).toBe(10);
    act(() => store.redo());
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("render")).toEqual({ type: "heatmap" });
    expect(summary("style_editor.points")).toBe("Never, density only");
    expect(pointsSlider()).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("render.points_from_zoom")).toBe(14);
  });

  it("Points' slider: a drag is one undo step", async () => {
    const { store } = setup({ type: "heatmap", points_from_zoom: 12 });
    await open("style_editor.points");
    for (const value of [13, 14, 15]) fireEvent.change(pointsSlider() as HTMLElement, { target: { value } });
    expect(store.get("render.points_from_zoom")).toBe(15);
    act(() => store.undo());
    expect(store.get("render")).toEqual({ type: "heatmap", points_from_zoom: 12 });
    expect(store.canUndo).toBe(false);
  });

  it("Points keeps a stored zoom below the zooms it once offered; opening writes nothing", async () => {
    const { store } = setup({ type: "h3", points_from_zoom: 5 });
    expect(summary("style_editor.points")).toBe("From zoom 5");
    await open("style_editor.points");
    const slider = pointsSlider() as HTMLElement;
    expect(
      (screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }) as HTMLInputElement).checked
    ).toBe(true);
    expect(slider.getAttribute("aria-valuenow")).toBe("5");
    expect(caption(5)).toBeDefined();
    expect(screen.getByText("style_editor.points_note_h3")).toBeDefined();
    expect(store.document).toEqual({
      version: "1.0.0",
      kind: "vector",
      render: { type: "h3", points_from_zoom: 5 },
    });
    expect(store.canUndo).toBe(false);
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(store.get("render.points_from_zoom")).toBeUndefined();
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(store.get("render.points_from_zoom")).toBe(5);
  });

  it("the marker reads the map's zoom and follows the map while the editor is open", async () => {
    const map = fakeMap();
    const cluster = setup({ type: "cluster" }, map);
    await open("style_editor.until");
    expect(pointer().getAttribute("title")).toBe("12");
    // The number the user reads under the marker.
    expect(pointer().textContent).toBe("12.0");
    expect(pointer().style.left).toBe("50%");
    map.zoomTo(18);
    expect(pointer().textContent).toBe("18.0");
    expect(pointer().style.left).toBe("75%");
    cluster.unmount();

    // The Points slider spans the same zooms: below 10 the marker stands where the map is.
    const other = fakeMap();
    setup({ type: "heatmap", points_from_zoom: 12 }, other);
    await open("style_editor.points");
    expect(pointer().style.left).toBe("50%");
    other.zoomTo(6);
    expect(pointer().style.left).toBe("25%");
    expect(pointer().textContent).toBe("6.0");
    other.zoomTo(8.8);
    expect(pointer().textContent).toBe("8.8");
  });

  it("each editor closes when its row goes", async () => {
    const { store, unmount } = setup({ type: "cluster" });
    await open("style_editor.until");
    expect(untilSlider()).not.toBeNull();
    act(() => store.set("render", { type: "heatmap" }));
    expect(untilSlider()).toBeNull();
    unmount();

    const heat = setup({ type: "heatmap", points_from_zoom: 12 });
    await open("style_editor.points");
    expect(pointsSlider()).not.toBeNull();
    // The hexagons have a Points row of their own: the heatmap's editor still closes.
    act(() => heat.store.set("render", { type: "h3", points_from_zoom: 12 }));
    expect(screen.getByText("style_editor.section_h3")).toBeDefined();
    expect(pointsSlider()).toBeNull();
    await open("style_editor.points");
    expect(pointsSlider()).not.toBeNull();
    act(() => heat.store.set("render", undefined));
    expect(pointsSlider()).toBeNull();
  });

  it("the Visible editor has no subtitle: its marker carries the map's zoom", async () => {
    renderPanel(
      <PopoverProvider>
        <LayerSection />
      </PopoverProvider>,
      {
        document: { version: "1.0.0", kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle,
        data: { geometry: "polygon" },
        mapZoom: 8.8,
      }
    );
    await userEvent.click(within(sectionRow("style_editor.visible")).getByRole("button"));
    expect(screen.getAllByRole("slider", { name: "style_editor.zoom_from" })).toHaveLength(1);
    expect(screen.queryByText("style_editor.map_at_zoom")).toBeNull();
    expect(pointer().getAttribute("title")).toBe("8.8");
  });
});
