// The legend cases' values by attribute put in zoom stops (spec 4.4), for the tests that hold the legend of a size or
// a color that follows a field and changes with the zoom against the plain value by attribute and against the map.
import { type JsonObject, isObject } from "@/lib/style/json";

import type { LegendCase } from "./caseList";

/** The parts of the layer's symbol whose values by attribute the legend shows as a ramp or samples. */
const PARTS = ["marker", "outline", "line", "casing", "fill"];

/** How a variant puts a value by attribute in zoom stops, around the case's zoom `z`. */
export type ZoomStops = (form: JsonObject, z: number) => JsonObject;

/** The form with another range or palette: what a later or an earlier stop changes. */
const grown = (form: JsonObject): JsonObject =>
  Array.isArray(form.range)
    ? { ...form, range: [(form.range[0] as number) + 2, (form.range[1] as number) * 2] }
    : { ...form, reverse: form.reverse !== true };
const shrunk = (form: JsonObject): JsonObject =>
  Array.isArray(form.range)
    ? { ...form, range: [(form.range[0] as number) / 2, (form.range[1] as number) / 2] }
    : { ...form, reverse: form.reverse !== true };

/** The variants: the same form at two stops; two stops whose middle (where the legend reads sizes, spec 7.2) and the
 * case's zoom (where it reads colors) lie between them, on a linear and on an exponential curve; and three stops
 * whose middle stop is at the case's zoom. */
export const ZOOM_STOPS: Record<string, ZoomStops> = {
  same: (form, z) => ({
    zoom: [
      [z - 2, form],
      [z + 2, form],
    ],
  }),
  between: (form, z) => ({
    zoom: [
      [z - 1, form],
      [z + 3, grown(form)],
    ],
  }),
  exponential: (form, z) => ({
    zoom: [
      [z - 1, form],
      [z + 3, grown(form)],
    ],
    interpolate: "exponential",
    base: 1.6,
  }),
  on_a_stop: (form, z) => ({
    zoom: [
      [z - 2, shrunk(form)],
      [z, form],
      [z + 2, grown(form)],
    ],
  }),
};

/** Whether a value is a range or a palette by a field. */
const byAttribute = (form: unknown): form is JsonObject =>
  isObject(form) && typeof form.field === "string" && (Array.isArray(form.range) || "palette" in form);

/** The `part.key` paths of the case's values by attribute (ranges and palettes) on its symbol. */
export function attributePaths(c: LegendCase): string[] {
  const symbol = isObject(c.style.symbol) ? c.style.symbol : {};
  return PARTS.flatMap((part) => {
    const node = symbol[part];
    return isObject(node)
      ? Object.entries(node).flatMap(([key, form]) => (byAttribute(form) ? [`${part}.${key}`] : []))
      : [];
  });
}

/** The case with each value by attribute of its symbol put in zoom stops by `stops`; null where it has none. */
export function inZoomStops(c: LegendCase, name: string, stops: ZoomStops): LegendCase | null {
  const paths = attributePaths(c);
  if (!paths.length) return null;
  const symbol = { ...(c.style.symbol as JsonObject) };
  for (const path of paths) {
    const [part, key] = path.split(".");
    const node = { ...(symbol[part] as JsonObject) };
    node[key] = stops(node[key] as JsonObject, c.zoom);
    symbol[part] = node;
  }
  return { ...c, id: `${c.id}-${name}`, style: { ...c.style, symbol } };
}
