import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { ZoomEditor } from "@/components/map/panels/styleEditor/editors/ZoomEditor";
import { CHART_WIDTH, ZOOM_AXIS, xOf } from "@/components/map/panels/styleEditor/editors/ZoomStopChart";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { choose, openGroup, renderPanel } from "./renderPanel";

type Stops = Array<[number, unknown]>;

const FIELDS = [{ name: "traffic", type: "number" as const, label: "traffic" }];

function setup(form: object, key = "line.width", choices?: string[], map?: unknown) {
  const [part, prop] = key.split(".");
  return renderPanel(
    <PopoverProvider>
      <ZoomEditor path={`symbol.${key}`} choices={choices} />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "vector", symbol: { [part]: { [prop]: form } } } as LayerStyle,
      data: { geometry: "line", fields: FIELDS },
      mapZoom: 12,
      map,
    }
  );
}

function chart(): HTMLElement {
  const svg = screen.getByRole("application", { name: "style_editor.zoom_chart_aria" });
  svg.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: CHART_WIDTH,
      bottom: 100,
      width: CHART_WIDTH,
      height: 100,
      x: 0,
      y: 0,
    }) as DOMRect;
  return svg;
}

const at = (_stops: Stops, z: number) => xOf(ZOOM_AXIS, z);

describe("zoom editor", () => {
  it("a press on the track adds an interpolated stop", () => {
    const stops: Stops = [
      [10, 2],
      [14, 6],
    ];
    const { store } = setup({ zoom: stops });
    const svg = chart();
    fireEvent.pointerDown(svg, { clientX: at(stops, 12), clientY: 70, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(store.get("symbol.line.width.zoom")).toEqual([
      [10, 2],
      [12, 4],
      [14, 6],
    ]);
  });

  it("a drag stays between neighbors", () => {
    const stops: Stops = [
      [8, 1],
      [12, 3],
      [16, 5],
    ];
    const { store } = setup({ zoom: stops });
    const svg = chart();
    fireEvent.pointerDown(svg, { clientX: at(stops, 12), clientY: 70, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: at(stops, 23), clientY: 70, pointerId: 1 });
    expect(store.get("symbol.line.width.zoom.1")).toEqual([15.5, 3]);
    fireEvent.pointerMove(svg, { clientX: at(stops, 2), clientY: 70, pointerId: 1 });
    expect(store.get("symbol.line.width.zoom.1")).toEqual([8.5, 3]);
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect((store.get("symbol.line.width.zoom") as Stops).map(([z]) => z)).toEqual([8, 8.5, 16]);
  });

  it("a stop with an attribute form shows By field and opens the attribute editor on its path", async () => {
    setup({
      zoom: [
        [10, { field: "traffic", range: [1, 4] }],
        [14, 6],
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "style_editor.by_field" }));
    expect(screen.getByText("style_editor.by_attribute_title")).toBeDefined();
    expect(screen.getByText("style_editor.scale")).toBeDefined();
  });

  it("remove keeps at least two stops", async () => {
    const { store } = setup({
      zoom: [
        [8, 1],
        [12, 3],
        [16, 5],
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "style_editor.remove_stop_aria" }));
    expect(store.get("symbol.line.width.zoom")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "style_editor.remove_stop_aria" })).toBeNull();
  });

  it("step-only keys have no transition", () => {
    setup(
      {
        zoom: [
          [10, "solid"],
          [14, "dashed"],
        ],
        interpolate: "step",
      },
      "line.dash",
      ["solid", "dashed", "dotted", "dash_dot"]
    );
    expect(screen.queryByText("style_editor.transition")).toBeNull();
    expect(screen.getByText("style_editor.zoom_note_step")).toBeDefined();
  });

  it("Smooth writes exponential with base 1.6", async () => {
    const { store } = setup({
      zoom: [
        [10, 2],
        [14, 6],
      ],
    });
    await choose(
      "style_editor.transition",
      "style_editor.transition_linear",
      "style_editor.transition_smooth"
    );
    expect(store.get("symbol.line.width")).toEqual({
      zoom: [
        [10, 2],
        [14, 6],
      ],
      interpolate: "exponential",
      base: 1.6,
    });
    await choose(
      "style_editor.transition",
      "style_editor.transition_smooth",
      "style_editor.transition_steps"
    );
    expect(store.get("symbol.line.width.interpolate")).toBe("step");
    expect(store.get("symbol.line.width.base")).toBeUndefined();
  });

  it("the axis spans every zoom, 0 to 24, wherever the map is: its ends add stops at 0 and 24", () => {
    const stops: Stops = [
      [10, 2],
      [14, 6],
    ];
    setup({ zoom: stops });
    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: at(stops, 0), clientY: 66 });
    expect(svg.querySelector('[data-ghost="stop"]')?.textContent).toBe("z0");
    fireEvent.pointerMove(svg, { clientX: at(stops, 24), clientY: 66 });
    expect(svg.querySelector('[data-ghost="stop"]')?.textContent).toBe("z24");
  });

  it("the map zoom mark follows the map as it zooms", async () => {
    const handlers: Record<string, () => void> = {};
    let zoom = 12;
    const map = {
      on: (event: string, handler: () => void) => (handlers[event] = handler),
      off: vi.fn(),
      getZoom: () => zoom,
    };
    setup(
      {
        zoom: [
          [10, 2],
          [14, 6],
        ],
      },
      "line.width",
      undefined,
      map
    );
    zoom = 16.4;
    act(() => handlers.zoom());
    // The mark under the axis names the zoom it stands at, as soon as the map's zoom event returns: it paints in the
    // map's frame.
    expect(chart().querySelector("path > title")?.textContent).toBe("16.4");
  });

  it("a stop shows it can be dragged: the cursor turns to a sideways arrow over it", () => {
    const stops: Stops = [
      [10, 2],
      [14, 6],
    ];
    setup({ zoom: stops });
    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: at(stops, 10), clientY: 66 });
    expect(svg.style.cursor).toBe("ew-resize");
    fireEvent.pointerMove(svg, { clientX: at(stops, 20), clientY: 66 });
    expect(svg.style.cursor).toBe("pointer");
  });
});

