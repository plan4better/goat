// Plain JSON helpers for GOAT Style documents, which stay plain objects end to end.

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The keys JSON writes: a key holding `undefined` is not sent. */
const jsonKeys = (o: JsonObject) => Object.keys(o).filter((k) => o[k] !== undefined);

/** Equal as JSON: objects compare key by key whatever their order (a key holding `undefined` counts as absent), lists
 * item by item. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
    );
  }
  if (isObject(a) && isObject(b)) {
    const keys = jsonKeys(a);
    return keys.length === jsonKeys(b).length && keys.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

export const clone = <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T));
