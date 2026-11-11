import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import {
  FOG_FADE_ZOOMS,
  GLOBE_PROJECTION,
  GLOBE_TERRAIN_RISE,
  GLOBE_TERRAIN_STEPS,
  type SceneInputs,
  TERRAIN_MAXZOOM,
  buildingsAnchor,
  compileScene,
  fogGroundOnGlobe,
  terrainAt,
  terrainExaggerationAt,
} from "@/lib/scene/compile";
import { GLOBE_HANDOVER } from "@/lib/scene/visibility";

const DEM = "https://dem.example/{z}/{x}/{y}.webp";

const inputs = (extra: Partial<SceneInputs> = {}): SceneInputs => ({
  mode: "3d",
  projection: "mercator",
  tone: "light",
  terrainUrl: DEM,
  buildings: { kind: "source", source: "openmaptiles", color: "#eaeae5" },
  projectExtrudes: false,
  imagery: false,
  ...extra,
});

/** Every part of a compiled scene as one style, through MapLibre's validator. */
function errors(out: ReturnType<typeof compileScene>): string[] {
  const sources: Record<string, unknown> = {
    openmaptiles: { type: "vector", url: "https://tiles.example/planet" },
    ...out.sources,
  };
  const style = {
    version: 8,
    sources,
    layers: out.layers.map((l) => l.layer),
    projection: out.projection,
    ...(out.terrain ? { terrain: out.terrain } : {}),
    ...(out.sky ? { sky: out.sky } : {}),
    ...(out.light ? { light: out.light } : {}),
    state: Object.fromEntries(Object.entries(out.state ?? {}).map(([k, v]) => [k, { default: v }])),
  };
  return validateStyleMin(JSON.parse(JSON.stringify(style)) as never).map(
    (e: { message: string }) => e.message
  );
}

