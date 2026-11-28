import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type SaveResult, StyleSaver, type StyleTransport } from "@/lib/style/save";

import { layerSwatchIcon } from "@/components/map/legend/StyleLegend";
import { StyleEditor, StyleHeader } from "@/components/map/panels/styleEditor/StyleEditor";
import { EMPTY_DATA } from "@/components/map/panels/styleEditor/context";

import { echoTransport, renderWithProviders } from "./renderPanel";

const DOC = { version: "1.0.0", kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;

function setup() {
  const saves: Array<{ document: LayerStyle; keepalive: boolean }> = [];
  const resolvers: Array<(r: SaveResult) => void> = [];
  const transport: StyleTransport = {
    save: (body, opts) => {
      saves.push({ document: body.document, keepalive: opts.keepalive });
      return new Promise((resolve) => resolvers.push(resolve));
    },
    load: async () => ({ document: DOC, revision: 9 }),
  };
  const saver = new StyleSaver({ transport, document: DOC, revision: 1 });
  let listeners = 0;
  const subscribe = saver.subscribe.bind(saver);
  saver.subscribe = (listener) => {
    listeners += 1;
    const off = subscribe(listener);
    return () => {
      listeners -= 1;
      return off();
    };
  };
  const store = new EditorStore({ saver });
  const answer = async (result: SaveResult) => {
    resolvers.shift()?.(result);
    await vi.advanceTimersByTimeAsync(0);
  };
  const ui = (
    <StyleEditor
      layer={{ id: "l1", name: "Districts", geometry: "polygon", kind: "vector" }}
      store={store}
      data={{ ...EMPTY_DATA, featureCount: 375 }}
      map={null}
      mapZoom={12}
    />
  );
  return { saver, store, saves, answer, ui, listeners: () => listeners };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("style editor shell", () => {
  it("shows the layer and its geometry with the feature count", () => {
    const { ui } = setup();
    renderWithProviders(ui);
    expect(screen.getByText("Districts")).toBeDefined();
    expect(screen.getByText("style_editor.geometry_polygon · style_editor.feature_count")).toBeDefined();
  });

  it("the header shows the layer's area swatch, which follows the style being edited", () => {
    const { ui, store } = setup();
    renderWithProviders(ui);
    const header = screen.getByTestId("layer-settings-header");
    const area = () => header.querySelector("svg rect:not([data-checker-under])");
    expect(area()?.getAttribute("fill")).toBe("#cccccc");
    act(() => store.set("symbol.fill.color", "#ff0000"));
    expect(area()?.getAttribute("fill")).toBe("#ff0000");
  });

  it("the header swatch of a color with its own transparency lies over the swatch checkerboard", () => {
    const { ui, store } = setup();
    renderWithProviders(ui);
    act(() => store.set("symbol.fill.color", "#ff000080"));
    expect(screen.getByTestId("layer-settings-header").querySelector("[data-checker-under]")).not.toBeNull();
  });

  it("the header shows a line layer's line swatch and a point layer's marker", () => {
    const line = { version: "1.0.0", kind: "vector", symbol: { line: { color: "#00ff00" } } } as LayerStyle;
    const lineStore = new EditorStore({
      saver: new StyleSaver({ transport: echoTransport(), document: line, revision: 1 }),
    });
    const { unmount } = renderWithProviders(
      <StyleHeader
        layer={{ id: "l2", name: "Roads", geometry: "line", kind: "vector" }}
        store={lineStore}
        zoom={12}
      />
    );
    const swatch = screen.getByTestId("layer-settings-header").querySelector("svg");
    expect(swatch?.querySelector("rect")).toBeNull();
    expect(swatch?.innerHTML).toContain("#00ff00");
    unmount();
    const point = {
      version: "1.0.0",
      kind: "vector",
      symbol: { marker: { color: "#0000ff" } },
    } as LayerStyle;
    const pointStore = new EditorStore({
      saver: new StyleSaver({ transport: echoTransport(), document: point, revision: 1 }),
    });
    renderWithProviders(
      <StyleHeader
        layer={{ id: "l3", name: "Stops", geometry: "point", kind: "vector" }}
        store={pointStore}
        zoom={12}
      />
    );
    const header = screen.getByTestId("layer-settings-header");
    expect(header.querySelector("rect")).toBeNull();
    // The marker as the layer list draws it.
    const listed = renderWithProviders(
      <>{layerSwatchIcon({ style: { document: point }, feature_layer_geometry_type: "point" })}</>
    );
    expect(header.firstElementChild?.innerHTML).toBe(listed.container.innerHTML);
    expect(listed.container.innerHTML).toContain("marker");
  });

  it("the header of a layer colored by classes shows their colors, not the base color the map never draws", () => {
    // Hexagons classified by ranges in five blues over the default orange.
    const blues = ["#eff3ff", "#bdd7e7", "#6baed6", "#3182bd", "#08519c"];
    const hexagons = {
      version: "1.0.0",
      kind: "vector",
      symbol: { fill: { color: "#f28e2b" } },
      classify: [
        {
          field: "accessibility",
          method: "quantile",
          classes: blues.map((color, i) => ({ from: i, to: i + 1, fill: { color } })),
        },
      ],
    } as LayerStyle;
    const store = new EditorStore({
      saver: new StyleSaver({ transport: echoTransport(), document: hexagons, revision: 1 }),
    });
    renderWithProviders(
      <StyleHeader
        layer={{ id: "l4", name: "Hexagons", geometry: "polygon", kind: "vector" }}
        store={store}
        zoom={12}
      />
    );
    const header = screen.getByTestId("layer-settings-header");
    expect(header.querySelector("[data-stripes]")?.getAttribute("data-stripes")).toBe(
      [blues[0], blues[1], blues[3], blues[4]].join(" ")
    );
    expect(header.innerHTML).not.toContain("#f28e2b");
  });

  it("the header shows the raster icon for a raster file and a map service, and the table icon for a table", () => {
    for (const kind of ["raster", "service"] as const) {
      const { unmount } = renderWithProviders(
        <StyleHeader layer={{ id: "r1", name: "Elevation", kind }} store={null} zoom={12} />
      );
      expect(screen.getByTestId("raster-layer-icon")).toBeDefined();
      unmount();
    }
    renderWithProviders(
      <StyleHeader layer={{ id: "t1", name: "Counts", kind: "vector" }} store={null} zoom={12} table noHint />
    );
    const icon = screen.getByTestId("layer-settings-header").querySelector("svg path");
    const table = renderWithProviders(<Icon iconName={ICON_NAME.TABLE} />).container.querySelector("path");
    expect(icon?.getAttribute("d")).toBe(table?.getAttribute("d"));
    expect(screen.queryByTestId("raster-layer-icon")).toBeNull();
  });

  it.each([
    ["saved", "style_editor.status_saved"],
    ["saving", "style_editor.status_saving"],
  ])("status %s", async (status, copy) => {
    const { ui, store } = setup();
    renderWithProviders(ui);
    if (status === "saving") act(() => store.set("symbol.fill.color", "#ff0000"));
    expect(screen.getByText(copy)).toBeDefined();
  });

  it("status retrying and offline", async () => {
    const { ui, store, answer } = setup();
    renderWithProviders(ui);
    act(() => store.set("symbol.fill.color", "#ff0000"));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() => answer({ ok: false, status: 0 }));
    expect(screen.getByText("style_editor.status_retrying")).toBeDefined();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() => answer({ ok: false, status: 0 }));
    expect(screen.getByText("style_editor.status_offline")).toBeDefined();
  });

  it.each([
    [403, undefined, "style_editor.stopped_forbidden"],
    [404, undefined, "style_editor.stopped_deleted"],
  ])("stopped on %s", async (status, code, copy) => {
    const { ui, store, answer } = setup();
    renderWithProviders(ui);
    act(() => store.set("symbol.fill.color", "#ff0000"));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() => answer({ ok: false, status, code }));
    expect(screen.getByText(copy)).toBeDefined();
  });

  it("a refused save says so with the server's issue", async () => {
    const { ui, store, saves, answer } = setup();
    renderWithProviders(ui);
    act(() => store.set("symbol.fill.color", "#ff0000"));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const message = "This document needs GOAT Style 1.1.0 (a newer GOAT); this server reads up to 1.0.0.";
    await act(() =>
      answer({
        ok: false,
        status: 422,
        code: "newer_version",
        issues: [{ level: "error", code: "newer_version", path: "/version", message }],
      })
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("style_editor.stopped_refused");
    expect(status.textContent).toContain(message);
    act(() => store.set("symbol.fill.color", "#00ff00"));
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(saves).toHaveLength(1);
  });

  it.each([
    [422, "document_too_large"],
    [413, "body_too_large"],
    [413, undefined],
  ])("a style too large to save says so (%s %s), and nothing is sent again", async (status, code) => {
    const { ui, store, saves, answer } = setup();
    renderWithProviders(ui);
    act(() => store.set("symbol.fill.color", "#ff0000"));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() => answer({ ok: false, status, code }));
    expect(screen.getByRole("status").textContent).toBe("style_editor.stopped_too_large");
    act(() => store.set("symbol.fill.color", "#00ff00"));
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(saves).toHaveLength(1);
  });

  it("base_too_old asks to apply or discard", async () => {
    const { ui, store, saver, answer } = setup();
    const resolve = vi.spyOn(saver, "resolveBaseTooOld");
    renderWithProviders(ui);
    act(() => store.set("symbol.fill.color", "#ff0000"));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() => answer({ ok: false, status: 409, code: "base_too_old" }));
    expect(screen.getByText("style_editor.stopped_base_too_old")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.apply_my_changes" }));
    expect(resolve).toHaveBeenCalledWith("apply");
  });

  it("undo in the feature editor does not undo a style; inside the panel it does, not in its inputs", () => {
    const { ui, store } = setup();
    const { container } = renderWithProviders(
      <>
        {ui}
        <input aria-label="other" />
      </>
    );
    const panel = container.querySelector("[data-style-panel]") as HTMLElement;
    act(() => store.set("symbol.fill.color", "#ff0000"));
    // Elsewhere on the page (the feature editor listens on window): not the style's undo.
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText("other"), { key: "z", ctrlKey: true });
    expect(store.get("symbol.fill.color")).toBe("#ff0000");
    fireEvent.keyDown(panel, { key: "z", ctrlKey: true });
    expect(store.get("symbol.fill.color")).toBe("#cccccc");
    fireEvent.keyDown(panel, { key: "z", ctrlKey: true, shiftKey: true });
    expect(store.get("symbol.fill.color")).toBe("#ff0000");
  });

  it("a damaged issue shows the notice", async () => {
    const { ui, store, answer } = setup();
    renderWithProviders(ui);
    act(() => store.set("symbol.fill.color", "#ff0000"));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() =>
      answer({
        ok: true,
        document: store.document,
        revision: 2,
        issues: [
          {
            level: "damaged",
            code: "field_missing",
            path: "/classify/0/field",
            message: "Field density is gone.",
          },
        ],
      })
    );
    expect(screen.getByText("style_editor.damaged_notice")).toBeDefined();
    expect(screen.getByText("Field density is gone.")).toBeDefined();
  });

  it("closing the panel leaves the store to its owner: the pending save still goes out, listeners are dropped", async () => {
    const { ui, store, saves, listeners } = setup();
    const { unmount } = renderWithProviders(ui);
    act(() => store.set("symbol.fill.color", "#ff0000"));
    const held = listeners();
    unmount();
    expect(listeners()).toBeLessThan(held);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(saves).toEqual([{ document: store.document, keepalive: false }]);
  });
});
