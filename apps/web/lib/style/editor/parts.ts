// Part-level edits of a document (spec 3, 3.3, 8): which parts are drawn, the marker's shape, what `render` hides,
// and the cluster symbol the panel edits.
import { isSet, setValues } from "@/lib/style/compile/cascade";
import { DEFAULT_CLUSTER_SYMBOL } from "@/lib/style/compile/render";
import type { Geometry } from "@/lib/style/compile/types";
import { switchMode, targetsOf } from "@/lib/style/editor/forms";
import { perLayerPath, recordPaths } from "@/lib/style/editor/sources";
import { type Path, getIn, setIn } from "@/lib/style/editor/store";
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

/** Whether the layer's markers are more than plain circles anywhere: the base, a class, `other`, `no_data` or a rule
 * gives them an icon or a shape other than the circle (a shape by zoom in one of its stops), as the map reads them (the
 * Icon editor's switch). Markers switched off draw none. */
export function markerOn(doc: LayerStyle): boolean {
  if (getIn(doc, MARKER) === false) return false;
  const style = doc as unknown as JsonObject;
  return isSet(style, "marker.icon") || setValues(style, "marker.shape").some((shape) => shape !== "circle");
}

/** `render` for clusters: points that draw an icon or a shape other than a plain circle, in any record, cluster like
 * the points with the count on a badge; plain circles cluster as circles by count (spec 8.2). */
export function clusterRender(doc: LayerStyle): JsonObject {
  return markerOn(doc) ? { type: "cluster", look: "points", count: "badge" } : { type: "cluster" };
}

/** What switching the layer's icon off takes from its markers: the base marker's icon, shape and what only an icon
 * uses; the classifications that set the icon or the shape, with their place in the list; and the icon and shape of
 * every other class and rule record (their icon color and anchor stay, unused). `restoreIcon` puts them back. */
export interface IconSettings {
  marker: JsonObject;
  classify: Array<{ index: number; classification: JsonObject }>;
  records: Array<{ path: Path; id: unknown; values: JsonObject }>;
}

/** What a class or rule record's marker loses with the icon: the icon, and a shape other than the circle. */
function recordIcon(marker: JsonObject): JsonObject {
  const out: JsonObject = {};
  if (marker.icon !== undefined) out.icon = clone(marker.icon);
  if (marker.shape !== undefined && marker.shape !== "circle") out.shape = clone(marker.shape);
  return out;
}

/** Whether a classification sets the icon or the shape (`target`). */
const setsIcon = (c: unknown, geometry?: Geometry): c is JsonObject =>
  isObject(c) && (targetsOf(c, geometry).includes("marker.icon") || c.target === "marker.shape");

/** A record's id, else its classification's field (a rule's own path): what `restoreIcon` checks before it writes
 * into the record at the same path. */
function recordId(doc: LayerStyle, path: Path): unknown {
  const record = getIn(doc, path);
  if (isObject(record) && record.id !== undefined) return record.id;
  const at = /^classify\.(\d+)\./.exec(path);
  return at ? getIn(doc, `classify.${at[1]}.field`) : path;
}

export function iconSettings(doc: LayerStyle, geometry: Geometry = "point"): IconSettings {
  const marker = getIn(doc, MARKER);
  const own = isObject(marker) ? marker : {};
  const kept: JsonObject = {};
  for (const key of ICON_KEYS) if (own[key] !== undefined) kept[key] = clone(own[key]);
  if (own.shape !== undefined) kept.shape = clone(own.shape);
  const all = getIn(doc, "classify");
  const classify = (Array.isArray(all) ? all : []).flatMap((c, index) =>
    setsIcon(c, geometry) ? [{ index, classification: clone(c) }] : []
  );
  const records = recordPaths(doc).flatMap(({ path, record }) => {
    const at = /^classify\.(\d+)\./.exec(path);
    if (at && setsIcon(getIn(doc, `classify.${at[1]}`), geometry)) return [];
    if (!isObject(record.marker)) return [];
    const values = recordIcon(record.marker);
    return Object.keys(values).length ? [{ path, id: recordId(doc, path), values }] : [];
  });
  return { marker: kept, classify, records };
}

/** The layer's markers as plain circles (the Icon switch off): no icon or shape other than the circle in the base or
 * in any record, and none of the classifications that set the icon or the shape. `iconSettings`, taken before, keeps
 * what goes. */
export function iconOff(doc: LayerStyle, ctx: { mapZoom: number; geometry?: Geometry }): LayerStyle {
  let next = setIn(setMarkerIcon(doc, `${MARKER}.icon`, undefined, ctx), `${MARKER}.shape`, undefined);
  const all = getIn(next, "classify");
  if (Array.isArray(all) && all.some((c) => setsIcon(c, ctx.geometry))) {
    const kept = all.filter((c) => !setsIcon(c, ctx.geometry));
    next = setIn(next, "classify", kept.length ? kept : undefined);
  }
  for (const { path, record } of recordPaths(next)) {
    if (!isObject(record.marker)) continue;
    for (const key of Object.keys(recordIcon(record.marker)))
      next = setIn(next, `${path}.marker.${key}`, undefined);
  }
  return next;
}