describe("compileScene", () => {
  it("(a) 2D mercator without a scene: nothing but the projection and the automatic state", () => {
    const out = compileScene(inputs({ mode: "2d" }));
    expect(out.projection).toEqual({ type: "mercator" });
    expect(out.terrain).toBeNull();
    expect(out.sky).toBeNull();
    expect(out.light).toBeNull();
    expect(out.sources).toEqual({});
    expect(out.layers).toEqual([]);
    expect(out.state).toEqual({
      sunAzimuth: null,
      sunAltitude: null,
      lightPosition: [1.15, 210, 30],
    });
    expect(errors(out)).toEqual([]);
  });

  it("(b) 3D with a terrain URL: exaggeration 1, both DEM sources, the hillshade before roads, the auto sky", () => {
    const out = compileScene(inputs());
    expect(out.terrain).toEqual({ source: "goat-terrain", exaggeration: 1 });
    expect(Object.keys(out.sources).sort()).toEqual(["goat-terrain", "goat-terrain-hillshade"]);
    expect(out.sources["goat-terrain"]).toMatchObject({
      type: "raster-dem",
      tiles: [DEM],
      encoding: "terrarium",
      tileSize: 512,
      maxzoom: TERRAIN_MAXZOOM,
    });
    expect(out.sources["goat-terrain-hillshade"]).toMatchObject({ maxzoom: TERRAIN_MAXZOOM });
    expect(String((out.sources["goat-terrain"] as { attribution: string }).attribution)).toContain(
      "Mapterhorn"
    );
    const hillshade = out.layers.find((l) => l.layer.id === "goat-terrain-hillshade")!;
    expect(hillshade.before).toBe("roads");
    expect(hillshade.layer).toMatchObject({
      type: "hillshade",
      source: "goat-terrain-hillshade",
      paint: {
        "hillshade-method": "igor",
        "hillshade-exaggeration": 0.5,
        "hillshade-illumination-anchor": "map",
        "hillshade-illumination-direction": ["coalesce", ["global-state", "sunAzimuth"], 315],
      },
    });
    expect(JSON.stringify(out.sky!["sky-color"])).toContain("#79B8EC");
    // The automatic glow is full; MapLibre fades its atmosphere with the globe's handover.
    expect(out.sky!["atmosphere-blend"]).toBe(1);
    // The automatic light stands with the camera: on the globe MapLibre puts the atmosphere's sun behind the planet,
    // so the face is evenly lit with a soft rim instead of a white wash.
    // Zoomed out the sun stands straight behind the planet (polar 0: an even rim); from the city zooms on, volumes
    // get MapLibre's default angle.
    expect(out.light).toMatchObject({
      anchor: "viewport",
      position: [
        "interpolate",
        ["linear"],
        ["zoom"],
        5,
        ["literal", [1.15, 210, 0]],
        10,
        ["literal", [1.15, 210, 30]],
      ],
    });
    expect(errors(out)).toEqual([]);
  });

  it("a custom light stands on the map, at the direction it comes from", () => {
    const out = compileScene(inputs({ scene: { light: { direction: 225, altitude: 30 } } }));
    expect(out.light).toMatchObject({ anchor: "map", position: ["global-state", "lightPosition"] });
    expect(out.state.lightPosition).toEqual([1.15, 225, 60]);
    expect(errors(out)).toEqual([]);
  });

  it("(c) terrain off: no terrain, sources or hillshade", () => {
    const out = compileScene(inputs({ scene: { terrain: false } }));
    expect(out.terrain).toBeNull();
    expect(Object.keys(out.sources)).toEqual([]);
    expect(out.layers.map((l) => l.layer.id)).toEqual(["goat-buildings"]);
  });

  it("no terrain URL: no terrain", () => {
    expect(compileScene(inputs({ terrainUrl: "" })).terrain).toBeNull();
  });

  it("(d) the project's own extrusions turn the basemap's buildings off unless the scene says otherwise", () => {
    const off = compileScene(inputs({ projectExtrudes: true, scene: { terrain: false } }));
    expect(off.layers).toEqual([]);
    const on = compileScene(inputs({ projectExtrudes: true, scene: { terrain: false, buildings: true } }));
    expect(on.layers.map((l) => [l.layer.id, l.before])).toEqual([["goat-buildings", "buildings"]]);
    expect(on.layers[0].layer).toMatchObject({
      source: "openmaptiles",
      paint: { "fill-extrusion-color": "#eaeae5" },
    });
  });

  it("buildings by plan: own layers shown or flat, the overlay with its source, the tone's colour", () => {
    const own = { kind: "own" as const, layers: ["building-3d"] };
    expect(compileScene(inputs({ buildings: own }))).toMatchObject({ show: ["building-3d"] });
    // Off is flat, not gone: the basemap's own visibility, held at height 0, as 2D draws them.
    const off = compileScene(inputs({ buildings: own, scene: { buildings: false } }));
    expect(off.show).toEqual([]);
    expect(off.paint).toEqual({ "building-3d": { "fill-extrusion-height": 0, "fill-extrusion-base": 0 } });
    expect(off).not.toHaveProperty("hide");
    expect(compileScene(inputs({ buildings: own, mode: "2d" }))).toMatchObject({ show: [], paint: {} });
    const overlay = compileScene(
      inputs({
        tone: "dark",
        buildings: { kind: "overlay", url: "https://tiles.example/planet" },
        scene: { terrain: false },
      })
    );
    expect(overlay.sources["goat-buildings-src"]).toEqual({
      type: "vector",
      url: "https://tiles.example/planet",
    });
    expect(overlay.layers[0].layer).toMatchObject({
      source: "goat-buildings-src",
      paint: { "fill-extrusion-color": "#3a4250" },
    });
    expect(errors(overlay)).toEqual([]);
  });

  it("GOAT's buildings keep the basemap's building colour on light, lightened on dark", () => {
    const color = (tone: "light" | "dark", value: string) =>
      compileScene(
        inputs({ tone, buildings: { kind: "source", source: "openmaptiles", color: value } })
      ).layers.find((l) => l.layer.id === "goat-buildings")!.layer.paint as Record<string, unknown>;
    expect(color("light", "rgb(234, 234, 229)")["fill-extrusion-color"]).toBe("rgb(234, 234, 229)");
    // Dark's flat building fill is nearly its background (rgb(12,12,12)): a fifth of the way to white.
    expect(color("dark", "rgb(10,10,10)")["fill-extrusion-color"]).toBe("#3b3b3b");
  });

  it("buildings' opacity: on the basemap's own building layers and GOAT's building layer, only while they show", () => {
    const own = { kind: "own" as const, layers: ["building-3d"] };
    const opacity = (value: number) => ({ "building-3d": { "fill-extrusion-opacity": value } });
    expect(compileScene(inputs({ buildings: own })).paint).toEqual(opacity(0.6));
    expect(compileScene(inputs({ buildings: own, scene: { buildings: { opacity: 0.3 } } })).paint).toEqual(
      opacity(0.3)
    );
    // Flat buildings keep the basemap's own opacity, as in 2D.
    expect(
      compileScene(inputs({ buildings: own, scene: { buildings: { on: false, opacity: 0.3 } } })).paint
    ).toEqual({ "building-3d": { "fill-extrusion-height": 0, "fill-extrusion-base": 0 } });
    expect(compileScene(inputs({ buildings: own, mode: "2d" })).paint).toEqual({});
    const overlay = compileScene(
      inputs({
        buildings: { kind: "overlay", url: "https://tiles.example/planet" },
        scene: { terrain: false, buildings: { opacity: 0.25 } },
      })
    );
    expect(overlay.layers[0].layer).toMatchObject({ paint: { "fill-extrusion-opacity": 0.25 } });
    expect(overlay.paint).toEqual({});
    const source = compileScene(inputs({ scene: { terrain: false } }));
    expect(source.layers[0].layer).toMatchObject({ paint: { "fill-extrusion-opacity": 0.6 } });
  });

  it("the basemap's flat footprints fade under shown 3D buildings only", () => {
    const hidden = ["step", ["zoom"], 1, 16, 0];
    const footprints = [{ id: "flat", opacity: hidden }];
    const own = { kind: "own" as const, layers: ["tall"], footprints };
    expect(compileScene(inputs({ buildings: own })).paint).toEqual({
      tall: { "fill-extrusion-opacity": 0.6 },
      flat: { "fill-opacity": hidden },
    });
    // Off (flat extrusions) and 2D: the footprints as the basemap draws them.
    expect(compileScene(inputs({ buildings: own, scene: { buildings: false } })).paint).not.toHaveProperty(
      "flat"
    );
    expect(compileScene(inputs({ buildings: own, mode: "2d" })).paint).toEqual({});
    const source = { kind: "source" as const, source: "openmaptiles", footprints };
    expect(compileScene(inputs({ buildings: source })).paint).toEqual({ flat: { "fill-opacity": hidden } });
    expect(compileScene(inputs({ buildings: source, projectExtrudes: true })).paint).toEqual({});
  });

  it("3D buildings reaching down to their footprints' tiles show from their own zoom, only while they show", () => {
    const hidden = ["step", ["zoom"], 1, 16, 0];
    const own = {
      kind: "own" as const,
      layers: ["tall"],
      footprints: [{ id: "flat", opacity: hidden }],
      reach: { tall: { minzoom: 12, shows: 16 } },
    };
    const on = compileScene(inputs({ buildings: own }));
    expect(on.zoom).toEqual({ tall: { minzoom: 12 } });
    expect(on.paint.tall).toEqual({ "fill-extrusion-opacity": ["step", ["zoom"], 0, 16, 0.6] });
    // Off and 2D: the basemap's own zoom range and opacity.
    expect(compileScene(inputs({ buildings: own, scene: { buildings: false } })).zoom).toEqual({});
    expect(compileScene(inputs({ buildings: own, mode: "2d" })).zoom).toEqual({});
    // Without a reach the opacity stays a number.
    expect(compileScene(inputs({ buildings: { ...own, reach: undefined } })).zoom).toEqual({});

    const source = {
      kind: "source" as const,
      source: "openmaptiles",
      color: "#eaeae5",
      footprints: [{ id: "building", opacity: ["step", ["zoom"], 1, 14, 0] }],
      reach: { minzoom: 12, shows: 14 },
    };
    const goat = compileScene(inputs({ buildings: source }));
    expect(goat.layers.find((l) => l.layer.id === "goat-buildings")!.layer).toMatchObject({
      minzoom: 12,
      paint: { "fill-extrusion-opacity": ["step", ["zoom"], 0, 14, 0.6] },
    });
    expect(goat.zoom).toEqual({});
    expect(errors(goat)).toEqual([]);
  });

  it("GOAT's copies of the hidden footprints go right above them, only while 3D buildings show", () => {
    const copy = {
      id: "goat-footprint-flat",
      type: "fill" as const,
      source: "openmaptiles",
      "source-layer": "building",
      filter: ["!", [">", ["to-number", ["get", "h"], 0], 0]] as never,
      paint: { "fill-opacity": ["step", ["zoom"], 0, 16, 1] as never },
    };
    const own = {
      kind: "own" as const,
      layers: ["tall"],
      footprints: [{ id: "flat", opacity: ["step", ["zoom"], 1, 16, 0], copy }],
    };
    const on = compileScene(inputs({ buildings: own, scene: { terrain: false } }));
    expect(on.layers).toEqual([{ layer: copy, before: { above: "flat" } }]);
    expect(errors(on)).toEqual([]);
    expect(
      compileScene(inputs({ buildings: own, scene: { terrain: false, buildings: false } })).layers
    ).toEqual([]);
    expect(compileScene(inputs({ buildings: own, mode: "2d" })).layers).toEqual([]);
    const source = { kind: "source" as const, source: "openmaptiles", footprints: own.footprints };
    expect(
      compileScene(inputs({ buildings: source, scene: { terrain: false } })).layers.map((l) => l.layer.id)
    ).toEqual(["goat-footprint-flat", "goat-buildings"]);
  });

  it("the terrain hillshade over a dark basemap: soft highlights and shadows, so the basemap still reads", () => {
    const dark = compileScene(inputs({ tone: "dark" }));
    const paint = (
      dark.layers.find((l) => l.layer.id === "goat-terrain-hillshade")!.layer as { paint: object }
    ).paint;
    expect(paint).toMatchObject({
      "hillshade-highlight-color": "rgba(255, 255, 255, 0.25)",
      "hillshade-shadow-color": "rgba(0, 0, 0, 0.7)",
    });
    expect(errors(dark)).toEqual([]);
  });

  it("(e) the dark tone's sky", () => {
    const out = compileScene(inputs({ tone: "dark" }));
    expect(out.sky!["sky-color"]).toBe("#1D4877");
    expect(out.sky!["horizon-color"]).toBe("#3B6A99");
  });

  it("a custom sky and light: values by zoom stay zoom curves", () => {
    const out = compileScene(
      inputs({
        scene: {
          sky: {
            color: "#112233",
            horizon_blend: {
              zoom: [
                [10, 0.2],
                [16, 0.8],
              ],
            },
          },
          light: {
            direction: 200,
            altitude: 30,
            intensity: {
              zoom: [
                [10, 0.3],
                [16, 0.6],
              ],
            },
          },
        },
      })
    );
    expect(out.sky!["sky-color"]).toBe("#112233");
    expect(out.sky!["sky-horizon-blend"]).toEqual(["interpolate", ["linear"], ["zoom"], 10, 0.2, 16, 0.8]);
    const intensity = out.light!.intensity as unknown[];
    expect(intensity).toEqual(["interpolate", ["linear"], ["zoom"], 10, 0.3, 16, 0.6]);
    expect(errors(out)).toEqual([]);
  });

  it("(f) a light from a direction: the hillshades and the light read it, polar from straight above", () => {
    const out = compileScene(inputs({ scene: { light: { direction: 271.9, altitude: 28.6 } } }));
    expect(out.state).toEqual({ sunAzimuth: 271.9, sunAltitude: 28.6, lightPosition: [1.15, 271.9, 61.4] });
    const low = compileScene(inputs({ scene: { light: { direction: 90, altitude: -10 } } }));
    expect(low.state.lightPosition).toEqual([1.15, 90, 100]);
    expect(errors(low)).toEqual([]);
  });

  it("a custom light on the zoomed-out globe stands with the camera, the sun behind the planet toward the light", () => {
    const scene = { light: { direction: 225, altitude: 30 } };
    const out = compileScene(inputs({ mode: "2d", projection: "globe", scene, zoomedOut: true }));
    // The atmosphere's sun sits behind the planet, a third of the light's angle from straight behind, on the side the
    // light comes from (MapLibre's viewport azimuth 180 - direction): a brighter rim there, the face stays clear.
    expect(out.light).toMatchObject({ anchor: "viewport", position: [1.15, 315, 20] });
    expect(out.state).toEqual({ sunAzimuth: 225, sunAltitude: 30, lightPosition: [1.15, 225, 60] });
    expect(errors(out)).toEqual([]);
    const near = compileScene(inputs({ mode: "2d", projection: "globe", scene, zoomedOut: false }));
    expect(near.light).toMatchObject({ anchor: "map", position: ["global-state", "lightPosition"] });
    // Mercator has no atmosphere: the light stays on the map whatever the zoom.
    const flat = compileScene(inputs({ projection: "mercator", scene, zoomedOut: true }));
    expect(flat.light).toMatchObject({ anchor: "map" });
  });

  it("(g) Globe in 2D: sky and light, no terrain or buildings", () => {
    const out = compileScene(inputs({ mode: "2d", projection: "globe" }));
    expect(out.projection).toEqual(GLOBE_PROJECTION);
    expect(out.sky).not.toBeNull();
    expect(out.light).not.toBeNull();
    expect(out.terrain).toBeNull();
    expect(out.layers).toEqual([]);
    expect(errors(out)).toEqual([]);
  });

  it("(k) imagery keeps terrain without the automatic hillshade, on one DEM source", () => {
    const out = compileScene(inputs({ imagery: true }));
    expect(out.terrain).not.toBeNull();
    expect(Object.keys(out.sources)).toEqual(["goat-terrain"]);
    expect(out.layers.map((l) => l.layer.id)).not.toContain("goat-terrain-hillshade");
  });

  it("(h) every combination validates as one style", () => {
    for (const mode of ["2d", "3d"] as const)
      for (const projection of ["mercator", "globe"] as const)
        for (const tone of ["light", "dark"] as const)
          expect(
            errors(compileScene(inputs({ mode, projection, tone, scene: { terrain: { exaggeration: 2 } } })))
          ).toEqual([]);
  });
});

