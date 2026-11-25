// A feature made up for a legend entry, shared by the tests that hold the legend against what is drawn.
import type { FieldType } from "@/lib/style/compile/types";
import type { JsonObject } from "@/lib/style/json";
import type { LegendEntry } from "@/lib/style/legend";

/** The properties of a feature that falls in an entry of a classification; null where none can be made up. */
export function sampleFor(
  c: JsonObject,
  entry: LegendEntry,
  type: FieldType | undefined
): Record<string, unknown> | null {
  const field = c.field as string;
  const numeric = type === "number" || type === "integer";
  if (entry.extra === "no_data") return {};
  if (entry.extra === "other") {
    if (c.method !== "categories" || type === "boolean") return null;
    return { [field]: numeric ? -987654 : "not a listed value" };
  }
  if (entry.values) {
    const value = entry.values[0];
    if (type === "boolean") return { [field]: value === true || value === "true" };
    return { [field]: numeric ? Number(value) : value };
  }
  if (entry.range) {
    const { from, to } = entry.range;
    if (from !== undefined && to !== undefined) return { [field]: (from + to) / 2 };
    if (to !== undefined) return { [field]: to - 1 };
    if (from !== undefined) return { [field]: from + 1 };
    return { [field]: 0 };
  }
  return null;
}
