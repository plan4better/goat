// Diff and merge of GOAT Style documents (spec section 13.1), the same rules as goatlib's `style/merge.py`, kept
// equal by goatlib's `merge_cases.json`.
//
// - Objects merge key by key; on the same path the last write wins.
// - Lists whose items carry ids (classifications, classes, rules, popup blocks) merge item by item; an item one
//   side removed stays removed. Every other list is one value.
// - What the server computes is never part of a diff: `computed` objects, `issues`, and the class bounds and
//   values of a computed classification.
import { assignIds, existingIds } from "@/lib/style/ids";
import { type JsonObject, clone, deepEqual, isObject } from "@/lib/style/json";
import { toPointer } from "@/lib/style/pointer";

/**
 * A set, a removal, or an item of an id-keyed list placed after the nearest of `after` that still exists (`after`
 * lists the ids before it in the author's list, nearest first; none surviving places it first). `item` carries an
 * added item's content; an item that already exists keeps its content and only moves.
 */
export type Change =
  | { op: "set"; path: string[]; value: unknown }
  | { op: "remove"; path: string[] }
  | { op: "place"; listPath: string[]; itemId: string; after: string[]; item?: unknown };

const MISSING = Symbol("missing");

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i]);

function isIdList(path: string[]): boolean {
  return (
    samePath(path, ["classify"]) ||
    samePath(path, ["rules"]) ||
    samePath(path, ["popup", "blocks"]) ||
    samePath(path, ["render", "classify", "classes"]) ||
    (path.length === 3 && path[0] === "classify" && path[2] === "classes")
  );
}

function allIds(items: unknown[]): boolean {
  const ids = items.map((i) => (isObject(i) ? i.id : undefined));
  return ids.every((i) => typeof i === "string") && new Set(ids).size === ids.length;
}

/** Keys of class records the server writes for this classification. */
function classSkip(classification: unknown): Set<string> {
  const skip = new Set<string>();
  if (!isObject(classification)) return skip;
  const method = classification.method;
  if (method !== undefined && method !== "manual" && method !== "categories") {
    skip.add("from");
    skip.add("to");
  }
  if (method === "categories" && "count" in classification) skip.add("values");
  return skip;
}

/** What changed from `base` to `next`, without server-owned values. */
export function diff(base: object, next: object): Change[] {
  const out: Change[] = [];
  diffObject(base as JsonObject, next as JsonObject, [], out, new Set(["issues"]));
  return out;
}

function diffObject(base: JsonObject, next: JsonObject, path: string[], out: Change[], skip: Set<string>) {
  for (const key of Object.keys(base)) {
    if (!(key in next) && !skip.has(key) && key !== "computed")
      out.push({ op: "remove", path: [...path, key] });
  }
  for (const [key, nv] of Object.entries(next)) {
    if (skip.has(key) || key === "computed") continue;
    const child = [...path, key];
    if (!(key in base)) {
      out.push({ op: "set", path: child, value: clone(nv) });
      continue;
    }
    const bv = base[key];
    if (deepEqual(nv, bv)) continue;
    if (isObject(nv) && isObject(bv)) {
      diffObject(bv, nv, child, out, new Set());
    } else if (Array.isArray(nv) && Array.isArray(bv) && isIdList(child) && allIds(bv) && allIds(nv)) {
      const itemSkip =
        key === "classes" || samePath(child, ["render", "classify", "classes"])
          ? classSkip(next)
          : new Set<string>();
      diffList(bv as JsonObject[], nv as JsonObject[], child, out, itemSkip);
    } else {
      out.push({ op: "set", path: child, value: clone(nv) });
    }
  }
}