describe("terrain by zoom", () => {
  const { from, until } = GLOBE_HANDOVER;
  const full = until + GLOBE_TERRAIN_RISE;

  it("the globe hands over to mercator over GLOBE_HANDOVER", () => {
    expect(GLOBE_PROJECTION.type).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      from,
      "vertical-perspective",
      until,
      "mercator",
    ]);
    expect(errors(compileScene(inputs({ projection: "globe" })))).toEqual([]);
  });

  it.each([
    [from - 3, null],
    [from, null],
    [until - 0.1, null],
    [until, 0],
    [until + GLOBE_TERRAIN_RISE / 2, 1],
    [until + GLOBE_TERRAIN_RISE * 0.94, 1.8],
    [full, 2],
    [full + 2, 2],
  ])("on the globe at zoom %s: %s", (zoom, expected) => {
    expect(terrainExaggerationAt(zoom, "globe", 2)).toBe(expected);
  });

  it("rises in ten steps once the globe has handed over", () => {
    const values = new Set<number | null>();
    for (let zoom = until; zoom < full; zoom += 0.001) values.add(terrainExaggerationAt(zoom, "globe", 1.5));
    expect(values.size).toBe(GLOBE_TERRAIN_STEPS + 1);
    expect(terrainExaggerationAt(until + 0.04 * GLOBE_TERRAIN_RISE, "globe", 1.5)).toBe(0);
    expect(terrainExaggerationAt(until + 0.26 * GLOBE_TERRAIN_RISE, "globe", 1.5)).toBe(0.45);
  });

  it.each([from - 3, until - 0.1, until + 0.5, full + 2])("with Globe off at zoom %s: full", (zoom) => {
    expect(terrainExaggerationAt(zoom, "mercator", 1.5)).toBe(1.5);
  });

  it("gives the compiled terrain at a zoom, or none", () => {
    const { terrain } = compileScene(
      inputs({ projection: "globe", scene: { terrain: { exaggeration: 3 } } })
    );
    expect(terrainAt(terrain, from - 1, "globe")).toBeNull();
    expect(terrainAt(terrain, until + GLOBE_TERRAIN_RISE / 2, "globe")).toEqual({
      source: "goat-terrain",
      exaggeration: 1.5,
    });
    expect(terrainAt(terrain, from - 1, "mercator")).toEqual(terrain);
    expect(terrainAt(null, full + 2, "globe")).toBeNull();
  });
});

