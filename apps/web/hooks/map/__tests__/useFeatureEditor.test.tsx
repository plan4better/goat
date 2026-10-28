/**
 * `useFeatureEditor` drives MapboxDraw from the feature-editor slice. Both
 * behaviours pinned here are about the arming of draw mode:
 *
 * - a table layer has no shape to draw, so entering draw mode *is* adding the
 *   blank row — exactly one, on the way in, not once per render where nothing
 *   is selected (Done and Cancel both clear the selection);
 * - `enteringDraw` is derived from the previous mode, so the ref holding it has
 *   to keep up with every mode change — undo/redo restores one behind the
 *   effect's early return.
 *
 * MapboxDraw and the map are stubs: what is asserted is the Redux state and
 * the calls made against the draw control, which is all this hook decides.
 */
import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook } from "@testing-library/react";
import React from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  commitFeature,
  featureEditorReducer,
  pushSnapshot,
  removePendingFeature,
  setMode,
  startEditing,
} from "@/lib/store/featureEditor/slice";
import { mapReducer } from "@/lib/store/map/slice";

import { useFeatureEditor } from "@/hooks/map/useFeatureEditor";

vi.mock("@mapbox/mapbox-gl-draw", () => ({
  default: {
    constants: {
      modes: { SIMPLE_SELECT: "simple_select", DIRECT_SELECT: "direct_select" },
      events: { CREATE: "draw.create", UPDATE: "draw.update" },
    },
  },
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ projectId: "project-1" }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("swr", () => ({ default: vi.fn(() => ({})), mutate: vi.fn() }));
vi.mock("@p4b/draw", () => ({ DrawHistory: { active: undefined } }));
vi.mock("@/lib/api/layers", () => ({
  COLLECTIONS_API_BASE_URL: "http://localhost:8100/collections",
  createFeaturesBulk: vi.fn(),
  deleteFeature: vi.fn(),
  getFeature: vi.fn(),
  getFeatures: vi.fn(),
  replaceFeature: vi.fn(),
}));
vi.mock("@/lib/api/projects", () => ({
  useProjectLayers: () => ({ layers: [], mutate: vi.fn() }),
}));
vi.mock("@/lib/api/map", () => ({ useProjectMap: () => ({ map: undefined }) }));
vi.mock("@/hooks/map/useBundleEditSave", () => ({
  useBundleEditSave: () => ({ bundleForLayer: undefined, saveBundleEdits: vi.fn() }),
}));
vi.mock("@/hooks/map/useEdgeSnapping", () => ({
  useEdgeSnapping: () => ({ snapDrawnLine: () => null, showIndicator: vi.fn() }),
}));
vi.mock("@/hooks/map/CommonHooks", () => ({
  default: () => ({ layerFields: [{ name: "class", type: "string" }], isLoading: false, isError: false }),
}));

const { drawControl } = vi.hoisted(() => ({
  drawControl: {
    features: new Map<string, GeoJSON.Feature>(),
    get: vi.fn(),
    add: vi.fn(),
    delete: vi.fn(),
    deleteAll: vi.fn(),
    changeMode: vi.fn(),
    getMode: vi.fn(() => "simple_select"),
    getAll: vi.fn(() => ({ type: "FeatureCollection", features: [] })),
    setFeatureProperty: vi.fn(),
  },
}));
vi.mock("@/lib/providers/DrawProvider", () => ({ useDraw: () => ({ drawControl }) }));

const makeStore = () => configureStore({ reducer: { featureEditor: featureEditorReducer, map: mapReducer } });

/** The map handlers the hook registers, keyed by event name. */
const mapHandlers = new Map<string, (event: unknown) => void>();
const fakeMap = {
  on: (event: string, handler: (event: unknown) => void) => mapHandlers.set(event, handler),
  off: (event: string) => mapHandlers.delete(event),
  getLayer: () => undefined,
  queryRenderedFeatures: () => [],
};
const mapRef = { current: { getMap: () => fakeMap } } as unknown as React.RefObject<never>;

const renderEditor = (store: ReturnType<typeof makeStore>) =>
  renderHook(() => useFeatureEditor(mapRef), {
    wrapper: ({ children }: { children: React.ReactNode }) => <Provider store={store}>{children}</Provider>,
  });

const pendingIds = (store: ReturnType<typeof makeStore>) =>
  Object.keys(store.getState().featureEditor.pendingFeatures);

beforeEach(() => {
  mapHandlers.clear();
  drawControl.get.mockReset();
  drawControl.delete.mockReset();
  drawControl.add.mockReset();
  drawControl.add.mockReturnValue(["draw-1"]);
});

describe("useFeatureEditor on a table layer", () => {
  const startTableEditing = () => {
    const store = makeStore();
    store.dispatch(startEditing({ layerId: "layer-1", geometryType: null }));
    return store;
  };

  it("adds exactly one blank row when draw mode is armed", () => {
    const store = startTableEditing();
    renderEditor(store);

    act(() => {
      store.dispatch(setMode("draw"));
    });

    expect(pendingIds(store)).toHaveLength(1);
    // Seeded with the layer's defaults, and selected so the panel edits it.
    expect(store.getState().featureEditor.activeFeatureId).toBe(pendingIds(store)[0]);
  });

  it("does not spawn another row when the finished row is committed", () => {
    const store = startTableEditing();
    renderEditor(store);
    act(() => {
      store.dispatch(setMode("draw"));
    });
    const [rowId] = pendingIds(store);

    // What "Done" does: commit, which clears the selection.
    act(() => {
      store.dispatch(commitFeature(rowId));
    });

    expect(pendingIds(store)).toEqual([rowId]);
  });

  it("does not spawn another row when the row is discarded", () => {
    const store = startTableEditing();
    renderEditor(store);
    act(() => {
      store.dispatch(setMode("draw"));
    });
    const [rowId] = pendingIds(store);

    // What "Cancel" does: drop the row, leaving nothing selected.
    act(() => {
      store.dispatch(removePendingFeature(rowId));
    });

    expect(pendingIds(store)).toEqual([]);
  });

  it("arms the next row when draw mode is entered again", () => {
    const store = startTableEditing();
    renderEditor(store);
    act(() => {
      store.dispatch(setMode("draw"));
    });
    const [first] = pendingIds(store);
    act(() => {
      store.dispatch(commitFeature(first));
      store.dispatch(setMode("select"));
    });

    act(() => {
      store.dispatch(setMode("draw"));
    });

    expect(pendingIds(store)).toHaveLength(2);
  });
});

describe("useFeatureEditor after an undo that changes the mode", () => {
  it("keeps the shape drawn once drawing has been restored", () => {
    const store = makeStore();
    store.dispatch(startEditing({ layerId: "layer-1", geometryType: "point" }));
    const { result } = renderEditor(store);

    // A snapshot taken while drawing, then a mode change away from it: undo
    // now restores "draw" behind the effect's undo/redo early return.
    act(() => {
      store.dispatch(setMode("draw"));
      store.dispatch(pushSnapshot({ drawFeatures: { type: "FeatureCollection", features: [] } }));
      store.dispatch(setMode("select"));
    });
    act(() => {
      result.current.handleUndo();
    });
    expect(store.getState().featureEditor.mode).toBe("draw");

    // The user draws: MapboxDraw reports the finished shape.
    const drawn: GeoJSON.Feature = {
      type: "Feature",
      id: "draw-1",
      geometry: { type: "Point", coordinates: [11.5, 48.1] },
      properties: {},
    };
    drawControl.get.mockReturnValue(drawn);
    act(() => {
      mapHandlers.get("draw.create")?.({ features: [drawn] });
    });

    // It is the user's work: it stays pending, and is not torn down as if
    // draw mode had only just been entered.
    expect(pendingIds(store)).toHaveLength(1);
    expect(drawControl.delete).not.toHaveBeenCalled();
  });
});
