// What sets a part or a key for the whole layer, as the map draws it (spec 3, 5.7, 6.1): the base symbol, then each
// classification's records (classes, `other`, `no_data`) in list order, then the rules. A part the base leaves out is
// drawn where a record turns it on (`partUsed`); a key set once for the layer comes from the first record that sets it
// (`perLayer`). The symbol section's rows, switches and notes ask here, so they say what `compile/cascade` draws.
import { isSet, partUsed, setValues } from "@/lib/style/compile/cascade";
import type { Geometry } from "@/lib/style/compile/types";
import { type ScopedView, scopedView } from "@/lib/style/editor/classify";
import { LABEL_FONT_CHOICE, classificationFor, compoundKeys, keyOf, targets } from "@/lib/style/editor/forms";
import { type Path, dropKey, getIn, setIn } from "@/lib/style/editor/paths";
import { type Scope, isRuleScope } from "@/lib/style/editor/store";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";

import { GROUPS } from "@/components/map/panels/styleEditor/editors/partRows";

const MAIN_PART: Record<Geometry, string> = { point: "marker", line: "line", polygon: "fill" };

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** Every record below the base, with its path, in cascade order: class records, `other`, `no_data`, rules. */
export function recordPaths(doc: LayerStyle): Array<{ path: Path; record: JsonObject }> {
  const out: Array<{ path: Path; record: JsonObject }> = [];
  list(getIn(doc, "classify")).forEach((c, ci) => {
    const classes = Array.isArray(c.classes) ? c.classes : [];
    classes.forEach((record, k) => {
      if (isObject(record)) out.push({ path: `classify.${ci}.classes.${k}`, record });
    });
    for (const name of ["other", "no_data"])
      if (isObject(c[name])) out.push({ path: `classify.${ci}.${name}`, record: c[name] as JsonObject });
  });
  const rules = getIn(doc, "rules");
  (Array.isArray(rules) ? rules : []).forEach((record, i) => {
    if (isObject(record)) out.push({ path: `rules.${i}`, record });
  });
  return out;
}

/** How a part is drawn for the layer: for every feature (`all`), only where classes or rules turn it on (`some`),
 * nowhere (`none`), or switched off for the layer (`off`, which no record turns back on). */
export type PartState = "all" | "some" | "none" | "off";

export function partState(doc: LayerStyle, part: string, geometry: Geometry): PartState {
  const base = getIn(doc, `symbol.${part}`);
  if (base === false) return "off";
  if (base !== undefined || MAIN_PART[geometry] === part) return "all";
  return partUsed(doc as unknown as JsonObject, part, geometry) ? "some" : "none";
}

/** What sets something below the base: the last classification one of whose records passes `test` (the one that wins
 * where both apply), else "rules" when a rule does. */
export type Setter = JsonObject | "rules";

export function setterOf(doc: LayerStyle, test: (record: JsonObject) => boolean): Setter | undefined {
  const classes = list(getIn(doc, "classify")).filter((c) =>
    [...list(c.classes), c.other, c.no_data].some((r) => isObject(r) && test(r))
  );
  if (classes.length) return classes[classes.length - 1];
  return list(getIn(doc, "rules")).some(test) ? "rules" : undefined;
}

/** A setter as a selector can return it (a string): its classification's field, RULES for rules, "" for none. */
export const RULES = "\u0000rules";
export const setterKey = (setter: Setter | undefined): string =>
  setter === undefined ? "" : setter === "rules" ? RULES : String(setter.field);

/** What turns `part` on below the base. */
export const partSetter = (doc: LayerStyle, part: string): Setter | undefined =>
  setterOf(doc, (r) => isObject(r[part]));

/** What switches `part` off below the base (`false` in a class or rule). */
export const partOffSetter = (doc: LayerStyle, part: string): Setter | undefined =>
  setterOf(doc, (r) => r[part] === false);

/** A record whose marker fills: `fill: true` over hollow markers. */
const fills = (r: JsonObject) => isObject(r.marker) && r.marker.fill === true;

/** Whether the points' markers draw their fill: for every feature, only where classes or rules fill hollow markers,
 * or nowhere. */
export function markerFillState(doc: LayerStyle): "all" | "some" | "none" {
  const marker = getIn(doc, "symbol.marker");
  const hollow = isObject(marker) && marker.fill === false && marker.shape !== "icon";
  if (!hollow) return "all";
  return setterOf(doc, fills) ? "some" : "none";
}

/** What fills hollow markers below the base. */
export const fillSetter = (doc: LayerStyle): Setter | undefined => setterOf(doc, fills);

/** Whether a key is set once for the layer (spec 6.1: not per feature). */
export const isPerLayer = (key: string): boolean => CAPABILITIES[key]?.perFeature === false;

/** Where the panel reads and writes a key set once for the layer: the first record that sets it (the base first), as
 * the map takes it; the path itself for any other key, or while no record sets it. */
export function perLayerPath(doc: LayerStyle, path: Path): Path {
  if (!path.startsWith("symbol.")) return path;
  const key = keyOf(path);
  if (!isPerLayer(key)) return path;
  const set = (v: unknown) => v !== undefined && v !== null;
  if (set(getIn(doc, path))) return path;
  const holder = recordPaths(doc).find(({ record }) => set(getIn(record, key)));
  return holder ? `${holder.path}.${key}` : path;
}

