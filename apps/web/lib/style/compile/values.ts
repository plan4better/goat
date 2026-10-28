// Value forms (spec 4.1 to 4.4, 5.8) as MapLibre expressions. A value is either one expression or stops over
// zoom; MapLibre accepts ["zoom"] only as the input of a top-level interpolate or step, so values are combined stop
// by stop (`combine`) and turned into a property only at the end (`toProperty`).
import { PALETTES } from "@/lib/style/generated/catalog";
import { isObject } from "@/lib/style/json";

export type Expr = unknown;
export type Kind = "color" | "number" | "choice";
export type Curve = ["linear"] | ["exponential", number];

export type Value =
  | { expr: Expr }
  | { interpolate: Curve | "step"; stops: Array<[number, Expr]>; kind: Kind };

type Zoomed = Extract<Value, { stops: unknown }>;

export const isZoomed = (value: Value): value is Zoomed => "stops" in value;

const constant = (value: unknown): Expr => (Array.isArray(value) ? ["literal", value] : value);

const domainOf = (form: Record<string, unknown>): [number, number] | null => {
  const domain = Array.isArray(form.domain)
    ? form.domain
    : isObject(form.computed)
      ? form.computed.domain
      : null;
  return Array.isArray(domain) && domain.length === 2 && domain.every((d) => typeof d === "number")
    ? [domain[0] as number, domain[1] as number]
    : null;
};

const paletteColors = (palette: unknown): string[] | null => {
  if (Array.isArray(palette)) return palette.filter((c): c is string => typeof c === "string");
  if (typeof palette === "string") return PALETTES[palette] ? [...PALETTES[palette].colors] : null;
  return null;
};

/**
 * The input a scale interpolates over (spec 5.8): the value itself, or its square root or logarithm with the values
 * the scale cannot map (below 0, from 0 down) as no data; `at` maps a domain end the same way.
 */
function scaleOf(scale: unknown, field: string, number: Expr) {
  if (scale === "sqrt")
    return {
      input: ["sqrt", number] as Expr,
      has: ["all", ["has", field], [">=", number, 0]] as Expr,
      at: Math.sqrt,
    };
  if (scale === "log")
    return {
      input: ["ln", number] as Expr,
      has: ["all", ["has", field], [">", number, 0]] as Expr,
      at: Math.log,
    };
  return { input: number, has: ["has", field] as Expr, at: (x: number) => x };
}

/** A value form by attribute: a palette ramp (colors) or a range (numbers) over a scale, guarded for missing data. */
function byAttribute(form: Record<string, unknown>, fallback: Expr): Expr {
  const field = form.field as string;
  const domain = domainOf(form);
  const noData = "no_data" in form && form.no_data !== undefined ? form.no_data : fallback;
  if (!domain) return fallback;
  let [d0, d1] = domain;
  const number: Expr = ["to-number", ["get", field], 0];
  const scale = form.scale;
  const { input, has, at } = scaleOf(scale, field, number);
  // Values below 0 (sqrt) or from 0 down (log) are no data: a sqrt domain starts at 0 at the lowest, and a log
  // domain that does not start above 0 (domain_invalid) draws the start value, like a domain of one value.
  const flat = () => {
    if (scale === "sqrt") d0 = Math.max(d0, 0);
    return d0 >= d1 || (scale === "log" && d0 <= 0);
  };
  if ("palette" in form) {
    const colors = paletteColors(form.palette);
    if (!colors || !colors.length) return fallback;
    if (form.reverse === true) colors.reverse();
    // A reversed domain is the same ramp the other way round; MapLibre needs ascending stops.
    if (d0 > d1) {
      [d0, d1] = [d1, d0];
      colors.reverse();
    }
    if (colors.length === 1 || flat()) return ["case", ["has", field], colors[0], noData];
    const [t0, t1] = [at(d0), at(d1)];
    const stops = colors.flatMap((c, i) => [t0 + (i * (t1 - t0)) / (colors.length - 1), c]);
    return ["case", has, ["interpolate-lab", ["linear"], input, ...stops], noData];
  }
  let range = form.range as [number, number];
  if (d0 > d1) {
    [d0, d1] = [d1, d0];
    range = [range[1], range[0]];
  }
  if (flat()) return ["case", ["has", field], range[0], noData];
  return ["case", has, ["interpolate", ["linear"], input, at(d0), range[0], at(d1), range[1]], noData];
}

