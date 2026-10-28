// Labels (spec 3.4, 16): the text as a concat of literals and formatted values, lines as format sections, the
// placement by geometry (around points, along or at the center of lines, at geoapi's anchors in polygons).
import type { LayerSpecification } from "maplibre-gl";

import { cascade, isSet, partUsed, perLayer } from "@/lib/style/compile/cascade";
import { FONT_STACKS } from "@/lib/style/compile/constants";
import { type PartContext, makeLayer, put, withLayerOpacity } from "@/lib/style/compile/parts";
import type { FieldType } from "@/lib/style/compile/types";
import {
  type Expr,
  type Value,
  combine,
  fold,
  fromForm,
  isZoomed,
  toProperty,
} from "@/lib/style/compile/values";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";

export interface NumberFormatSpec {
  decimals?: number | "auto";
  thousands_separator?: boolean;
  abbreviate?: boolean;
  always_show_sign?: boolean;
  prefix?: string;
  suffix?: string;
}

const LOCALE: Expr = ["global-state", "locale"];

const digits = (n: number) => ({ "min-fraction-digits": n, "max-fraction-digits": n });

/** `x` formatted with the decimals: number-format with the viewer's locale; 0 decimals round first. */
function formatted(x: Expr, decimals: number | "auto"): Expr {
  if (decimals === "auto") return ["number-format", x, { locale: LOCALE }];
  if (decimals === 0) return ["number-format", ["round", x], { locale: LOCALE }];
  return ["number-format", x, { locale: LOCALE, ...digits(decimals) }];
}

/** A number as a label shows it (spec 16 "numbers", 18.3). */
export function formatNumber(x: Expr, format: NumberFormatSpec = {}): Expr {
  const decimals = format.decimals ?? "auto";
  let text: Expr;
  if (format.thousands_separator === false) {
    const scale = typeof decimals === "number" ? 10 ** decimals : null;
    text = [
      "to-string",
      scale === null ? x : scale === 1 ? ["round", x] : ["/", ["round", ["*", x, scale]], scale],
    ];
  } else {
    text = formatted(x, decimals);
  }
  if (format.abbreviate) {
    const short = (n: number) => ["number-format", ["/", x, n], { locale: LOCALE, ...digits(1) }];
    text = [
      "case",
      [">=", ["abs", x], 1000000],
      ["concat", short(1000000), " M"],
      [">=", ["abs", x], 1000],
      ["concat", short(1000), " k"],
      text,
    ];
  }
  if (format.always_show_sign) text = ["case", [">", x, 0], ["concat", "+", text], text];
  if (format.prefix || format.suffix)
    text = [
      "concat",
      ...(format.prefix ? [format.prefix] : []),
      text,
      ...(format.suffix ? [format.suffix] : []),
    ];
  return text;
}

type TemplatePart = { text: string } | { field: string };

