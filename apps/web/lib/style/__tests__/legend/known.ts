// What the legend checks find wrong today and nobody has decided on yet. Each entry names the check, the cases it
// holds for (by their settings, so the list survives a reshuffle of the cases) and what is wrong. A check expects
// these to fail: once one is fixed its test turns red until the entry is removed. Differences that are by design
// do not belong here; the checks themselves allow for those.
import { isNone } from "@/lib/style/colors";
import { type JsonObject, isObject } from "@/lib/style/json";

import type { LegendCase } from "./caseList";

export interface KnownDifference {
  check: "compiles" | "invariants" | "map" | "render" | "lab";
  when: (c: LegendCase) => boolean;
  reason: string;
  /** For the lab: which of its findings the difference shows in (the others stay empty). */
  finding?: "errors" | "missingImages" | "notDrawn" | "drawnHidden" | "colorMismatches";
}

const record = (node: unknown, key: string): JsonObject =>
  isObject(node) && isObject(node[key]) ? (node[key] as JsonObject) : {};

/** Whether a point's marker takes part in collisions (an icon alone without `allow_overlap: true`, a marker image
 * with `allow_overlap: false`; compile/labels.ts `markerCollides`) and its label sits on it (`placement: "center"`). */
function labelOnCollidingMarker(c: LegendCase): boolean {
  if (c.geometry !== "point") return false;
  const symbol = record(c.style, "symbol");
  const marker = record(symbol, "marker");
  const label = record(symbol, "label");
  if (label.placement !== "center" || label.text === undefined) return false;
  const imaged = marker.shape !== undefined && marker.shape !== "circle" ? true : marker.icon !== undefined;
  return marker.shape === "icon" ? marker.allow_overlap !== true : imaged && marker.allow_overlap === false;
}

export const KNOWN_DIFFERENCES: KnownDifference[] = [
  {
    check: "lab",
    when: labelOnCollidingMarker,
    reason:
      "spec 3.4: `center` on a marker that collides hides the marker: the map places the label first, and the " +
      "label's clearance covers the collision paddings only beside the marker",
    finding: "notDrawn",
  },
];

/** Properties the legend's data holds and its swatches do not draw: two entries that differ only in these look the
 * same on screen. The render check expects exactly that, so drawing one turns it red until its line is removed. */
export const NOT_DRAWN: Array<{ keys: string[]; reason: string }> = [];

/** The limits of the contrast floor the specification documents for a text read on its halo (18.10), each over the
 * cases it holds for, by their style, and the contrast the check still holds there. Every case a limit holds for dips
 * below 4.5 to 1 somewhere: once one does not, its test turns red until the predicate is narrowed. */
export interface ContrastLimit {
  when: (c: LegendCase) => boolean;
  reason: string;
  /** The lowest contrast of text and halo the check accepts in these cases. */
  floor: number;
}

const MAIN = { point: "marker", line: "line", polygon: "fill" } as const;
/** The color of the feature a case's label belongs to, in its base symbol. */
const mainColor = (c: LegendCase): unknown =>
  c.geometry ? record(c.style.symbol, MAIN[c.geometry]).color : undefined;
/** Whether a value changes by zoom or over a field. */
const varies = (form: unknown): boolean =>
  isObject(form) && (typeof form.field === "string" || Array.isArray(form.zoom));
const textAuto = (c: LegendCase) => record(c.style.symbol, "label").color === "auto";
const haloColor = (c: LegendCase): unknown => record(record(c.style.symbol, "label"), "halo").color;
/** Whether the feature colors a label follows vary by class, rule or palette (spec 18.10): a class on the main color,
 * a rule setting it, or a main color over a palette by attribute. One color by zoom and a color read from a field as
 * it is are not: beside a halo by zoom their text is worked out at every zoom. */
function featureColorsVary(c: LegendCase): boolean {
  if (!c.geometry) return false;
  const main = `${MAIN[c.geometry]}.color`;
  const list = (value: unknown) => (Array.isArray(value) ? value.filter(isObject) : []);
  const color = mainColor(c);
  return (
    (isObject(color) && typeof color.field === "string" && color.palette !== undefined) ||
    list(c.style.classify).some((k) => (k.target ?? main) === main) ||
    list(c.style.rules).some((r) => record(r, MAIN[c.geometry!]).color !== undefined)
  );
}

export const CONTRAST_LIMITS: ContrastLimit[] = [
  {
    when: (c) => textAuto(c) && varies(haloColor(c)) && featureColorsVary(c),
    reason:
      "spec 18.10: where the halo changes by zoom or over a field and the feature's colors vary by class, rule or " +
      "palette, the text is worked out at five points of each stretch between two of the halo's stops; between " +
      "those points its contrast with the halo can dip below 4.5 to 1, and below 3 to 1 where the halo turns from " +
      "light to dark within the stretch, down to about 2.8 to 1 in the cases tested",
    floor: 2.8,
  },
  {
    when: (c) => {
      const halo = haloColor(c);
      const main = mainColor(c);
      return (
        textAuto(c) &&
        typeof halo === "string" &&
        /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(halo) &&
        !isNone(halo) &&
        isObject(main) &&
        typeof main.field === "string" &&
        main.palette !== undefined
      );
    },
    reason:
      "spec 18.10: where the feature's color blends over a palette beside one halo color, the text blends from one " +
      "stop's text to the next where both lie on the same side of the halo; between stops the blend is not " +
      "checked, and its contrast with the halo can come out slightly below 4.5 to 1",
    floor: 4.4,
  },
];

/** The documented limit of the contrast floor a case falls under, if any. */
export const contrastLimit = (c: LegendCase): ContrastLimit | undefined =>
  CONTRAST_LIMITS.find((k) => k.when(c));

/** The known difference a case has for a check, if any. */
export const known = (check: KnownDifference["check"], c: LegendCase): KnownDifference | undefined =>
  KNOWN_DIFFERENCES.find((k) => k.check === check && k.when(c));
