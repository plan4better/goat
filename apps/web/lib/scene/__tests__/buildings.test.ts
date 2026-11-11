import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import { BASEMAPS } from "@/lib/constants/basemaps";
import {
  buildingsLayer,
  buildingsPlan,
  buildingsSetting,
  ownPaint,
  withBuildings,
} from "@/lib/scene/buildings";
import { basemapAnchors } from "@/lib/style/render/mapLayers";

import type { Basemap } from "@/types/map/common";

import { maplibreErrors } from "../../style/__tests__/maplibre";
import bkg from "./fixtures/bkg-grayscale.json";
import orders from "./fixtures/layer-orders.json";
import liberty from "./fixtures/liberty.json";
import positron from "./fixtures/positron.json";

const builtin = (value: string) => BASEMAPS.find((b) => b.value === value)!;
const style = (json: unknown) => json as StyleSpecification;
const OVERLAY = "https://tiles.example/planet";

const raster: Basemap = {
  source: "custom",
  value: "r1",
  id: "6b0c4c4e-6f43-4c43-a3a3-7f0c1a2b3c4d",
  name: "Aerial",
  type: "raster",
  url: "https://tiles.example/{z}/{x}/{y}.png",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

describe("3D buildings per basemap", () => {
  it("the built-in basemaps say how they get buildings", () => {
    expect(builtin("streets").buildings).toBe("own");
    expect(builtin("light").buildings).toEqual({ source: "openmaptiles" });
    expect(builtin("dark").buildings).toEqual({ source: "openmaptiles" });
    for (const value of ["basemap_wld_col", "basemap_de_gry", "basemap_de_top", "basemap_de_landuse"])
      expect(builtin(value).buildings).toBe("own");
  });

  it("liberty draws its own extrusions", () => {
    expect(buildingsPlan(builtin("streets"), style(liberty), OVERLAY)).toEqual({
      kind: "own",
      layers: ["building-3d"],
    });
  });

  it("the basemap's own extrusions only: not a project layer's, not GOAT's building layer", () => {
    const loaded = style(liberty);
    const withOthers = {
      ...loaded,
      layers: [
        ...loaded.layers,
        { id: "project-layer-12-extrude", type: "fill-extrusion", source: "p12" },
        { id: "goat-buildings", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building" },
      ],
    } as StyleSpecification;
    const isProjectLayer = (id: string) => id.startsWith("project-layer-");
    expect(buildingsPlan(builtin("streets"), withOthers, OVERLAY, isProjectLayer)).toEqual({
      kind: "own",
      layers: ["building-3d"],
    });
  });

  it("BKG basemaps draw their own, hidden by default, over flat footprints that go where they show", () => {
    // The flat fills of the extruded source layer fade out from the extrusions' zoom 16; the hidden underground
    // garages and the swimming pools (another source layer) keep theirs.
    const hidden = ["step", ["zoom"], 1, 16, 0];
    expect(buildingsPlan(builtin("basemap_de_gry"), style(bkg), OVERLAY)).toEqual({
      kind: "own",
      layers: ["Gebaeude3D_nicht_oeffentlich", "Gebaeude3D_oeffentlich", "Gebaeude3D_Treibhaus"],
      footprints: [
        { id: "Gebaeude2D_nicht_oeffentlich", opacity: hidden },
        { id: "Gebaeude2D_Treibhaus", opacity: hidden },
        { id: "Gebaeude2D_oeffentlich", opacity: hidden },
      ],
    });
  });

  it("positron gets GOAT's extrusion on its own source, in its building colour, over its footprints", () => {
    expect(buildingsPlan(builtin("light"), style(positron), OVERLAY)).toEqual({
      kind: "source",
      source: "openmaptiles",
      color: "rgb(234, 234, 229)",
      footprints: [{ id: "building", opacity: ["step", ["zoom"], 1, 14, 0] }],
    });
  });

  it("only the fills of the extruded source layer on its source are footprints, on every built-in basemap", () => {
    const ids = (value: string, layers: unknown[]) => {
      const loaded = {
        version: 8,
        sources: { openmaptiles: { type: "vector" } },
        layers,
      } as StyleSpecification;
      const plan = buildingsPlan(builtin(value), loaded, OVERLAY);
      return "footprints" in plan ? plan.footprints?.map((f) => f.id) : undefined;
    };
    expect(ids("light", orders.positron)).toEqual(["building"]);
    expect(ids("dark", orders.dark)).toEqual(["building"]);
    // The overlay is a tileset of its own: no basemap layer draws its buildings.
    expect(
      ids("light", [{ id: "building", type: "fill", source: "planet", "source-layer": "building" }])
    ).toBe(undefined);
  });

  it("footprints fade where the extrusion shows, keeping their own opacity elsewhere", () => {
    const fill = (paint: Record<string, unknown>, zooms: { minzoom?: number; maxzoom?: number } = {}) => ({
      id: "flat",
      type: "fill",
      source: "s",
      "source-layer": "building",
      ...zooms,
      paint,
    });
    const extrusion = {
      id: "tall",
      type: "fill-extrusion",
      source: "s",
      "source-layer": "building",
      minzoom: 15,
    };
    const footprint = (layer: object, extruded: object = extrusion) => {
      const loaded = { version: 8, sources: { s: { type: "vector" } }, layers: [layer, extruded] };
      const plan = buildingsPlan(builtin("streets"), loaded as StyleSpecification, OVERLAY);
      return "footprints" in plan ? plan.footprints?.[0]?.opacity : undefined;
    };
    const byClass = ["match", ["get", "class"], "shed", 0.5, 1];
    expect(footprint(fill({}))).toEqual(["step", ["zoom"], 1, 15, 0]);
    expect(footprint(fill({ "fill-opacity": 0.4 }))).toEqual(["step", ["zoom"], 0.4, 15, 0]);
    expect(footprint(fill({ "fill-opacity": byClass }))).toEqual(["step", ["zoom"], byClass, 15, 0]);
    // Back where the extrusion ends before the fill does.
    expect(footprint(fill({ "fill-opacity": 0.4 }), { ...extrusion, maxzoom: 18 })).toEqual([
      "step",
      ["zoom"],
      0.4,
      15,
      0,
      18,
      0.4,
    ]);
    // A fill that ends where the extrusion starts (Liberty's) stays as it is.
    expect(footprint(fill({}, { maxzoom: 15 }))).toBeUndefined();
    // An opacity by zoom cannot go inside another zoom step (MapLibre takes zoom only at the top): zero where the
    // extrusion covers the fill's whole range, else the fill keeps it.
    const byZoom = ["interpolate", ["linear"], ["zoom"], 12, 0.2, 18, 1];
    expect(
      maplibreErrors([fill({ "fill-opacity": ["step", ["zoom"], byZoom, 15, 0] })], {
        s: { type: "vector", url: OVERLAY },
      })
    ).not.toEqual([]);
    expect(footprint(fill({ "fill-opacity": byZoom }, { minzoom: 15 }))).toBe(0);
    expect(footprint(fill({ "fill-opacity": byZoom }))).toBeUndefined();
    expect(footprint(fill({ "fill-opacity": { stops: [[12, 0.3]] } }))).toBeUndefined();
    // Every value it sets validates.
    for (const opacity of [["step", ["zoom"], byClass, 15, 0, 18, byClass], 0])
      expect(
        maplibreErrors([fill({ "fill-opacity": opacity })], { s: { type: "vector", url: OVERLAY } })
      ).toEqual([]);
  });

  it("reads the basemap's own paint where the scene set it, so a footprint is not wrapped twice", () => {
    const loaded = style(positron);
    const first = buildingsPlan(builtin("light"), loaded, OVERLAY);
    const set = {
      ...loaded,
      layers: loaded.layers.map((l) =>
        l.id === "building"
          ? { ...l, paint: { ...l.paint, "fill-opacity": ["step", ["zoom"], 1, 14, 0] } }
          : l
      ),
    } as StyleSpecification;
    const recorded = new Map([["building", { "fill-opacity": undefined }]]);
    expect(buildingsPlan(builtin("light"), ownPaint(set, recorded), OVERLAY)).toEqual(first);
    expect(ownPaint(loaded, undefined)).toBe(loaded);
  });

  it("a declared source the style lacks falls back to the overlay", () => {
    const empty = style({ version: 8, sources: {}, layers: [] });
    expect(buildingsPlan(builtin("light"), empty, OVERLAY)).toEqual({ kind: "overlay", url: OVERLAY });
  });

  it("raster basemaps take the overlay when one is set, else none", () => {
    expect(buildingsPlan(raster, undefined, OVERLAY)).toEqual({ kind: "overlay", url: OVERLAY });
    expect(buildingsPlan(raster, undefined, "")).toEqual({ kind: "none" });
    expect(buildingsPlan(raster, undefined)).toEqual({ kind: "none" });
  });

  it("GOAT's building layer and the labels anchor are the start of the trailing label block", () => {
    // Positron draws its roads and boundaries after the flat building fill; Dark and Liberty also put symbols
    // among them (water names, road arrows), which stay below the anchor.
    expect(basemapAnchors(orders.positron)).toMatchObject({
      labels: "waterway_line_label",
      buildings: "waterway_line_label",
    });
    expect(basemapAnchors(orders.dark)).toMatchObject({ labels: "place_other", buildings: "place_other" });
    expect(basemapAnchors(orders.liberty)).toMatchObject({
      labels: "waterway_line_label",
      buildings: "waterway_line_label",
    });
  });

  it("a ground layer among the labels stays in the label block (basemap.de's rock pattern)", () => {
    // An excerpt of basemap.de's order with the same anchors as the whole: the first road layer, the flat building
    // fills, the 3D buildings and labels with the rock fill `Symbol_ReliefF_Felsen` among them (157 layers into the
    // labels in the whole order). The anchors stay at the block's start, right above the basemap's own 3D buildings.
    expect(basemapAnchors(orders.bkg_gry)).toMatchObject({
      labels: "Name_Hoehenzahl",
      roads: "Verkehrsflaeche_Fussgaengerzone",
      buildings: "Gebaeude3D_nicht_oeffentlich",
    });
  });

  it("without ground layers the building layer goes before the first label; on a raster basemap, on top", () => {
    const labels = [
      { id: "a", type: "symbol" },
      { id: "b", type: "symbol" },
    ];
    expect(basemapAnchors(labels).buildings).toBe("a");
    const raster = [
      { id: "bg", type: "background" },
      { id: "imagery", type: "raster" },
    ];
    expect(basemapAnchors(raster).buildings).toBeUndefined();
  });

  it("the building layer validates", () => {
    const layer = buildingsLayer("openmaptiles", "#d6d6d6", 0.6);
    expect(layer).toMatchObject({
      id: "goat-buildings",
      type: "fill-extrusion",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14,
      paint: {
        "fill-extrusion-color": "#d6d6d6",
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 0],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.6,
      },
    });
    expect(
      maplibreErrors([layer], { openmaptiles: { type: "vector", url: "https://tiles.example/planet" } })
    ).toEqual([]);
  });

  it("reads buildings from true, false or the object, with the default opacity", () => {
    expect(buildingsSetting(undefined)).toEqual({ on: undefined, opacity: 0.6 });
    expect(buildingsSetting({ buildings: true })).toEqual({ on: true, opacity: 0.6 });
    expect(buildingsSetting({ buildings: false })).toEqual({ on: false, opacity: 0.6 });
    expect(buildingsSetting({ buildings: { opacity: 0.3 } })).toEqual({ on: undefined, opacity: 0.3 });
    expect(buildingsSetting({ buildings: { on: false, opacity: 0.3 } })).toEqual({ on: false, opacity: 0.3 });
  });

  it("writes buildings as a boolean while it holds only on/off, keeping the opacity across a switch", () => {
    expect(withBuildings(undefined, { on: false })).toBe(false);
    expect(withBuildings({ buildings: true }, { on: false })).toBe(false);
    expect(withBuildings(undefined, { opacity: 0.4 })).toEqual({ opacity: 0.4 });
    expect(withBuildings({ buildings: true }, { opacity: 0.4 })).toEqual({ on: true, opacity: 0.4 });
    expect(withBuildings({ buildings: { opacity: 0.4 } }, { on: false })).toEqual({
      on: false,
      opacity: 0.4,
    });
    expect(withBuildings({ buildings: { on: true, opacity: 0.4 } }, { opacity: 0.5 })).toEqual({
      on: true,
      opacity: 0.5,
    });
  });
});