/** `{field}` placeholders and literal text; `\{` and `\}` are braces; an unbalanced brace stays literal. */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let buffer = "";
  for (let i = 0; i < template.length; ) {
    const ch = template[i];
    const next = template[i + 1];
    if (ch === "\\" && (next === "{" || next === "}")) {
      buffer += next;
      i += 2;
      continue;
    }
    if (ch === "{") {
      let j = i + 1;
      let name = "";
      while (j < template.length && template[j] !== "}" && template[j] !== "{") {
        if (template[j] === "\\" && (template[j + 1] === "{" || template[j + 1] === "}")) {
          name += template[j + 1];
          j += 2;
          continue;
        }
        name += template[j];
        j += 1;
      }
      if (template[j] === "}" && name.trim()) {
        if (buffer) parts.push({ text: buffer });
        buffer = "";
        parts.push({ field: name });
        i = j + 1;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  if (buffer) parts.push({ text: buffer });
  return parts;
}

interface TextContext {
  fields?: Record<string, FieldType>;
  formatFor?: (field: string) => NumberFormatSpec | undefined;
  /** Told when a value is formatted as a number (the style then needs the locale in its state). */
  onNumber?: () => void;
}

const isNumberField = (type?: FieldType) => type === "number" || type === "integer";

function partExprs(parts: TemplatePart[], ctx: TextContext): Expr[] {
  return parts.map((part) => {
    if ("text" in part) return part.text;
    const text: Expr = ["to-string", ["get", part.field]];
    const known = ctx.fields !== undefined;
    if (known && !isNumberField(ctx.fields?.[part.field])) return text;
    ctx.onNumber?.();
    const number = formatNumber(["to-number", ["get", part.field], 0], ctx.formatFor?.(part.field));
    // Without field types (the map compiles without them) each value is told apart while drawing.
    if (!known) return ["case", ["==", ["typeof", ["get", part.field]], "number"], number, text];
    return ["case", ["has", part.field], number, ""];
  });
}

/** A label template as a text-field expression. */
export function textField(template: string, ctx: TextContext): Expr {
  const exprs = partExprs(parseTemplate(template), ctx);
  if (!exprs.length) return "";
  return exprs.length === 1 ? exprs[0] : ["concat", ...exprs];
}

/** A template whose lines have their own size, color and weight, as format sections. */
function formatSections(template: string, lines: JsonObject[], baseSize: number, ctx: TextContext): Expr {
  const sections: Expr[] = ["format"];
  template.split("\n").forEach((line, i) => {
    if (i > 0) sections.push("\n", {});
    const style = lines[i] ?? {};
    const options: Record<string, unknown> = {};
    if (typeof style.size === "number") options["font-scale"] = fold(["/", style.size, baseSize]);
    if (isObject(style.font) && typeof style.font.weight === "string") {
      options["text-font"] = [
        "literal",
        FONT_STACKS[style.font.weight as keyof typeof FONT_STACKS] ?? FONT_STACKS.regular,
      ];
    }
    if (typeof style.color === "string") options["text-color"] = style.color;
    const exprs = partExprs(parseTemplate(line), ctx);
    sections.push(exprs.length === 1 ? exprs[0] : ["concat", ...exprs], options);
  });
  return sections;
}

const DEFAULT_PLACEMENT = { point: "auto", line: "line", polygon: "inside" } as const;

/**
 * `f` applied to each fixed offset an offset cascade can end in: the outputs of its match, case and step, or the
 * literal itself.
 */
function eachOffset(expr: Expr, f: (offset: number[]) => Expr): Expr {
  if (!Array.isArray(expr)) return f([0, 0]);
  const [op, ...args] = expr;
  if (op === "literal") return f(Array.isArray(args[0]) ? (args[0] as number[]) : [0, 0]);
  const last = args.length - 1;
  const output = (i: number) =>
    op === "match"
      ? (i % 2 === 0 && i > 0) || i === last
      : op === "case"
        ? i % 2 === 1 || i === last
        : op === "step"
          ? i % 2 === 1
          : false;
  if (op !== "match" && op !== "case" && op !== "step") return f([0, 0]);
  return [op, ...args.map((a, i) => (output(i) ? eachOffset(a, f) : a))];
}

/** A constant property as MapLibre's layout takes it: the bare array instead of a literal. */
const bare = (property: Expr): Expr =>
  Array.isArray(property) && property[0] === "literal" ? property[1] : property;

/** Whether any offset the value can end in moves the label. */
function moved(value: Value): boolean {
  let found = false;
  for (const expr of isZoomed(value) ? value.stops.map(([, e]) => e) : [value.expr]) {
    eachOffset(expr, ([x, y]) => {
      found ||= x !== 0 || y !== 0;
      return null;
    });
  }
  return found;
}

/** The marker size the base symbol sets, in any form. */
const baseMarkerSize = (style: JsonObject): unknown => {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  return isObject(symbol.marker) ? symbol.marker.size : undefined;
};

const baseNumber = (style: JsonObject, part: string, key: string): number => {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const node = isObject(symbol[part]) ? symbol[part] : {};
  return typeof node[key] === "number" ? (node[key] as number) : (DEFAULTS[`${part}.${key}`] as number);
};

export function labelLayers(ctx: PartContext): LayerSpecification[] {
  const { style, geometry } = ctx;
  const c = { fields: ctx.fields };
  if (!partUsed(style, "label", geometry) || !isSet(style, "label.text")) return [];
  const format = perLayer(style, "label.format") as NumberFormatSpec | undefined;
  const formats = perLayer(style, "label.formats") as Record<string, NumberFormatSpec> | undefined;
  const lines = perLayer(style, "label.lines");
  const baseSize = baseNumber(style, "label", "size");
  const text: TextContext = {
    fields: ctx.fields,
    formatFor: (field) => (isObject(formats) && formats[field]) || format,
    onNumber: () => {
      ctx.out.state.locale = { default: "en-US" };
    },
  };
  const toText = (template: unknown) =>
    typeof template !== "string"
      ? ""
      : Array.isArray(lines)
        ? formatSections(template, lines.filter(isObject), baseSize, text)
        : textField(template, text);

  const size = cascade(style, "label.size", c);
  const layout: Record<string, unknown> = {
    "text-field": toProperty(
      cascade(style, "label.text", { ...c, kind: "choice", fallback: "", map: toText })
    ),
    "text-size": toProperty(size),
  };
  const font = toProperty(
    cascade(style, "label.font.weight", {
      ...c,
      map: (w) => ["literal", FONT_STACKS[w as keyof typeof FONT_STACKS] ?? FONT_STACKS.regular],
    })
  );
  layout["text-font"] = Array.isArray(font) && font[0] === "literal" ? font[1] : font;
  put(
    layout,
    "text-max-width",
    combine([cascade(style, "label.max_width", c), size], ([m, s]) => ["/", m, s], { kind: "number" }),
    ctx,
    "label.max_width"
  );

  let sourceLayer = "default";
  const placement = perLayer(style, "label.placement") ?? DEFAULT_PLACEMENT[geometry];
  // Offsets vary per feature and by zoom (spec 4.5); MapLibre takes them in ems of the label size.
  const em = (px: number) => fold(["/", px, baseSize]) as number;
  const offset = cascade(style, "label.offset", { ...c, map: (o) => ["literal", o] });
  if (geometry === "point" && (placement === "auto" || placement === "above")) {
    // Around the marker: half its size plus 2 px, per zoom stop when the base size varies by zoom (spec 16).
    const marker = partUsed(style, "marker", "point")
      ? fromForm(baseMarkerSize(style), "number", DEFAULTS["marker.size"])
      : { expr: 0 };
    const fallbackSize = partUsed(style, "marker", "point") ? baseNumber(style, "marker", "size") : 0;
    const around = combine(
      [marker, offset],
      ([size, o]) =>
        eachOffset(o, ([x, y]) => {
          const d = em((typeof size === "number" ? size : fallbackSize) / 2 + 2);
          const at = (ax: number, ay: number) => [fold(["+", ax, em(x)]), fold(["+", ay, em(y)])];
          return [
            "literal",
            placement === "auto"
              ? ["top", at(0, d), "bottom", at(0, -d), "right", at(-d, 0), "left", at(d, 0)]
              : at(0, -d),
          ];
        }),
      { kind: "number" }
    );
    if (placement === "auto") {
      layout["text-variable-anchor-offset"] = bare(toProperty(around));
    } else {
      layout["text-anchor"] = "bottom";
      layout["text-offset"] = bare(toProperty(around));
    }
  } else if (moved(offset)) {
    layout["text-offset"] = bare(
      toProperty(
        combine([offset], ([o]) => eachOffset(o, ([x, y]) => ["literal", [em(x), em(y)]]), { kind: "choice" })
      )
    );
  }
  if (geometry === "line" && placement === "line") layout["symbol-placement"] = "line";
  if (geometry === "line" && placement === "center") {
    sourceLayer = "default_decoration";
    ctx.out.tileParams.decorations = [
      ...new Set([...(ctx.out.tileParams.decorations ?? []), "center" as const]),
    ];
  }
  if (geometry === "polygon") {
    sourceLayer = "default_anchor";
    ctx.out.tileParams.label = true;
  }
  const priority = perLayer(style, "label.priority");
  if (isObject(priority) && typeof priority.field === "string") {
    const value: Expr = ["to-number", ["get", priority.field], 0];
    layout["symbol-sort-key"] = priority.top === "smallest" ? value : ["-", value];
  }
  if (perLayer(style, "label.allow_overlap") === true) layout["text-allow-overlap"] = true;

  const paint: Record<string, unknown> = {};
  put(paint, "text-color", cascade(style, "label.color", c), ctx, "label.color");
  put(paint, "text-halo-color", cascade(style, "label.halo.color", c), ctx, "label.halo.color");
  put(paint, "text-halo-width", cascade(style, "label.halo.width", c), ctx, "label.halo.width");
  put(
    paint,
    "text-opacity",
    withLayerOpacity(ctx, cascade(style, "label.opacity", { ...c, kind: "number", fallback: 1 })),
    ctx,
    "label.opacity"
  );
  return [makeLayer(ctx, "label", "symbol", "label", layout, paint, sourceLayer, { ordered: false })];
}
