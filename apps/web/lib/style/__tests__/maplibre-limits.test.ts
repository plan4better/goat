// The MapLibre limits GOAT Style takes over (goatlib's style/data/maplibre_limits.json) against the installed style
// spec: a MapLibre upgrade that changes one of them fails here, naming the GOAT setting, the MapLibre property and what
// changed. New MapLibre features reach GOAT deliberately, through goatlib's models, the editor and the compiler.
import { latest } from "@maplibre/maplibre-gl-style-spec";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compileLayer, sourceKind } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import { SLIDERS } from "@/lib/style/editor/defaults";

import { fieldTypes, sampleDatasets, specExamples } from "./fixtures";

type Zoom = "blend" | "step" | null;

/** What MapLibre's spec allows for a set of properties: the tightest bounds, and for paint and layout properties
 * whether they take zoom expressions (interpolated or stepped) and data-driven ones (`feature`). */
interface Limits {
  min: number | null;
  max: number | null;
  zoom?: Zoom;
  feature?: boolean;
}

interface Setting {
  models?: string[];
  maplibre: string[];
  spec: Limits;
  /** `choice`: a name the compiler turns into the value; MapLibre's bounds apply to what the compiler writes. */
  goat?: Partial<Limits> & { attribute?: boolean; per_feature?: boolean; choice?: boolean };
  differs?: string;
}

const TABLE = resolve(
  __dirname,
  "../../../../../packages/python/goatlib/src/goatlib/style/data/maplibre_limits.json"
);
const settings = (): Record<string, Setting> => JSON.parse(readFileSync(TABLE, "utf8")).settings;

type SpecProperty = {
  minimum?: number;
  maximum?: number;
  expression?: { interpolated: boolean; parameters: string[] };
};

/** A property by its qualified name: `paint_fill.fill-opacity`, `layer.minzoom`, `$root.pitch`. */
function specProperty(qualified: string): SpecProperty | undefined {
  const dot = qualified.indexOf(".");
  const group = (latest as unknown as Record<string, Record<string, SpecProperty> | undefined>)[
    qualified.slice(0, dot)
  ];
  return group?.[qualified.slice(dot + 1)];
}

const ZOOM_RANK: Record<string, number> = { null: 0, step: 1, blend: 2 };

const zoomOf = (p: SpecProperty): Zoom =>
  !p.expression?.parameters.includes("zoom") ? null : p.expression.interpolated ? "blend" : "step";

/** The installed spec's limits over `properties`: the highest minimum, the lowest maximum, the most restricted value
 * forms. */
function installed(properties: string[]): Limits {
  const found = properties.map(specProperty).filter((p): p is SpecProperty => p !== undefined);
  const mins = found.map((p) => p.minimum).filter((n): n is number => n !== undefined);
  const maxes = found.map((p) => p.maximum).filter((n): n is number => n !== undefined);
  const out: Limits = {
    min: mins.length ? Math.max(...mins) : null,
    max: maxes.length ? Math.min(...maxes) : null,
  };
  const styled = found.filter((p) => p.expression);
  if (styled.length) {
    out.zoom = styled.map(zoomOf).reduce((a, b) => (ZOOM_RANK[String(a)] <= ZOOM_RANK[String(b)] ? a : b));
    out.feature = styled.every((p) => p.expression?.parameters.includes("feature"));
  }
  return out;
}

const ZOOM_WORDS: Record<string, string> = {
  null: "no zoom expressions",
  step: "zoom expressions that step",
  blend: "zoom expressions that interpolate",
};

/** What changed between the table's copy of the spec and the installed spec, in words. */
function changes(key: string, setting: Setting): string[] {
  const now = installed(setting.maplibre);
  const was = setting.spec;
  const where = `${key} (${setting.maplibre.join(", ")})`;
  const out: string[] = [];
  if (now.min !== was.min) out.push(`${where}: MapLibre's minimum is now ${now.min} (table: ${was.min})`);
  if (now.max !== was.max) out.push(`${where}: MapLibre's maximum is now ${now.max} (table: ${was.max})`);
  if (now.zoom !== was.zoom)
    out.push(
      `${where}: MapLibre now allows ${ZOOM_WORDS[String(now.zoom)]} (table: ${ZOOM_WORDS[String(was.zoom)]})`
    );
  if (now.feature !== was.feature)
    out.push(
      now.feature
        ? `${where}: MapLibre now allows data-driven values`
        : `${where}: MapLibre no longer allows data-driven values`
    );
  return out;
}

