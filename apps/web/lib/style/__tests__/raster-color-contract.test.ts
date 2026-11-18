import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type LegendEntry, type LegendSection, buildLegend } from "@/lib/style/legend";

import { rampColorAt } from "@/components/map/legend/rampGradient";

// The web side of the raster color contract (geoapi's side: apps/geoapi/tests/test_raster_color_contract.py). Each
// case of the shared fixture holds a style, the token the compiler makes of it and sample cells with the color geoapi
// paints them. Here: the compiler puts exactly that token in the tile URL, and the legend shows each sample in its
// color. geoapi's test paints the same samples from the same token.
//
// After an intended change of a coloring, refresh the tokens with
//   UPDATE_RASTER_TOKENS=1 pnpm exec vitest run lib/style/__tests__/raster-color-contract.test.ts
// which writes the compiled tokens into the fixture; geoapi's test then checks the new tokens' pixels.

interface Sample {
  /** What the style reads at the cell (the band, or the formula's result); null where only the cells say it. */
  value: number | null;
  /** The color geoapi paints the cell; null: transparent. */
  color: string | null;
  /** The cell is no data (the file's or the style's): the legend shows nothing for it. */
  no_data?: boolean;
  /** What the legend shows wrong for this sample today: the check expects the difference, and fails once it is gone. */
  legend_known?: string;
}

interface Case {
  id: string;
  style: Record<string, unknown>;
  token: string;
  /** false: the style has no legend (an image). */
  legend?: false;
  samples: Sample[];
}

const FIXTURE = resolve(
  __dirname,
  "../../../../../packages/python/goatlib/tests/unit/style/fixtures/raster_color_cases.json"
);
const CASES = JSON.parse(readFileSync(FIXTURE, "utf8")) as Case[];
// A local switch for the command above, not a build input: turbo has no need to know it.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const UPDATE = process.env.UPDATE_RASTER_TOKENS === "1";

const SOURCE: CompileInput["source"] = {
  type: "raster",
  id: "s",
  tiles: "https://geo/collections/d1/raster/tiles/{z}/{x}/{y}.webp",
  dem: "https://geo/collections/d1/raster/dem/{z}/{x}/{y}.webp",
  version: "1",
};

/** The largest difference per channel (0 to 255) a sample's color may have. */
const TOLERANCE = 2;

const compile = (style: Record<string, unknown>) =>
  compileLayer({ id: "r", style: style as unknown as LayerStyle, source: SOURCE });

/** The token in a compiled layer's tile URL. */
function tokenOf(out: ReturnType<typeof compile>): string | null {
  const tiles = (out.sources.s as { tiles?: string[] } | undefined)?.tiles;
  if (!tiles) return null;
  return new URL(tiles[0].replace("{z}/{x}/{y}", "0/0/0")).searchParams.get("style");
}

/** The compiled tokens, by case, written into the fixture with UPDATE_RASTER_TOKENS=1. */
const compiled = new Map<string, string>();

/** The fixture's text with each case's token replaced by the compiled one; the rest stays as written. */
function withTokens(text: string): string {
  let out = text;
  for (const [id, token] of compiled) {
    const at = out.indexOf(`"id": ${JSON.stringify(id)}`);
    const key = out.indexOf('"token": "', at);
    const end = out.indexOf('"', key + '"token": "'.length);
    if (at < 0 || key < 0) throw new Error(`No token for ${id} in the fixture`);
    out = `${out.slice(0, key)}"token": ${JSON.stringify(token)}${out.slice(end + 1)}`;
  }
  return out;
}

/** A token's coloring, or the token itself where it is not one. */
function decode(token: string): unknown {
  try {
    return JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
  } catch {
    return token;
  }
}

const rgb = (hex: string): number[] => {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= TOLERANCE);

const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

const covers = (entry: LegendEntry, value: number) =>
  entry.values
    ? entry.values.includes(value)
    : entry.range !== undefined &&
      (entry.range.from === undefined || value >= entry.range.from) &&
      (entry.range.to === undefined || value < entry.range.to);

/** The categories a style names, hidden ones included: the values its Other color does not paint. */
function categoryValues(style: Record<string, unknown>): Set<unknown> {
  const render = style.render as { classes?: unknown } | undefined;
  const classes = Array.isArray(render?.classes) ? (render.classes as Array<{ value?: unknown }>) : [];
  return new Set(classes.map((c) => c.value));
}

