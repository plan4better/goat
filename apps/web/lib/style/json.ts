// Plain JSON helpers for GOAT Style documents, which stay plain objects end to end.

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The keys JSON writes: a key holding `undefined` is not sent; `skip` leaves out keys by name at any depth. */
const jsonKeys = (o: JsonObject, skip?: ReadonlySet<string>) =>
  Object.keys(o).filter((k) => o[k] !== undefined && !skip?.has(k));

/** Equal as JSON: objects compare key by key whatever their order (a key holding `undefined` counts as absent), lists
 * item by item. Keys named in `skip` are left out at any depth. */
export function deepEqual(a: unknown, b: unknown, skip?: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => deepEqual(x, b[i], skip))
    );
  }
  if (isObject(a) && isObject(b)) {
    const keys = jsonKeys(a, skip);
    return keys.length === jsonKeys(b, skip).length && keys.every((k) => deepEqual(a[k], b[k], skip));
  }
  return false;
}

/** What the server computes into a style (a classification's breaks, a value form's domain): not the author's. */
const COMPUTED = new Set(["computed"]);

/** Two styles, or parts of them, the same as the author wrote them: equal as JSON, what the server computed aside. */
export const sameAsWritten = (a: unknown, b: unknown): boolean => deepEqual(a, b, COMPUTED);

export const clone = <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T));
