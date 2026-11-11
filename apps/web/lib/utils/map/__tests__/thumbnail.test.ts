import { describe, expect, it, vi } from "vitest";

import { renderLayersOf } from "@/lib/style/render/viewLayers";
import { parseThumbnailData, thumbnailLayers, thumbnailView } from "@/lib/utils/map/thumbnail";

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

const encode = (data: unknown) => btoa(JSON.stringify(data));
const VIEW = { latitude: 47.49, longitude: 11.09, zoom: 13, bearing: 30, pitch: 60 };

describe("the thumbnail payload in 3D (3D spec 10)", () => {
  it("a payload from before 3D (no scene, no mode) still parses and draws flat", () => {
    const data = parseThumbnailData(
      encode({ viewState: { ...VIEW, pitch: 0, bearing: 0 }, basemap: "light", layers: [] })
    );
    expect(data).not.toBeNull();
    expect(thumbnailView(data!, "project")).toEqual({
      mode: "2d",
      projection: "mercator",
      scene: undefined,
      maxPitch: 0,
    });
  });

  it("a project's 3D view carries its scene, and the map may tilt to 85", () => {
    const scene = { terrain: { exaggeration: 2 } };
    const data = parseThumbnailData(
      encode({
        viewState: { ...VIEW, pitch: 75, mode: "3d", projection: "globe" },
        basemap: "light",
        layers: [],
        scene,
      })
    );
    expect(thumbnailView(data!, "project")).toEqual({ mode: "3d", projection: "globe", scene, maxPitch: 85 });
  });

  it("a tilted view without a mode opens in 3D", () => {
    const data = parseThumbnailData(encode({ viewState: VIEW, basemap: "light", layers: [] }));
    expect(thumbnailView(data!, "project").mode).toBe("3d");
  });

  it("a layer thumbnail stays flat, whatever the payload says", () => {
    const data = parseThumbnailData(
      encode({ viewState: { ...VIEW, mode: "3d" }, basemap: "light", layers: [], scene: { buildings: true } })
    );
    expect(thumbnailView(data!, "layer")).toEqual({
      mode: "2d",
      projection: "mercator",
      scene: undefined,
      maxPitch: 0,
    });
  });

  it("refuses a payload without a view, a basemap or layers", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(parseThumbnailData(encode({ basemap: "light", layers: [] }))).toBeNull();
    expect(parseThumbnailData("not base64 json")).toBeNull();
    expect(parseThumbnailData(null)).toBeNull();
    error.mockRestore();
  });
});
