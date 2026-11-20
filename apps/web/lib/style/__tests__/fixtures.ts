// goatlib's GOAT Style fixtures, shared with the Python tests: the spec's checked examples, its sample datasets
// and the merge cases. Only tests read them: the web build never sees packages/python.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SampleDataset, SpecExample } from "./fixtureTypes";

export * from "./fixtureTypes";

const FIXTURES = resolve(__dirname, "../../../../../packages/python/goatlib/tests/unit/style/fixtures");

const read = <T>(name: string): T => JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as T;

export interface MergeCase {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  base: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  incoming: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  current: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expected: any;
  refused: string[];
}

export const specExamples = (): SpecExample[] => read("spec_examples.json");
export const sampleDatasets = (): Record<string, SampleDataset> => read("sample_datasets.json");
export const mergeCases = (): MergeCase[] => read("merge_cases.json");

/** The spec's compile examples (section 16): each `maplibre` fixture with the document right before it. */
export function goldenPairs(): Array<{
  doc: SpecExample["doc"];
  dataset: SampleDataset;
  expected: unknown[];
}> {
  const examples = specExamples();
  const datasets = sampleDatasets();
  return examples.flatMap((example, i) => {
    if (example.target !== "maplibre") return [];
    const source = examples[i - 1];
    return [{ doc: source.doc, dataset: datasets[source.target], expected: example.doc as unknown[] }];
  });
}
