// The classes a legend lists (spec 7.2 `legend.classes`): which classes of a layer's classifications have features,
// counted from the features the map drew in its view (`view`), or from the server's counts under the layer's filter
// (`filter`). Both read a feature's class with the legend's own classifier, so they agree with the map and the popup.
import { mapNumberText } from "@/lib/style/categoryTexts";
import { type JsonObject, isObject } from "@/lib/style/json";
import {
  type ClassIndex,
  type ClassPresence,
  type Presence,
  classListed,
  classifier,
  extraListed,
  itemKey,
  legendDraws,
} from "@/lib/style/legend";

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** The classifications the legend lists (`legendDraws`), each with its key in the counts (its id, else its
 * position). */
function counted(style: JsonObject): Array<{ key: string; c: JsonObject; field: string }> {
  return [...list(style.classify).entries()].flatMap(([index, c]) =>
    c.legend !== false && legendDraws(c) && typeof c.field === "string" && c.field && list(c.classes).length
      ? [{ key: itemKey(c, index), c, field: c.field }]
      : []
  );
}

export interface ViewFeature {
  properties?: Record<string, unknown> | null;
}

export interface PresenceCounter {
  /** Reads features; true once every class the legend could list was seen, when reading more changes nothing. */
  add(features: Iterable<ViewFeature>): boolean;
  readonly done: boolean;
  result(): Presence;
}

/** One classification's count: what it has seen, and how many of the classes the legend could list it still waits
 * for (hidden classes, and Other or No data the legend leaves out, are never waited for). */
interface Tally {
  key: string;
  field: string;
  read: (value: unknown) => ClassIndex;
  keys: string[];
  seen: boolean[];
  wanted: boolean[];
  other: boolean;
  no_data: boolean;
  wantsOther: boolean;
  wantsNoData: boolean;
}

/**
 * Counts the classes of a layer's classifications among features, read in batches (one MapLibre layer after the
 * other). It stops as soon as every class the legend could list was seen: the remaining features of the batch are not
 * read, and the caller asks for no further batch.
 */
export function countPresence(style: JsonObject): PresenceCounter {
  let left = 0;
  const tallies: Tally[] = counted(style).map(({ key, c, field }) => {
    const classes = list(c.classes);
    const wanted = classes.map((k) => classListed(style, c, k));
    const tally: Tally = {
      key,
      field,
      read: classifier(c),
      keys: classes.map((k, i) => itemKey(k, i)),
      seen: classes.map(() => false),
      wanted,
      other: false,
      no_data: false,
      wantsOther: extraListed(style, c, "other"),
      wantsNoData: extraListed(style, c, "no_data"),
    };
    left += wanted.filter(Boolean).length + Number(tally.wantsOther) + Number(tally.wantsNoData);
    return tally;
  });
  return {
    get done() {
      return left === 0;
    },
    add(features) {
      if (left === 0) return true;
      for (const feature of features) {
        const properties = feature.properties ?? {};
        for (const t of tallies) {
          const index = t.read(properties[t.field]);
          if (typeof index === "number") {
            if (t.seen[index]) continue;
            t.seen[index] = true;
            if (t.wanted[index]) left -= 1;
          } else if (!t[index]) {
            t[index] = true;
            if (index === "other" ? t.wantsOther : t.wantsNoData) left -= 1;
          }
        }
        if (left === 0) break;
      }
      return left === 0;
    },
    result: () =>
      Object.fromEntries(
        tallies.map((t) => [
          t.key,
          {
            classes: new Set(t.keys.filter((_, i) => t.seen[i])),
            other: t.other,
            no_data: t.no_data,
          } satisfies ClassPresence,
        ])
      ),
  };
}

/** What the server is asked per classification under a filter: a category field's values with their counts (and how
 * many features have none), a number field's histogram over the class bounds. */
export type PresenceRequest =
  | { kind: "values"; field: string }
  | { kind: "histogram"; field: string; breaks: number[] };

export function presenceRequests(style: JsonObject): Array<{ key: string; request: PresenceRequest }> {
  return counted(style).map(({ key, c, field }) => {
    if (c.method === "categories") return { key, request: { kind: "values", field } };
    const bounds = list(c.classes).flatMap((k) => [k.from, k.to]);
    const breaks = [
      ...new Set(bounds.filter((b): b is number => typeof b === "number" && Number.isFinite(b))),
    ];
    return { key, request: { kind: "histogram", field, breaks: breaks.sort((a, b) => a - b) } };
  });
}

/** The server's answer to a request: values with their counts, of `total` distinct values (the request asks for a
 * limited number), and the features without a value; or the histogram's bins and the features without a value. */
export type PresenceCount =
  | { kind: "values"; values: Array<{ value: unknown; count: number }>; total: number; missing: number }
  | { kind: "histogram"; bins: Array<{ range: [number, number]; count: number }>; missing: number };

/**
 * The classes present under a filter, from the server's counts by classification key. A classification without its
 * count (it failed, or is still on its way) and one whose values were cut off by the request's limit are left out: the
 * legend lists every class of it.
 *
 * A histogram's edges are the data's minimum, the class bounds between it and its maximum, and the maximum, so no bin
 * crosses a class bound: a bin with features marks the class its middle lies in. The minimum and the maximum are values
 * of the data, so they mark their classes too (the last bin also holds the maximum, which may lie in the next class
 * up; the bin then marks both, so a class is never left out wrongly).
 *
 * The server writes every value as the database's text ("3.0", "0.50" for numbers). A text that writes a number marks
 * the class of the text itself and the class of the number's spelling the map reads (`mapNumberText`): the field may
 * hold text or numbers, so both classes are listed; Other only where neither is a class.
 */
export function presenceFromCounts(
  style: JsonObject,
  counts: Readonly<Record<string, PresenceCount>>
): Presence {
  const out: Record<string, ClassPresence> = {};
  for (const { key, c } of counted(style)) {
    const count = counts[key];
    if (!count) continue;
    const classes = list(c.classes);
    const read = classifier(c);
    const found: ClassPresence = { classes: new Set(), other: false, no_data: count.missing > 0 };
    const markClass = (index: number) => (found.classes as Set<string>).add(itemKey(classes[index], index));
    const mark = (value: unknown) => {
      const index = read(value);
      if (typeof index === "number") markClass(index);
      else found[index] = true;
    };
    const markText = (value: unknown) => {
      const spelled = typeof value === "string" ? mapNumberText(value) : undefined;
      const index = spelled !== undefined && spelled !== value ? read(spelled) : undefined;
      if (typeof index !== "number") return mark(value);
      markClass(index);
      if (typeof read(value) === "number") mark(value);
    };
    if (count.kind === "values") {
      if (count.total > count.values.length) continue;
      for (const { value, count: n } of count.values) if (n > 0) markText(value);
    } else {
      const bins = count.bins.filter((bin) => bin.count > 0);
      for (const { range } of bins) mark((range[0] + range[1]) / 2);
      if (bins.length) {
        mark(count.bins[0].range[0]);
        mark(count.bins[count.bins.length - 1].range[1]);
      }
    }
    out[key] = found;
  }
  return out;
}
