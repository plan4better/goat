// The shapes of goatlib's GOAT Style fixtures and what is read from them without the file system, so a test in the
// browser (the style lab) can use them with the fixtures it imports as JSON.
import type { FieldType } from "@/lib/style/compile/types";

export interface SpecExample {
  line: number;
  target: string;
  expect: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any;
}

export interface SampleField {
  name: string;
  type: FieldType;
  values?: unknown[];
  min?: number;
  max?: number;
}

export interface SampleDataset {
  kind: "vector" | "raster";
  geometry?: "point" | "line" | "polygon";
  fields?: SampleField[];
  [key: string]: unknown;
}

export const fieldTypes = (dataset: SampleDataset): Record<string, FieldType> =>
  Object.fromEntries((dataset.fields ?? []).map((f) => [f.name, f.type]));