function diffList(
  base: JsonObject[],
  next: JsonObject[],
  path: string[],
  out: Change[],
  itemSkip: Set<string>
) {
  const baseItems = new Map(base.map((i) => [i.id as string, i]));
  const nextIds = next.map((i) => i.id as string);
  for (const id of baseItems.keys()) {
    if (!nextIds.includes(id)) out.push({ op: "remove", path: [...path, id] });
  }
  const commonBase = [...baseItems.keys()].filter((id) => nextIds.includes(id));
  const basePred = new Map(commonBase.map((id, j) => [id, j ? commonBase[j - 1] : null]));
  const before: string[] = [];
  let prevCommon: string | null = null;
  for (const item of next) {
    const id = item.id as string;
    const after = [...before].reverse();
    const baseItem = baseItems.get(id);
    if (!baseItem) {
      out.push({ op: "place", listPath: path, itemId: id, after, item: clone(item) });
    } else {
      if (basePred.get(id) !== prevCommon) out.push({ op: "place", listPath: path, itemId: id, after });
      diffObject(baseItem, item, [...path, id], out, itemSkip);
      prevCommon = id;
    }
    before.push(id);
  }
}

function find(items: unknown[], id: string): number {
  return items.findIndex((item) => isObject(item) && item.id === id);
}

/** The node at `segments`; with `create`, missing objects on the way are made, never an id-keyed list or item. */
function navigate(doc: unknown, segments: string[], create: boolean): unknown {
  let node = doc;
  for (let depth = 0; depth < segments.length; depth++) {
    const seg = segments[depth];
    if (isObject(node)) {
      if (!(seg in node)) {
        if (!create || isIdList(segments.slice(0, depth + 1))) return MISSING;
        node[seg] = {};
      }
      node = node[seg];
    } else if (Array.isArray(node)) {
      const index = find(node, seg);
      if (index < 0) return MISSING;
      node = node[index];
    } else {
      return MISSING;
    }
  }
  return node;
}

function applyOne(doc: JsonObject, change: Change): boolean {
  if (change.op === "set") {
    const parent = navigate(doc, change.path.slice(0, -1), true);
    const key = change.path[change.path.length - 1];
    if (isObject(parent)) {
      parent[key] = clone(change.value);
      return true;
    }
    if (Array.isArray(parent)) {
      const index = find(parent, key);
      if (index < 0) return false;
      parent[index] = clone(change.value);
      return true;
    }
    return false;
  }
  if (change.op === "remove") {
    const parent = navigate(doc, change.path.slice(0, -1), false);
    const key = change.path[change.path.length - 1];
    if (isObject(parent)) delete parent[key];
    else if (Array.isArray(parent)) {
      const index = find(parent, key);
      if (index >= 0) parent.splice(index, 1);
    }
    return true;
  }
  let items = navigate(doc, change.listPath, false);
  if (items === MISSING && change.item !== undefined) {
    const parent = navigate(doc, change.listPath.slice(0, -1), true);
    if (!isObject(parent)) return false;
    items = parent[change.listPath[change.listPath.length - 1]] = [];
  }
  if (!Array.isArray(items)) return false;
  const index = find(items, change.itemId);
  if (index < 0 && change.item === undefined) return false;
  const item = index >= 0 ? items.splice(index, 1)[0] : clone(change.item);
  let position = 0;
  for (const pred of change.after) {
    const found = find(items, pred);
    if (found >= 0) {
      position = found + 1;
      break;
    }
  }
  items.splice(position, 0, item);
  return true;
}

/** `doc` with the changes applied (a copy) and the changes whose target is gone. */
export function apply<T extends object>(doc: T, changes: Change[]): { doc: T; refused: Change[] } {
  const out = clone(doc);
  const refused = changes.filter((c) => !applyOne(out as JsonObject, c));
  return { doc: out, refused };
}

/**
 * What the author changed from `base` to `incoming`, applied onto `current`. Items the author added without an id
 * get one first (unique against all three documents), so they merge item by item like every other item.
 */
export function merge<T extends object>(
  base: object,
  incoming: object,
  current: T
): { doc: T; refused: Change[] } {
  const reserved = new Set([...existingIds(base), ...existingIds(current)]);
  return apply(current, diff(base, assignIds(incoming, reserved)));
}

export const changedPaths = (changes: Change[]): string[] =>
  changes.map((c) => toPointer(c.op === "place" ? [...c.listPath, c.itemId] : c.path));
