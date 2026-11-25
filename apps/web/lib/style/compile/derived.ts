// Colors one part takes from another (spec 3.1 to 3.3, 8.2, 8.3, 18.10): an outline in the fill color (`"fill"`) or a
// darker shade of it (`"auto"`), a casing in a darker shade of the line, a hexagon outline in a darker shade of each
// hexagon, a pattern and arrows in the hue they follow while unset, opaque, the icon of a hollow marker in the marker's
// hue, a label's text and halo chosen together for the basemap from the feature's color (a text beside a set halo read
// on that halo), an icon and a cluster's number in white or dark on the color underneath. `DERIVED` says what each key
// follows and by which rule (goatlib's `data/color_keys.json` lists where `"auto"` is taken); the compiler asks it for
// every feature (`derivedValue`), the legend and the panel for one fixed color (`derivedColor`), so the three draw the
// same.
import { Color, interpolates } from "@maplibre/maplibre-gl-style-spec";

import {
  LABEL_FALLBACK,
  LIGHT,
  contrastRatio,
  haloAgainst,
  isNone,
  labelPair,
  onColor,
  opaque,
  shade,
  textAgainst,
} from "@/lib/style/colors";
import { cascade } from "@/lib/style/compile/cascade";
import { always, byFill } from "@/lib/style/compile/parts";
import type { FieldType, Geometry } from "@/lib/style/compile/types";
import { type Expr, type Value, combine, isZoomed, substitute, valueAt } from "@/lib/style/compile/values";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";

/** What a rule reads besides the followed color, the same for every feature (a basemap's tone, say). */
export type RuleInputs = Readonly<Record<string, unknown>>;

/** A rule: the derived color of one fixed followed color. */
export type Rule = (color: string, inputs: RuleInputs) => string;

/** The rules: `same`, the followed color as it is, its alpha included ("Same as fill"); `hue`, the followed color
 * without its alpha (a color that is not set draws opaque in the hue it follows, spec 4.6); `shade`, its darker shade,
 * opaque; `label_text` and `label_halo`, a label's text and halo chosen together for the basemap's tone
 * (`inputs.tone`, light where none is given) from the feature's color; `on_color`, white or dark on the color;
 * `halo_against`, a halo that meets the contrast floor against a set text color; `text_against` and `number_against`,
 * a label's text and a cluster's number read on the halo color the style sets (`inputs.halo`), the table's text or
 * the on-color first. */
export type RuleName =
  | "same"
  | "hue"
  | "shade"
  | "label_text"
  | "label_halo"
  | "on_color"
  | "halo_against"
  | "text_against"
  | "number_against";

const toneOf = (inputs: RuleInputs) => (inputs.tone === "dark" ? "dark" : "light");
const haloOf = (inputs: RuleInputs) => (typeof inputs.halo === "string" ? inputs.halo : "");

export const RULES: Readonly<Record<RuleName, Rule>> = {
  same: (color) => color,
  hue: (color) => opaque(color),
  shade: (color) => shade(color),
  label_text: (color, inputs) => labelPair(color, toneOf(inputs)).text,
  label_halo: (color, inputs) => labelPair(color, toneOf(inputs)).halo,
  on_color: (color) => onColor(color),
  halo_against: (color) => haloAgainst(color),
  text_against: (color, inputs) => textAgainst(color, haloOf(inputs), toneOf(inputs)),
  number_against: (color, inputs) => textAgainst(color, haloOf(inputs), toneOf(inputs), onColor(color)),
};

/** What a rule that cannot follow the data's color draws for every feature of a field read as it is (spec 18.10): the
 * label's neutral pair for the tone, white for an on-color. The other rules draw the data's color itself. */
const RAW_COLOR: Partial<Record<RuleName, (inputs: RuleInputs) => string>> = {
  label_text: (inputs) => LABEL_FALLBACK[toneOf(inputs)].text,
  label_halo: (inputs) => LABEL_FALLBACK[toneOf(inputs)].halo,
  on_color: () => LIGHT,
  halo_against: () => LIGHT,
  text_against: (inputs) => textAgainst("", haloOf(inputs), toneOf(inputs)),
  number_against: (inputs) => textAgainst("", haloOf(inputs), toneOf(inputs), LIGHT),
};

/** What a rule gives where the followed color is read from a field as it is (spec 4.5): `read` is the read as it is
 * (`["to-color", get, fallback]`), `turned` the same read with its fallback turned by the rule. The data's color is
 * known only when drawn: the shade cannot darken it and its alpha stays, so it stands, the fallback turned like any
 * fixed color; the label pair and the on-color draw their documented colors for the whole read. */
export const RAW_RULES: Readonly<Record<RuleName, (read: Expr, turned: Expr, inputs: RuleInputs) => Expr>> = {
  same: (read) => read,
  hue: (_read, turned) => turned,
  shade: (_read, turned) => turned,
  label_text: (_read, _turned, inputs) => RAW_COLOR.label_text!(inputs),
  label_halo: (_read, _turned, inputs) => RAW_COLOR.label_halo!(inputs),
  on_color: (_read, _turned, inputs) => RAW_COLOR.on_color!(inputs),
  halo_against: (_read, _turned, inputs) => RAW_COLOR.halo_against!(inputs),
  text_against: (_read, _turned, inputs) => RAW_COLOR.text_against!(inputs),
  number_against: (_read, _turned, inputs) => RAW_COLOR.number_against!(inputs),
};

/** The rules that choose among a few colors (white or dark, black for a halo): where the color they look at blends (a
 * palette over a field, a color by zoom), their answer switches where it flips instead of blending through grey
 * (`switched`). */
const SWITCHED: ReadonlySet<RuleName> = new Set(["on_color", "halo_against"]);

/** The samples per blended stretch at which a switching rule looks for where its answer flips. */
const SAMPLES = 64;

/** The answers recorded between two samples at most (`breakpoints`). */
const TURNS = 4;

/** The rules whose answers are tinted shades or a few fixed colors on either side of a halo (a text read on its halo):
 * between stops they blend where neighbouring answers lie on the same side of the halo and step where they cross it
 * (`sided`). */
const SIDED: ReadonlySet<RuleName> = new Set(["text_against", "number_against"]);

/** The rules whose value is filled in branch by branch (`substituteAligned`). */
const ALIGNED: ReadonlySet<RuleName> = new Set(["label_text", "label_halo", "on_color", "halo_against"]);

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const isHexColor = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

