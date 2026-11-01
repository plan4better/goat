import { describe, expect, it } from "vitest";

import { fakeMap } from "@/lib/assistant/__tests__/fakeMap";
import { applyMapView, mapViewport, projectMapContext } from "@/lib/assistant/mapView";

describe("map view helpers", () => {
  it("rounds and clamps the viewport to what the server accepts", () => {
    expect(
      mapViewport(
        fakeMap({
          lng: 13.4049871234,
          lat: 52.5200061234,
          zoom: 26.3,
          pitch: 95,
          bounds: [-200, -91, 200, 91],
        })
      )
    ).toEqual({
      center: [13.40499, 52.52001],
      zoom: 24,
      bearing: 0,
      pitch: 90,
      bbox: [-180, -90, 180, 90],
    });
  });

  it("wraps a center panned across world copies to its real longitude", () => {
    expect(mapViewport(fakeMap({ lng: 370, lat: 52, zoom: 3 })).center).toEqual([10, 52]);
    expect(mapViewport(fakeMap({ lng: -350, lat: 52, zoom: 3 })).center).toEqual([10, 52]);
  });

  it("drops the bbox of a view across the antimeridian and keeps the context valid", () => {
    const map = fakeMap({ lng: 180, lat: 0, zoom: 4, bounds: [170, -10, -170, 10] });
    const viewport = mapViewport(map);
    expect(viewport.bbox).toBeUndefined();
    expect(projectMapContext({ projectId: "p1", map, activeLayerId: null })).toEqual({
      surface: "project.map",
      project_id: "p1",
      viewport: { center: [-180, 0], zoom: 4, bearing: 0, pitch: 0 },
    });
  });

  it("names the selected layer only when one is selected", () => {
    const map = fakeMap({ lng: 13, lat: 52, zoom: 10 });
    expect(projectMapContext({ projectId: "p1", map, activeLayerId: 4 })).toMatchObject({
      surface: "project.map",
      project_id: "p1",
      selected_layer_project_id: 4,
    });
    expect(projectMapContext({ projectId: "p1", map: null, activeLayerId: -1 })).toEqual({
      surface: "project.map",
      project_id: "p1",
    });
  });

  it("flies to a camera or fits a bbox, and flies back on undo", () => {
    const map = fakeMap({ lng: 11.5, lat: 48.1, zoom: 9, bearing: 10, pitch: 20 });
    const undo = applyMapView(map, {
      project_id: "p1",
      camera: { center: [13.4, 52.5], zoom: 12, bearing: 0, pitch: 0 },
      bbox: null,
      layer_project_id: null,
    });
    expect(map.flyTo).toHaveBeenCalledWith({ center: [13.4, 52.5], zoom: 12, bearing: 0, pitch: 0 });
    undo();
    expect(map.flyTo).toHaveBeenLastCalledWith({ center: [11.5, 48.1], zoom: 9, bearing: 10, pitch: 20 });

    applyMapView(map, {
      project_id: "p1",
      camera: null,
      bbox: [13.1, 52.3, 13.8, 52.7],
      layer_project_id: 3,
    });
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [13.1, 52.3],
        [13.8, 52.7],
      ],
      { padding: 48, duration: 800 }
    );
  });
});
