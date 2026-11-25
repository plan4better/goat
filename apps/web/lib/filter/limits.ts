// The shapes of a filter as the server counts them (goatlib/filter/limits.py): every geometry in it is one shape, with
// the positions it holds. Conditions and values are counted on the panel's rows (write.ts); only the shapes are read
// from the CQL, as a custom row can hold any number of them. The filter's length is what a map request carries.
import { isObject } from "@/lib/style/json";

const SPATIAL = new Set([
  "s_intersects",
  "s_within",
  "s_contains",
  "s_disjoint",
  "s_touches",
  "s_crosses",
  "s_overlaps",
  "s_equals",
]);

/** An envelope: `{ bbox: [...] }` and nothing else. */
const isEnvelope = (node: Record<string, unknown>) =>
  Object.keys(node).length === 1 && Array.isArray(node.bbox);

/** The positions in a geometry's coordinates, at any nesting. */
function positions(coordinates: unknown): number {
  let count = 0;
  const stack = [coordinates];
  while (stack.length) {
    const item = stack.pop();
    if (!Array.isArray(item)) continue;
    if (typeof item[0] === "number") count++;
    else for (const inner of item) stack.push(inner);
  }
  return count;
}

/** The positions of each geometry in a filter; an envelope holds five. Nothing inside a geometry or a comparison is
 * looked at. */
export function shapePoints(cql: unknown): number[] {
  const shapes: number[] = [];
  const stack: unknown[] = [cql];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const inner of node) stack.push(inner);
      continue;
    }
    if (!isObject(node)) continue;
    if (isEnvelope(node)) shapes.push(5);
    else if ("type" in node && "coordinates" in node) shapes.push(positions(node.coordinates));
    else if (
      ((node.op === "and" || node.op === "or") && Array.isArray(node.args)) ||
      node.op === "not" ||
      SPATIAL.has(node.op as string) ||
      !("op" in node)
    ) {
      for (const inner of Object.values(node))
        if (typeof inner === "object" && inner !== null) stack.push(inner);
    }
  }
  return shapes;
}

const encodedLength = (value: unknown) => encodeURIComponent(JSON.stringify(value) ?? "null").length;

/** The characters of the filter in a map request's URL: its compact JSON as `encodeURIComponent` writes it, each
 * brace, bracket, comma and colon as three. Counted without recursion, as goatlib's `url_length` counts it. */
export function urlLength(cql: unknown): number {
  if (cql === undefined) return 0;
  let total = 0;
  const stack: unknown[] = [cql];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item)) {
      total += 3 * (2 + Math.max(item.length - 1, 0));
      for (const inner of item) stack.push(inner);
    } else if (isObject(item)) {
      // JSON leaves out a key without a value.
      const entries = Object.entries(item).filter(([, value]) => value !== undefined);
      total += 3 * (2 + Math.max(entries.length - 1, 0) + entries.length);
      for (const [key, value] of entries) {
        total += encodedLength(key);
        stack.push(value);
      }
    } else total += encodedLength(item);
  }
  return total;
}
