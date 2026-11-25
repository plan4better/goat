// Label templates in the panel (spec 3.4): field tokens with escaped braces, the fields a template uses, and the
// preview text: the template filled from one feature with numbers formatted as the map draws them (spec 18.3). And
// what the label editor's summary rows show (Halo, Text style, Position) for the layer or the scoped class or rule.
import type { TFunction } from "i18next";

import { isNone } from "@/lib/style/colors";
import { type NumberFormatSpec, parseTemplate } from "@/lib/style/compile/labels";
import { extrudes } from "@/lib/style/compile/polygons";
import type { FieldType, Geometry } from "@/lib/style/compile/types";
import { LABEL_FONT_CHOICE, keyOf, modeOf } from "@/lib/style/editor/forms";
import { type Path, getIn } from "@/lib/style/editor/paths";
import { isPerLayer, perLayerPath, summaryView } from "@/lib/style/editor/sources";
import type { Scope } from "@/lib/style/editor/store";
import { choiceLabel, compoundLabel, summarize, summaryNumber, swatchOf } from "@/lib/style/editor/summaries";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";
import type { Tone } from "@/lib/style/tone";

import type { FieldInfo } from "@/components/map/panels/styleEditor/context";

const NUMBER_TYPES = new Set<FieldType>(["number", "integer"]);

export const isNumberType = (type: FieldType | undefined): boolean =>
  type !== undefined && NUMBER_TYPES.has(type);

/** `{name}` with `{` and `}` in the name escaped. */
export const fieldToken = (name: string): string => `{${name.replace(/[{}]/g, (brace) => `\\${brace}`)}}`;

/** The fields a template uses, in order. */
export const templateFields = (template: string): string[] =>
  parseTemplate(template).flatMap((part) => ("field" in part ? [part.field] : []));

/** The field when the template is that one field alone (a plain field label), else null. */
export function templateField(template: string): string | null {
  const parts = parseTemplate(template);
  return parts.length === 1 && "field" in parts[0] ? parts[0].field : null;
}

/** A number as the label shows it: the twin of the compiler's formatNumber expression. */
export function formatNumberText(n: number, format: NumberFormatSpec, locale: string): string {
  const decimals = format.decimals ?? "auto";
  if (format.percent) {
    // A percent of 1 in the reader's language ("73 %" in German), its decimals after the percent; never abbreviated.
    const percent = new Intl.NumberFormat(locale, {
      style: "percent",
      useGrouping: format.thousands_separator !== false,
      ...(typeof decimals === "number"
        ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
        : {}),
    }).format(n);
    return `${format.prefix ?? ""}${format.always_show_sign && n > 0 ? "+" : ""}${percent}${format.suffix ?? ""}`;
  }
  let text: string;
  if (format.thousands_separator === false) {
    text = String(typeof decimals === "number" ? Math.round(n * 10 ** decimals) / 10 ** decimals : n);
  } else {
    const value = decimals === 0 ? Math.round(n) : n;
    text = new Intl.NumberFormat(
      locale,
      typeof decimals === "number" ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : {}
    ).format(value);
  }
  if (format.abbreviate && Math.abs(n) >= 1000) {
    const [divisor, unit] = Math.abs(n) >= 1000000 ? [1000000, "M"] : [1000, "k"];
    const short = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    text = `${short.format(n / divisor)} ${unit}`;
  }
  if (format.always_show_sign && n > 0) text = `+${text}`;
  return `${format.prefix ?? ""}${text}${format.suffix ?? ""}`;
}

/** The template filled from `feature`: number fields formatted, a field the data lacks shown as `{name?}`. */
export function fillTemplate(
  template: string,
  feature: Record<string, unknown> | undefined,
  types: Record<string, FieldType>,
  format: NumberFormatSpec,
  locale: string,
  formats: Record<string, NumberFormatSpec> = {}
): string {
  return parseTemplate(template)
    .map((part) => {
      if ("text" in part) return part.text;
      if (!(part.field in types)) return `{${part.field}?}`;
      const value = feature?.[part.field];
      if (value === undefined || value === null) return "";
      return isNumberType(types[part.field]) && typeof value === "number"
        ? formatNumberText(value, { ...format, ...formats[part.field] }, locale)
        : String(value);
    })
    .join("");
}

export interface LabelSummaryContext {
  fields: FieldInfo[];
  mapZoom: number;
  geometry?: Geometry;
  /** The panel's language: the summary's first letter is a capital in it. */
  language: string;
  /** The tone of the basemap the map draws: a swatch shows the derived color the map draws (light by default). */
  tone?: Tone;
}