/** In class or rule scope: what draws over the scoped record's own value at `key` where it applies, as the cascade
 * applies records in order (spec 6.1): a later classification whose records set the key, else a rule (for a rule, a
 * later rule). */
export function laterSetter(
  doc: LayerStyle,
  scope: Scope,
  key: string,
  geometry?: Geometry
): Setter | undefined {
  const sets = (r: unknown) => isObject(r) && getIn(r, key) !== undefined;
  const rules = list(getIn(doc, "rules"));
  if (isRuleScope(scope)) return rules.slice(scope.index + 1).some(sets) ? "rules" : undefined;
  // A classification that targets the key sets it, also before the server has computed its classes (one without
  // `target` sets the main color then).
  const later = list(getIn(doc, "classify"))
    .slice(scope.classify + 1)
    .filter((c) => [...list(c.classes), c.other, c.no_data].some(sets) || targets(c, key, geometry));
  if (later.length) return later[later.length - 1];
  return rules.some(sets) ? "rules" : undefined;
}

/** The fields a rule's condition requires to be empty: `isNull` at its top, or directly inside a top `and`. */
function emptyFields(when: unknown): Set<string> {
  const out = new Set<string>();
  const add = (node: unknown) => {
    if (!isObject(node) || node.op !== "isNull" || !Array.isArray(node.args)) return;
    const arg = node.args[0];
    if (isObject(arg) && typeof arg.property === "string") out.add(arg.property);
  };
  add(when);
  if (isObject(when) && when.op === "and" && Array.isArray(when.args)) when.args.forEach(add);
  return out;
}

/** The leaf paths an object sets ("outline.width", "label.halo.color"); a part switched off is its own leaf. */
function leaves(node: JsonObject, prefix = ""): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    isObject(value) && !Array.isArray(value.zoom) && !("field" in value)
      ? leaves(value, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  );
}

/** What the layer draws under a rule for its features: the rule's record over the base with every classification
 * (whichever features the condition picks, a classification applies to them). A condition the panel cannot read as
 * "this field is empty" leaves it at that. Where it requires a field to be empty (`isNull`, also inside a top `and`),
 * that field's classifications reach the features only through their No data, in list order as the cascade applies
 * them: an earlier classification's value for a key the No data sets is drawn over, so it leaves those records; the
 * No data record joins the base. */
function underRule(doc: LayerStyle, index: number, view: LayerStyle): LayerStyle {
  const rule = getIn(doc, `rules.${index}`);
  const empty = emptyFields(isObject(rule) ? rule.when : undefined);
  const next = setIn(view, "rules", undefined);
  if (!empty.size) return next;
  let symbol = getIn(next, "symbol");
  let kept: JsonObject[] = [];
  for (const c of list(getIn(next, "classify"))) {
    if (typeof c.field !== "string" || !empty.has(c.field)) {
      kept.push(c);
      continue;
    }
    const noData = c.no_data;
    if (!isObject(noData)) continue;
    const parts = Object.fromEntries(Object.entries(noData).filter(([part]) => PART_KEYS.has(part)));
    const paths = leaves(parts as JsonObject);
    kept = kept.map((k) => {
      let out = k;
      for (const record of [...list(k.classes).map((_, i) => `classes.${i}`), "other", "no_data"])
        if (isObject(getIn(out, record))) for (const path of paths) out = dropKey(out, record, path);
      return out;
    });
    symbol = getIn(
      scopedView(setIn(setIn(next, "symbol", symbol), "classify", [c]), { classify: 0, key: "no_data" }).view,
      "symbol"
    );
  }
  return setIn(setIn(next, "symbol", symbol), "classify", kept.length ? kept : undefined);
}

/** The parts a record may set. */
const PART_KEYS = new Set(["fill", "outline", "extrude", "line", "casing", "arrows", "marker", "label"]);

/** The document a row's summary reads in scope, and what draws over it: where the scoped record sets `path` itself,
 * its own value alone (its record over the base, no classifications or rules) and the later records that draw over
 * it; otherwise what the scoped class's features draw, the base under every other classification (the scoped one's
 * other classes do not reach them), or for a rule what the layer draws under it (`underRule`). Out of scope, the
 * document itself. */
export function summaryView(
  doc: LayerStyle,
  scope: Scope | null,
  path: Path,
  scoped?: ScopedView,
  geometry?: Geometry
): { doc: LayerStyle; later: Setter | undefined } {
  if (!scope) return { doc, later: undefined };
  const view = scoped ?? scopedView(doc, scope);
  const alone = () => {
    const own: JsonObject = { ...(view.view as unknown as JsonObject) };
    delete own.classify;
    delete own.rules;
    return own as unknown as LayerStyle;
  };
  if (view.overridden(path)) return { doc: alone(), later: laterSetter(doc, scope, keyOf(path), geometry) };
  if (isRuleScope(scope)) return { doc: underRule(doc, scope.index, view.view), later: undefined };
  const others = list(getIn(view.view, "classify")).filter((_, i) => i !== scope.classify);
  return { doc: setIn(view.view, "classify", others.length ? others : undefined), later: undefined };
}

