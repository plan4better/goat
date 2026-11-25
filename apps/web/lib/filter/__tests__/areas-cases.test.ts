// goatlib's area cases (`goatlib.filter.areas`, how the assistant builds a filter's area): pieces added one by one with
// the area's CQL and notes the panel writes for them. Here the panel's own functions build each case from its inputs, so
// a change to how the panel writes an area fails this file instead of the assistant writing areas the panel does not.
// Only tests read the fixture: the web build never sees packages/python. A missing fixture fails the file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type FilterArea,
  type PolygonCoords,
  areaCql,
  areaNotes,
  areaPolygons,
  geometryPolygons,
  pointCount,
  roundPolygons,
} from "@/lib/filter/area";
import { FILTER_LIMITS } from "@/lib/filter/generated/operators";
import { urlLength } from "@/lib/filter/limits";
import { readFilter } from "@/lib/filter/read";
import { simplifyToFit } from "@/lib/filter/simplify";
import { writeFilter } from "@/lib/filter/write";

import { viewPieceOf, withFeature, withPiece } from "@/components/map/panels/filter/area/pieces";

const FIXTURE = resolve(
  __dirname,
  "../../../../../packages/python/goatlib/tests/unit/filter/fixtures/filter_areas.json"
);

type InPiece =
  | {
      kind: "features";
      source: string;
      features: Array<{ id: string; name?: string; geometry: unknown }>;
    }
  | { kind: "view"; bounds: [number, number, number, number] };

interface AreaCase {
  name: string;
  pieces: InPiece[];
  outside: boolean;
  expected: { cql: unknown; notes: unknown };
  simplified?: Array<{ points: number; kept: number; shift: number }>;
}

const cases: AreaCase[] = JSON.parse(readFileSync(FIXTURE, "utf8"));

/** What one filter's area may hold, as the filter panel checks a new outline (`useFilterAreaHost` in
 * FilterPanel.tsx): the points limit, and the length of the filter a map request takes, measured switched on. */
const fits = (area: FilterArea) =>
  pointCount(areaPolygons(area)) <= FILTER_LIMITS.points &&
  urlLength(writeFilter({ match: "all", rows: [], area: { ...area, enabled: true } }, {}).cql) <=
    FILTER_LIMITS.length;

/** The case's pieces added as the panel's lists add them (`add` in AreaTools.tsx, the person agreeing to every
 * simplified outline), and what was simplified on the way. */
function build(c: AreaCase) {
  let area: FilterArea | undefined;
  const simplified: NonNullable<AreaCase["simplified"]> = [];
  const add = (polygons: PolygonCoords[], compose: (p: PolygonCoords[]) => FilterArea) => {
    const fitting = (p: PolygonCoords[]) => fits(compose(p));
    if (fitting(polygons)) {
      area = compose(polygons);
      return;
    }
    const outline = simplifyToFit(polygons, fitting);
    if (!outline) throw new Error(`${c.name}: an outline does not fit even simplified`);
    simplified.push({
      points: pointCount(polygons),
      kept: pointCount(outline.polygons),
      shift: outline.shift,
    });
    area = compose(outline.polygons);
  };
  for (const piece of c.pieces) {
    if (piece.kind === "view") {
      add(viewPieceOf(piece.bounds).polygons, (polygons) => withPiece(area, { kind: "view", polygons }));
      continue;
    }
    for (const feature of piece.features) {
      const outline = geometryPolygons(feature.geometry);
      if (!outline) throw new Error(`${c.name}: ${feature.id} has no outline`);
      add(roundPolygons(outline), (polygons) =>
        withFeature(area, piece.source, { id: feature.id, name: feature.name, n: polygons.length }, polygons)
      );
    }
  }
  if (!area) throw new Error(`${c.name}: no area`);
  return { area: c.outside ? { ...area, op: "outside" as const } : area, simplified };
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("filter_areas.json", () => {
  it("holds cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.name, c] as const))("builds case %s as the shared fixture says", (_, c) => {
    const { area, simplified } = build(c);
    expect(json({ cql: areaCql(area), notes: areaNotes(area) })).toEqual(c.expected);
    expect(simplified).toEqual(c.simplified ?? []);
  });

  it.each(cases.map((c) => [c.name, c] as const))("reads the area of case %s as its pieces", (_, c) => {
    const { area } = build(c);
    const model = readFilter({ op: "and", args: [c.expected.cql] }, { v: 1, area: c.expected.notes }, {});
    expect(model.rows).toEqual([]);
    expect(model.area?.op).toBe(c.outside ? "outside" : "inside");
    expect(model.area?.enabled).toBe(true);
    expect(json(model.area?.pieces)).toEqual(json(area.pieces));
  });
});
