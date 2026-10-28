import { describe, expect, it } from "vitest";

import { renderLayersOf } from "@/lib/style/render/viewLayers";
import { thumbnailLayers } from "@/lib/utils/map/thumbnail";

const FILL = { version: 1, kind: "vector", symbol: { fill: { color: "#ff0000" } } };

describe("thumbnails", () => {
  it("the thumbnail page renders the payload's styles", () => {
    // The payload goatlib injects: the map's layers top first, each with its active style document.
    const payload = [
      {
        id: 12,
        layer_id: "d12",
        type: "feature",
        feature_layer_geometry_type: "polygon",
        url: null,
        data_type: null,
        other_properties: {},
        visible: true,
        style: FILL,
      },
      // A row from before GOAT Style (layer properties, no style) draws nothing.
      {
        id: 13,
        layer_id: "d13",
        type: "feature",
        feature_layer_geometry_type: "point",
        properties: { color: [1, 2, 3] },
      },
      {
        id: 14,
        layer_id: "d14",
        type: "feature",
        feature_layer_geometry_type: "line",
        visible: false,
        style: FILL,
      },
    ];
    const layers = renderLayersOf(thumbnailLayers(payload));
    expect(layers.map((l) => [l.key, l.entry.visible])).toEqual([
      ["12", true],
      ["14", false],
    ]);
    expect(layers[0].style).toEqual(FILL);
    expect(layers[0].geometry).toBe("polygon");
    expect(thumbnailLayers(undefined)).toEqual([]);
  });

  it("a stored time slider step travels with the payload", () => {
    const timed = { ...FILL, time: { field: "year", step: 1 } };
    const [layer] = renderLayersOf(
      thumbnailLayers([
        {
          id: 15,
          layer_id: "d15",
          type: "feature",
          feature_layer_geometry_type: "polygon",
          style: timed,
          entry: { time: { value: 2016 } },
        },
      ])
    );
    expect(layer.entry.time).toEqual({ value: 2016 });
  });
});