describe("fog", () => {
  const { until } = GLOBE_HANDOVER;
  const fogOf = (out: ReturnType<typeof compileScene>) => {
    const sky = out.sky as Record<string, unknown>;
    return { ground: sky["fog-ground-blend"], horizon: sky["horizon-fog-blend"], color: sky["fog-color"] };
  };

  it("draws none on Auto, on the globe and with Globe off", () => {
    for (const projection of ["mercator", "globe"] as const) {
      const out = compileScene(inputs({ projection }));
      expect(fogOf(out)).toMatchObject({ ground: 1, horizon: 0 });
      expect(errors(out)).toEqual([]);
    }
  });

  it("a set fog with Globe off is exactly its own", () => {
    const out = compileScene(inputs({ scene: { fog: { ground_blend: 0.6, horizon_blend: 0.5 } } }));
    expect(fogOf(out)).toMatchObject({ ground: 0.6, horizon: 0.5 });
  });

  it("a set fog on the globe comes in after the handover", () => {
    const out = compileScene(inputs({ projection: "globe", scene: { fog: { ground_blend: 0.6 } } }));
    expect(fogOf(out).ground).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      until,
      1,
      until + FOG_FADE_ZOOMS,
      0.6,
    ]);
    expect(errors(out)).toEqual([]);
  });

  it("a fog by zoom on the globe: sampled through the fade, its own stops after it", () => {
    const form = {
      zoom: [
        [8, 0.2],
        [12, 0.6],
        [16, 0.9],
      ] as [number, number][],
    };
    const faded = fogGroundOnGlobe(form);
    const at = new Map(faded.zoom);
    expect(at.get(until)).toBe(1);
    // Halfway through the fade: halfway between none (1) and the fog's own value there.
    const mid = until + FOG_FADE_ZOOMS / 2;
    const own = 0.2 + ((mid - 8) / 4) * 0.4;
    expect(at.get(mid)).toBeCloseTo(1 + (own - 1) * 0.5, 6);
    expect(at.get(until + FOG_FADE_ZOOMS)).toBeCloseTo(0.2 + ((until + FOG_FADE_ZOOMS - 8) / 4) * 0.4, 6);
    expect(at.get(12)).toBeCloseTo(0.6, 6);
    expect(at.get(16)).toBeCloseTo(0.9, 6);
    expect(faded.zoom.every(([, v]) => v >= 0 && v <= 1)).toBe(true);
    const out = compileScene(inputs({ projection: "globe", scene: { fog: { ground_blend: form } } }));
    expect(errors(out)).toEqual([]);
  });

  it("takes the horizon and fog colours from the basemap's ground", () => {
    const out = compileScene(
      inputs({ atmosphere: { horizon: "#aabbcc", fog: "#112233" }, scene: { fog: { ground_blend: 0.6 } } })
    );
    const sky = out.sky as Record<string, unknown>;
    expect(sky["horizon-color"]).toBe("#aabbcc");
    expect(sky["fog-color"]).toBe("#112233");
    expect(sky["sky-color"]).toBe("#79B8EC");
  });
});

describe("buildingsAnchor", () => {
  const own = { kind: "own" as const, layers: ["building-3d", "building-3d-roof"] };

  it("is the lowest building layer the scene shows: GOAT's own, or the basemap's first", () => {
    expect(buildingsAnchor(compileScene(inputs()))).toBe("goat-buildings");
    expect(buildingsAnchor(compileScene(inputs({ buildings: own })))).toBe("building-3d");
  });

  it("is undefined without buildings: in 2D, switched off, or on a basemap without any", () => {
    expect(buildingsAnchor(null)).toBeUndefined();
    expect(buildingsAnchor(compileScene(inputs({ mode: "2d", buildings: own })))).toBeUndefined();
    expect(
      buildingsAnchor(compileScene(inputs({ scene: { buildings: false }, buildings: own })))
    ).toBeUndefined();
    expect(buildingsAnchor(compileScene(inputs({ buildings: { kind: "none" } })))).toBeUndefined();
  });
});
