import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
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

/** GOAT's copy of the footprint `id`, as the plans hold it. */
const copyOf = (id: string) => expect.objectContaining({ id: `goat-footprint-${id}`, type: "fill" });

/** Whether a layer's `filter` keeps a feature with `properties`, through MapLibre's filter. */
function keeps(filter: unknown, properties: Record<string, unknown>): boolean {
  return featureFilter(filter as never, "layers[0].filter" as never).filter(
    { zoom: 16 } as never,
    { type: 3, properties } as never
  );
}

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
        { id: "Gebaeude2D_nicht_oeffentlich", opacity: hidden, copy: copyOf("Gebaeude2D_nicht_oeffentlich") },
        { id: "Gebaeude2D_Treibhaus", opacity: hidden, copy: copyOf("Gebaeude2D_Treibhaus") },
        { id: "Gebaeude2D_oeffentlich", opacity: hidden, copy: copyOf("Gebaeude2D_oeffentlich") },
      ],
      // Their tiles reach down to the footprints' (zoom 12), so a far tile of a tilted view that draws a footprint
      // also builds the building that replaces it; they show from their own zoom 16 on.
      reach: {
        Gebaeude3D_nicht_oeffentlich: { minzoom: 12, shows: 16 },
        Gebaeude3D_oeffentlich: { minzoom: 12, shows: 16 },
        Gebaeude3D_Treibhaus: { minzoom: 12, shows: 16 },
      },
    });
  });

  it("positron gets GOAT's extrusion on its own source, in its building colour, over its footprints", () => {
    expect(buildingsPlan(builtin("light"), style(positron), OVERLAY)).toEqual({
      kind: "source",
      source: "openmaptiles",
      color: "rgb(234, 234, 229)",
      footprints: [{ id: "building", opacity: ["step", ["zoom"], 1, 14, 0], copy: copyOf("building") }],
      reach: { minzoom: 12, shows: 14 },
    });
  });

  it("BKG footprints get a copy for the buildings without a height, as the basemap draws them, above the original", () => {
    // The live style also keeps the buildings below ground out of both flat fills (the fixture's excerpt does not).
    const below = { lage: "Unter der Erdoberfläche" };
    const live = {
      ...style(bkg),
      layers: style(bkg).layers.map((l) =>
        l.id === "Gebaeude2D_nicht_oeffentlich" || l.id === "Gebaeude2D_oeffentlich"
          ? { ...l, filter: ["all", (l as { filter: unknown }).filter, ["!in", "lage", below.lage]] }
          : l
      ),
    } as StyleSpecification;
    const plan = buildingsPlan(builtin("basemap_de_gry"), live, OVERLAY);
    const copies = Object.fromEntries(
      (plan.kind === "own" ? plan.footprints! : []).map((f) => [f.id, f.copy!])
    );
    const home = copies.Gebaeude2D_nicht_oeffentlich as { filter: unknown };
    const hall = copies.Gebaeude2D_oeffentlich as { filter: unknown };
    // A building without a height (missing, null or 0) keeps its flat shape; one with a height gets its volume.
    expect(keeps(home.filter, { klasse: "Wohngebäude" })).toBe(true);
    expect(keeps(home.filter, { klasse: "Wohngebäude", hoehe: null })).toBe(true);
    expect(keeps(home.filter, { klasse: "Wohngebäude", hoehe: 0 })).toBe(true);
    expect(keeps(home.filter, { klasse: "Wohngebäude", hoehe: 9 })).toBe(false);
    expect(keeps(hall.filter, { klasse: "Rathaus" })).toBe(true);
    expect(keeps(hall.filter, { klasse: "Rathaus", hoehe: 12 })).toBe(false);
    // Only what the original draws: not the garages, not the buildings below ground, not the other fill's classes.
    expect(keeps(home.filter, { klasse: "Tiefgarage" })).toBe(false);
    expect(keeps(home.filter, { klasse: "Wohngebäude", ...below })).toBe(false);
    expect(keeps(home.filter, { klasse: "Rathaus" })).toBe(false);
    expect(keeps(hall.filter, { klasse: "Rathaus", ...below })).toBe(false);
    // The original's source, zoom range and paint at the basemap's own values; shown only where it is hidden.
    const original = live.layers.find((l) => l.id === "Gebaeude2D_nicht_oeffentlich") as Record<
      string,
      unknown
    >;
    expect(home).toMatchObject({
      id: "goat-footprint-Gebaeude2D_nicht_oeffentlich",
      source: original.source,
      "source-layer": "Gebaeudeflaeche",
      minzoom: 12,
      maxzoom: 22,
      paint: { ...(original.paint as object), "fill-opacity": ["step", ["zoom"], 0, 16, 1] },
    });
    expect(home).not.toHaveProperty("layout");
    for (const copy of Object.values(copies))
      expect(maplibreErrors([copy], { smarttiles_de: { type: "vector", url: OVERLAY } })).toEqual([]);
  });

  it("positron's footprints keep the buildings without render_height flat (OpenMapTiles' tiles below zoom 14)", () => {
    const plan = buildingsPlan(builtin("light"), style(positron), OVERLAY);
    const copy = (plan.kind === "source" ? plan.footprints![0].copy! : undefined) as Record<string, unknown>;
    const original = style(positron).layers.find((l) => l.id === "building") as Record<string, unknown>;
    // Its own paint, the unset opacity as MapLibre's 1 where the original is hidden.
    expect(copy.paint).toEqual({
      ...(original.paint as object),
      "fill-opacity": ["step", ["zoom"], 0, 14, 1],
    });
    expect(copy.minzoom).toBe(original.minzoom);
    expect(keeps(copy.filter, {})).toBe(true);
    expect(keeps(copy.filter, { render_height: 0 })).toBe(true);
    expect(keeps(copy.filter, { render_height: 12 })).toBe(false);
    expect(maplibreErrors([copy], { openmaptiles: { type: "vector", url: OVERLAY } })).toEqual([]);
  });

  it("a copy keeps what the original draws and the extrusions give no volume, by their filters and heights", () => {
    const copy = (fill: Record<string, unknown>, ...extrusions: Array<Record<string, unknown>>) => {
      const loaded = {
        version: 8,
        sources: { s: { type: "vector" } },
        layers: [
          { id: "flat", type: "fill", source: "s", "source-layer": "building", minzoom: 12, ...fill },
          ...extrusions.map((e, i) => ({
            id: `tall${i}`,
            type: "fill-extrusion",
            source: "s",
            "source-layer": "building",
            minzoom: 15,
            ...e,
          })),
        ],
      };
      const plan = buildingsPlan(builtin("streets"), loaded as StyleSpecification, OVERLAY);
      return (plan.kind === "own" ? plan.footprints?.[0]?.copy : undefined) as
        | Record<string, unknown>
        | undefined;
    };
    const height = { paint: { "fill-extrusion-height": ["get", "h"] } };
    const kept = (
      fill: Record<string, unknown>,
      p: Record<string, unknown>,
      ...e: Array<Record<string, unknown>>
    ) => keeps(copy(fill, ...(e.length ? e : [height]))!.filter, p);
    // Legacy filters converted, expression filters as they are.
    expect(kept({}, {})).toBe(true);
    expect(kept({}, { h: 3 })).toBe(false);
    expect(kept({ filter: ["==", "k", "a"] }, { k: "a" })).toBe(true);
    expect(kept({ filter: ["==", "k", "a"] }, { k: "b" })).toBe(false);
    expect(kept({ filter: ["!=", "k", "a"] }, { k: "a" })).toBe(false);
    expect(kept({ filter: ["has", "k"] }, { k: 1 })).toBe(true);
    expect(kept({ filter: ["!has", "k"] }, { k: 1 })).toBe(false);
    expect(kept({ filter: ["in", "k", "a", "b", "a"] }, { k: "b" })).toBe(true);
    expect(kept({ filter: ["!in", "k", "a"] }, { k: "a" })).toBe(false);
    expect(kept({ filter: ["none", ["==", "k", "a"]] }, { k: "a" })).toBe(false);
    expect(kept({ filter: ["any", ["==", "k", "a"], ["==", "j", 1]] }, { j: 1 })).toBe(true);
    expect(kept({ filter: ["==", ["get", "k"], "a"] }, { k: "a" })).toBe(true);
    // A feature an extrusion does not draw keeps its flat shape, whatever its height.
    expect(kept({}, { h: 3, k: "b" }, { ...height, filter: ["==", "k", "a"] })).toBe(true);
    expect(kept({}, { h: 3, k: "a" }, { ...height, filter: ["==", "k", "a"] })).toBe(false);
    // Several extrusions: a volume from any of them.
    expect(kept({}, { g: 3 }, height, { paint: { "fill-extrusion-height": ["get", "g"] } })).toBe(false);
    // No height (MapLibre's 0) or 0: no volume, so the copy draws all the original does; a fixed height: no copy.
    expect(copy({}, {})).not.toHaveProperty("filter");
    expect(copy({ filter: ["==", "k", "a"] }, { paint: { "fill-extrusion-height": 0 } })!.filter).toEqual([
      "==",
      ["get", "k"],
      "a",
    ]);
    expect(copy({}, { paint: { "fill-extrusion-height": 10 } })).toBeUndefined();
    // A footprint filter it cannot read: no copy; an extrusion filter it cannot read: taken as drawing nothing.
    expect(copy({ filter: [">=", ["zoom"], 14] }, height)).toBeUndefined();
    expect(copy({ filter: ["==", "$type", "Polygon"] }, height)).toBeUndefined();
    expect(kept({}, { h: 3 }, { ...height, filter: ["==", "$type", "Polygon"] })).toBe(true);
    // An opacity by zoom hidden over the whole range: the copy keeps it as it is.
    const byZoom = ["interpolate", ["linear"], ["zoom"], 15, 0.2, 18, 1];
    expect(copy({ minzoom: 15, paint: { "fill-opacity": byZoom } }, height)!.paint).toEqual({
      "fill-opacity": byZoom,
    });
    // The copies validate.
    for (const fill of [{}, { filter: ["in", "k", "a", "b"] }, { filter: ["==", ["get", "k"], "a"] }])
      expect(maplibreErrors([copy(fill, height)!], { s: { type: "vector", url: OVERLAY } })).toEqual([]);
  });

  it("an extrusion reaches down only to the tiles of the footprints it hides, and only where they start lower", () => {
    const layers = (fillMinzoom: number | undefined, extra: object[] = []) => [
      {
        id: "flat",
        type: "fill",
        source: "s",
        "source-layer": "building",
        ...(fillMinzoom === undefined ? {} : { minzoom: fillMinzoom }),
      },
      {
        id: "tall",
        type: "fill-extrusion",
        source: "s",
        "source-layer": "building",
        minzoom: 15,
      },
      ...extra,
    ];
    const reach = (l: object[]) => {
      const plan = buildingsPlan(
        builtin("streets"),
        { version: 8, sources: { s: { type: "vector" } }, layers: l } as StyleSpecification,
        OVERLAY
      );
      return plan.kind === "own" ? plan.reach : undefined;
    };
    expect(reach(layers(13.5))).toEqual({ tall: { minzoom: 13, shows: 15 } });
    expect(reach(layers(undefined))).toEqual({ tall: { minzoom: 0, shows: 15 } });
    // Footprints that start with the extrusion, or none at all: its own zoom range stays.
    expect(reach(layers(15))).toBeUndefined();
    expect(reach(layers(16))).toBeUndefined();
    expect(reach(layers(13).slice(1))).toBeUndefined();
    // An extrusion over another source layer keeps its own.
    expect(
      reach(
        layers(13, [
          {
            id: "pool",
            type: "fill-extrusion",
            source: "s",
            "source-layer": "water",
            minzoom: 15,
          },
        ])
      )
    ).toEqual({ tall: { minzoom: 13, shows: 15 } });
    // Liberty's fill ends where its extrusion starts: nothing hidden, nothing lowered.
    expect(buildingsPlan(builtin("streets"), style(liberty), OVERLAY)).not.toHaveProperty("reach");
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

  it("reads the basemap's own zoom range where the scene lowered it, so the reach is not taken for its own", () => {
    const loaded = style(bkg);
    const first = buildingsPlan(builtin("basemap_de_gry"), loaded, OVERLAY);
    const ids = ["Gebaeude3D_nicht_oeffentlich", "Gebaeude3D_oeffentlich", "Gebaeude3D_Treibhaus"];
    const set = {
      ...loaded,
      layers: loaded.layers.map((l) => (ids.includes(l.id) ? { ...l, minzoom: 12 } : l)),
    } as StyleSpecification;
    const zooms = new Map(ids.map((id) => [id, { minzoom: 16 }]));
    expect(buildingsPlan(builtin("basemap_de_gry"), ownPaint(set, undefined, zooms), OVERLAY)).toEqual(first);
    // A layer without a minzoom of its own gets none back.
    const unset = ownPaint(set, undefined, new Map([[ids[0], { minzoom: undefined }]]))!;
    expect(unset.layers.find((l) => l.id === ids[0])).not.toHaveProperty("minzoom");
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

  it("the building layer reaching down to the footprints' tiles shows from its own zoom, and validates", () => {
    const layer = buildingsLayer("openmaptiles", "#d6d6d6", 0.6, "building", { minzoom: 12, shows: 14 });
    expect(layer).toMatchObject({
      minzoom: 12,
      paint: { "fill-extrusion-opacity": ["step", ["zoom"], 0, 14, 0.6] },
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
