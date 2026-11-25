// Colors one part takes from another (spec 3.1 to 3.3, 8.2, 8.3, 18.10): an outline in the fill color (`"fill"`) or a
// darker shade of it (`"auto"`), a casing in a darker shade of the line, a hexagon outline in a darker shade of each
// hexagon, a pattern and arrows in the hue they follow while unset, opaque, the icon of a hollow marker in the marker's
// hue, a label's text and halo chosen together for the basemap from the feature's color, an icon and a cluster's number
// in white or dark on the color underneath. `DERIVED` says what each key follows and by which rule (goatlib's
// `data/color_keys.json` lists where `"auto"` is taken); the compiler asks it for every feature (`derivedValue`), the
// legend and the panel for one fixed color (`derivedColor`), so the three draw the same.
import { Color, interpolates } from "@maplibre/maplibre-gl-style-spec";

import { LABEL_FALLBACK, LIGHT, haloAgainst, labelPair, onColor, opaque, shade } from "@/lib/style/colors";
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
 * `halo_against`, a halo that meets the contrast floor against a set text color. */
export type RuleName = "same" | "hue" | "shade" | "label_text" | "label_halo" | "on_color" | "halo_against";

const toneOf = (inputs: RuleInputs) => (inputs.tone === "dark" ? "dark" : "light");

export const RULES: Readonly<Record<RuleName, Rule>> = {
  same: (color) => color,
  hue: (color) => opaque(color),
  shade: (color) => shade(color),
  label_text: (color, inputs) => labelPair(color, toneOf(inputs)).text,
  label_halo: (color, inputs) => labelPair(color, toneOf(inputs)).halo,
  on_color: (color) => onColor(color),
  halo_against: (color) => haloAgainst(color),
};

/** What a rule that cannot follow the data's color draws for every feature of a field read as it is (spec 18.10): the
 * label's neutral pair for the tone, white for an on-color. The other rules draw the data's color itself. */
const RAW_COLOR: Partial<Record<RuleName, (inputs: RuleInputs) => string>> = {
  label_text: (inputs) => LABEL_FALLBACK[toneOf(inputs)].text,
  label_halo: (inputs) => LABEL_FALLBACK[toneOf(inputs)].halo,
  on_color: () => LIGHT,
  halo_against: () => LIGHT,
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
};

/** The rules that choose among a few colors (white or dark, black for a halo): where the color they look at blends (a palette over a
 * field, a color by zoom), their answer switches where it flips instead of blending through grey (`switched`). */
const SWITCHED: ReadonlySet<RuleName> = new Set(["on_color", "halo_against"]);

/** The samples per blended stretch at which a switching rule looks for where its answer flips. */
const SAMPLES = 64;

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
 * first sample that differs. */
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
      if (!same(answer, current)) {
        // Where between this sample and the one before the answer turns, to a tiny share of the stretch.
        let [lo, hi] = [xs[i] + ((xs[i + 1] - xs[i]) * (k - 1)) / SAMPLES, x];
        for (let n = 0; n < 24; n++) {
          const mid = (lo + hi) / 2;
          if (same(answerAt(i, mid), answer)) hi = mid;
          else lo = mid;
        }
        out.push([rounded(hi), answer]);
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

/** `turned` (the followed value with each fixed color turned by `turn`) where every blend between fixed colors of
 * `plain` (the followed value as it is) is a step that switches where `turn` of the blended color changes, and every
 * color read from a field as it is is `raw`. */
function switchedExpr(turned: Expr, plain: Expr, turn: (color: string) => string, raw: Expr): Expr {
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
      if (typeof input === "number")
        return turn(
          blendAt(colors[0], colors[colors.length - 1], factorOf(curve, input, xs[0], xs.at(-1)!), space)
        );
      const points = breakpoints(xs, outs, (i, x) =>
        turn(blendAt(colors[i], colors[i + 1], factorOf(curve, x, xs[i], xs[i + 1]), space))
      );
      return points.length ? ["step", input, outs[0], ...points.flat()] : outs[0];
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
function switched(turned: Value, plain: Value, turn: (color: string) => string, raw: Expr): Value {
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
  "label.color": { follows: MAIN_COLOR, words: { auto: "label_text" } },
  "label.halo.color": {
    follows: MAIN_COLOR,
    words: { auto: "label_halo" },
    against: { key: "label.color", rule: "halo_against", pair: "label_text" },
  },
  // A cluster's number sits on the cluster's marker. Its halo contrasts with the number as it is drawn: the table names
  // the rule `label_halo` (a halo), but with no `pair` its own rule is never reached, the halo against the number always is.
  "cluster.symbol.label.color": {
    path: "label.color",
    follows: { point: "marker.color" },
    words: { auto: "on_color" },
  },
  "cluster.symbol.label.halo.color": {
    path: "label.halo.color",
    follows: { point: "marker.color" },
    words: { auto: "label_halo" },
    against: { key: "cluster.symbol.label.color", rule: "halo_against" },
  },
};

const CLUSTER = "cluster.symbol.";

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
 * key's partner (`Derivation.against`; unset: the partner's reference color).
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
  const against = DERIVED[key].against;
  if (against && isDerivedWord(key, value)) {
    const partner = opts.against ?? DEFAULTS[pathOf(against.key)];
    const partnerRule = ruleOf(against.key, partner);
    // A partner that is no one color (by zoom, by a field) gives no one color either.
    if (partnerRule === undefined)
      return typeof partner === "string" ? RULES[against.rule](partner, inputs) : undefined;
    if (partnerRule !== against.pair) {
      const drawn = derivedColor(against.key, partner, followed, { raw: opts.raw, inputs });
      return typeof drawn === "string" ? RULES[against.rule](drawn, inputs) : drawn;
    }
  }
  if (typeof followed !== "string") return followed;
  // The legend's stand-in for the data's colors has no fallback: a rule that cannot follow the data's color gives its
  // documented color, any other the stand-in as the read and the turned read alike.
  if (opts.raw) return RAW_COLOR[rule]?.(inputs) ?? RAW_RULES[rule](followed, followed, inputs);
  return RULES[rule](followed, inputs);
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
  // The followed color turned by each of `rules` in turn.
  const derived = (rules: RuleName[]) => () => {
    if (rules.length === 1 && rules[0] === "same") return follow();
    const turn = (color: string) => rules.reduce((out, rule) => RULES[rule](out, inputs), color);
    const turned = follow((color) => (typeof color === "string" ? turn(color) : (color as Expr)));
    const raw = rawRead(rules, inputs);
    return rules.some((rule) => SWITCHED.has(rule))
      ? switched(turned, follow(), turn, raw(null, null))
      : withReads(turned, follow(), raw);
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
