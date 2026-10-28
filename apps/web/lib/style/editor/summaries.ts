// The short text a row shows for a value: "#C7E9B4 · 72%", "3 px", "2 → 6 px", "Dotted → Dashed → Solid",
// "By Visitors per year".
import type { TFunction } from "i18next";

import type { Geometry } from "@/lib/style/compile/types";
import { SLIDERS } from "@/lib/style/editor/defaults";
import { MAIN_COLOR, classificationFor, keyOf, modeOf } from "@/lib/style/editor/forms";
import { type Path, getIn } from "@/lib/style/editor/store";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import { PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";
import { isObject } from "@/lib/style/json";

import type { FieldInfo } from "@/components/map/panels/styleEditor/context";

interface SummaryContext {
  fields: FieldInfo[];
  mapZoom: number;
  geometry?: Geometry;
}

/** The label of a choice: `style_editor.value_<key with _>_<value>` ("value_line_dash_dash_dot" is "Dash dot"). */
export const choiceLabel = (t: TFunction, key: string, value: unknown): string =>
  t(`style_editor.value_${key.replace(/\./g, "_")}_${String(value)}`, { defaultValue: String(value) });

function number(value: number, key: string): string {
  const slider = SLIDERS[key];
  if (slider?.pct) return `${Math.round(value * 100)}%`;
  const text = String(Math.round(value * 100) / 100);
  return slider?.unit ? `${text} ${slider.unit}` : text;
}

export function summarize(doc: LayerStyle, path: Path, t: TFunction, ctx: SummaryContext): string {
  const key = keyOf(path);
  const kind = CAPABILITIES[key]?.kind ?? "choice";
  const label = (field: unknown) => ctx.fields.find((f) => f.name === field)?.label ?? String(field);
  const value = getIn(doc, path);
  switch (modeOf(doc, path, ctx.geometry)) {
    case "classes":
      return t("style_editor.by_field", { field: label(classificationFor(doc, key, ctx.geometry)?.field) });
    case "attribute":
    case "raw":
      return t("style_editor.by_field", { field: label(isObject(value) ? value.field : undefined) });
    case "zoom": {
      const stops = (isObject(value) && Array.isArray(value.zoom) ? value.zoom : []) as Array<
        [number, unknown]
      >;
      if (kind === "color") return t("style_editor.by_zoom_stops", { count: stops.length });
      if (kind === "number" && stops.every(([, v]) => typeof v === "number")) {
        const first = stops[0][1] as number;
        const last = stops[stops.length - 1][1] as number;
        const slider = SLIDERS[key];
        if (slider?.pct) return `${number(first, key)} → ${number(last, key)}`;
        const plain = (n: number) => String(Math.round(n * 100) / 100);
        return `${plain(first)} → ${plain(last)}${slider?.unit ? ` ${slider.unit}` : ""}`;
      }
      return stops.map(([, v]) => (isObject(v) ? "…" : choiceLabel(t, key, v))).join(" → ");
    }
    default: {
      const fixed = value ?? DEFAULTS[key];
      if (kind === "color") {
        if (fixed === "fill") return t("style_editor.same_as_fill");
        const hex = typeof fixed === "string" ? fixed.toUpperCase() : "";
        const opacityPath = path.replace(/color$/, "opacity");
        const opacityKey = key.replace(/color$/, "opacity");
        const opacity = opacityPath !== path ? (getIn(doc, opacityPath) ?? DEFAULTS[opacityKey]) : undefined;
        return typeof opacity === "number" ? `${hex} · ${Math.round(opacity * 100)}%` : hex;
      }
      if (typeof fixed === "number") return number(fixed, key);
      return fixed === undefined ? "" : choiceLabel(t, key, fixed);
    }
  }
}

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
/** A hatched swatch for a color the row cannot show as one. */
export const HATCH = "repeating-linear-gradient(45deg, #c9ced6 0 2px, transparent 2px 5px)";
const gradient = (colors: string[]) =>
  colors.length > 1 ? `linear-gradient(90deg, ${colors.join(", ")})` : (colors[0] ?? HATCH);

/** The CSS background a row's swatch shows for the color at `path`. `scoped`: `doc` is one class's view, which
 * draws its own color, not the classes'. */
export function swatchOf(
  doc: LayerStyle,
  path: Path,
  geometry?: Geometry,
  opts: { scoped?: boolean } = {}
): string {
  const key = keyOf(path);
  const value = getIn(doc, path) ?? DEFAULTS[key];
  if (value === "fill") {
    const main = MAIN_COLOR[geometry ?? "polygon"];
    return swatchOf(doc, `symbol.${main}`, geometry, opts);
  }
  // A color set by classes shows the classes' colors, in their order: the color under them draws nothing.
  const classified =
    path.startsWith("symbol.") && !opts.scoped ? classificationFor(doc, key, geometry) : undefined;
  const classColors = (Array.isArray(classified?.classes) ? classified.classes : []).flatMap((record) => {
    const color = getIn(record, key);
    return typeof color === "string" && HEX.test(color) ? [color] : [];
  });
  if (classColors.length) return gradient(classColors);
  if (typeof value === "string") return HEX.test(value) ? value : HATCH;
  if (!isObject(value)) return HATCH;
  if (Array.isArray(value.zoom))
    return gradient(
      (value.zoom as Array<[number, unknown]>).flatMap(([, v]) =>
        typeof v === "string" && HEX.test(v) ? [v] : []
      )
    );
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
