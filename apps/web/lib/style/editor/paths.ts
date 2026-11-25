// Dot paths into a document: read a value, or write one sharing every unchanged subtree.
import { isObject } from "@/lib/style/json";

/** A dot path; numeric segments index arrays: "classify.0.classes.2.fill.color". */
export type Path = string;

const segments = (path: Path): string[] => (path === "" ? [] : path.split("."));

const isIndex = (segment: string) => /^\d+$/.test(segment);

export function getIn(node: unknown, path: Path): unknown {
  let current = node;
  for (const segment of segments(path)) {
    if (Array.isArray(current) && isIndex(segment)) current = current[Number(segment)];
    else if (isObject(current)) current = current[segment];
    else return undefined;
  }
  return current;
}

const isEmpty = (node: unknown) =>
  Array.isArray(node) ? node.length === 0 : isObject(node) && Object.keys(node).length === 0;

/** Parts, whose empty object is the part switched on with its defaults (spec 3). */
const PARTS = new Set(["fill", "outline", "line", "casing", "arrows", "marker", "label"]);

/** Whether an emptied object at `head` (under `parents`) still means something: a part, or a classification's
 * `other` or `no_data` class. Array items hold their position, so an emptied class stays where it is. */
const keptWhenEmpty = (parents: string[], head: string) =>
  PARTS.has(head) || ((head === "other" || head === "no_data") && parents[parents.length - 2] === "classify");

/** `node` with `value` at the path, sharing everything else; undefined removes the key and any parent it empties
 * (except parts, a classification's `other` and `no_data`, and array items). */
export function setIn<T>(node: T, path: Path, value: unknown): T {
  const parts = segments(path);
  const write = (current: unknown, rest: string[]): unknown => {
    const [head, ...tail] = rest;
    const container: unknown = current ?? (isIndex(head) ? [] : {});
    const child = Array.isArray(container)
      ? container[Number(head)]
      : isObject(container)
        ? container[head]
        : undefined;
    const next = tail.length ? write(child, tail) : value;
    const parents = parts.slice(0, parts.length - rest.length);
    if (next === child) return current;
    if (Array.isArray(container) && isIndex(head)) {
      const copy = [...container];
      if (next === undefined) copy.splice(Number(head), 1);
      else copy[Number(head)] = next;
      return copy;
    }
    const copy: Record<string, unknown> = { ...(isObject(container) ? container : {}) };
    if (next === undefined || (tail.length && isEmpty(next) && !keptWhenEmpty(parents, head)))
      delete copy[head];
    else copy[head] = next;
    return copy;
  };
  return (parts.length ? write(node, parts) : value) as T;
}

/** `node` without the key a classification wrote into the record at `record`, and without the part object that held
 * only that key: the part was there to carry the key, not switched on by the author. */
export function dropKey<T>(node: T, record: Path, key: Path): T {
  const path = record ? `${record}.${key}` : key;
  if (getIn(node, path) === undefined) return node;
  const next = setIn(node, path, undefined);
  const part = record ? `${record}.${key.split(".")[0]}` : key.split(".")[0];
  return isEmpty(getIn(next, part)) ? setIn(next, part, undefined) : next;
}
