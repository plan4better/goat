import { describe, expect, it } from "vitest";

import {
  findPopupLayer,
  layerHighlightsActiveFeature,
  shouldClosePopupForHiddenLayer,
  shouldHighlightActivePopupFeature,
} from "../popupVisibility";

// Minimal layer shapes matching how popupInfo.layerId is resolved:
// popupInfo.layerId is set to `layer_id ?? id` at dispatch time.
const projectLayer = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 42,
  layer_id: "dataset-abc",
  visible: true,
  ...over,
});

describe("findPopupLayer", () => {
  it("matches on layer_id (ProjectLayer)", () => {
    const layers = [projectLayer()];
    expect(findPopupLayer("dataset-abc", layers)).toBe(layers[0]);
  });

  it("matches on stringified id (plain Layer)", () => {
    const layers = [{ id: 7, visible: true }];
    expect(findPopupLayer("7", layers)).toBe(layers[0]);
  });

  it("returns undefined when no layer matches", () => {
    expect(findPopupLayer("missing", [projectLayer()])).toBeUndefined();
  });

  it("returns undefined for a missing layerId or layers list", () => {
    expect(findPopupLayer(undefined, [projectLayer()])).toBeUndefined();
    expect(findPopupLayer("dataset-abc", undefined)).toBeUndefined();
  });

  it("prefers the projectLayerId match when the same dataset backs multiple project layers", () => {
    // Same dataset added to a project twice (e.g. a "(Status)" variant and a
    // configured one). Matching by dataset id alone would return whichever
    // twin comes first in the array — the clicked layer's own id must win.
    const statusTwin = projectLayer({ id: 9 });
    const configuredTwin = projectLayer({ id: 23 });
    const layers = [statusTwin, configuredTwin];
    expect(findPopupLayer("dataset-abc", layers, "23")).toBe(configuredTwin);
    expect(findPopupLayer("dataset-abc", layers, "9")).toBe(statusTwin);
  });

  it("falls back to the dataset-id match when projectLayerId finds nothing", () => {
    const layers = [projectLayer()];
    expect(findPopupLayer("dataset-abc", layers, "999")).toBe(layers[0]);
  });
});

describe("shouldClosePopupForHiddenLayer", () => {
  it("closes when the owning layer is hidden", () => {
    const layers = [projectLayer({ visible: false })];
    expect(shouldClosePopupForHiddenLayer("dataset-abc", layers)).toBe(true);
  });

  it("keeps the popup while the owning layer is visible", () => {
    expect(shouldClosePopupForHiddenLayer("dataset-abc", [projectLayer()])).toBe(false);
  });

  it("treats a missing visible flag as drawn", () => {
    const layers = [projectLayer({ visible: undefined })];
    expect(shouldClosePopupForHiddenLayer("dataset-abc", layers)).toBe(false);
  });

  it("closes when the owning layer was removed from the project", () => {
    expect(shouldClosePopupForHiddenLayer("dataset-abc", [])).toBe(true);
  });

  it("does not close while layers are still unknown (undefined during load/refetch)", () => {
    expect(shouldClosePopupForHiddenLayer("dataset-abc", undefined)).toBe(false);
  });

  it("does not act when there is no owning layerId", () => {
    expect(shouldClosePopupForHiddenLayer(undefined, [projectLayer()])).toBe(false);
  });

  it("tracks the clicked twin's visibility when the dataset backs multiple project layers", () => {
    const hiddenTwin = projectLayer({ id: 9, visible: false });
    const visibleTwin = projectLayer({ id: 23 });
    const layers = [hiddenTwin, visibleTwin];
    // Popup opened on the visible twin: the hidden sibling must not close it.
    expect(shouldClosePopupForHiddenLayer("dataset-abc", layers, "23")).toBe(false);
    // Popup opened on the hidden twin: close even though a visible sibling exists.
    expect(shouldClosePopupForHiddenLayer("dataset-abc", layers, "9")).toBe(true);
  });
});

describe("shouldClosePopupForHiddenLayer on map layers", () => {
  it("closes when the map layer is not drawn (its own or a group's visibility)", () => {
    const hidden = { id: 42, layer_id: "dataset-abc", visible: false };
    expect(shouldClosePopupForHiddenLayer("dataset-abc", [hidden], "42")).toBe(true);
    expect(shouldClosePopupForHiddenLayer("dataset-abc", [{ ...hidden, visible: true }], "42")).toBe(false);
    expect(findPopupLayer("dataset-abc", [{ ...hidden, layer_id: null }], "42")?.id).toBe(42);
  });
});

describe("shouldHighlightActivePopupFeature", () => {
  it("shows the recolor highlight when a popup is active and highlight is on", () => {
    expect(shouldHighlightActivePopupFeature(true, true)).toBe(true);
  });

  it("suppresses the recolor highlight when a popup is active but highlight is off", () => {
    expect(shouldHighlightActivePopupFeature(true, false)).toBe(false);
  });

  it("treats an unset highlight flag as off, mirroring the pulse's visible prop", () => {
    expect(shouldHighlightActivePopupFeature(true, undefined)).toBe(false);
  });

  it("leaves non-popup highlights (click-to-filter, hover, table) untouched", () => {
    // No active popup config → the shared highlightedFeature is passed through
    // regardless of any popup toggle.
    expect(shouldHighlightActivePopupFeature(false, false)).toBe(true);
    expect(shouldHighlightActivePopupFeature(false, undefined)).toBe(true);
  });
});

describe("layerHighlightsActiveFeature", () => {
  it("highlights only when the popup is enabled AND highlight is on", () => {
    expect(layerHighlightsActiveFeature(true, true)).toBe(true);
  });

  it("does not highlight when the popup is disabled (no popup ⇒ no highlight)", () => {
    expect(layerHighlightsActiveFeature(false, true)).toBe(false);
    expect(layerHighlightsActiveFeature(false, false)).toBe(false);
    expect(layerHighlightsActiveFeature(undefined, true)).toBe(false);
  });

  it("does not highlight when the popup is enabled but highlight is off/unset", () => {
    expect(layerHighlightsActiveFeature(true, false)).toBe(false);
    expect(layerHighlightsActiveFeature(true, undefined)).toBe(false);
  });
});
