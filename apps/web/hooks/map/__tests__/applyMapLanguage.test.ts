import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { syncMapLayers } from "@/lib/style/render/mapLayers";

import { applyMapLanguage } from "@/hooks/map/MapHooks";

vi.mock("@/lib/transformers/map-image", () => ({ loadImage: vi.fn(async () => undefined) }));

/** A map whose layers keep their layout, so a rewrite can be read back. */
function fakeMap() {
  const layers = new Map<string, { id: string; type: string; layout?: Record<string, unknown> }>();
  layers.set("basemap-place", {
    id: "basemap-place",
    type: "symbol",
    layout: { "text-field": ["get", "name"] },
  });
  return {
    isStyleLoaded: () => true,
    getStyle: () => ({ layers: [...layers.values()] }),
    getLayer: (id: string) => layers.get(id),
    getLayoutProperty: (id: string, name: string) => layers.get(id)?.layout?.[name],
    setLayoutProperty: (id: string, name: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.layout = { ...layer.layout, [name]: value };
    },
    addLayer: (l: { id: string; type: string; layout?: Record<string, unknown> }) => layers.set(l.id, l),
    removeLayer: (id: string) => layers.delete(id),
    getSource: () => undefined,
    addSource: () => undefined,
    removeSource: () => undefined,
    moveLayer: () => undefined,
    setPaintProperty: () => undefined,
    setFilter: () => undefined,
    setLayerZoomRange: () => undefined,
    setGlobalStateProperty: () => undefined,
    setFeatureState: () => undefined,
    setMissingStyleImageResolver: () => undefined,
    hasImage: () => false,
  };
}

describe("applyMapLanguage", () => {
  it("the language rewrite leaves a label on name intact", () => {
    const map = fakeMap();
    syncMapLayers(
      map,
      null,
      [
        {
          key: "5",
          style: { version: 1, kind: "vector", symbol: { label: { text: "{name}" } } } as LayerStyle,
          geometry: "point",
          entry: {},
          source: { type: "tiles", id: "src-5", tiles: ["https://geoapi/5/{z}/{x}/{y}"] },
        },
      ],
      { locale: "de" }
    );
    const projectLabel = JSON.stringify(map.getLayoutProperty("5-label", "text-field"));
    applyMapLanguage(map as never, "de");
    expect(map.getLayoutProperty("basemap-place", "text-field")).toEqual([
      "coalesce",
      ["get", "name:de"],
      ["get", "name:en"],
      ["get", "name:latin"],
      ["get", "name"],
    ]);
    expect(JSON.stringify(map.getLayoutProperty("5-label", "text-field"))).toBe(projectLabel);
  });
});