/** The entries that list `value`: its class, else the Other entry, which stands for every value no class names. */
function holding(entries: LegendEntry[], value: number, named: Set<unknown>): LegendEntry[] {
  const listed = entries.filter((e) => covers(e, value));
  return listed.length || named.has(value) ? listed : entries.filter((e) => e.extra === "other");
}

/** What is wrong with the legend for a sample, or null. */
function legendProblem(sections: LegendSection[], sample: Sample, named: Set<unknown>): string | null {
  const { value, color } = sample;
  if (value === null) return "the sample has no value to look up";
  for (const section of sections) {
    if (section.kind === "ramp") {
      const inside = value >= section.domain[0] && value <= section.domain[1];
      if (color === null) return inside ? `the ramp shows ${value}, which the map leaves transparent` : null;
      const shown = rgb(rampColorAt(section, value));
      return near(shown, rgb(color)) ? null : `the ramp shows ${hex(shown)} at ${value}, the map ${color}`;
    }
    if (section.kind === "entries") {
      const found = holding(section.entries, value, named);
      if (color === null)
        return found.length ? `entries ${found.map((e) => e.id)} list ${value}, which the map hides` : null;
      if (found.length !== 1) return `${found.length} entries list ${value}, the map paints it ${color}`;
      const swatch = found[0].swatch.fill?.color;
      return typeof swatch === "string" && near(rgb(swatch), rgb(color))
        ? null
        : `the entry for ${value} is ${String(swatch)}, the map ${color}`;
    }
  }
  return `no legend section shows ${value}`;
}

describe("raster color contract (with geoapi's test_raster_color_contract.py)", () => {
  afterAll(() => {
    if (UPDATE) writeFileSync(FIXTURE, withTokens(readFileSync(FIXTURE, "utf8")));
  });

  it("covers ramps, stops, classes, categories, formulas, band choice, no data and opacity", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(10);
  });

  describe.each(CASES)("$id", (c) => {
    it("compiles to the token geoapi colors with", () => {
      const out = compile(c.style);
      expect(out.unsupported).toEqual([]);
      const token = tokenOf(out);
      expect(token).not.toBeNull();
      compiled.set(c.id, token as string);
      if (UPDATE) return;
      const refresh = `compiled token ${token} (UPDATE_RASTER_TOKENS=1 writes it into the fixture)`;
      // The decoded coloring first, for a readable difference; then the exact string geoapi receives.
      expect(decode(token as string), refresh).toEqual(decode(c.token));
      expect(token, refresh).toBe(c.token);
    });

    if (c.style.opacity !== undefined)
      it("leaves opacity to the browser: the token carries none, the layer's paint does", () => {
        const { opacity, ...opaque } = c.style;
        expect(tokenOf(compile(opaque))).toBe(tokenOf(compile(c.style)));
        const layer = compile(c.style).layers.find((l) => l.type === "raster") as {
          paint: Record<string, unknown>;
        };
        expect(layer.paint["raster-opacity"]).toBe(opacity);
      });

    it("has a legend that shows each sample in the color geoapi paints it", () => {
      const legend = buildLegend(c.style, { zoom: 10 });
      if (c.legend === false) {
        expect(legend).toBeNull();
        return;
      }
      expect(legend).not.toBeNull();
      const sections = legend?.sections ?? [];
      // Rasters have no No data entry: no-data cells are transparent.
      const entries = sections.flatMap((s) => (s.kind === "entries" ? s.entries : []));
      expect(entries.filter((e) => e.extra === "no_data")).toEqual([]);
      const wrong: string[] = [];
      const fixed: string[] = [];
      for (const sample of c.samples) {
        if (sample.no_data) continue;
        const problem = legendProblem(sections, sample, categoryValues(c.style));
        if (sample.legend_known) {
          if (problem === null) fixed.push(`${sample.value}: ${sample.legend_known}`);
        } else if (problem !== null) wrong.push(problem);
      }
      expect(wrong).toEqual([]);
      // A known difference that is gone: remove its legend_known from the fixture.
      expect(fixed).toEqual([]);
    });
  });
});