/**
 * One value form as a value. `fallback` is the property's base value (what an absent form or missing data draws);
 * `map` turns fixed values into what MapLibre wants (dash names into arrays, say).
 */
export function fromForm(
  form: unknown,
  kind: Kind,
  fallback: Expr,
  map: (v: unknown) => Expr = constant
): Value {
  if (form === undefined || form === null) return { expr: fallback };
  if (isObject(form) && Array.isArray(form.zoom)) {
    const stops = (form.zoom as unknown[][]).map(([z, v]) => {
      const inner = fromForm(v, kind, fallback, map);
      return [z as number, isZoomed(inner) ? fallback : inner.expr] as [number, Expr];
    });
    const interpolate: Curve | "step" =
      kind === "choice" || form.interpolate === "step"
        ? "step"
        : form.interpolate === "exponential"
          ? ["exponential", typeof form.base === "number" ? form.base : 1.6]
          : ["linear"];
    return { interpolate, stops, kind };
  }
  if (isObject(form) && typeof form.field === "string") {
    if ("palette" in form || "range" in form) return { expr: byAttribute(form, fallback) };
    const get = ["get", form.field];
    if (kind === "number") return { expr: ["to-number", get, fallback] };
    if (kind === "color") return { expr: ["to-color", get, fallback] };
    return { expr: get };
  }
  return { expr: map(form) };
}

const round = (x: number) => Number(x.toFixed(10));

const ARITHMETIC: Record<string, (args: number[]) => number> = {
  "+": (a) => a.reduce((x, y) => x + y, 0),
  "*": (a) => a.reduce((x, y) => x * y, 1),
  "-": (a) => (a.length === 1 ? -a[0] : a[0] - a[1]),
  "/": (a) => a[0] / a[1],
  max: (a) => Math.max(...a),
  min: (a) => Math.min(...a),
};

/** Constant arithmetic folded to a number, everywhere in the expression. */
export function fold(expr: Expr): Expr {
  if (!Array.isArray(expr) || expr[0] === "literal") return expr;
  const [op, ...args] = expr;
  // Category labels are data, never arithmetic: only the input and the outputs of a match fold.
  if (op === "match")
    return ["match", ...args.map((a, i) => (i % 2 === 1 && i < args.length - 1 ? a : fold(a)))];
  const folded = args.map(fold);
  if (typeof op === "string" && op in ARITHMETIC && folded.every((a) => typeof a === "number")) {
    return round(ARITHMETIC[op](folded as number[]));
  }
  // A sum or product with a data expression: the constants combined, a neutral one (0, 1) left out.
  const numbers = folded.filter((a): a is number => typeof a === "number");
  const rest = folded.filter((a) => typeof a !== "number");
  if ((op === "+" || op === "*") && numbers.length && rest.every(Array.isArray)) {
    const c = round(ARITHMETIC[op](numbers));
    if (op === "*" && c === 0) return 0;
    const kept = c === (op === "*" ? 1 : 0) ? rest : [...rest, c];
    return kept.length === 1 ? kept[0] : [op, ...kept];
  }
  return [op, ...folded];
}

const hex = (color: string): number[] | null => {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (!m) return null;
  const v = m[1] + (m[2] ?? "ff");
  return [0, 2, 4, 6].map((i) => parseInt(v.slice(i, i + 2), 16));
};

const toHex = (rgba: number[]) =>
  "#" +
  rgba
    .slice(0, rgba[3] === 255 ? 3 : 4)
    .map((c) =>
      Math.floor(c + 0.5)
        .toString(16)
        .padStart(2, "0")
    )
    .join("");

