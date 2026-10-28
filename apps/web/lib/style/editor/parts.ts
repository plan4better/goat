// Part-level edits of a document (spec 3, 3.3, 8): which parts are drawn, the marker's shape, what `render` hides,
// and the cluster symbol the panel edits.
import { DEFAULT_CLUSTER_SYMBOL } from "@/lib/style/compile/render";
import type { Geometry } from "@/lib/style/compile/types";
import { switchMode, targetsOf } from "@/lib/style/editor/forms";
import { getIn, setIn } from "@/lib/style/editor/store";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, clone, isObject } from "@/lib/style/json";
import { type MarkerShapeId, isPin, markerShapeOf, symbolShape } from "@/lib/style/markerShapes";

/** The part a geometry draws when the symbol leaves it out (spec 3). */
export const MAIN_PART: Readonly<Record<Geometry, string>> = {
  polygon: "fill",
  line: "line",
  point: "marker",
};

/** Whether a part is drawn: `false` is off; an absent part is off except the geometry's main part (spec 3). */
export const partOn = (value: unknown, part: string, geometry: Geometry): boolean =>
  value === false ? false : value === undefined ? MAIN_PART[geometry] === part : true;

/** Whether a marker draws its fill: `fill: false` draws it hollow; the icon alone has no fill to leave out (spec 3.3). */
export const markerFilled = (marker: unknown): boolean =>
  !(isObject(marker) && marker.fill === false && marker.shape !== "icon");

/** Clusters are computed in the browser up to this many features (goatlib's default `cluster_feature_limit`). */
export const CLUSTER_FEATURE_LIMIT = 100_000;

/** Whether the layer's marker is more than a plain circle: it has an icon or a shape (the Icon editor's switch). */
export function markerOn(doc: LayerStyle): boolean {
  const marker = getIn(doc, MARKER);
  if (!isObject(marker)) return false;
  return marker.icon !== undefined || (marker.shape !== undefined && marker.shape !== "circle");
}

/** What switching the layer's icon off takes from its marker: the icon and what only an icon uses, the shape, and the
 * classifications that set the icon. `restoreIcon` puts them back. */
export interface IconSettings {
  marker: JsonObject;
  classify: JsonObject[];
}

export function iconSettings(doc: LayerStyle, geometry: Geometry = "point"): IconSettings {
  const marker = getIn(doc, MARKER);
  const own = isObject(marker) ? marker : {};
  const kept: JsonObject = {};
  for (const key of ICON_KEYS) if (own[key] !== undefined) kept[key] = clone(own[key]);
  if (own.shape !== undefined && own.shape !== "circle") kept.shape = clone(own.shape);
  const all = getIn(doc, "classify");
  const classify = (Array.isArray(all) ? all : [])
    .filter((c): c is JsonObject => isObject(c) && targetsOf(c, geometry).includes("marker.icon"))
    .map((c) => clone(c));
  return { marker: kept, classify };
}

/** The layer's icon and shape back as `kept` had them (a pin without an icon stays without); with nothing kept, the
 * default marker icon. */
export function restoreIcon(doc: LayerStyle, kept?: IconSettings): LayerStyle {
  const marker = kept?.marker ?? {};
  const nothing = marker.icon === undefined && marker.shape === undefined;
  let next = nothing ? setIn(doc, `${MARKER}.icon`, DEFAULT_ICON) : doc;
  if (marker.icon !== undefined) next = setIn(next, `${MARKER}.icon`, marker.icon);
  for (const key of ["icon_color", "anchor", "shape"])
    if (marker[key] !== undefined) next = setIn(next, `${MARKER}.${key}`, marker[key]);
  if (kept?.classify.length) {
    const all = getIn(next, "classify");
    const current = (Array.isArray(all) ? all : []).filter(isObject);
    const ids = new Set(current.map((c) => c.id));
    next = setIn(next, "classify", [...current, ...kept.classify.filter((c) => !ids.has(c.id))]);
  }
  return next;
}

/** Whether the point symbol is drawn: a heatmap or H3 hides it unless it hands over at `points_from_zoom` (spec 8). */
export function symbolShown(doc: LayerStyle): boolean {
  const render = getIn(doc, "render");
  if (!isObject(render) || (render.type !== "heatmap" && render.type !== "h3")) return true;
  return typeof render.points_from_zoom === "number";
}

/** The panel's marker shapes (spec 3.3 `shape`): a shape or a pin (lib/style/markerShapes.ts), or the icon alone. */
export type MarkerShape = MarkerShapeId | "icon";

