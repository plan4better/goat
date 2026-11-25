// The legend test cases (caseList.ts), loaded from goatlib's fixtures for the jsdom tests: the generated cases and
// the spec's examples, then the cases of automatic colors, None and transparency.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sampleDatasets, specExamples } from "../fixtures";
import { type GeneratedCases, type LegendCase, buildColorCases, buildLegendCases } from "./caseList";

export * from "./caseList";

const FIXTURE = resolve(
  __dirname,
  "../../../../../../packages/python/goatlib/tests/unit/style/fixtures/legend_cases.json"
);

let cached: { all: LegendCase[]; colors: LegendCase[] } | undefined;

function load() {
  if (!cached) {
    const generated = JSON.parse(readFileSync(FIXTURE, "utf8")) as GeneratedCases;
    const colors = buildColorCases(generated);
    cached = { all: [...buildLegendCases(generated, specExamples(), sampleDatasets()), ...colors], colors };
  }
  return cached;
}

/** Every legend case: the generated ones, the spec's examples, the cases of the colors. */
export const legendCases = (): LegendCase[] => load().all;

/** The cases of automatic colors, None and transparency (the last of `legendCases`). */
export const colorCases = (): LegendCase[] => load().colors;
