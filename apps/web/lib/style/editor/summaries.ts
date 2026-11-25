// The short text a row shows for a value: "#C7E9B4 · 72%", "3 px", "2 → 6 px", "Dotted → Dashed → Solid",
// "By Visitors per year".
import type { TFunction } from "i18next";

import { alphaOf, isNone } from "@/lib/style/colors";
import {
  DERIVED,
  derivedColor,
  derivedSwitches,
  followedKey,
  isDerivedWord,
  pathOf,
  switchedRamp,
} from "@/lib/style/compile/derived";
import { h3Resolution, h3Scale } from "@/lib/style/compile/render";
import type { Geometry } from "@/lib/style/compile/types";
import type { ScopedView } from "@/lib/style/editor/classify";
import { SLIDERS } from "@/lib/style/editor/defaults";
import {
  type CompoundChoice,
  MAIN_COLOR,
  classificationFor,
  fixedValue,
  keyOf,
  modeOf,
} from "@/lib/style/editor/forms";
import { RULES, type Setter, perLayerPath, summaryView } from "@/lib/style/editor/sources";
import { type Path, type Scope, getIn } from "@/lib/style/editor/store";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import { PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import type { Tone } from "@/lib/style/tone";
import { percentOf } from "@/lib/utils/colorFormats";

import type { FieldInfo } from "@/components/map/panels/styleEditor/context";
import { PLAIN } from "@/components/map/panels/styleEditor/plainText";
import type { ChoiceOption } from "@/components/map/panels/styleEditor/rows/ChoiceRow";

interface SummaryContext {
  fields: FieldInfo[];
  mapZoom: number;
  geometry?: Geometry;
  /** The panel's language: numbers take its decimal separator. */
  language: string;
  /** The class or rule the panel styles: the summary reads what its features draw (`summaryView`). */
  scope?: Scope | null;
  /** The scope's view when the caller has it already. */
  view?: ScopedView;
}

/** The label of a choice: `style_editor.value_<key with _>_<value>` ("value_line_dash_dash_dot" is "Dash dot"). */
export const choiceLabel = (t: TFunction, key: string, value: unknown): string =>
  t(`style_editor.value_${key.replace(/\./g, "_")}_${String(value)}`, { defaultValue: String(value) });

/** The label of a compound's choice, in full: an upright font is named by its weight ("Medium"), an italic one by its
 * style ("Italic", "Medium italic"). */
export const compoundLabel = (t: TFunction, compound: CompoundChoice, choice: string): string =>
  choiceLabel(t, `${compound.part}.${compound.labelKey(choice)}`, choice);

/** A compound's choices as the options of a choice field, wherever its font is picked: in the compound's groups, each
 * named in its group ("Medium" under "Italic") and in full in the field ("Medium italic"). */
export const compoundOptions = (t: TFunction, compound: CompoundChoice): ChoiceOption<string>[] =>
  compound.values.map((value) => {
    const label = compoundLabel(t, compound, value);
    const group = compound.group?.(value);
    if (!group) return { value, label };
    const named = ([key, v]: [string, string]) => choiceLabel(t, `${compound.part}.${key}`, v);
    return {
      value,
      label: named(group.name),
      short: label,
      group: named(group.heading),
      ariaLabel: group.spoken ? named(group.spoken) : label,
    };
  });

/** A number in the panel's language, to two decimals at most: "1.5", "1,5" in German (the number boxes show it so). */
export const plainNumber = (value: number, language: string): string =>
  new Intl.NumberFormat(language, { maximumFractionDigits: 2, useGrouping: false }).format(value);

/** A number as the panel's summaries show it, with its slider's unit: "1.5 px" ("1,5 px" in German), a share as a
 * percent ("72%"). */
export function summaryNumber(value: number, key: string, language: string): string {
  const slider = SLIDERS[key];
  if (slider?.pct) return `${Math.round(value * 100)}%`;
  const text = plainNumber(value, language);
  return slider?.unit ? `${text} ${slider.unit}` : text;
}

/** What a setter (`setterKey`) reads as: "By <field>" for a classification, the field by its display name, or "By
 * rules". */
export const setterSummary = (t: TFunction, key: string, fields: FieldInfo[]): string =>
  key === RULES
    ? t("style_editor.by_rules")
    : t("style_editor.by_field", { field: fields.find((f) => f.name === key)?.label ?? key, ...PLAIN });

/** A scoped record's own value with what draws over it where it applies: "6 px, then by pop". */
export const thenText = (t: TFunction, value: string, later: Setter, fields: FieldInfo[]): string =>
  later === "rules"
    ? t("style_editor.scope_then_rules", { value, ...PLAIN })
    : t("style_editor.scope_then_field", {
        value,
        field: fields.find((f) => f.name === later.field)?.label ?? String(later.field),
        ...PLAIN,
      });

/** A color as the panel shows it, never with eight digits (spec 4.6): "None" at alpha 0, six digits and the color's
 * own percent where it is transparent ("#E87AB2 · 58%", 1 to 99, spelled as the Opacity rows spell theirs), six digits
 * where it is opaque; anything else upper case as it is. */
export function colorLabel(t: TFunction, color: string): string {
  const alpha = alphaOf(color);
  if (alpha === undefined) return color.toUpperCase();
  if (alpha === 0) return t("style_editor.none");
  const hex = color.slice(0, 7).toUpperCase();
  if (alpha === 255) return hex;
  return `${hex} · ${percentOf(color)}%`;
}

/** The panel's words for a color taken from another part. */
const WORD_LABELS: Record<string, string> = { fill: "style_editor.same_as_fill", auto: "style_editor.auto" };

/** The panel's word for a color taken from another part ("Auto", "Same as fill"). */
export const wordLabel = (t: TFunction, word: string): string => t(WORD_LABELS[word] ?? word);

export function summarize(doc: LayerStyle, path: Path, t: TFunction, ctx: SummaryContext): string {
  if (ctx.scope) {
    const { doc: shown, later } = summaryView(doc, ctx.scope, path, ctx.view, ctx.geometry);
    const text = summarize(shown, path, t, { ...ctx, scope: null, view: undefined });
    return later ? thenText(t, text, later, ctx.fields) : text;
  }
  const key = keyOf(path);
  const kind = CAPABILITIES[key]?.kind ?? "choice";
  const label = (field: unknown) => ctx.fields.find((f) => f.name === field)?.label ?? String(field);
  // A key set once for the layer reads where a class or rule holds it (spec 6.1).
  const at = perLayerPath(doc, path);
  const value = getIn(doc, at);
  switch (modeOf(doc, at, ctx.geometry)) {
    case "classes":
      return t("style_editor.by_field", {
        field: label(classificationFor(doc, key, ctx.geometry)?.field),
        ...PLAIN,
      });
    case "attribute":
    case "raw":
      return t("style_editor.by_field", {
        field: label(isObject(value) ? value.field : undefined),
        ...PLAIN,
      });
    case "zoom": {
      const stops = (isObject(value) && Array.isArray(value.zoom) ? value.zoom : []) as Array<
        [number, unknown]
      >;
      if (kind === "color") return t("style_editor.by_zoom_stops", { count: stops.length });
      if (kind === "number" && stops.every(([, v]) => typeof v === "number")) {
        const first = stops[0][1] as number;
        const last = stops[stops.length - 1][1] as number;
        const slider = SLIDERS[key];
        if (slider?.pct)
          return `${summaryNumber(first, key, ctx.language)} → ${summaryNumber(last, key, ctx.language)}`;
        const plain = (n: number) => plainNumber(n, ctx.language);
        return `${plain(first)} → ${plain(last)}${slider?.unit ? ` ${slider.unit}` : ""}`;
      }
      return stops.map(([, v]) => (isObject(v) ? "…" : choiceLabel(t, key, v))).join(" → ");
    }
    default: {
      const fixed = value ?? DEFAULTS[key];
      if (kind === "color") {
        if (isDerivedWord(key, fixed)) return wordLabel(t, fixed);
        if (isNone(fixed)) return t("style_editor.none");
        const hex = typeof fixed === "string" ? colorLabel(t, fixed) : "";
        const opacityPath = path.replace(/color$/, "opacity");
        const opacityKey = key.replace(/color$/, "opacity");
        // An opacity by classes or by attribute varies: no one percent to show.
        const opacity =
          opacityPath !== path && modeOf(doc, opacityPath, ctx.geometry) === "fixed"
            ? (getIn(doc, opacityPath) ?? DEFAULTS[opacityKey])
            : undefined;
        if (typeof opacity !== "number") return hex;
        // Beside a color's own percent, the part's opacity is named, so the two read apart.
        const named = (alphaOf(fixed) ?? 255) < 255 ? `${t("style_editor.opacity")} ` : "";
        return `${hex} · ${named}${Math.round(opacity * 100)}%`;
      }
      if (typeof fixed === "number") return summaryNumber(fixed, key, ctx.language);
      return fixed === undefined ? "" : choiceLabel(t, key, fixed);
    }
  }
}

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
/** A hatched swatch for a color the row cannot show as one. */
export const HATCH = "repeating-linear-gradient(45deg, #c9ced6 0 2px, transparent 2px 5px)";
const gradient = (colors: string[]) =>
  colors.length > 1 ? `linear-gradient(90deg, ${colors.join(", ")})` : (colors[0] ?? HATCH);

/** A zoom stop's value in a path (`….zoom.<i>.1`). */
const STOP = /\.zoom\.(\d+)\.1$/;
/** The record a key's path lies in: the base symbol, a cluster's symbol, a class's or a rule's. */
const RECORD = /^(symbol\.|render\.symbol\.|classify\.\d+\.(?:classes\.\d+|other|no_data)\.|rules\.\d+\.)/;
const position = (x: number) => `${Number((x * 100).toFixed(2))}%`;

/** A gradient of answers that each hold up to where the next starts (`switchedRamp`), or the one answer. */
function stepped(ramp: Array<[number, string]>): string {
  if (ramp.length === 1) return ramp[0][1];
  const stops = ramp.flatMap(([x, color], i) => [
    `${color} ${position(x)}`,
    `${color} ${position(ramp[i + 1]?.[0] ?? 1)}`,
  ]);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** The CSS background a row's swatch shows for the color at `path`, which may be a zoom stop's (`….zoom.<i>.1`).
 * `scoped`: `doc` is one class's view, which draws its own color, not the classes'. `tone`: the basemap's tone the map
 * draws a derived color for (light by default), so the swatch shows the map's color. `follow`: a key that is not set
 * and follows another part shows the hue it draws, not the hatch. `zoom`: a color by zoom shows its color there. */
export function swatchOf(
  doc: LayerStyle,
  path: Path,
  geometry?: Geometry,
  opts: { scoped?: boolean; tone?: Tone; follow?: boolean; zoom?: number } = {}
): string {
  const key = keyOf(path);
  const stop = STOP.exec(path);
  const at = stop ? path.slice(0, stop.index) : path;
  const zoom = stop ? getIn(doc, `${at}.zoom.${stop[1]}.0`) : opts.zoom;
  const prefix = RECORD.exec(at)?.[1] ?? "";
  // A class's or rule's record draws what the layer's symbol sets where it sets nothing itself.
  const inRecord = prefix !== "" && prefix !== "symbol." && prefix !== "render.symbol.";
  const read = (sub: string) =>
    getIn(doc, `${prefix}${sub}`) ?? (inRecord ? getIn(doc, `symbol.${sub}`) : undefined);
  const own = stop ? getIn(doc, path) : read(at.slice(prefix.length));
  const value = own ?? DEFAULTS[key];
  // A cluster symbol's colors follow the cluster's marker; its number has a derivation of its own.
  const cluster = prefix === "render.symbol.";
  const derived = cluster && `cluster.symbol.${key}` in DERIVED ? `cluster.symbol.${key}` : key;
  // An unset icon color of a hollow marker follows the marker color (spec 3.3), and so does an Auto one. An unset
  // pattern or arrows color keeps the hatch (its row reads "Same as fill" or "Same as line") unless `follow` asks.
  const part = key.split(".")[0];
  const hollow = read(`${part}.fill`) === false && read(`${part}.shape`) !== "icon";
  const absent = DERIVED[key]?.absent;
  const follows =
    own === undefined && absent !== undefined && (absent.only === "hollow" ? hollow : opts.follow === true);
  if (isDerivedWord(derived, value) || follows) {
    const rule = { hollow, against: undefined as unknown, inputs: { tone: opts.tone ?? "light" } };
    let followed: string;
    if (derived === "h3.outline.color") {
      // An H3 outline follows each hexagon's color, which the render works out.
      const render = isObject(doc.render) ? (doc.render as JsonObject) : {};
      const scale = h3Scale(render, h3Resolution(render, typeof zoom === "number" ? zoom : 12));
      followed = gradient(scale.kind === "color" ? [scale.color] : scale.colors);
    } else {
      const main = followedKey(derived, geometry ?? "polygon") ?? MAIN_COLOR[geometry ?? "polygon"];
      // Clusters drawn like the points take the points' marker; a record without a color of its own the layer's.
      const ownMarker = cluster && getIn(doc, "render.look") !== "points";
      const from =
        ownMarker || (inRecord && getIn(doc, `${prefix}${main}`) !== undefined) ? prefix : "symbol.";
      // A class that leaves the followed color to the layer draws the layer's own, where its own classification is
      // the one that sets that color; a rule, or a class of another classification, draws that one's classes.
      const setter = from === "symbol." && inRecord ? classificationFor(doc, main, geometry) : undefined;
      const own = /^classify\.(\d+)\./.exec(prefix)?.[1];
      const classes = getIn(doc, "classify");
      const ownSetter =
        setter !== undefined && Array.isArray(classes) && String(classes.indexOf(setter)) === own;
      followed = swatchOf(doc, `${from}${main}`, geometry, {
        ...opts,
        scoped: opts.scoped || ownSetter,
        follow: undefined,
        zoom: typeof zoom === "number" ? zoom : undefined,
      });
      // The partner a color is chosen against (a halo's text): the record's, else the base symbol's.
      const partner = DERIVED[derived].against;
      const partnerPath = partner && pathOf(partner.key);
      rule.against = partnerPath
        ? (getIn(doc, `${prefix}${partnerPath}`) ??
          (cluster ? undefined : getIn(doc, `symbol.${partnerPath}`)))
        : undefined;
    }
    const word = follows ? undefined : value;
    const turn = (color: string) => derivedColor(derived, word, color, rule);
    const colors = followed.match(/#[0-9a-f]{6}([0-9a-f]{2})?/gi) ?? [];
    if (followed === HATCH || colors.some((color) => typeof turn(color) !== "string")) return HATCH;
    // An answer that switches (an on-color) shows where the map switches it, never a blend through grey.
    if (followed.startsWith("linear-gradient") && derivedSwitches(derived, word, rule))
      return stepped(switchedRamp(colors, (color) => turn(color) as string));
    // Each color the followed swatch shows, derived (a darker shade for "auto").
    return followed.replace(/#[0-9a-f]{6}([0-9a-f]{2})?/gi, (color) => turn(color) as string);
  }
  // A color set by classes shows the classes' colors, in their order: the color under them draws nothing.
  const classified =
    path.startsWith("symbol.") && !opts.scoped ? classificationFor(doc, key, geometry) : undefined;
  const all = getIn(doc, "classify");
  const ci = classified && Array.isArray(all) ? all.indexOf(classified) : -1;
  // A word a class or a stop holds ("Auto") shows as the map draws it there.
  const resolved = (color: unknown, at: Path): string[] => {
    if (typeof color !== "string") return [];
    if (HEX.test(color)) return [color];
    const drawn = isDerivedWord(derived, color)
      ? swatchOf(doc, at, geometry, { ...opts, follow: undefined })
      : "";
    return HEX.test(drawn) ? [drawn] : [];
  };
  const classColors = (Array.isArray(classified?.classes) ? classified.classes : []).flatMap((record, k) =>
    resolved(getIn(record, key), `classify.${ci}.classes.${k}.${key}`)
  );
  if (classColors.length) return gradient(classColors);
  if (typeof value === "string") return HEX.test(value) ? value : HATCH;
  if (!isObject(value)) return HATCH;
  if (Array.isArray(value.zoom)) {
    // At one zoom, the color drawn there.
    const there = typeof zoom === "number" ? fixedValue(doc, path, { mapZoom: zoom }) : undefined;
    if (typeof there === "string" && HEX.test(there)) return there;
    return gradient(
      (value.zoom as Array<[number, unknown]>).flatMap(([, v], i) => resolved(v, `${at}.zoom.${i}.1`))
    );
  }
  if ("palette" in value) {
    const colors = [
      ...(Array.isArray(value.palette)
        ? (value.palette as string[])
        : (PALETTES[value.palette as string]?.colors ?? [])),
    ];
    if (value.reverse === true) colors.reverse();
    return gradient(colors);
  }
  return HATCH;
}

/** The colors a style uses, each once (lower case), in document order: the picker's "In this style" swatches. */
export function colorsIn(doc: LayerStyle): string[] {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (HEX.test(value)) found.add(value.toLowerCase());
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (isObject(value)) Object.values(value).forEach(walk);
  };
  walk(doc);
  return [...found];
}
