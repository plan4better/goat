// The names of images the renderer draws on demand (markers with a shape, fill patterns): a prefix and the look's
// parts joined by `|`, built per feature and zoom from the style's values.
import { type Expr, type Value, isZoomed, valueAt } from "@/lib/style/compile/values";

/** A value by zoom with a stop at every whole zoom between its stops, so a step through images follows its curve
 * closely; other values as they are. */
export function everyZoom(value: Value): Value {
  if (!isZoomed(value) || value.interpolate === "step" || value.kind === "choice") return value;
  const first = value.stops[0][0];
  const last = value.stops[value.stops.length - 1][0];
  const zooms = new Set(value.stops.map(([z]) => z));
  for (let z = Math.ceil(first); z < last; z++) zooms.add(z);
  return {
    ...value,
    stops: [...zooms].sort((a, b) => a - b).map((z) => [z, valueAt(value, z)] as [number, Expr]),
  };
}

/** A value by zoom as images draw it: its color at each whole zoom, held up to the next (a step). */
export function wholeZooms(value: Value): Value {
  const sampled = everyZoom(value);
  return isZoomed(sampled) ? { ...sampled, interpolate: "step" } : sampled;
}

const INTERPOLATIONS = new Set(["interpolate", "interpolate-lab", "interpolate-hcl"]);

/** Whether a color value holds a color MapLibre types as a color: an interpolation, or a color read from a field
 * among the choices of a match, case or step (alone, a read is written into the name as MapLibre writes colors). */
const hasColorValue = (expr: Expr, nested = false): boolean =>
  Array.isArray(expr) &&
  expr[0] !== "literal" &&
  (INTERPOLATIONS.has(expr[0] as string) ||
    (nested && expr[0] === "to-color") ||
    expr.slice(1).some((e) => hasColorValue(e, true)));

/** Color strings among the outputs of an interpolation, and of the choices around one or around a color read from a
 * field, parsed as colors: outside a paint property nothing says they are colors, and a choice between a text and a
 * typed color does not type. */
function colorOutputs(expr: Expr): Expr {
  if (!Array.isArray(expr) || expr[0] === "literal") return expr;
  const color = (e: Expr): Expr => (typeof e === "string" && e ? ["to-color", e] : colorOutputs(e));
  const last = expr.length - 1;
  const op = expr[0];
  if (INTERPOLATIONS.has(op as string)) return expr.map((e, i) => (i >= 4 && i % 2 === 0 ? color(e) : e));
  if (op === "case") return expr.map((e, i) => (i >= 2 && (i % 2 === 0 || i === last) ? color(e) : e));
  if (op === "match") return expr.map((e, i) => (i >= 3 && (i % 2 === 1 || i === last) ? color(e) : e));
  if (op === "step") return expr.map((e, i) => (i >= 2 && i % 2 === 0 ? color(e) : e));
  if (op === "coalesce") return expr.map((e, i) => (i >= 1 ? color(e) : e));
  return expr.map(colorOutputs);
}

/** A color as text in an image name: a fixed color as it is, an interpolated one or one read from a field as MapLibre
 * writes colors. */
export const colorText = (expr: Expr): Expr =>
  hasColorValue(expr) ? ["to-string", ["to-color", colorOutputs(expr)]] : expr;

export const numberText = (expr: Expr): Expr =>
  typeof expr === "number" ? String(Math.round(expr * 100) / 100) : ["to-string", expr];

/** `parts` concatenated, neighbouring texts joined: one text when every part is fixed. */
export function concat(parts: Expr[]): Expr {
  const joined: Expr[] = [];
  for (const part of parts) {
    const last = joined[joined.length - 1];
    if (typeof part === "string" && typeof last === "string") joined[joined.length - 1] = last + part;
    else joined.push(part);
  }
  return joined.length === 1 ? joined[0] : ["concat", ...joined];
}