const TEXT_NUMBERS = ["letter_spacing", "line_height", "max_width"] as const;

/** The Text style row in short words, named as its rows: the font first ("Regular", "Medium italic"), then what
 * differs from the defaults in order of importance: case, letter spacing, line height, wrap width ("Regular,
 * uppercase, letter spacing 24%"). A value by zoom or by classes says that it varies, in its place. */
export function labelTextStyleSummary(
  doc: LayerStyle,
  base: Path,
  scope: Scope | null,
  t: TFunction,
  ctx: LabelSummaryContext
): string {
  // Each value as the scoped features draw it (`summaryView`); one a later record draws over varies. A key set once
  // for the layer (line height) is read where it is set.
  const at = (key: string) => {
    const path = `${base}.${key}`;
    // One value for the layer: read on the whole document, wherever a record holds it, in any scope.
    const held = perLayerPath(doc, path);
    if (held !== path || isPerLayer(keyOf(path)))
      return { value: getIn(doc, held), fixed: modeOf(doc, held, ctx.geometry) === "fixed", path };
    const { doc: shown, later } = summaryView(doc, scope, path);
    return {
      value: getIn(shown, path),
      fixed: !later && modeOf(shown, path, ctx.geometry) === "fixed",
      path,
    };
  };
  const parts: string[] = [];
  const weight = at("font.weight");
  const style = at("font.style");
  if (!weight.fixed || !style.fixed) parts.push(t("style_editor.ts_font_varies"));
  else {
    const font = { font: { weight: weight.value, style: style.value } };
    parts.push(compoundLabel(t, LABEL_FONT_CHOICE, LABEL_FONT_CHOICE.read(font)));
  }
  const transform = at("transform");
  if (!transform.fixed) parts.push(t("style_editor.ts_case_varies"));
  else if (transform.value === "uppercase" || transform.value === "lowercase")
    parts.push(t(`style_editor.ts_${transform.value}`));
  for (const name of TEXT_NUMBERS) {
    const { value, fixed, path } = at(name);
    const key = keyOf(path);
    if (!fixed) parts.push(t(`style_editor.ts_${name}_varies`));
    else if (typeof value === "number" && value !== DEFAULTS[key])
      parts.push(t(`style_editor.ts_${name}`, { value: summaryNumber(value, key, ctx.language) }));
  }
  const text = parts.join(", ");
  return text.charAt(0).toLocaleUpperCase(ctx.language) + text.slice(1);
}

/** The Halo row: the color's swatch and the width ("1.5 px", "1,5 px" in German), "None" at 0 or for a None color. */
export function labelHaloSummary(
  doc: LayerStyle,
  base: Path,
  scope: Scope | null,
  t: TFunction,
  ctx: LabelSummaryContext
): { text: string; swatch: string } {
  const width = `${base}.halo.width`;
  const color = `${base}.halo.color`;
  const swatch = swatchOf(summaryView(doc, scope, color).doc, color, ctx.geometry, {
    scoped: scope !== null,
    tone: ctx.tone,
  });
  const { doc: shown, later } = summaryView(doc, scope, width);
  const colorShown = summaryView(doc, scope, color);
  const none =
    (!later && modeOf(shown, width, ctx.geometry) === "fixed" && getIn(shown, width) === 0) ||
    (!colorShown.later && isNone(getIn(colorShown.doc, color)));
  return { text: none ? t("style_editor.halo_none") : summarize(doc, width, t, { ...ctx, scope }), swatch };
}

const DEFAULT_PLACEMENT: Record<Geometry, string> = { point: "auto", line: "line", polygon: "auto" };

/** The Position row: the label's placement (one for the layer); polygons with a height put it on the roofs. */
export function labelPositionSummary(
  doc: LayerStyle,
  base: Path,
  t: TFunction,
  ctx: LabelSummaryContext
): { placement: string; text: string } {
  // One for the layer, wherever it is set: the base, or the first class or rule record that sets it (spec 6.1).
  const set = getIn(doc, perLayerPath(doc, `${base}.placement`));
  const placement = typeof set === "string" ? set : DEFAULT_PLACEMENT[ctx.geometry ?? "point"];
  const roof = ctx.geometry === "polygon" && extrudes(doc as unknown as JsonObject);
  return {
    placement,
    text: roof ? t("style_editor.placement_roof") : choiceLabel(t, "label.placement", placement),
  };
}