describe("stop labels and hidden zooms", () => {
  const labels = (svg: HTMLElement) =>
    [...svg.querySelectorAll("text")].map((t) => t.textContent).filter((t) => t?.startsWith("z"));

  it("labels of stops close together give way: the selected one shows, the hovered one shows over it", () => {
    const stops: Stops = [
      [10, 2],
      [10.5, 3],
      [14, 6],
    ];
    setup({ zoom: stops });
    const svg = chart();
    // The stop nearest the map zoom (12) is selected.
    expect(labels(svg)).toEqual(["z10.5", "z14"]);
    fireEvent.pointerMove(svg, { clientX: at(stops, 10), clientY: 30 });
    expect(labels(svg)).toEqual(["z10", "z14"]);
    fireEvent.pointerOut(svg, { relatedTarget: document.body });
    expect(labels(svg)).toEqual(["z10.5", "z14"]);
  });

  it("a press picks the nearest of two close stops", () => {
    const stops: Stops = [
      [10, 2],
      [10.5, 3],
      [14, 6],
    ];
    const { store } = setup({ zoom: stops });
    const svg = chart();
    const press = (z: number) => {
      fireEvent.pointerDown(svg, { clientX: at(stops, z), clientY: 30, pointerId: 1 });
      fireEvent.pointerUp(svg, { pointerId: 1 });
      fireEvent.pointerOut(svg, { relatedTarget: document.body });
    };
    press(10.1);
    expect(labels(svg)).toEqual(["z10", "z14"]);
    // Within reach of both, nearer to 10.5.
    press(10.4);
    expect(labels(svg)).toEqual(["z10.5", "z14"]);
    expect(store.get("symbol.line.width.zoom")).toEqual(stops);
  });

  it("the axis is dashed where the layer is hidden, with no bands", () => {
    renderPanel(
      <PopoverProvider>
        <ZoomEditor path="symbol.line.width" />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          min_zoom: 1,
          max_zoom: 22,
          symbol: {
            line: {
              width: {
                zoom: [
                  [10, 2],
                  [14, 6],
                ],
              },
            },
          },
        } as LayerStyle,
        data: { geometry: "line", fields: FIELDS },
        mapZoom: 12,
      }
    );
    const svg = chart();
    const hidden = [...svg.querySelectorAll("[data-hidden-zooms]")];
    expect(hidden.map((l) => [l.getAttribute("x1"), l.getAttribute("x2")])).toEqual([
      [String(xOf(ZOOM_AXIS, 0)), String(xOf(ZOOM_AXIS, 1))],
      [String(xOf(ZOOM_AXIS, 22)), String(xOf(ZOOM_AXIS, 24))],
    ]);
    expect(svg.querySelector("rect[height]:not([rx])")).toBeNull();
  });
});

