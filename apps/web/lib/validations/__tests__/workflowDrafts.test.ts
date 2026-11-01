import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SpatialIntersectionGeomType } from "@/lib/validations/filter";
import { isDrawableWorkflowConfig } from "@/lib/validations/workflow";

import {
  spatialGeometryType,
  spatialIntersectionOptions,
} from "@/components/map/panels/filter/spatialIntersection";

type Region = { name: string; as_box: boolean };
type FilterRow = { type?: string; value?: unknown };
type DraftCase = { note: string; regions: Region[]; config: unknown };
type ConfigNodes = { nodes?: { data?: { type?: string; filter?: { expressions?: FilterRow[] } } }[] };

// The assistant's own tests build these configs from drafts; the editor must draw every one.
const FIXTURE = path.join(__dirname, "../../../../assistant/tests/fixtures/workflow_drafts.json");
const { cases } = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: DraftCase[] };

const t = (key: string) => key;

/** The spatial rows of every dataset step's filter: the areas the assistant set. */
const areaRows = (config: unknown): FilterRow[] =>
  ((config as ConfigNodes).nodes ?? [])
    .filter((node) => node.data?.type === "dataset")
    .flatMap((node) => node.data?.filter?.expressions ?? [])
    .filter((row) => row.type === "spatial");

const areaCases = cases.filter((c) => areaRows(c.config).length > 0);

describe("workflows the assistant builds", () => {
  it("has cases to check", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.note, c.config] as const))("draws %s", (_note, config) => {
    expect(isDrawableWorkflowConfig(config)).toBe(true);
  });
});

describe("areas the assistant sets on a dataset", () => {
  it("has areas to check, one of them a region stored as its bounding box", () => {
    expect(areaCases.length).toBeGreaterThan(0);
    expect(areaCases.some((c) => c.regions.some((region) => region.as_box))).toBe(true);
  });

  it.each(areaCases.map((c) => [c.note, c] as const))("shows the area of %s as a boundary", (_note, c) => {
    for (const row of areaRows(c.config)) {
      const current = spatialGeometryType(row.value);
      expect(current).toBe(SpatialIntersectionGeomType.BOUNDARY);
      expect(spatialIntersectionOptions(t, current).map((option) => option.value)).toContain(
        SpatialIntersectionGeomType.BOUNDARY
      );
    }
  });

  it.each(areaCases.map((c) => [c.note, c] as const))(
    "labels the area of %s with its region's name, saying when it is the bounding box",
    (_note, c) => {
      const labels = c.regions.map((region) =>
        region.as_box ? `${region.name} (bounding box)` : region.name
      );
      for (const row of areaRows(c.config)) {
        expect(labels).toContain(JSON.parse(row.value as string).properties.label);
      }
    }
  );
});