/** goatlib's values: its own where the table gives them, MapLibre's otherwise (goatlib.style.limits). */
function effective(setting: Setting) {
  const goat = setting.goat ?? {};
  const pick = <K extends keyof Limits>(k: K) => (k in goat ? goat[k] : setting.spec[k]) ?? null;
  return {
    choice: goat.choice ?? false,
    min: pick("min") as number | null,
    max: pick("max") as number | null,
    zoom: pick("zoom") as Zoom,
    attribute: goat.attribute ?? setting.spec.feature ?? false,
    perFeature: goat.per_feature ?? setting.spec.feature ?? false,
  };
}

/** Where goatlib allows more than MapLibre: a wider range or a value form MapLibre does not take. */
function beyond(key: string, setting: Setting): string[] {
  const spec = setting.spec;
  const goat = effective(setting);
  const out: string[] = [];
  if (!goat.choice && spec.min !== null && (goat.min === null || goat.min < spec.min))
    out.push(`${key}: goatlib's minimum ${goat.min} is below MapLibre's ${spec.min}`);
  if (!goat.choice && spec.max !== null && (goat.max === null || goat.max > spec.max))
    out.push(`${key}: goatlib's maximum ${goat.max} is above MapLibre's ${spec.max}`);
  if (spec.zoom !== undefined && ZOOM_RANK[String(goat.zoom)] > ZOOM_RANK[String(spec.zoom)])
    out.push(
      `${key}: goatlib allows ${ZOOM_WORDS[String(goat.zoom)]}, MapLibre ${ZOOM_WORDS[String(spec.zoom)]}`
    );
  if (spec.feature === false && goat.attribute)
    out.push(`${key}: goatlib maps attributes, MapLibre allows no data-driven values`);
  if (spec.feature === false && goat.perFeature)
    out.push(`${key}: classes and rules set it per feature, MapLibre allows no data-driven values`);
  return out;
}

const datasets = sampleDatasets();

function exampleSource(target: string, points: boolean): CompileInput["source"] {
  const dataset = datasets[target];
  if (dataset.source === "wms" || dataset.source === "xyz")
    return {
      type: "service",
      id: "s",
      service: dataset.source,
      tiles: "https://tiles.example/{z}/{x}/{y}.png",
    };
  if (dataset.kind === "raster")
    return {
      type: "raster",
      id: "s",
      tiles: "https://geo/{z}/{x}/{y}.webp",
      dem: "https://geo/dem/{z}/{x}/{y}.webp",
    };
  if (points) return { type: "points", id: "s", data: "https://geoapi.example/items" };
  return { type: "tiles", id: "s", tiles: ["https://tiles.example/{z}/{x}/{y}"] };
}

const TILES: CompileInput["source"] = {
  type: "tiles",
  id: "s",
  tiles: ["https://tiles.example/{z}/{x}/{y}"],
};

/** Styles that reach the properties the spec's examples leave out. */
const PROBES: CompileInput[] = [
  {
    id: "polygon",
    geometry: "polygon",
    source: TILES,
    style: {
      version: 1,
      kind: "vector",
      opacity: 0.5,
      symbol: {
        fill: { color: "#ff0000" },
        outline: { width: 1 },
        label: { text: "x", allow_overlap: true },
      },
    },
  },
  {
    id: "icon",
    geometry: "point",
    source: TILES,
    style: { version: 1, kind: "vector", symbol: { marker: { shape: "icon" }, outline: { width: 1 } } },
  },
  {
    id: "circle",
    geometry: "point",
    source: TILES,
    style: { version: 1, kind: "vector", symbol: { marker: { shape: "circle", offset: [2, 2] } } },
  },
  {
    id: "heatmap",
    geometry: "point",
    source: TILES,
    style: { version: 1, kind: "vector", render: { type: "heatmap", intensity: 2, opacity: 0.5 } },
  },
  {
    id: "image",
    source: { type: "service", id: "s", service: "xyz", tiles: "https://tiles.example/{z}/{x}/{y}.png" },
    style: { version: 1, kind: "raster", brightness: -0.2, hue: 30 },
  },
];