describe("zooming the map from the zoom chart", () => {
  const fakeMap = () => ({
    getZoom: () => 12,
    on: vi.fn(),
    off: vi.fn(),
    jumpTo: vi.fn(),
    easeTo: vi.fn(),
  });
  const stops: Stops = [
    [10, 2],
    [14, 6],
  ];

  it("a press under the axis zooms the map there; the map zoom's pointer drags the map's zoom", () => {
    const map = fakeMap();
    const { store } = setup({ zoom: stops }, "line.width", undefined, map);
    const svg = chart();
    fireEvent.pointerDown(svg, { clientX: at(stops, 16), clientY: 92, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: at(stops, 16), clientY: 92, pointerId: 1 });
    expect(map.easeTo).toHaveBeenCalledWith({ zoom: 16 });
    // No stop was added under the axis.
    expect(store.get("symbol.line.width.zoom")).toHaveLength(2);
    fireEvent.pointerDown(svg, { clientX: at(stops, 12), clientY: 89, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: at(stops, 14.3), clientY: 89, pointerId: 1 });
    expect(map.jumpTo).toHaveBeenLastCalledWith({ zoom: expect.closeTo(14.3, 1) });
  });

  it("hovering shows where a press goes: a stop on the axis, the map's zoom under it", () => {
    setup({ zoom: stops }, "line.width", undefined, fakeMap());
    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: at(stops, 20), clientY: 66 });
    expect(svg.querySelector('[data-ghost="stop"]')).not.toBeNull();
    // Its zoom shows just above the axis, below the stop labels and their values.
    const ghostY = Number(svg.querySelector('[data-ghost="stop"] text')?.getAttribute("y"));
    const stopLabelY = Number(within(svg).getByText("z10").getAttribute("y"));
    expect(ghostY).toBeGreaterThan(stopLabelY + 40);
    fireEvent.pointerMove(svg, { clientX: at(stops, 20), clientY: 92 });
    expect(svg.querySelector('[data-ghost="stop"]')).toBeNull();
    expect(svg.querySelector('[data-ghost="zoom"]')?.textContent).toContain("20");
  });
});

describe("opening the zoom editor", () => {
  it("a row by zoom opens its editor with the stops", async () => {
    renderPanel(
      <PopoverProvider>
        <SymbolSection />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: {
            line: {
              width: {
                zoom: [
                  [10, 1],
                  [16, 6],
                ],
              },
            },
          },
        } as LayerStyle,
        data: { geometry: "line" },
        mapZoom: 12,
      }
    );
    await openGroup("style_editor.part_line");
    const row = screen.getByText("style_editor.width").parentElement as HTMLElement;
    expect(within(row).getByText("1 → 6 px")).toBeDefined();
    await userEvent.click(within(row).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.by_zoom_title")).toBeDefined();
    expect(screen.getByText("z16")).toBeDefined();
  });
});