/** The layer's icons and shapes back as `kept` had them (a pin without an icon stays without); with nothing to bring
 * back, the default marker icon. */
export function restoreIcon(doc: LayerStyle, kept?: IconSettings): LayerStyle {
  const marker = kept?.marker ?? {};
  let next = doc;
  for (const key of ["icon", "icon_color", "anchor", "shape"])
    if (marker[key] !== undefined) next = setIn(next, `${MARKER}.${key}`, marker[key]);
  if (kept?.classify.length) {
    const all = getIn(next, "classify");
    const back = (Array.isArray(all) ? all : []).filter(isObject);
    const ids = new Set(back.map((c) => c.id));
    for (const { index, classification } of kept.classify)
      if (classification.id === undefined || !ids.has(classification.id))
        back.splice(Math.min(index, back.length), 0, classification);
    next = setIn(next, "classify", back);
  }
  // Records still where they were get their icon keys back.
  for (const { path, id, values } of kept?.records ?? []) {
    if (!isObject(getIn(next, path)) || recordId(next, path) !== id) continue;
    for (const [key, value] of Object.entries(values)) next = setIn(next, `${path}.marker.${key}`, value);
  }
  return markerOn(next) ? next : setIn(next, `${MARKER}.icon`, DEFAULT_ICON);
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

/** The arrows with icon `ref` at `path` (spec 3.2), GOAT's arrow for undefined: the arrow turns with the line, any
 * other icon stays upright until the user turns it (`turn_with_line`). */
export function setArrowsIcon(doc: LayerStyle, path: string, ref: string | undefined): LayerStyle {
  // `turn_with_line` is one for the layer too (spec 6.1): written where a record holds it, else beside the icon.
  const held = perLayerPath(doc, "symbol.arrows.turn_with_line");
  const turn = getIn(doc, held) !== undefined ? held : path.replace(/icon$/, "turn_with_line");
  return ref === undefined || ref === DEFAULTS["arrows.icon"]
    ? setIn(setIn(doc, path, undefined), turn, undefined)
    : setIn(setIn(doc, path, ref), turn, false);
}

/** The document with the cluster symbol written out, so an edit of one key keeps the rest of the default symbol. */
export function withClusterSymbol(doc: LayerStyle): LayerStyle {
  return isObject(getIn(doc, "render.symbol"))
    ? doc
    : setIn(doc, "render.symbol", clone(DEFAULT_CLUSTER_SYMBOL));
}

/** The starting range of a cluster value by a field (spec 8.2): the field's for its mean, smallest or largest value;
 * for its sum, from the field's lowest value to ten times its highest. The panel's Range row changes it. */
export function clusterValueDomain(
  op: string,
  profile?: { min?: number; max?: number }
): [number, number] | undefined {
  if (profile?.min === undefined || profile.max === undefined) return undefined;
  return op === "sum" ? [profile.min, profile.max * 10] : [profile.min, profile.max];
}

/** The document with the clusters' value set (spec 8.2 `value`; none for the count), and the cluster symbol following
 * it: a label of the count or the value shows the new one, a size or color by either follows it, with `domain` for a
 * value by a field and the map's for the count. A value by a field without its `domain` yet puts the size and color
 * on the count: by the value they would need one, and another field's range would not fit it. */
export function withClusterValue(
  doc: LayerStyle,
  value: { op: string; field: string } | undefined,
  domain?: [number, number]
): LayerStyle {
  let next = withClusterSymbol(setIn(doc, "render.value", value));
  const text = getIn(next, "render.symbol.label.text");
  if (text === "{count}" || text === "{value}")
    next = setIn(next, "render.symbol.label.text", value ? "{value}" : "{count}");
  const byValue = value !== undefined && domain !== undefined;
  for (const key of ["size", "color"]) {
    const path = `render.symbol.marker.${key}`;
    const form = getIn(next, path);
    if (!isObject(form) || (form.field !== "count" && form.field !== "value")) continue;
    const { domain: _old, ...rest } = form;
    next = setIn(next, path, byValue ? { ...rest, field: "value", domain } : { ...rest, field: "count" });
  }
  return next;
}

/** A cluster symbol key's value while the style leaves it out: the default cluster symbol's, else the reference's. */
export function clusterFallback(doc: LayerStyle, key: string): unknown {
  const symbol = isObject(getIn(doc, "render.symbol")) ? {} : DEFAULT_CLUSTER_SYMBOL;
  return getIn(symbol, key) ?? DEFAULTS[key];
}