/** Every paint and layout property the compiler writes for the spec's examples and the probes, as
 * `paint_<type>.<name>`. */
function emitted(): Set<string> {
  const out = new Set<string>();
  const inputs = specExamples()
    .filter((e) => e.target in datasets && !e.expect.length)
    .map((example): CompileInput => {
      const dataset = datasets[example.target];
      return {
        id: "1",
        style: example.doc,
        geometry: dataset.geometry,
        fields: fieldTypes(dataset),
        source: exampleSource(example.target, sourceKind(example.doc) === "points"),
        highlight: true,
      };
    });
  for (const input of [...inputs, ...PROBES]) {
    const compiled = compileLayer(input);
    for (const layer of compiled.layers as unknown as Array<Record<string, unknown>>) {
      for (const group of ["paint", "layout"])
        for (const name of Object.keys((layer[group] as object | undefined) ?? {}))
          out.add(`${group}_${layer.type}.${name}`);
    }
  }
  return out;
}

describe("MapLibre limits (goatlib maplibre_limits.json)", () => {
  it("name properties that exist in MapLibre's style spec", () => {
    const missing = Object.entries(settings()).flatMap(([key, s]) =>
      s.maplibre.filter((p) => !specProperty(p)).map((p) => `${key}: MapLibre has no ${p}`)
    );
    expect(missing).toEqual([]);
  });

  it("name paint and layout properties the compiler writes", () => {
    const seen = emitted();
    const unused = Object.entries(settings()).flatMap(([key, s]) =>
      s.maplibre
        .filter((p) => /^(paint|layout)_/.test(p) && !seen.has(p))
        .map((p) => `${key}: the compiler writes no ${p} for the spec's examples and the probes`)
    );
    expect(unused).toEqual([]);
  });

  it("are the installed style spec's", () => {
    const changed = Object.entries(settings()).flatMap(([key, s]) => changes(key, s));
    expect(changed).toEqual([]);
  });

  it("leave goatlib inside MapLibre's limits, except where the table says why not", () => {
    const problems = Object.entries(settings()).flatMap(([key, s]) => {
      const found = beyond(key, s);
      if (s.differs) return found.length ? [] : [`${key}: no longer differs from MapLibre; remove "differs"`];
      return found;
    });
    expect(problems).toEqual([]);
  });

  it("hold the editor's slider ranges", () => {
    const table = settings();
    const problems = Object.entries(SLIDERS).flatMap(([key, slider]) => {
      if (!table[key]) return [`${key}: a slider for a setting the table does not name`];
      const { min, max } = effective(table[key]);
      const out: string[] = [];
      if (min !== null && slider.min < min)
        out.push(`${key}: the slider starts at ${slider.min}, goatlib at ${min}`);
      if (max !== null && slider.max > max)
        out.push(`${key}: the slider ends at ${slider.max}, goatlib at ${max}`);
      return out;
    });
    expect(problems).toEqual([]);
    expect(Object.keys(SLIDERS)).toEqual(
      expect.arrayContaining(["terrain.direction", "terrain.exaggeration"])
    );
  });

  it("report a change in words", () => {
    const setting: Setting = {
      maplibre: ["paint_hillshade.hillshade-exaggeration"],
      spec: { min: 0, max: 1, zoom: null, feature: false },
    };
    expect(changes("terrain.exaggeration", setting)).toEqual([
      "terrain.exaggeration (paint_hillshade.hillshade-exaggeration): MapLibre now allows zoom expressions that interpolate (table: no zoom expressions)",
    ]);
  });
});
