// Ids for the list items edits and issues address (goatlib `style/ids.py`, spec section 1).
import { type JsonObject, clone, isObject } from "@/lib/style/json";

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The first of `prefix1`, `prefix2`, ... not in `taken`, which it is added to. */
export function freshId(prefix: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  taken.add(`${prefix}${n}`);
  return `${prefix}${n}`;
}

/** Every id in a document. */
export function existingIds(node: unknown): Set<string> {
  const found = new Set<string>();
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (isObject(n)) {
      if (typeof n.id === "string") found.add(n.id);
      stack.push(...Object.values(n).filter((v) => typeof v === "object" && v !== null));
    } else if (Array.isArray(n)) {
      stack.push(...n);
    }
  }
  return found;
}

/**
 * A copy of `doc` where every classification, class, rule and popup block has an id: a classification takes its
 * field name when that id is free, otherwise `k1`, `k2`; classes get `c1`, rules `r1`, blocks `b1`. Existing ids
 * are kept; `reserved` names ids a new item must not take (the ids of the other documents of a merge).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assignIds<T = any>(doc: T, reserved: Iterable<string> = []): T {
  const out = clone(doc);
  if (!isObject(out)) return out;
  const taken = new Set([...existingIds(out), ...reserved]);
  const fill = (items: unknown, prefix: string) => {
    for (const item of list(items)) {
      if (isObject(item) && typeof item.id !== "string") item.id = freshId(prefix, taken);
    }
  };
  for (const c of list(out.classify)) {
    if (!isObject(c)) continue;
    if (typeof c.id !== "string") {
      const field = c.field;
      if (typeof field === "string" && field && !taken.has(field)) {
        c.id = field;
        taken.add(field);
      } else {
        c.id = freshId("k", taken);
      }
    }
    fill(c.classes, "c");
  }
  fill(out.rules, "r");
  if (isObject(out.popup)) fill((out.popup as JsonObject).blocks, "b");
  const render = out.render;
  if (isObject(render) && isObject(render.classify)) fill(render.classify.classes, "c");
  return out;
}

/** `doc` itself when every rule has an id, else a copy where the rules without one get `r1`, `r2`: the panel
 * opens, scopes and removes rules by id (spec 6), and a stored document may lack them (spec 1). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withRuleIds<T = any>(doc: T): T {
  if (!isObject(doc) || !list(doc.rules).some((r) => isObject(r) && typeof r.id !== "string")) return doc;
  const taken = existingIds(doc);
  return {
    ...doc,
    rules: list(doc.rules).map((r) =>
      isObject(r) && typeof r.id !== "string" ? { ...r, id: freshId("r", taken) } : r
    ),
  } as T;
}
