// The short text a row shows for a value: "#C7E9B4 · 72%", "3 px", "2 → 6 px", "Dotted → Dashed → Solid",
// "By Visitors per year".
import { Color, interpolates } from "@maplibre/maplibre-gl-style-spec";
import type { TFunction } from "i18next";

import { LIGHT, alphaOf, contrastRatio, isNone } from "@/lib/style/colors";
import {
  DERIVED,
  derivedColor,
  derivedSwitches,
  followedKey,
  haloOff,
  isDerivedWord,
  pathOf,
  switchedRamp,
} from "@/lib/style/compile/derived";
import { h3Resolution, h3Scale, onCluster } from "@/lib/style/compile/render";
import type { Geometry } from "@/lib/style/compile/types";
import { type ScopedView, recordPathOf } from "@/lib/style/editor/classify";
import { SLIDERS } from "@/lib/style/editor/defaults";
import {
  type CompoundChoice,
  MAIN_COLOR,
  classificationFor,
  fixedValue,
  keyOf,
  modeOf,
} from "@/lib/style/editor/forms";
import { setIn } from "@/lib/style/editor/paths";
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

/** The color MapLibre draws at `t` (0 to 1) between two hex colors blended in Lab, as `#rrggbb`. */
function blendLab(a: string, b: string, t: number): string {
  const [r, g, bl] = interpolates.color(Color.parse(a)!, Color.parse(b)!, t, "lab").rgb;
  return `#${[r, g, bl]
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

/** A text read on one halo color over `colors` spread evenly from 0 to 1 (a palette's ramp in a swatch), as the map
 * draws it: blending from one color's text to the next where both lie on the same side of the halo (lighter or darker
 * than it), stepping where they lie on either side, so it never blends through the halo's own color. */
function sidedGradient(colors: string[], turn: (color: string) => string, halo: string): string {
  const outs = colors.map(turn);
  const lighter = (color: string) => contrastRatio(color, LIGHT) < contrastRatio(halo, LIGHT);
  const sides = colors.every((c) => HEX.test(c)) ? switchedRamp(colors, (c) => String(lighter(turn(c)))) : [];
  if (sides.length < 2) return gradient(outs);
  const last = colors.length - 1;
  const at = (x: number) => {
    const i = Math.min(Math.floor(x * last), last - 1);
    return turn(blendLab(colors[i], colors[i + 1], x * last - i));
  };
  const stops: Array<[number, string]> = [
    ...outs.map((color, i): [number, string] => [i / last, color]),
    ...sides.slice(1).flatMap(
      ([x]): Array<[number, string]> => [
        [x, at(Math.max(x - 1e-4, 0))],
        [x, at(Math.min(x + 1e-4, 1))],
      ]
    ),
  ].sort((a, b) => a[0] - b[0]);
  return `linear-gradient(90deg, ${stops.map(([x, color]) => `${color} ${position(x)}`).join(", ")})`;
}

/** Whether a halo's width by zoom draws no halo at `zoom`, as the compiler reads it: where the stretch the zoom lies
 * in starts and ends at 0 (below the first stop and from the last on, where that stop is 0). A width that blends from
 * 0 to a width above draws a halo over the whole stretch. */
function widthOffAt(width: unknown, zoom: number): boolean {
  if (!isObject(width) || !Array.isArray(width.zoom)) return false;
  const stops = width.zoom as Array<[number, unknown]>;
  const i = stops.reduce((at, [z], k) => (z <= zoom ? k : at), -1);
  if (i < 0) return stops[0]?.[1] === 0;
  if (i === stops.length - 1) return stops[i][1] === 0;
  return stops[i][1] === 0 && stops[i + 1][1] === 0;
}

/** How many zooms between a partner's first and last stop by zoom a swatch reads its answer at. */
const ZOOM_SAMPLES = 96;

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
 * and follows another part shows the hue it draws, not the hatch. `zoom`: a color by zoom shows its color there. A
 * derived color beside a partner by zoom (a text's color, a halo's color or width) shows the colors the map steps
 * through over the partner's stops, or, at `zoom`, the one it draws there. */
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
  // A record's stop that the record does not hold itself is the base symbol's (the record reads the layer's stops).
  const own = stop
    ? (getIn(doc, path) ?? (inRecord ? getIn(doc, `symbol.${path.slice(prefix.length)}`) : undefined))
    : read(at.slice(prefix.length));
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
    // A partner that changes by zoom (its color, or a width that draws no halo over part of the zoom range): what it
    // draws at a zoom, and the zooms its stops span.
    let partnerAt: ((zoom: number) => unknown) | undefined;
    let followedOne: ((zoom: number) => string | undefined) | undefined;
    let span: [number, number] | undefined;
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
      const followedPath = `${from}${main}`;
      // A record reads the classes or the layer's own color by that check alone, whoever asks.
      const followedOpts = {
        ...opts,
        scoped: inRecord ? ownSetter : opts.scoped,
        follow: undefined,
      };
      followed = swatchOf(doc, followedPath, geometry, {
        ...followedOpts,
        zoom: typeof zoom === "number" ? zoom : undefined,
      });
      const followedAt = (z: number) => swatchOf(doc, followedPath, geometry, { ...followedOpts, zoom: z });
      // The partner a color is chosen against (a halo's text) or read on (a text's halo): the record's, else the base
      // symbol's, else (unset) its reference color. No halo is drawn, as on the map, where the record's width is 0
      // (else the base symbol's), on a cluster label without a halo of its own and on a badge.
      const { against, beside } = DERIVED[derived];
      const partner = against ?? beside;
      const partnerPath = partner && pathOf(partner.key);
      const badge = cluster && (getIn(doc, "render.count") ?? DEFAULTS["cluster.count"]) === "badge";
      const width = partnerPath?.replace(/color$/, "width");
      const drawnWidth = !width
        ? undefined
        : cluster
          ? getIn(onCluster(getIn(doc, "render.symbol")), width)
          : (getIn(doc, `${prefix}${width}`) ?? getIn(doc, `symbol.${width}`));
      rule.against = !partnerPath
        ? undefined
        : beside && (badge || haloOff(drawnWidth))
          ? null
          : (getIn(doc, `${prefix}${partnerPath}`) ??
            (cluster ? undefined : getIn(doc, `symbol.${partnerPath}`)));
      const where = (sub: string | undefined): Path | undefined =>
        sub === undefined
          ? undefined
          : getIn(doc, `${prefix}${sub}`) !== undefined
            ? `${prefix}${sub}`
            : !cluster && getIn(doc, `symbol.${sub}`) !== undefined
              ? `symbol.${sub}`
              : undefined;
      const colorAt = where(partnerPath);
      const widthAt = beside ? where(width) : undefined;
      const stops = [colorAt, widthAt].flatMap((at) => {
        const form = at === undefined ? undefined : getIn(doc, at);
        return isObject(form) && Array.isArray(form.zoom) ? (form.zoom as Array<[number, unknown]>) : [];
      });
      if (rule.against !== null && stops.length && stops.every(([z]) => typeof z === "number")) {
        const zooms = stops.map(([z]) => z);
        span = [Math.min(...zooms), Math.max(...zooms)];
        const widthForm = widthAt === undefined ? undefined : getIn(doc, widthAt);
        const colorForm = colorAt === undefined ? undefined : getIn(doc, colorAt);
        const colorStops =
          isObject(colorForm) && Array.isArray(colorForm.zoom)
            ? (colorForm.zoom as Array<[number, unknown]>)
            : [];
        // The partner's colors by zoom with each word a stop holds as drawn there, so a zoom between two stops reads
        // their blend; at a word's own stop, and beyond an end stop with one, the partner holds the word.
        const shown = colorStops.reduce(
          (d, [, v], i) =>
            isDerivedWord(partner!.key, v) && colorAt
              ? setIn(
                  d,
                  `${colorAt}.zoom.${i}.1`,
                  swatchOf(doc, `${colorAt}.zoom.${i}.1`, geometry, followedOpts)
                )
              : d,
          doc
        );
        partnerAt = (z) => {
          if (widthOffAt(widthForm, z)) return null;
          if (colorAt === undefined || !colorStops.length) return rule.against;
          const i = colorStops.reduce((at, [stop], k) => (stop <= z ? k : at), -1);
          const held = colorStops[Math.max(i, 0)];
          if (i < 0 || i === colorStops.length - 1 || held[0] === z)
            if (isDerivedWord(partner!.key, held[1])) return held[1];
          return fixedValue(shown, colorAt, { mapZoom: z });
        };
        // The followed color at a zoom, where it is one color there.
        followedOne = (z) => {
          const color = followedAt(z);
          return HEX.test(color) ? color : undefined;
        };
      }
    }
    const word = follows ? undefined : value;
    const turn = (color: string, against: unknown = rule.against) =>
      derivedColor(derived, word, color, { ...rule, against });
    if (partnerAt && followedOne && span) {
      // Beside a partner by zoom: what the map draws at the zoom, else each answer over the partner's stops, stepping
      // where it changes.
      // A color chosen against a partner that holds a color there (a halo against its text) looks at the partner
      // alone: the same for every feature, whatever the followed color.
      const looksAtPartner = (against: unknown) =>
        DERIVED[derived].against !== undefined && typeof against === "string" && HEX.test(against);
      const answer = (z: number) => {
        const against = partnerAt!(z);
        const color = followedOne!(z) ?? (looksAtPartner(against) ? "#000000" : undefined);
        const out = color === undefined ? undefined : turn(color, against);
        return typeof out === "string" ? out : undefined;
      };
      if (typeof zoom === "number") return answer(zoom) ?? HATCH;
      const [z0, z1] = span;
      const ramp: Array<[number, string]> = [];
      for (let k = 0; k <= ZOOM_SAMPLES; k++) {
        const color = answer(z0 + ((z1 - z0) * k) / ZOOM_SAMPLES);
        if (color === undefined) return HATCH;
        if (!ramp.length) ramp.push([0, color]);
        else if (ramp[ramp.length - 1][1] !== color) ramp.push([(k - 0.5) / ZOOM_SAMPLES, color]);
      }
      return stepped(ramp);
    }
    const colors = followed.match(/#[0-9a-f]{6}([0-9a-f]{2})?/gi) ?? [];
    if (followed === HATCH || colors.some((color) => typeof turn(color) !== "string")) return HATCH;
    // An answer that switches (an on-color) shows where the map switches it, never a blend through grey.
    if (followed.startsWith("linear-gradient") && derivedSwitches(derived, word, rule))
      return stepped(switchedRamp(colors, (color) => turn(color) as string));
    // A text read on one halo color steps where its answers cross the halo, as the map draws it.
    const halo = DERIVED[derived].beside && isDerivedWord(derived, word) ? rule.against : undefined;
    if (followed.startsWith("linear-gradient") && typeof halo === "string" && HEX.test(halo) && !isNone(halo))
      return sidedGradient(colors, (color) => turn(color) as string, halo.slice(0, 7));
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
    const stops = (value.zoom as Array<[number, unknown]>).map(([, v], i) =>
      resolved(v, `${at}.zoom.${i}.1`)
    );
    // A stop whose word draws more than one color there (over classes) leaves no one gradient to show.
    if (
      (value.zoom as Array<[number, unknown]>).some(
        ([, v], i) => isDerivedWord(derived, v) && !stops[i].length
      )
    )
      return HATCH;
    return gradient(stops.flat());
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

/** The swatch a row shows for the symbol path `path`: in a class's or rule's scope, the color the scope's features draw,
 * read at the record's path of the document (a derived color then follows the classes or the layer by the record's
 * own check); else, and for a path outside the symbol, `swatchOf` of `view` (the scope's view) or the document. */
export function scopedSwatchOf(
  doc: LayerStyle,
  path: Path,
  geometry: Geometry | undefined,
  opts: { scope: Scope | null; view?: LayerStyle; tone?: Tone }
): string {
  const { scope, view, tone } = opts;
  if (scope && path.startsWith("symbol."))
    return swatchOf(doc, `${recordPathOf(scope)}.${path.slice("symbol.".length)}`, geometry, {
      scoped: true,
      tone,
    });
  return swatchOf(view ?? doc, path, geometry, { scoped: scope !== null, tone });
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