/** The value at zoom `z`, by the value's own curve between its stops. */
export function valueAt(value: Value, z: number): Expr {
  if (!isZoomed(value)) return value.expr;
  const { stops, interpolate, kind } = value;
  if (z <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (z >= last[0]) return last[1];
  const i = stops.findIndex(([zi], k) => zi <= z && z < stops[k + 1][0]);
  const [z0, a] = stops[i];
  const [z1, b] = stops[i + 1];
  if (z === z0 || interpolate === "step" || kind === "choice") return a;
  const t =
    interpolate[0] === "exponential"
      ? (interpolate[1] ** (z - z0) - 1) / (interpolate[1] ** (z1 - z0) - 1)
      : (z - z0) / (z1 - z0);
  if (typeof a === "number" && typeof b === "number") return round(a + (b - a) * t);
  if (typeof a === "string" && typeof b === "string") {
    const ca = hex(a);
    const cb = hex(b);
    if (ca && cb) return toHex(ca.map((c, k) => c + (cb[k] - c) * t));
    return a;
  }
  if (kind === "number") return fold(["+", ["*", a, round(1 - t)], ["*", b, round(t)]]);
  return a;
}

const sameCurve = (a: Curve, b: Curve) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * `fn` applied to the values. With zoom values among them, over the union of their stop zooms, each value taken at
 * each stop: a step when any is a step (or `opts.step`), their curve when they share one, otherwise linear.
 */
export function combine(
  values: Value[],
  fn: (exprs: Expr[]) => Expr,
  opts: { step?: boolean; kind?: Kind } = {}
): Value {
  const zoomed = values.filter(isZoomed);
  if (!zoomed.length) return { expr: fold(fn(values.map((v) => (v as { expr: Expr }).expr))) };
  const zooms = [...new Set(zoomed.flatMap((v) => v.stops.map(([z]) => z)))].sort((a, b) => a - b);
  const curves = zoomed.map((v) => v.interpolate);
  const interpolate: Curve | "step" =
    opts.step || curves.some((c) => c === "step")
      ? "step"
      : curves.every((c) => c !== "step" && sameCurve(c, curves[0] as Curve))
        ? (curves[0] as Curve)
        : ["linear"];
  const stops = zooms.map((z) => [z, fold(fn(values.map((v) => valueAt(v, z))))] as [number, Expr]);
  return { interpolate, stops, kind: opts.kind ?? zoomed[0].kind };
}

/** The value as a MapLibre property: the expression, or a top-level interpolate or step on ["zoom"]. */
export function toProperty(value: Value): Expr {
  if (!isZoomed(value)) return value.expr;
  const { stops, interpolate } = value;
  if (stops.length === 1) return stops[0][1];
  if (interpolate === "step") return ["step", ["zoom"], stops[0][1], ...stops.slice(1).flat()];
  return ["interpolate", interpolate, ["zoom"], ...stops.flat()];
}

/** Stands for a color another part supplies (an outline in the fill color, a pattern's default) until `substitute`. */
export const FILL_COLOR = "\u0000fill";

const uses = (expr: Expr, name: string): boolean =>
  expr === name || (Array.isArray(expr) && expr.some((e) => uses(e, name)));

const replaced = (expr: Expr, name: string, by: Expr): Expr =>
  expr === name
    ? by
    : Array.isArray(expr) && expr[0] !== "literal"
      ? expr.map((e) => replaced(e, name, by))
      : expr;

/** `value` with the placeholder `name` replaced by the color `by`, stop by stop when either varies by zoom. */
export function substitute(value: Value, name: string, by: Value): Value {
  const found = isZoomed(value) ? value.stops.some(([, e]) => uses(e, name)) : uses(value.expr, name);
  return found ? combine([value, by], ([v, b]) => replaced(v, name, b), { kind: "color" }) : value;
}