/** The color MapLibre draws at `t` (0 to 1) between `a` and `b`, blended in Lab or RGB, as hex. */
function blendAt(a: string, b: string, t: number, space: "lab" | "rgb"): string {
  const color = interpolates.color(Color.parse(a)!, Color.parse(b)!, t, space);
  const [r, g, bl] = (color.toString().match(/[\d.]+/g) ?? []).map(Number);
  return `#${[r, g, bl].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** The share of the way from `x0` to `x1` that `x` is, by an interpolation curve. */
function factorOf(curve: Expr, x: number, x0: number, x1: number): number {
  const base = Array.isArray(curve) && curve[0] === "exponential" ? Number(curve[1]) : 1;
  return base === 1 ? (x - x0) / (x1 - x0) : (base ** (x - x0) - 1) / (base ** (x1 - x0) - 1);
}

const rounded = (x: number) => Number(x.toFixed(6));
const same = (a: Expr, b: Expr) => JSON.stringify(a) === JSON.stringify(b);

/** Breakpoints `[x, answer]` over stops `xs` whose answers are `outs`: `answerAt(i, x)` gives the answer at `x` between
 * stops i and i + 1 (undefined: no blend to look into); an answer is kept up to where it changes, found from the
 * first sample that differs, and every answer that starts before that sample (several may follow each other between
 * two samples) from where it starts. */
function breakpoints(
  xs: number[],
  outs: Expr[],
  answerAt: (i: number, x: number) => Expr | undefined
): Array<[number, Expr]> {
  const out: Array<[number, Expr]> = [];
  let current = outs[0];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let k = 1; k < SAMPLES; k++) {
      const x = xs[i] + ((xs[i + 1] - xs[i]) * k) / SAMPLES;
      const answer = answerAt(i, x);
      if (answer === undefined) break;
      let from = xs[i] + ((xs[i + 1] - xs[i]) * (k - 1)) / SAMPLES;
      for (let turns = 0; !same(answer, current) && turns < TURNS; turns++) {
        // Where after `from` the answer first turns, to a tiny share of the stretch.
        let [lo, hi] = [from, x];
        for (let n = 0; n < 24; n++) {
          const mid = (lo + hi) / 2;
          if (same(answerAt(i, mid), current)) lo = mid;
          else hi = mid;
        }
        const next = answerAt(i, hi);
        if (next === undefined) break;
        const at = rounded(hi);
        if (out.length && out[out.length - 1][0] >= at) out[out.length - 1][1] = next;
        else out.push([at, next]);
        current = next;
        from = hi;
      }
      // An answer that changes more often between two samples (a blended color whose every shade is an answer): the
      // sample's own answer from where it starts.
      if (!same(answer, current)) {
        let [lo, hi] = [from, x];
        for (let n = 0; n < 24; n++) {
          const mid = (lo + hi) / 2;
          if (same(answerAt(i, mid), answer)) hi = mid;
          else lo = mid;
        }
        const at = rounded(hi);
        if (out.length && out[out.length - 1][0] >= at) out[out.length - 1][1] = answer;
        else out.push([at, answer]);
        current = answer;
      }
    }
    if (!same(outs[i + 1], current)) {
      out.push([xs[i + 1], outs[i + 1]]);
      current = outs[i + 1];
    }
  }
  return out;
}

/** What a switching rule gives for one blended color; undefined where it has no one answer (each stop's answer then
 * holds up to the next stop). */
type Turn = (color: string) => string | undefined;

/** `turned` (the followed value with each fixed color turned by `turn`) where every blend between fixed colors of
 * `plain` (the followed value as it is) is a step that switches where `turn` of the blended color changes, and every
 * color read from a field as it is is `raw`. */
function switchedExpr(turned: Expr, plain: Expr, turn: Turn, raw: Expr): Expr {
  if (!Array.isArray(plain) || !Array.isArray(turned) || plain[0] === "literal") return turned;
  if (plain[0] === "to-color") return raw;
  if ((plain[0] === "interpolate" || plain[0] === "interpolate-lab") && turned.length === plain.length) {
    const [op, curve, input, ...stops] = plain;
    const xs = stops.filter((_, i) => i % 2 === 0) as number[];
    const colors = stops.filter((_, i) => i % 2 === 1);
    const space = op === "interpolate-lab" ? "lab" : "rgb";
    if (colors.every(isHexColor) && xs.every((x) => typeof x === "number")) {
      const outs = turned.slice(3).filter((_, i) => i % 2 === 1);
      // A blend at one known share (two values by zoom blended at a fixed zoom): its one answer.
      const one =
        typeof input === "number"
          ? turn(
              blendAt(colors[0], colors[colors.length - 1], factorOf(curve, input, xs[0], xs.at(-1)!), space)
            )
          : undefined;
      if (one !== undefined) return one;
      if (typeof input !== "number") {
        const points = breakpoints(xs, outs, (i, x) =>
          turn(blendAt(colors[i], colors[i + 1], factorOf(curve, x, xs[i], xs[i + 1]), space))
        );
        return points.length ? ["step", input, outs[0], ...points.flat()] : outs[0];
      }
    }
  }
  // Two values by zoom blended at one known share, the colors per feature: the nearer one, never a blend of answers.
  if (
    (plain[0] === "interpolate" || plain[0] === "interpolate-lab") &&
    typeof plain[2] === "number" &&
    turned.length === plain.length &&
    plain.length === 7
  ) {
    const [, , share, x0, , x1] = plain as [string, Expr, number, number, Expr, number, Expr];
    const near = share - x0 < x1 - share ? 4 : 6;
    return switchedExpr(turned[near], plain[near], turn, raw);
  }
  return turned.length === plain.length ? turned.map((e, i) => switchedExpr(e, plain[i], turn, raw)) : turned;
}

/** `switchedExpr` over a value: between stops by zoom whose colors are fixed, the answer switches where `turn` of the
 * color blended over the zoom changes; the value then steps. */
function switched(turned: Value, plain: Value, turn: Turn, raw: Expr): Value {
  if (!isZoomed(turned) || !isZoomed(plain))
    return isZoomed(turned) || isZoomed(plain)
      ? isZoomed(turned)
        ? { ...turned, interpolate: "step" }
        : turned
      : { expr: switchedExpr(turned.expr, plain.expr, turn, raw) };
  if (turned.stops.length !== plain.stops.length) return { ...turned, interpolate: "step" };
  const xs = plain.stops.map(([z]) => z);
  const outs = turned.stops.map(([, e], i) => switchedExpr(e, plain.stops[i][1], turn, raw));
  const blends = plain.interpolate !== "step";
  const points = breakpoints(xs, outs, (i, z) => {
    if (!blends || !isHexColor(plain.stops[i][1]) || !isHexColor(plain.stops[i + 1][1])) return undefined;
    const color = valueAt(plain, z);
    return isHexColor(color) ? turn(color) : undefined;
  });
  return { interpolate: "step", stops: [[xs[0], outs[0]], ...points], kind: turned.kind };
}

/** Where a value whose records each set a placeholder is filled in with a value that is a match, case or step on the
 * same input, the branch the record stands in is taken instead of the whole value, so a color set in each of N
 * classes takes N branches, not N times N. */
type Fact =
  | { op: "match"; input: string; labels: string[]; within: boolean }
  | { op: "case"; cond: string; holds: boolean }
  | { op: "step"; input: string; stops: string; index: number };

const labelsOf = (label: Expr): string[] =>
  Array.isArray(label) ? label.map((l) => JSON.stringify(l)) : [JSON.stringify(label)];

/** `by` with each match, case and step that `facts` decide reduced to its branch. */
function narrow(by: Expr, facts: Fact[]): Expr {
  if (!Array.isArray(by) || by[0] === "literal") return by;
  const [op] = by;
  if (op === "match") {
    const input = JSON.stringify(by[1]);
    const known = facts.filter(
      (f): f is Extract<Fact, { op: "match" }> => f.op === "match" && f.input === input
    );
    if (known.length) {
      const last = by.length - 1;
      const branches: Array<[Expr, Expr]> = [];
      for (let i = 2; i < last; i += 2) branches.push([by[i], by[i + 1]]);
      const kept = branches.filter(([label]) => {
        const labels = labelsOf(label);
        return known.every((f) =>
          f.within ? labels.some((l) => f.labels.includes(l)) : !labels.every((l) => f.labels.includes(l))
        );
      });
      const within = known.find((f) => f.within);
      const whole = within && kept.find(([label]) => within.labels.every((l) => labelsOf(label).includes(l)));
      if (whole) return narrow(whole[1], facts);
      if (!kept.length) return narrow(by[last], facts);
      return [
        "match",
        by[1],
        ...kept.flatMap(([label, out]) => [label, narrow(out, facts)]),
        narrow(by[last], facts),
      ];
    }
  }
  if (op === "case") {
    const last = by.length - 1;
    const kept: Expr[] = [];
    for (let i = 1; i < last; i += 2) {
      const fact = facts.find((f) => f.op === "case" && f.cond === JSON.stringify(by[i])) as
        | Extract<Fact, { op: "case" }>
        | undefined;
      if (fact?.holds === false) continue;
      if (fact?.holds === true && !kept.length) return narrow(by[i + 1], facts);
      if (fact?.holds === true) {
        kept.push(true, narrow(by[i + 1], facts));
        break;
      }
      kept.push(by[i], narrow(by[i + 1], facts));
    }
    if (kept.length && kept[kept.length - 2] === true)
      return ["case", ...kept.slice(0, -2), kept[kept.length - 1]];
    return kept.length ? ["case", ...kept, narrow(by[last], facts)] : narrow(by[last], facts);
  }
  if (op === "step") {
    const input = JSON.stringify(by[1]);
    const stops = JSON.stringify(by.slice(3).filter((_, i) => i % 2 === 0));
    const fact = facts.find((f) => f.op === "step" && f.input === input && f.stops === stops) as
      | Extract<Fact, { op: "step" }>
      | undefined;
    if (fact) return narrow(fact.index === 0 ? by[2] : by[2 + fact.index * 2], facts);
  }
  return by.map((e) => narrow(e, facts));
}

/** `expr` with the placeholder `name` replaced by `by`, narrowed to the branch it stands in (`narrow`). */
function replaceAligned(expr: Expr, name: string, by: Expr, facts: Fact[]): Expr {
  if (expr === name) return narrow(by, facts);
  if (!Array.isArray(expr) || expr[0] === "literal") return expr;
  const [op] = expr;
  const last = expr.length - 1;
  const down = (e: Expr, more: Fact[]) => replaceAligned(e, name, by, [...facts, ...more]);
  if (op === "match") {
    const input = JSON.stringify(expr[1]);
    const all = expr
      .slice(2, last)
      .filter((_, i) => i % 2 === 0)
      .flatMap(labelsOf);
    return expr.map((e, i) =>
      i < 2 || (i < last && i % 2 === 0)
        ? e
        : i === last
          ? down(e, [{ op: "match", input, labels: all, within: false }])
          : down(e, [{ op: "match", input, labels: labelsOf(expr[i - 1]), within: true }])
    );
  }
  if (op === "case") {
    const conds = expr
      .slice(1, last)
      .filter((_, i) => i % 2 === 0)
      .map((c) => JSON.stringify(c));
    return expr.map((e, i) => {
      if (i === 0 || (i < last && i % 2 === 1)) return e;
      const k = i === last ? conds.length : i / 2 - 1;
      return down(
        e,
        conds.slice(0, k + (i === last ? 0 : 1)).map((cond, j) => ({ op: "case", cond, holds: j === k }))
      );
    });
  }
  if (op === "step") {
    const input = JSON.stringify(expr[1]);
    const stops = JSON.stringify(expr.slice(3).filter((_, i) => i % 2 === 0));
    return expr.map((e, i) =>
      i === 2 || (i > 3 && i % 2 === 0)
        ? down(e, [{ op: "step", input, stops, index: i === 2 ? 0 : i / 2 - 1 }])
        : e
    );
  }
  return expr.map((e) => down(e, []));
}

const holds = (expr: Expr, name: string): boolean =>
  expr === name || (Array.isArray(expr) && expr.some((e) => holds(e, name)));

/** `substitute` that takes the branch a placeholder stands in from a value on the same classes (`narrow`). */
function substituteAligned(value: Value, name: string, by: Value | (() => Value)): Value {
  const found = isZoomed(value) ? value.stops.some(([, e]) => holds(e, name)) : holds(value.expr, name);
  if (!found) return value;
  return combine([value, typeof by === "function" ? by() : by], ([v, b]) => replaceAligned(v, name, b, []), {
    kind: "color",
  });
}

export interface Derivation {
  /** The color key the derived color follows, by geometry. */
  follows: Partial<Record<Geometry, string>>;
  /** Where a record holds the key, when not at the key itself (a cluster symbol's `label.color`). */
  path?: string;
  /** The rule of each word the key takes in place of a color. */
  words?: Readonly<Record<string, RuleName>>;
  /** The rule of a word on a hollow marker, where it differs from `words`. */
  hollowWords?: Readonly<Record<string, RuleName>>;
  /** The rule while no record sets the key; `only: "hollow"`: on a hollow marker only, the reference default on a
   * filled one. */
  absent?: { rule: RuleName; only?: "hollow" };
  /** A partner key the word's color is chosen against (a halo against its text): where the partner holds a color, set
   * or not, or a word by any rule but `pair`, the color is `rule` of the partner's color as drawn; where the partner
   * holds a word by `pair`, the key's own rule of the followed color. */
  against?: { key: string; rule: RuleName; pair?: RuleName };
  /** A partner key whose drawn color the word's color is read on (a text on its halo): where the partner draws a color
   * with some opacity (one a record sets, else its reference color), `rule` of the followed color with that color,
   * opaque, as `inputs.halo`; in records where it holds a word, None or a read from a field, or has width 0, the key's
   * own rule. */
  beside?: { key: string; rule: RuleName };
}

/** The color of the feature a label belongs to. */
const MAIN_COLOR: Partial<Record<Geometry, string>> = {
  point: "marker.color",
  line: "line.color",
  polygon: "fill.color",
};

/** Every derived color key. */
export const DERIVED: Readonly<Record<string, Derivation>> = {
  "outline.color": {
    follows: { polygon: "fill.color", point: "marker.color" },
    words: { fill: "same", auto: "shade" },
  },
  "casing.color": { follows: { line: "line.color" }, words: { auto: "shade" } },
  // An H3 render's outline (fixed for the layer) follows each hexagon's color, which the render works out (`h3Scale`).
  "h3.outline.color": { follows: {}, words: { auto: "shade" } },
  "fill.pattern_color": { follows: { polygon: "fill.color" }, absent: { rule: "hue" } },
  "arrows.color": { follows: { line: "line.color" }, absent: { rule: "hue" } },
  "marker.icon_color": {
    follows: { point: "marker.color", line: "marker.color", polygon: "marker.color" },
    words: { auto: "on_color" },
    hollowWords: { auto: "hue" },
    absent: { rule: "hue", only: "hollow" },
  },
  "label.color": {
    follows: MAIN_COLOR,
    words: { auto: "label_text" },
    beside: { key: "label.halo.color", rule: "text_against" },
  },
  "label.halo.color": {
    follows: MAIN_COLOR,
    words: { auto: "label_halo" },
    against: { key: "label.color", rule: "halo_against", pair: "label_text" },
  },
  // A cluster's number sits on the cluster's marker, read on the halo the cluster symbol sets. Its halo contrasts with
  // the number as it is drawn: the table names the rule `label_halo` (a halo), but with no `pair` its own rule is never
  // reached, the halo against the number always is.
  "cluster.symbol.label.color": {
    path: "label.color",
    follows: { point: "marker.color" },
    words: { auto: "on_color" },
    beside: { key: "cluster.symbol.label.halo.color", rule: "number_against" },
  },
  "cluster.symbol.label.halo.color": {
    path: "label.halo.color",
    follows: { point: "marker.color" },
    words: { auto: "label_halo" },
    against: { key: "cluster.symbol.label.color", rule: "halo_against" },
  },
};

const CLUSTER = "cluster.symbol.";

/** A partner's color a word's color is read on (`Derivation.beside`): a hex color with some opacity, without its
 * alpha; undefined for anything else (a word, None, no partner). */
const setColor = (value: unknown): string | undefined =>
  isHexColor(value) && !isNone(value) ? opaque(value) : undefined;

/** Whether a halo's width draws no halo there (`Derivation.beside`): 0, or 0 at every stop of a width by zoom. The
 * compiler asks it record by record and stop by stop, the panel for the record a row shows, so the two read the same
 * halo. */
export const haloOff = (width: unknown): boolean =>
  width === 0 ||
  (isObject(width) &&
    Array.isArray(width.zoom) &&
    width.zoom.length > 0 &&
    width.zoom.every((stop) => Array.isArray(stop) && stop[1] === 0));

/** The key whose derivation `key` takes: its own, or a cluster symbol's part key without one, the part's. */
const derivationOf = (key: string): string =>
  key in DERIVED || !key.startsWith(CLUSTER) ? key : key.slice(CLUSTER.length);

/** Where a record holds `key`. */
export const pathOf = (key: string): string => DERIVED[key]?.path ?? derivationOf(key);

/** The derived color keys a word of which takes its color by a rule that reads the basemap's tone (`inputs.tone`).
 * A layer whose style sets one of them to one of its words compiles again when the basemap's tone changes; every
 * other layer is left as it is drawn. */
export const TONE_KEYS: readonly string[] = ["label.color", "label.halo.color"];

/** Whether a zoom stop value or the value itself is one of `key`'s words. */
const holdsWord = (key: string, value: unknown): boolean =>
  isDerivedWord(key, value) ||
  (isObject(value) &&
    Array.isArray(value.zoom) &&
    value.zoom.some((stop) => Array.isArray(stop) && isDerivedWord(key, stop[1])));

/**
 * Whether the style draws a color that depends on the basemap's tone: one of `keys` holds one of its words in any
 * record of the style, as it is or in a zoom stop. A part key is looked for in the base symbol, the classes, `other`,
 * `no_data` and the rules; a `cluster.symbol.*` key in a cluster's own symbol.
 */
export function usesTone(style: JsonObject, keys: readonly string[] = TONE_KEYS): boolean {
  const render = isObject(style.render) ? style.render : {};
  return keys.some((key) => {
    const path = pathOf(key).split(".");
    const walk = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.some(walk);
      if (!isObject(node)) return false;
      const value = path.reduce<unknown>((at, name) => (isObject(at) ? at[name] : undefined), node);
      return holdsWord(derivationOf(key), value) || Object.values(node).some(walk);
    };
    return key.startsWith(CLUSTER) ? walk(render.symbol) : walk({ ...style, render: undefined });
  });
}

/** The color key `key` follows on `geometry`; undefined where it follows none. */
export const followedKey = (key: string, geometry: Geometry): string | undefined =>
  DERIVED[key]?.follows[geometry];

/** Whether `value` is one of the words `key` takes in place of a color (`"fill"`, `"auto"`). */
export const isDerivedWord = (key: string, value: unknown): value is string =>
  typeof value === "string" && DERIVED[key]?.words?.[value] !== undefined;

/** The rule `value` of `key` derives its color by: its word's (on a hollow marker its hollow rule), or, unset
 * (`undefined`), the key's absent rule. */
export function ruleOf(key: string, value: unknown, opts: { hollow?: boolean } = {}): RuleName | undefined {
  const derivation = DERIVED[key];
  if (!derivation) return undefined;
  if (isDerivedWord(key, value))
    return (opts.hollow && derivation.hollowWords?.[value]) || derivation.words![value];
  const absent = derivation.absent;
  if (value === undefined && absent && (absent.only !== "hollow" || opts.hollow)) return absent.rule;
  return undefined;
}

/**
 * The color a fixed value of `key` shows, given the fixed color it follows: the rule's color where `value` is one of
 * the key's words or unset where the key follows while unset (`hollow`: the marker is hollow), else `value` itself.
 * `raw`: the followed color stands for one read from a field as it is (`RAW_RULES`). `against`: the fixed value of the
 * key's partner (unset: the partner's reference color; for `Derivation.beside`, `null`: no partner drawn, a halo of
 * width 0 or none at all).
 */
export function derivedColor(
  key: string,
  value: unknown,
  followed: unknown,
  opts: { hollow?: boolean; raw?: boolean; inputs?: RuleInputs; against?: unknown } = {}
): unknown {
  const rule = ruleOf(key, value, opts);
  if (!rule) return value;
  const inputs = opts.inputs ?? {};
  const beside = DERIVED[key].beside;
  if (beside && isDerivedWord(key, value)) {
    // A partner that is no one color (by zoom, by a field) gives no one color either.
    const halo = opts.against === undefined ? DEFAULTS[pathOf(beside.key)] : opts.against;
    if (isObject(halo)) return undefined;
    const on = setColor(halo);
    if (on !== undefined) {
      if (typeof followed !== "string") return followed;
      const withHalo = { ...inputs, halo: on };
      return opts.raw ? RAW_COLOR[beside.rule]!(withHalo) : RULES[beside.rule](followed, withHalo);
    }
  }
  const against = DERIVED[key].against;
  if (against && isDerivedWord(key, value)) {
    const partner = opts.against ?? DEFAULTS[pathOf(against.key)];
    const partnerRule = ruleOf(against.key, partner);
    // A partner that is no one color (by zoom, by a field) gives no one color either.
    if (partnerRule === undefined)
      return typeof partner === "string" ? RULES[against.rule](partner, inputs) : undefined;
    if (partnerRule !== against.pair) {
      // The partner reads this key's word as its own partner, so a partner beside this key takes its own rule.
      const drawn = derivedColor(against.key, partner, followed, { raw: opts.raw, inputs, against: value });
      return typeof drawn === "string" ? RULES[against.rule](drawn, inputs) : drawn;
    }
  }
  if (typeof followed !== "string") return followed;
  // The legend's stand-in for the data's colors has no fallback: a rule that cannot follow the data's color gives its
  // documented color, any other the stand-in as the read and the turned read alike.
  if (opts.raw) return RAW_COLOR[rule]?.(inputs) ?? RAW_RULES[rule](followed, followed, inputs);
  return RULES[rule](followed, inputs);
}

/** Whether the color a fixed value of `key` shows over a blended followed color switches where its answer flips
 * (an on-color, a halo against a partner that is derived) instead of blending (`derivedColor`'s options). */
export function derivedSwitches(
  key: string,
  value: unknown,
  opts: { hollow?: boolean; against?: unknown } = {}
): boolean {
  const rule = ruleOf(key, value, opts);
  if (!rule) return false;
  const beside = DERIVED[key].beside;
  if (beside && isDerivedWord(key, value) && setColor(opts.against) !== undefined)
    return SWITCHED.has(beside.rule);
  const against = DERIVED[key].against;
  if (against && isDerivedWord(key, value)) {
    const partnerRule = ruleOf(against.key, opts.against ?? DEFAULTS[pathOf(against.key)]);
    if (partnerRule === undefined) return false;
    if (partnerRule !== against.pair) return SWITCHED.has(against.rule);
  }
  return SWITCHED.has(rule);
}

/** What a switching color shows over `colors` spread evenly from 0 to 1 and blended in Lab (a palette's ramp in a
 * swatch): each answer of `turn` with where it starts, switching where the map's answer switches. */
export function switchedRamp(colors: string[], turn: (color: string) => string): Array<[number, string]> {
  const outs = colors.map(turn);
  if (colors.length < 2 || !colors.every(isHexColor)) return [[0, outs[0]]];
  const xs = colors.map((_, i) => i / (colors.length - 1));
  const points = breakpoints(xs, outs, (i, x) =>
    turn(blendAt(colors[i], colors[i + 1], (x - xs[i]) / (xs[i + 1] - xs[i]), "lab"))
  );
  return [[0, outs[0]], ...(points as Array<[number, string]>)];
}

/** `turned`, the followed value with each fixed color turned by a rule, with every color read from a field as it is
 * given by `read` from the read in `same` (the followed value as it is) and in `turned` at the same place. Both come
 * from one cascade, so they have one shape; where they do not, `turned` stands. */
function withReads(turned: Value, same: Value, read: (read: Expr, turned: Expr) => Expr): Value {
  const pick = (t: Expr, s: Expr): Expr =>
    Array.isArray(s) && s[0] === "to-color"
      ? read(s, t)
      : Array.isArray(t) && Array.isArray(s) && t.length === s.length && t[0] !== "literal"
        ? t.map((e, i) => pick(e, s[i]))
        : t;
  if (!isZoomed(turned)) return isZoomed(same) ? turned : { expr: pick(turned.expr, same.expr) };
  if (!isZoomed(same) || same.stops.length !== turned.stops.length) return turned;
  return {
    ...turned,
    stops: turned.stops.map(([z, e], i) => [z, pick(e, same.stops[i][1])] as [number, Expr]),
  };
}

/** Stands for the color a rule derives (or an unset key follows) until `substitute`. */
const placeholder = (rule: RuleName) => `\u0000${rule}`;
const partnerPlaceholder = (rule: RuleName) => `\u0000partner:${rule}`;
const ABSENT = "\u0000absent";

export interface DeriveContext {
  geometry: Geometry;
  fields?: Record<string, FieldType>;
  /** The followed color of every feature with each fixed color `map`ped (none: as it is); default: the cascade of
   * the followed key. */
  follow?: (map?: (color: unknown) => Expr) => Value;
  /** Each feature's `marker.fill`, for a key that follows on hollow markers only; default: filled. */
  fill?: Value;
  /** The key's base value where no record sets it, in place of its reference default (a MapLibre value). */
  fallback?: Expr;
  inputs?: RuleInputs;
}

/**
 * The value of the derived color `key` for every feature (spec 6.1): its cascade with each word, and the unset key
 * where it follows, replaced by the rule's color of the followed color, class by class, rule by rule and stop by
 * stop. Where the followed color is read from a field as it is, `RAW_RULES` give the color (spec 4.5).
 */
export function derivedValue(style: JsonObject, key: string, ctx: DeriveContext): Value {
  const derivation = DERIVED[key];
  const c = { fields: ctx.fields };
  const follow =
    ctx.follow ??
    ((map?: (color: unknown) => Expr) =>
      cascade(style, derivation.follows[ctx.geometry]!, map ? { ...c, map } : c));
  const inputs = ctx.inputs ?? {};
  // The followed color turned by each of `rules` in turn, with `given` (default: the context's inputs).
  const derived =
    (rules: RuleName[], given: RuleInputs = inputs) =>
    () => {
      if (rules.length === 1 && rules[0] === "same") return follow();
      const turn = (color: string) => rules.reduce((out, rule) => RULES[rule](out, given), color);
      const turned = follow((color) => (typeof color === "string" ? turn(color) : (color as Expr)));
      const raw = rawRead(rules, given);
      if (rules.some((rule) => SWITCHED.has(rule))) return switched(turned, follow(), turn, raw(null, null));
      const read = withReads(turned, follow(), raw);
      return rules.length === 1 && SIDED.has(rules[0])
        ? sided(read, follow(), turn, haloOf(given), raw(null, null))
        : read;
    };
  const words = derivation.words ?? {};
  const absent = derivation.absent;
  const hollowOnly = absent?.only === "hollow";
  const fill = ctx.fill ?? { expr: true };
  const follows = absent !== undefined && !(hollowOnly && always(fill, true));
  const fallback = follows ? ABSENT : ctx.fallback;
  let value = cascade(style, pathOf(key), {
    ...c,
    ...(derivation.words ? { map: (v: unknown) => (isDerivedWord(key, v) ? placeholder(words[v]) : v) } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
  });
  for (const [word, rule] of Object.entries(words)) {
    let by = derivation.against
      ? () => partnerValue(style, derivation, rule, derived, c, inputs)
      : derivation.beside
        ? () => besideValue(style, derivation, rule, derived, follow, c, inputs)
        : derived([rule]);
    // On a hollow marker the word takes its hollow rule.
    const hollow = derivation.hollowWords?.[word];
    if (hollow && !always(fill, true)) {
      const filled = by;
      by = always(fill, false)
        ? derived([hollow])
        : () => byFill(fill, filled(), derived([hollow])(), "color");
    }
    // The new rules take each record's branch of the followed value; the older ones keep their whole value.
    value = (ALIGNED.has(rule) ? substituteAligned : substitute)(value, placeholder(rule), by);
  }
  if (follows) {
    const followed = derived([absent.rule]);
    value = substitute(
      value,
      ABSENT,
      hollowOnly ? () => byFill(fill, { expr: DEFAULTS[key] as Expr }, followed(), "color") : followed
    );
  }
  return value;
}

/** What `rules`, one after the other, give for a color read from a field as it is: where a rule cannot follow the
 * data's color, its documented color (turned by the rules after it) for the whole read; else the first rule's
 * `RAW_RULES`. */
function rawRead(rules: RuleName[], inputs: RuleInputs): (read: Expr, turned: Expr) => Expr {
  let known: string | undefined;
  for (const rule of rules)
    known = known !== undefined ? RULES[rule](known, inputs) : RAW_COLOR[rule]?.(inputs);
  return (read, turned) => known ?? RAW_RULES[rules[0]](read, turned, inputs);
}

/** A word's color chosen against the key's partner (`Derivation.against`), for every feature: the partner's color as
 * drawn turned by `against.rule`, and where the partner holds its word by `against.pair`, `own` of the followed
 * color. */
function partnerValue(
  style: JsonObject,
  derivation: Derivation,
  own: RuleName,
  derived: (rules: RuleName[]) => () => Value,
  c: { fields?: Record<string, FieldType> },
  inputs: RuleInputs
): Value {
  const { key, rule, pair } = derivation.against!;
  const words = DERIVED[key]?.words ?? {};
  const read = (map: (v: unknown) => Expr) =>
    cascade(style, pathOf(key), {
      ...c,
      map: (v) => (isDerivedWord(key, v) ? partnerPlaceholder(words[v]) : map(v)),
    });
  const turn = (color: string) => RULES[rule](color, inputs);
  const turned = read((v) => (typeof v === "string" ? turn(v) : (v as Expr)));
  const raw = rawRead([rule], inputs);
  const partnerWords = [...new Set(Object.values(words))];
  let value: Value;
  if (SWITCHED.has(rule)) {
    // The partner as it is drawn, its words filled in, so the answer switches where the drawn color flips it.
    let drawn = read((v) => v as Expr);
    for (const partnerRule of partnerWords)
      drawn = substituteAligned(drawn, partnerPlaceholder(partnerRule), derived([partnerRule]));
    value = switched(turned, drawn, turn, raw(null, null));
  } else
    value = withReads(
      turned,
      read((v) => v as Expr),
      raw
    );
  for (const partnerRule of partnerWords)
    value = substituteAligned(
      value,
      partnerPlaceholder(partnerRule),
      partnerRule === pair ? derived([own]) : derived([partnerRule, rule])
    );
  return value;
}

const besidePlaceholder = (halo: string) => `\u0000beside:${halo}`;
const DRAWN = "\u0000beside:drawn";
const UNDRAWN = "\u0000beside:undrawn";

/** Whether every answer of `expr` (through match, case and step) is one of `names`. */
const answersOnly = (expr: Expr, names: string[]): boolean => {
  if (typeof expr === "string") return names.includes(expr);
  if (!Array.isArray(expr)) return false;
  const last = expr.length - 1;
  if (expr[0] === "match")
    return expr.every((e, i) => (i < 3 || (i < last && i % 2 === 0) ? true : answersOnly(e, names)));
  if (expr[0] === "case")
    return expr.every((e, i) => (i === 0 || (i < last && i % 2 === 1) ? true : answersOnly(e, names)));
  if (expr[0] === "step")
    return expr.every((e, i) => (i < 2 || (i > 2 && i % 2 === 1) ? true : answersOnly(e, names)));
  return false;
};

/** The share of a stretch between two halo stops where each of its sub-steps starts, and where its halo is read
 * (`besideRead`): four answers per stretch, each held centred on the zoom it is chosen for. */
const SUB_STEPS: Array<[number, number]> = [
  [1 / 8, 1 / 4],
  [3 / 8, 1 / 2],
  [5 / 8, 3 / 4],
  [7 / 8, 1],
];

/** A word's color read on the key's partner (`Derivation.beside`), for every feature: where the partner draws a color
 * with some opacity, `rule` of the followed color with that color as `inputs.halo`; in records where the partner's width
 * is 0, `own` of the followed color. */
function besideValue(
  style: JsonObject,
  derivation: Derivation,
  own: RuleName,
  derived: (rules: RuleName[], given?: RuleInputs) => () => Value,
  follow: (map?: (color: unknown) => Expr) => Value,
  c: { fields?: Record<string, FieldType> },
  inputs: RuleInputs
): Value {
  const width = pathOf(derivation.beside!.key).replace(/color$/, "width");
  const drawn = drawnHalo(cascade(style, width, { ...c, map: (v) => (haloOff(v) ? UNDRAWN : DRAWN) }));
  const markers = isZoomed(drawn) ? drawn.stops.map(([, e]) => e) : [drawn.expr];
  if (markers.every((e) => e === UNDRAWN)) return derived([own])();
  const read = besideRead(style, derivation, own, derived, follow, c, inputs);
  // A width that is 0 nowhere, or one read from the data: the halo is drawn.
  if (markers.every((e) => e === DRAWN) || !markers.every((e) => answersOnly(e, [DRAWN, UNDRAWN])))
    return read;
  return substituteAligned(substituteAligned(drawn, DRAWN, read), UNDRAWN, derived([own]));
}

/** Where a halo is drawn, from its width turned into markers stop by stop (0: `UNDRAWN`), as a value that steps. A
 * width by zoom that blends draws a halo between a stop of 0 and a stop above it, so such a stop is `UNDRAWN` only where
 * the next stop is 0 too; below its first stop a width stays at that stop's. */
function drawnHalo(markers: Value): Value {
  if (!isZoomed(markers)) return markers;
  if (markers.interpolate === "step") return markers;
  const drawnTo = (a: Expr, b: Expr | undefined): Expr =>
    a === UNDRAWN
      ? b === DRAWN
        ? DRAWN
        : UNDRAWN
      : Array.isArray(a) && Array.isArray(b) && a.length === b.length && a[0] === b[0] && a[0] !== "literal"
        ? a.map((e, i) => drawnTo(e, b[i]))
        : a;
  const stops = markers.stops.map(
    ([z, e], i) => [z, drawnTo(e, markers.stops[i + 1]?.[1])] as [number, Expr]
  );
  // Below the first stop the width is the first stop's: a halo that grows from 0 there starts just above it.
  if (!same(stops[0][1], markers.stops[0][1]) && stops.length > 1)
    stops.splice(0, 1, [stops[0][0], markers.stops[0][1]], [rounded(stops[0][0] + 1e-6), stops[0][1]]);
  return { interpolate: "step", stops, kind: "choice" };
}

/** `besideValue` where the partner is drawn: its color as each record draws it (unset: its reference color).
 * - Where the followed color and the partner's are each one color or vary by zoom alone, the answer is a function of
 *   the zoom: it switches exactly where it changes.
 * - Elsewhere each partner color is filled in with the followed value turned against it, class by class and stop by
 *   stop. A partner by zoom is read at a few sub-steps between its stops (`SUB_STEPS`), each record's answer stepping
 *   there; a partner over a palette holds each stop's answer to the next. */
function besideRead(
  style: JsonObject,
  derivation: Derivation,
  own: RuleName,
  derived: (rules: RuleName[], given?: RuleInputs) => () => Value,
  follow: (map?: (color: unknown) => Expr) => Value,
  c: { fields?: Record<string, FieldType> },
  inputs: RuleInputs
): Value {
  const { key, rule } = derivation.beside!;
  const path = pathOf(key);
  const OWN = besidePlaceholder("");
  const followed = follow();
  const fixed = !isZoomed(followed) && isHexColor(followed.expr) ? followed.expr : undefined;
  // A followed color read from a field as it is, for every feature: its answer is the documented one for the read, the
  // same for every feature, so it is worked out as for one color.
  const raw = !isZoomed(followed) && Array.isArray(followed.expr) && followed.expr[0] === "to-color";
  const answerOf = (color: string | undefined, halo: unknown) => {
    const on = setColor(halo);
    if (color === undefined)
      return on === undefined ? RAW_COLOR[own]?.(inputs) : RAW_COLOR[rule]?.({ ...inputs, halo: on });
    return on === undefined ? RULES[own](color, inputs) : RULES[rule](color, { ...inputs, halo: on });
  };
  // Where no record sets the partner, the map draws its reference color.
  const plain = cascade(style, path, { ...c, map: (v) => (isHexColor(v) ? v : OWN) });
  // A partner by zoom alone that draws a color somewhere, beside a followed color that is one color, by zoom alone or
  // read from a field as it is.
  const byZoomAlone =
    isZoomed(plain) &&
    plain.stops.every(([, e]) => isHexColor(e) || e === OWN) &&
    plain.stops.some(([, e]) => isHexColor(e));
  const followsByZoom = isZoomed(followed) && followed.stops.every(([, e]) => isHexColor(e));
  if (byZoomAlone && (fixed !== undefined || followsByZoom || raw)) {
    const at = (z: number) => {
      if (raw) return answerOf(undefined, valueAt(plain, z));
      const color = fixed ?? valueAt(followed, z);
      return isHexColor(color) ? answerOf(color, valueAt(plain, z)) : undefined;
    };
    const zooms = [
      ...new Set(
        [...(isZoomed(followed) ? followed.stops : []), ...(isZoomed(plain) ? plain.stops : [])].map(
          ([z]) => z
        )
      ),
    ].sort((a, b) => a - b);
    const outs = zooms.map(at) as Expr[];
    if (outs.every((o) => o !== undefined)) {
      const points = breakpoints(zooms, outs, (_, z) => at(z));
      return { interpolate: "step", stops: [[zooms[0], outs[0]], ...points], kind: "color" };
    }
  }
  const answer = (on: string) => RULES[rule](fixed!, { ...inputs, halo: on });
  // The partner's colors: each turned into its answer where the followed color is one color, else into a placeholder
  // filled in below with the followed value turned against it.
  const halos = new Set<string>();
  const turnColor = (v: unknown): Expr => {
    const on = setColor(v);
    if (on === undefined) return OWN;
    if (fixed !== undefined) return answer(on);
    halos.add(on);
    return besidePlaceholder(on);
  };
  let turned = cascade(style, path, { ...c, map: turnColor });
  let partner = plain;
  // A partner blended by zoom beside followed colors that vary per feature: its color at a few sub-steps per stretch.
  if (fixed === undefined && isZoomed(plain) && isZoomed(turned) && plain.interpolate !== "step") {
    const p = plain;
    const t = turned;
    const plainStops: Array<[number, Expr]> = [];
    const turnedStops: Array<[number, Expr]> = [];
    p.stops.forEach(([z, e], i) => {
      plainStops.push([z, e]);
      turnedStops.push([z, t.stops[i][1]]);
      const next = p.stops[i + 1];
      if (!next || !isHexColor(e) || !isHexColor(next[1])) return;
      for (const [start, read] of SUB_STEPS) {
        const color = valueAt(p, z + (next[0] - z) * read) as string;
        plainStops.push([rounded(z + (next[0] - z) * start), color]);
        turnedStops.push([rounded(z + (next[0] - z) * start), turnColor(color)]);
      }
    });
    partner = { interpolate: "step", stops: plainStops, kind: p.kind };
    turned = { interpolate: "step", stops: turnedStops, kind: t.kind };
  }
  // A partner blended over a field beside followed colors that vary per feature: likewise at a few sub-steps.
  if (fixed === undefined && !isZoomed(partner) && !isZoomed(turned)) {
    const [p, t] = subStepped(partner.expr, turned.expr, turnColor);
    partner = { expr: p };
    turned = { expr: t };
  }
  const turn: Turn = (color) => {
    const on = setColor(color);
    return fixed !== undefined && on !== undefined ? answer(on) : undefined;
  };
  let value = switched(turned, partner, turn, OWN);
  value = substituteAligned(value, OWN, derived([own]));
  for (const on of halos)
    value = substituteAligned(value, besidePlaceholder(on), derived([rule], { ...inputs, halo: on }));
  return value;
}

/** Where `turn` of a color blended between stops `xs` lies on the other side of `halo` than before (lighter or darker
 * than it): the position, and the answers just before and from there. */
function sideTurns(
  xs: number[],
  outs: Expr[],
  halo: string,
  answerAt: (i: number, x: number) => string
): Array<{ at: number; before: string; after: string }> {
  const lighter = (color: unknown) =>
    typeof color === "string" && contrastRatio(color, LIGHT) < contrastRatio(halo, LIGHT);
  const out: Array<{ at: number; before: string; after: string }> = [];
  if (!isHexColor(halo) || !outs.every(isHexColor)) return out;
  for (let i = 0; i < xs.length - 1; i++) {
    let prev = xs[i];
    let side = lighter(outs[i]);
    for (let k = 1; k <= SAMPLES; k++) {
      const x = k === SAMPLES ? xs[i + 1] : xs[i] + ((xs[i + 1] - xs[i]) * k) / SAMPLES;
      const answer = k === SAMPLES ? (outs[i + 1] as string) : answerAt(i, x);
      if (lighter(answer) !== side) {
        let [lo, hi] = [prev, x];
        for (let n = 0; n < 40; n++) {
          const mid = (lo + hi) / 2;
          if (lighter(answerAt(i, mid)) === side) lo = mid;
          else hi = mid;
        }
        const at = rounded(hi) > lo && rounded(hi) < xs[i + 1] ? rounded(hi) : hi;
        out.push({ at, before: answerAt(i, lo), after: answerAt(i, hi) });
        side = !side;
      }
      prev = x;
    }
  }
  return out;
}

/** `value` (the followed value turned by a sided rule, `SIDED`) where a blend between two answers on either side of
 * `halo` steps at the turn instead: a palette over a field in steps of interpolations, a color by zoom in steps at its
 * stops and turns. */
function sided(value: Value, plain: Value, turn: (color: string) => string, halo: string, raw: Expr): Value {
  if (!isZoomed(value) || !isZoomed(plain)) {
    return isZoomed(value) || isZoomed(plain)
      ? value
      : { expr: sidedExpr(value.expr, plain.expr, turn, halo) };
  }
  if (value.stops.length !== plain.stops.length) return value;
  const stops = value.stops.map(
    ([z, e], i) => [z, sidedExpr(e, plain.stops[i][1], turn, halo)] as [number, Expr]
  );
  const xs = plain.stops.map(([z]) => z);
  const hex = plain.interpolate !== "step" && plain.stops.every(([, e]) => isHexColor(e));
  // Colors by zoom that vary per feature: a step at each stop and at a few sub-steps between, each feature's answer
  // chosen for the color it blends to there. Beside one halo color every answer meets the floor; only its tint lags.
  if (!hex && plain.interpolate !== "step" && isHexColor(halo)) {
    const all: Array<[number, Expr]> = [];
    stops.forEach(([z, e], i) => {
      all.push([z, e]);
      const next = xs[i + 1];
      if (next === undefined) return;
      for (const [start, read] of SUB_STEPS) {
        const blended = valueAt(plain, z + (next - z) * read);
        all.push([
          rounded(z + (next - z) * start),
          sidedExpr(turnLeaves(blended, turn, raw), blended, turn, halo),
        ]);
      }
    });
    return { interpolate: "step", stops: all, kind: value.kind };
  }
  const turns = hex
    ? sideTurns(
        xs,
        stops.map(([, e]) => e),
        halo,
        (_, z) => turn(valueAt(plain, z) as string)
      )
    : [];
  if (!turns.length) return { ...value, stops };
  const all = [...stops, ...turns.map(({ at, after }) => [at, after] as [number, Expr])].sort(
    (a, b) => a[0] - b[0]
  );
  return { interpolate: "step", stops: all, kind: value.kind };
}

function sidedExpr(turned: Expr, plain: Expr, turn: (color: string) => string, halo: string): Expr {
  if (
    !Array.isArray(plain) ||
    !Array.isArray(turned) ||
    plain[0] === "literal" ||
    turned.length !== plain.length
  )
    return turned;
  if ((plain[0] === "interpolate" || plain[0] === "interpolate-lab") && typeof plain[2] !== "number") {
    const [op, curve, input, ...stops] = plain;
    const xs = stops.filter((_, i) => i % 2 === 0) as number[];
    const colors = stops.filter((_, i) => i % 2 === 1);
    const outs = turned.slice(3).filter((_, i) => i % 2 === 1);
    const space = op === "interpolate-lab" ? "lab" : "rgb";
    if (!colors.every(isHexColor) || !xs.every((x) => typeof x === "number")) return turned;
    const turns = sideTurns(xs, outs, halo, (i, x) =>
      turn(blendAt(colors[i], colors[i + 1], factorOf(curve, x, xs[i], xs[i + 1]), space))
    );
    if (!turns.length) return turned;
    // Each run between two turns: the interpolation of its answers, from the answer at its start to the one at its end.
    const runs: Array<Array<[number, Expr]>> = [[]];
    let k = 0;
    xs.forEach((x, i) => {
      while (k < turns.length && turns[k].at <= x) {
        runs[runs.length - 1].push([turns[k].at, turns[k].before]);
        runs.push([[turns[k].at, turns[k].after]]);
        k++;
      }
      const run = runs[runs.length - 1];
      if (!run.length || run[run.length - 1][0] < x) run.push([x, outs[i]]);
    });
    for (; k < turns.length; k++) {
      runs[runs.length - 1].push([turns[k].at, turns[k].before]);
      runs.push([[turns[k].at, turns[k].after]]);
    }
    const interpolation = (run: Array<[number, Expr]>): Expr =>
      run.length === 1 ? run[0][1] : [op, curve, input, ...run.flat()];
    return [
      "step",
      input,
      interpolation(runs[0]),
      ...turns.flatMap((t, i) => [t.at, interpolation(runs[i + 1])]),
    ];
  }
  return turned.map((e, i) => sidedExpr(e, plain[i], turn, halo));
}

/** `expr` (a followed value at one zoom) with each fixed color, and each blend of two at a known share, turned by
 * `turn`, and each color read from a field as it is `raw`. A blend of two values of one shape (a match on the same
 * classes) is turned branch by branch, so no two answers blend. */
function turnLeaves(expr: Expr, turn: (color: string) => string, raw: Expr): Expr {
  if (isHexColor(expr)) return turn(expr);
  if (!Array.isArray(expr) || expr[0] === "literal") return expr;
  if (expr[0] === "to-color") return raw;
  const [op, , share, , a, , b] = expr;
  if (op === "interpolate" && typeof share === "number" && expr.length === 7) {
    const blend = (x: Expr, y: Expr): Expr => {
      if (isHexColor(x) && isHexColor(y)) return turn(blendAt(x, y, share, "rgb"));
      if (same(x, y)) return turnLeaves(x, turn, raw);
      if (
        Array.isArray(x) &&
        Array.isArray(y) &&
        x.length === y.length &&
        x[0] === y[0] &&
        x[0] !== "literal"
      )
        return x.map((e, i) => (i === 0 ? e : blend(e, y[i])));
      return ["interpolate", ["linear"], share, 0, turnLeaves(x, turn, raw), 1, turnLeaves(y, turn, raw)];
    };
    return blend(a, b);
  }
  return expr.map((e, i) => (i === 0 ? e : turnLeaves(e, turn, raw)));
}

/** `plain` and `turned` (the partner's colors as drawn and as turned by `turnColor`) with each blend over a field
 * between fixed colors read at a few sub-steps per stretch (`SUB_STEPS`), each holding its answer there. */
function subStepped(plain: Expr, turned: Expr, turnColor: (color: string) => Expr): [Expr, Expr] {
  if (
    !Array.isArray(plain) ||
    !Array.isArray(turned) ||
    plain[0] === "literal" ||
    plain.length !== turned.length
  )
    return [plain, turned];
  if ((plain[0] === "interpolate" || plain[0] === "interpolate-lab") && typeof plain[2] !== "number") {
    const [op, curve, input, ...stops] = plain;
    const xs = stops.filter((_, i) => i % 2 === 0) as number[];
    const colors = stops.filter((_, i) => i % 2 === 1);
    const outs = turned.slice(3).filter((_, i) => i % 2 === 1);
    if (colors.every(isHexColor) && xs.every((x) => typeof x === "number")) {
      const space = op === "interpolate-lab" ? "lab" : "rgb";
      const p: Expr[] = [colors[0]];
      const t: Expr[] = [outs[0]];
      for (let i = 0; i < xs.length - 1; i++) {
        for (const [start, read] of SUB_STEPS) {
          const color = blendAt(
            colors[i],
            colors[i + 1],
            factorOf(curve, xs[i] + (xs[i + 1] - xs[i]) * read, xs[i], xs[i + 1]),
            space
          );
          const at = rounded(xs[i] + (xs[i + 1] - xs[i]) * start);
          p.push(at, read === 1 ? colors[i + 1] : color);
          t.push(at, read === 1 ? outs[i + 1] : turnColor(color));
        }
      }
      return [
        ["step", input, ...p],
        ["step", input, ...t],
      ];
    }
  }
  const pairs = plain.map((e, i) => subStepped(e, turned[i], turnColor));
  return [pairs.map(([a]) => a), pairs.map(([, b]) => b)];
}
