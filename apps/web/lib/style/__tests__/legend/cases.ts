// The legend test cases (caseList.ts), loaded from goatlib's fixtures for the jsdom tests.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sampleDatasets, specExamples } from "../fixtures";
import { type GeneratedCases, type LegendCase, buildLegendCases } from "./caseList";

export * from "./caseList";

const FIXTURE = resolve(
  __dirname,
  "../../../../../../packages/python/goatlib/tests/unit/style/fixtures/legend_cases.json"
);

let cached: LegendCase[] | undefined;

export function legendCases(): LegendCase[] {
  cached ??= buildLegendCases(
    JSON.parse(readFileSync(FIXTURE, "utf8")) as GeneratedCases,
    specExamples(),
    sampleDatasets()
  );
  return cached;
}
