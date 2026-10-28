import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type SaveResult, StyleSaver, type StyleTransport } from "@/lib/style/save";

import { StyleEditor } from "@/components/map/panels/styleEditor/StyleEditor";
import { EMPTY_DATA } from "@/components/map/panels/styleEditor/context";

import { renderWithProviders } from "./renderPanel";

const DOC = { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;

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

  it("the header dot shows the main color", () => {
    const { ui, store } = setup();
    renderWithProviders(ui);
    const dot = screen.getByTestId("layer-dot");
    expect(dot.style.backgroundColor).toBe("rgb(204, 204, 204)");
    act(() => store.set("symbol.fill.color", "#ff0000"));
    expect(dot.style.backgroundColor).toBe("rgb(255, 0, 0)");
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
