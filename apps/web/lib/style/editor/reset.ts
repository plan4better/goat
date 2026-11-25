// Parts of a style put back as a reference style has them (the dataset's default style): the parts' own values and,
// for symbol parts, the classifications that set them. A classification whose target is in the part is the part's: it
// goes, and the reference's come in its place. Other classifications keep their place but lose what their classes set
// in the part (a class's own value, written in class scope). What the server computed does not count as a difference.
import type { Geometry } from "@/lib/style/compile/types";
import { freshId, recordPaths } from "@/lib/style/editor/classify";
import { targetsOf } from "@/lib/style/editor/forms";
import { type Path, dropKey, getIn, setIn } from "@/lib/style/editor/paths";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, clone, isObject, sameAsWritten } from "@/lib/style/json";

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** The symbol part a path names ("symbol.fill" is "fill", "symbol.marker.color" "marker.color"). */
const symbolPart = (path: Path) => (path.startsWith("symbol.") ? path.slice("symbol.".length) : undefined);

const within = (key: string, part: string) => key === part || key.startsWith(`${part}.`);

/** Whether a classification sets one of `parts` through its target. */
const owns = (c: JsonObject, parts: string[], geometry?: Geometry) =>
  targetsOf(c, geometry).some((key) => parts.some((part) => within(key, part)));

/** `c` without what its classes set in `parts`. */
const withoutParts = (c: JsonObject, parts: string[]) =>
  recordPaths(c).reduce(
    (next, record) => parts.reduce((inner, part) => dropKey(inner, record, part), next),
    c
  );

/** `doc` with the values at `paths` as `reference` has them (removed where it has none), and for symbol parts their
 * classifications as the reference has them. */
export function resetParts(
  doc: LayerStyle,
  reference: LayerStyle,
  paths: Path[],
  geometry?: Geometry
): LayerStyle {
  let next = paths.reduce((d, path) => setIn(d, path, clone(getIn(reference, path))), doc);
  const parts = paths.map(symbolPart).filter((part): part is string => !!part);
  if (!parts.length) return next;
  const current = list(getIn(next, "classify"));
  const ownCurrent = current.filter((c) => owns(c, parts, geometry));
  const ownReference = list(getIn(reference, "classify")).filter((c) => owns(c, parts, geometry));
  // The part's classifications as written already: they stay, with what the server computed for them.
  const own = sameAsWritten(ownCurrent, ownReference) ? ownCurrent : ownReference.map((c) => clone(c));
  const kept = current.filter((c) => !owns(c, parts, geometry)).map((c) => withoutParts(c, parts));
  // In the place of the first classification of the part, else after the others.
  const first = current.findIndex((c) => owns(c, parts, geometry));
  const at =
    first < 0 ? kept.length : current.slice(0, first).filter((c) => !owns(c, parts, geometry)).length;
  const classify: JsonObject[] = [...kept.slice(0, at)];
  for (const c of own) {
    // An id another classification took meanwhile is given up for a free one.
    const taken = [...classify, ...kept.slice(at)].some((other) => other.id === c.id);
    classify.push(
      taken && typeof c.id === "string"
        ? {
            ...c,
            id: freshId(setIn(doc, "classify", [...classify, ...kept]), String(c.field ?? c.id)),
          }
        : c
    );
  }
  classify.push(...kept.slice(at));
  if (sameAsWritten(classify, current)) return next;
  next = setIn(next, "classify", classify.length ? classify : undefined);
  return next;
}
