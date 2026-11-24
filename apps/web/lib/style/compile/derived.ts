// Colors one part takes from another (spec 3.1 to 3.3, 8.2): an outline in the fill color (`"fill"`) or a darker shade
// of it (`"auto"`), a casing in a darker shade of the line, a pattern and arrows in the color they follow while unset,
// the icon of a hollow marker in the marker color. `DERIVED` says what each key follows and by which rule; the compiler
// asks it for every feature (`derivedValue`), the legend and the panel for one fixed color (`derivedColor`), so the
// three draw the same.
import { shade } from "@/lib/style/colors";
import { cascade } from "@/lib/style/compile/cascade";
import { always, byFill } from "@/lib/style/compile/parts";
import type { FieldType, Geometry } from "@/lib/style/compile/types";
import { type Expr, type Value, substitute } from "@/lib/style/compile/values";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { JsonObject } from "@/lib/style/json";

/** What a rule reads besides the followed color, the same for every feature (a basemap's tone, say). */
export type RuleInputs = Readonly<Record<string, unknown>>;

/** A rule: the derived color of one fixed followed color. */
export type Rule = (color: string, inputs: RuleInputs) => string;

/** The rules: `same`, the followed color as it is, its alpha included; `shade`, its darker shade, opaque. */
export type RuleName = "same" | "shade";

export const RULES: Readonly<Record<RuleName, Rule>> = {
  same: (color) => color,
  shade: (color) => shade(color),
};

export interface Derivation {
  /** The color key the derived color follows, by geometry. */
  follows: Partial<Record<Geometry, string>>;
  /** The rule of each word the key takes in place of a color. */
  words?: Readonly<Record<string, RuleName>>;
  /** The rule while no record sets the key; `only: "hollow"`: on a hollow marker only, the reference default on a
   * filled one. */
  absent?: { rule: RuleName; only?: "hollow" };
}

/** Every derived color key. */
export const DERIVED: Readonly<Record<string, Derivation>> = {
  "outline.color": {
    follows: { polygon: "fill.color", point: "marker.color" },
    words: { fill: "same", auto: "shade" },
  },
  "casing.color": { follows: { line: "line.color" }, words: { auto: "shade" } },
  "fill.pattern_color": { follows: { polygon: "fill.color" }, absent: { rule: "same" } },
  "arrows.color": { follows: { line: "line.color" }, absent: { rule: "same" } },
  "marker.icon_color": {
    follows: { point: "marker.color", line: "marker.color", polygon: "marker.color" },
    absent: { rule: "same", only: "hollow" },
  },
};

/** The color key `key` follows on `geometry`; undefined where it follows none. */
export const followedKey = (key: string, geometry: Geometry): string | undefined =>
  DERIVED[key]?.follows[geometry];

/** Whether `value` is one of the words `key` takes in place of a color (`"fill"`, `"auto"`). */
export const isDerivedWord = (key: string, value: unknown): value is string =>
  typeof value === "string" && DERIVED[key]?.words?.[value] !== undefined;

/** The rule `value` of `key` derives its color by: its word's, or, unset (`undefined`), the key's absent rule. */
export function ruleOf(key: string, value: unknown, opts: { hollow?: boolean } = {}): RuleName | undefined {
  const derivation = DERIVED[key];
  if (!derivation) return undefined;
  if (isDerivedWord(key, value)) return derivation.words![value];
  const absent = derivation.absent;
  if (value === undefined && absent && (absent.only !== "hollow" || opts.hollow)) return absent.rule;
  return undefined;
}

/**
 * The color a fixed value of `key` shows, given the fixed color it follows: the rule's color where `value` is one of
 * the key's words or unset where the key follows while unset (`hollow`: the marker is hollow), else `value` itself.
 */
export function derivedColor(
  key: string,
  value: unknown,
  followed: unknown,
  opts: { hollow?: boolean; inputs?: RuleInputs } = {}
): unknown {
  const rule = ruleOf(key, value, opts);
  if (!rule) return value;
  return typeof followed === "string" ? RULES[rule](followed, opts.inputs ?? {}) : followed;
}

/** Stands for the color a rule derives (or an unset key follows) until `substitute`. */
const placeholder = (rule: RuleName) => `\u0000${rule}`;
const ABSENT = "\u0000absent";

export interface DeriveContext {
  geometry: Geometry;
  fields?: Record<string, FieldType>;
  /** The followed color of every feature with each fixed color `map`ped (none: as it is); default: the cascade of
   * the followed key. */
  follow?: (map?: (color: unknown) => Expr) => Value;
  /** Each feature's `marker.fill`, for a key that follows on hollow markers only; default: filled. */
  fill?: Value;
  inputs?: RuleInputs;
}

/**
 * The value of the derived color `key` for every feature (spec 6.1): its cascade with each word, and the unset key
 * where it follows, replaced by the rule's color of the followed color, class by class, rule by rule and stop by
 * stop. A rule works on fixed colors: a color read from a field as it is stays as it is.
 */
export function derivedValue(style: JsonObject, key: string, ctx: DeriveContext): Value {
  const derivation = DERIVED[key];
  const c = { fields: ctx.fields };
  const follow =
    ctx.follow ??
    ((map?: (color: unknown) => Expr) =>
      cascade(style, derivation.follows[ctx.geometry]!, map ? { ...c, map } : c));
  const inputs = ctx.inputs ?? {};
  const derived = (rule: RuleName) => () =>
    rule === "same"
      ? follow()
      : follow((color) => (typeof color === "string" ? RULES[rule](color, inputs) : color));
  const words = derivation.words ?? {};
  const absent = derivation.absent;
  const hollowOnly = absent?.only === "hollow";
  const fill = ctx.fill ?? { expr: true };
  const follows = absent !== undefined && !(hollowOnly && always(fill, true));
  let value = cascade(style, key, {
    ...c,
    ...(derivation.words ? { map: (v: unknown) => (isDerivedWord(key, v) ? placeholder(words[v]) : v) } : {}),
    ...(follows ? { fallback: ABSENT } : {}),
  });
  for (const rule of new Set(Object.values(words)))
    value = substitute(value, placeholder(rule), derived(rule));
  if (follows) {
    const followed = derived(absent.rule);
    value = substitute(
      value,
      ABSENT,
      hollowOnly ? () => byFill(fill, { expr: DEFAULTS[key] as Expr }, followed(), "color") : followed
    );
  }
  return value;
}