/** The label editor's rows of values that may vary per feature (its Halo and Text style rows included; the text's
 * "Classes" row; the Font as one row over its weight and style). */
const LABEL_ROW_KEYS = [
  "text",
  "size",
  "color",
  "halo.color",
  "halo.width",
  "transform",
  "letter_spacing",
  "max_width",
];

/** Whether a point marker's group shows its rows: Fill while the markers are filled, Icon while they draw more than
 * plain circles (`markerOn`, any record), Size while markers are drawn. */
function pointGroupShows(doc: LayerStyle, id: string): boolean {
  const marker = getIn(doc, "symbol.marker");
  if (marker === false) return false;
  if (id === "fill") return markerFillState(doc) === "all";
  if (id === "icon") return markerIcons(doc);
  return true;
}

/** What gives the points' markers icons or shapes while the base marker is a plain circle: the Icon editor's "Classes"
 * row names it. */
export function iconSetter(doc: LayerStyle, geometry?: Geometry): Setter | undefined {
  const marker = getIn(doc, "symbol.marker");
  if (marker === false || !markerIcons(doc)) return undefined;
  if (isObject(marker) && (marker.icon !== undefined || (marker.shape ?? "circle") !== "circle"))
    return undefined;
  const setter = setterOf(
    doc,
    (r) => isObject(r.marker) && (r.marker.icon !== undefined || r.marker.shape !== undefined)
  );
  // A classification of the icon has its own Icon row.
  return setter !== "rules" && setter === classificationFor(doc, "marker.icon", geometry)
    ? undefined
    : setter;
}

/** Whether any record gives the markers an icon or a shape other than the circle (as `markerOn` reads it). */
function markerIcons(doc: LayerStyle): boolean {
  const style = doc as unknown as JsonObject;
  return isSet(style, "marker.icon") || setValues(style, "marker.shape").some((shape) => shape !== "circle");
}

/**
 * The rows of the symbol section (for all features) whose click opens classification `c`'s editor, as each row decides
 * it: a property row of a part drawn for every feature, of a key `classificationFor` gives to `c` ("<part>.<key>"); the
 * "Classes" row a part's editor shows while only classes turn the part on, for the classification `partSetter` names
 * ("some:<part>"); the same row of the points' Fill while only classes fill hollow markers (`fillSetter`, "fill").
 * Fixed on the main color keeps a classification only while this names a row for it (`leaveClasses`), so no
 * classification stays that nothing in the panel opens.
 */
export function rowsOpening(doc: LayerStyle, c: JsonObject, geometry: Geometry): string[] {
  const rows = new Set<string>();
  const opens = (key: string) => isPerLayer(key) === false && classificationFor(doc, key, geometry) === c;
  for (const group of GROUPS[geometry]) {
    const part = group.part;
    const state = partState(doc, part, geometry);
    if (state === "some") {
      if (partSetter(doc, part) === c) rows.add(`some:${part}`);
      continue;
    }
    if (state !== "all") continue;
    if (geometry === "point" && part === "marker") {
      if (group.id === "fill" && markerFillState(doc) === "some" && fillSetter(doc) === c) rows.add("fill");
      if (group.id === "icon" && iconSetter(doc, geometry) === c) rows.add("icon");
      if (!pointGroupShows(doc, group.id)) continue;
    }
    // The part's values as its editor reads them: a key set once for the layer at the record that holds it.
    const base = getIn(doc, `symbol.${part}`);
    const values: JsonObject = { ...(isObject(base) ? base : {}) };
    for (const row of group.rows) {
      const holder = perLayerPath(doc, `symbol.${part}.${row.key}`);
      if (holder !== `symbol.${part}.${row.key}`) values[row.key] = getIn(doc, holder);
    }
    // A compound row (the label's Font) opens the first classification over its keys, as PropertyRow does.
    const compoundOpens = (keys: string[]) =>
      keys.map((key) => classificationFor(doc, key, geometry)).find(Boolean) === c;
    if (part === "label" && compoundOpens(compoundKeys(LABEL_FONT_CHOICE))) rows.add("label.font");
    const keys =
      part === "label"
        ? LABEL_ROW_KEYS
        : [...group.rows, ...(group.inline ? [group.inline] : [])]
            .filter(
              (row) =>
                row.type !== "offset" &&
                row.type !== "pattern" &&
                row.type !== "pattern_tiles" &&
                (!row.only || row.only.includes(geometry)) &&
                (!row.when || row.when(values))
            )
            .flatMap((row) => {
              if (row.type !== "choice" || !row.compound) return [row.key];
              if (compoundOpens(compoundKeys(row.compound))) rows.add(`${part}.${row.key}`);
              return [];
            });
    for (const key of keys) if (opens(`${part}.${key}`)) rows.add(`${part}.${key}`);
    if (part === "extrude")
      for (const key of ["height", "base"]) if (opens(`extrude.${key}`)) rows.add(`extrude.${key}`);
  }
  return [...rows];
}
