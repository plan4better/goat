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

const hasInterpolate = (expr: Expr): boolean =>
  Array.isArray(expr) && expr[0] !== "literal" && (expr[0] === "interpolate" || expr.some(hasInterpolate));

/** Color strings inside an interpolate parsed as colors: outside a paint property nothing says they are colors. */
function colorOutputs(expr: Expr): Expr {
  if (!Array.isArray(expr) || expr[0] === "literal") return expr;
  if (expr[0] === "interpolate")
    return expr.map((e, i) =>
      i >= 4 && i % 2 === 0 ? (typeof e === "string" ? ["to-color", e] : colorOutputs(e)) : e
    );
  return expr.map(colorOutputs);
}

/** A color as text in an image name: a fixed color as it is, an interpolated one as MapLibre writes colors. */
export const colorText = (expr: Expr): Expr =>
  hasInterpolate(expr) ? ["to-string", ["to-color", colorOutputs(expr)]] : expr;

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