const MARKER = "symbol.marker";
/** Keys only an icon uses. */
const ICON_KEYS = ["icon", "icon_color", "anchor"];
/** Icons smaller than this are hard to make out; an icon alone is raised to it. */
const ICON_MIN_SIZE = 18;
const DEFAULT_ICON = "goat:marker";

export function markerShape(doc: LayerStyle): MarkerShape {
  const shape = getIn(doc, `${MARKER}.shape`);
  return shape === "icon" ? "icon" : markerShapeOf(shape);
}

/** Classifications of the icon color set the marker color instead, which tints an icon alone: the classes keep their
 * colors. */
function classesColorTheIcon(doc: LayerStyle): LayerStyle {
  const all = getIn(doc, "classify");
  if (!Array.isArray(all) || !all.some((c) => isObject(c) && c.target === `marker.icon_color`)) return doc;
  const moved = all.map((c) => {
    if (!isObject(c) || c.target !== "marker.icon_color") return c;
    const { target: _target, ...next } = clone(c);
    const records = [...(Array.isArray(next.classes) ? next.classes : []), next.other, next.no_data];
    for (const record of records) {
      const marker = isObject(record) ? record.marker : undefined;
      if (!isObject(marker) || !("icon_color" in marker)) continue;
      marker.color = marker.icon_color;
      delete marker.icon_color;
    }
    const generated = isObject(next.computed) ? next.computed.generated : undefined;
    if (isObject(generated) && generated.target === "marker.icon_color") generated.target = "marker.color";
    return next;
  });
  return setIn(doc, "classify", moved);
}

export function setMarkerShape(doc: LayerStyle, shape: MarkerShape): LayerStyle {
  if (shape !== "icon") {
    const next = setIn(doc, `${MARKER}.shape`, shape === "circle" ? undefined : shape);
    // A pin points at its place with its tip: an anchor set for the shape before goes.
    return isPin(shape) ? setIn(next, `${MARKER}.anchor`, undefined) : next;
  }
  // The icon alone, tinted with the marker color: it needs an icon, and no icon color.
  let next = getIn(doc, `${MARKER}.icon`) === undefined ? setIn(doc, `${MARKER}.icon`, DEFAULT_ICON) : doc;
  next = setIn(setIn(next, `${MARKER}.shape`, "icon"), `${MARKER}.icon_color`, undefined);
  next = classesColorTheIcon(next);
  const size = getIn(next, `${MARKER}.size`);
  return size === undefined || (typeof size === "number" && size < ICON_MIN_SIZE)
    ? setIn(next, `${MARKER}.size`, ICON_MIN_SIZE)
    : next;
}

/** The marker with icon `ref` at `path` (the base's or a class's); undefined takes the icon off the layer, and a
 * marker that was the icon alone becomes a circle. */
export function setMarkerIcon(
  doc: LayerStyle,
  path: string,
  ref: string | undefined,
  ctx: { mapZoom: number; geometry?: Geometry }
): LayerStyle {
  if (ref !== undefined) {
    const next = setIn(doc, path, ref);
    // A pin symbol on its own stands on its tip, unless an anchor is set.
    const alone = getIn(next, `${MARKER}.shape`) === "icon";
    return path === `${MARKER}.icon` &&
      alone &&
      isPin(symbolShape(ref)) &&
      getIn(next, `${MARKER}.anchor`) === undefined
      ? setIn(next, `${MARKER}.anchor`, "bottom")
      : next;
  }
  // A classification that sets the icon goes too.
  let next = switchMode(doc, `${MARKER}.icon`, "fixed", ctx);
  for (const key of ICON_KEYS) next = setIn(next, `${MARKER}.${key}`, undefined);
  return getIn(next, `${MARKER}.shape`) === "icon" ? setIn(next, `${MARKER}.shape`, undefined) : next;
}

/** The document with the cluster symbol written out, so an edit of one key keeps the rest of the default symbol. */
export function withClusterSymbol(doc: LayerStyle): LayerStyle {
  return isObject(getIn(doc, "render.symbol"))
    ? doc
    : setIn(doc, "render.symbol", clone(DEFAULT_CLUSTER_SYMBOL));
}

/** A cluster symbol key's value while the style leaves it out: the default cluster symbol's, else the reference's. */
export function clusterFallback(doc: LayerStyle, key: string): unknown {
  const symbol = isObject(getIn(doc, "render.symbol")) ? {} : DEFAULT_CLUSTER_SYMBOL;
  return getIn(symbol, key) ?? DEFAULTS[key];
}
