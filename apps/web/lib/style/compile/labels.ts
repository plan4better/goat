// Labels (spec 3.4, 16): the text as a concat of literals and formatted values, lines as format sections, the
// placement by geometry (around points, along or at the center of lines, at geoapi's anchors in polygons).
import type { LayerSpecification } from "maplibre-gl";

import { cascade, isSet, partUsed, perLayer } from "@/lib/style/compile/cascade";
import { fontStack } from "@/lib/style/compile/constants";
import { derivedValue } from "@/lib/style/compile/derived";
import {
  type PartContext,
  makeLayer,
  onDecorations,
  put,
  ruleInputs,
  withLayerOpacity,
} from "@/lib/style/compile/parts";
import { markersAsImages } from "@/lib/style/compile/points";
import { extrudes, heightValue } from "@/lib/style/compile/polygons";
import type { FieldType } from "@/lib/style/compile/types";
import {
  type Expr,
  type Value,
  combine,
  fold,
  fromForm,
  hasValue,
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
  /** The value as a percent of 1: 0.73 reads 73 %. */
  percent?: boolean;
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

/** `x` with exactly `decimals` decimals (1 or more) and no thousands separator, which number-format always writes:
 * the sign, the whole part as it is, and the decimals from number-format, so the decimal mark is the locale's. */
function ungrouped(x: Expr, decimals: number): Expr {
  const scale = 10 ** decimals;
  const scaled: Expr = ["round", ["*", x, scale]];
  const part: Expr = [
    "number-format",
    ["/", ["%", ["abs", scaled], scale], scale],
    { locale: LOCALE, ...digits(decimals) },
  ];
  return [
    "concat",
    ["case", ["<", scaled, 0], "-", ""],
    ["to-string", ["floor", ["/", ["abs", scaled], scale]]],
    // Less the 0 before the decimal mark.
    ["slice", part, 1],
  ];
}

/** A number as a label shows it (spec 16 "numbers", 18.3). */
export function formatNumber(x: Expr, format: NumberFormatSpec = {}): Expr {
  // A percent: the value times 100 with the percent sign after it (MapLibre's number-format has no percent style), never
  // abbreviated; the sign still reads the value. Automatic decimals show none, as a percent reads everywhere else, and
  // a number of decimals shows in full.
  const decimals = format.decimals ?? "auto";
  const places = format.percent && decimals === "auto" ? 0 : decimals;
  const value: Expr = format.percent ? ["*", x, 100] : x;
  let text: Expr;
  if (format.percent && format.thousands_separator === false && typeof places === "number" && places > 0) {
    text = ungrouped(value, places);
  } else if (format.thousands_separator === false) {
    const scale = typeof places === "number" ? 10 ** places : null;
    text = [
      "to-string",
      scale === null ? value : scale === 1 ? ["round", value] : ["/", ["round", ["*", value, scale]], scale],
    ];
  } else {
    text = formatted(value, places);
  }
  if (format.percent) text = ["concat", text, "%"];
  else if (format.abbreviate) {
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
    return ["case", hasValue(part.field), number, ""];
  });
}

/** A label template as a text-field expression. */
export function textField(template: string, ctx: TextContext): Expr {
  const exprs = partExprs(parseTemplate(template), ctx);
  if (!exprs.length) return "";
  return exprs.length === 1 ? exprs[0] : ["concat", ...exprs];
}

/** A weight's stack in one style, as a literal. */
const stackOf =
  (style: "normal" | "italic") =>
  (weight: unknown): Expr => ["literal", [...fontStack(weight, style)]];

/** The stack of a style over the weight's upright and italic stacks (spec 16). */
function withStyle(upright: Expr, italic: Expr, style: Expr): Expr {
  if (typeof style === "string") return style === "italic" ? italic : upright;
  return ["case", ["==", style, "italic"], italic, upright];
}

/** A template whose lines have their own size, color and font, as format sections. A line's font replaces the
 * label's: a key it leaves out takes its default. */
function formatSections(template: string, lines: JsonObject[], baseSize: number, ctx: TextContext): Expr {
  const sections: Expr[] = ["format"];
  template.split("\n").forEach((line, i) => {
    if (i > 0) sections.push("\n", {});
    const style = lines[i] ?? {};
    const options: Record<string, unknown> = {};
    if (typeof style.size === "number") options["font-scale"] = fold(["/", style.size, baseSize]);
    const font = isObject(style.font) ? style.font : {};
    if (typeof font.weight === "string" || typeof font.style === "string")
      options["text-font"] = ["literal", [...fontStack(font.weight, font.style)]];
    if (typeof style.color === "string") options["text-color"] = style.color;
    const exprs = partExprs(parseTemplate(line), ctx);
    sections.push(exprs.length === 1 ? exprs[0] : ["concat", ...exprs], options);
  });
  return sections;
}

const DEFAULT_PLACEMENT = { point: "auto", line: "line", polygon: "auto" } as const;

/**
 * The fixed placements beside a point (spec 3.4): MapLibre's text-anchor, the point of the label that sits on the
 * feature, so the opposite of the side named; and the direction the label moves to clear the marker.
 */
const BESIDE: Record<string, { anchor: string; x: number; y: number }> = {
  above: { anchor: "bottom", x: 0, y: -1 },
  below: { anchor: "top", x: 0, y: 1 },
  left: { anchor: "right", x: -1, y: 0 },
  right: { anchor: "left", x: 1, y: 0 },
  above_left: { anchor: "bottom-right", x: -1, y: -1 },
  above_right: { anchor: "bottom-left", x: 1, y: -1 },
  below_left: { anchor: "top-right", x: -1, y: 1 },
  below_right: { anchor: "top-left", x: 1, y: 1 },
};

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

/** MapLibre's icon padding, which the compiler leaves at its default (px). */
const ICON_PADDING = 2;

/** Whether the layer's marker takes part in MapLibre's collisions, so that its own label could hide it: an icon alone
 * unless overlap is turned on, a marker image when overlap is turned off (a circle layer never collides). */
function markerCollides(style: JsonObject, geometry: PartContext["geometry"]): boolean {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const shape = (isObject(symbol.marker) ? symbol.marker.shape : undefined) ?? DEFAULTS["marker.shape"];
  const overlap = perLayer(style, "marker.allow_overlap");
  if (shape === "icon") return overlap !== true;
  // Marker images draw overlapping unless the style turns overlap off (points.ts, `markerImageLayers`).
  return isSet(style, "marker.allow_overlap") && overlap === false && markersAsImages(style, geometry);
}

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
  // The stack follows both keys, each by zoom and per class.
  const font = toProperty(
    combine(
      [
        cascade(style, "label.font.weight", { ...c, map: stackOf("normal") }),
        cascade(style, "label.font.weight", { ...c, map: stackOf("italic") }),
        cascade(style, "label.font.style", c),
      ],
      ([upright, italic, fontStyle]) => withStyle(upright, italic, fontStyle),
      { step: true, kind: "choice" }
    )
  );
  layout["text-font"] = Array.isArray(font) && font[0] === "literal" ? font[1] : font;
  put(
    layout,
    "text-max-width",
    combine([cascade(style, "label.max_width", c), size], ([m, s]) => ["/", m, s], { kind: "number" }),
    ctx,
    "label.max_width"
  );

  put(layout, "text-transform", cascade(style, "label.transform", c), ctx, "label.transform");
  put(
    layout,
    "text-letter-spacing",
    cascade(style, "label.letter_spacing", { ...c, kind: "number" }),
    ctx,
    "label.letter_spacing"
  );
  // One line height for the whole layer (MapLibre takes no value per feature), fixed or by zoom.
  put(
    layout,
    "text-line-height",
    fromForm(perLayer(style, "label.line_height"), "number", DEFAULTS["label.line_height"]),
    ctx,
    "label.line_height"
  );

  let sourceLayer = "default";
  const placement = perLayer(style, "label.placement") ?? DEFAULT_PLACEMENT[geometry];
  // Offsets vary per feature and by zoom (spec 4.5); MapLibre takes them in ems of the label size.
  const em = (px: number) => fold(["/", px, baseSize]) as number;
  const offset = cascade(style, "label.offset", { ...c, map: (o) => ["literal", o] });
  const withMarker = partUsed(style, "marker", geometry);
  // A line's label sits along the line or at its center point; there, as on a polygon's label point, it takes the
  // positions of a point's label around the marker (spec 3.4).
  const side = typeof placement === "string" && placement in BESIDE ? BESIDE[placement] : undefined;
  const center =
    geometry === "line" && (placement === "center" || placement === "auto" || side !== undefined);
  // A GeoJSON line has no center point: MapLibre places the label at the middle of the line itself, where a fixed
  // anchor and offset move it but no variable anchors.
  const lineMiddle = center && !ctx.vectorSource;
  // `auto` beside the marker; on an area or a line without one it stays in the middle, as `inside` and `center` do.
  const around =
    side !== undefined || (placement === "auto" && (geometry === "point" || (withMarker && !lineMiddle)));
  if (around) {
    // Around the marker: half its size plus 2 px, per zoom stop when the base size varies by zoom (spec 16). Beside a
    // marker that collides, also the icon's and the label's collision padding: MapLibre places the label first and
    // would drop the marker where the two boxes meet.
    const collides = withMarker && markerCollides(style, geometry);
    const drawn = withMarker
      ? fromForm(baseMarkerSize(style), "number", DEFAULTS["marker.size"])
      : { expr: 0 };
    // MapLibre lays out an icon's collision box at the size it has one zoom above the tile's, the label's offset at
    // the tile's zoom: beside a marker that collides and grows with the zoom, each zoom's clearance takes the size of
    // the next.
    const marker =
      collides && isZoomed(drawn)
        ? { ...drawn, stops: drawn.stops.map(([z, e]): [number, Expr] => [z - 1, e]) }
        : drawn;
    const fallbackSize = withMarker ? baseNumber(style, "marker", "size") : 0;
    const labelPadding = DEFAULTS["label.padding"] as number;
    const padding = collides
      ? fromForm(perLayer(style, "label.padding"), "number", labelPadding)
      : { expr: null };
    const offsets = combine(
      [marker, offset, padding],
      ([size, o, pad]) =>
        eachOffset(o, ([x, y]) => {
          const clear = pad === null ? 0 : ICON_PADDING + (typeof pad === "number" ? pad : labelPadding);
          const d = em((typeof size === "number" ? size : fallbackSize) / 2 + 2 + clear);
          const shift = (ax: number, ay: number) => [fold(["+", ax, em(x)]), fold(["+", ay, em(y)])];
          return [
            "literal",
            side
              ? shift(side.x * d, side.y * d)
              : ["top", shift(0, d), "bottom", shift(0, -d), "right", shift(-d, 0), "left", shift(d, 0)],
          ];
        }),
      { kind: "number" }
    );
    if (side) {
      // A fixed side: the label is dropped on a collision, never moved to another side.
      layout["text-anchor"] = side.anchor;
      // Upright beside the marker, which stands upright at the line's middle too.
      if (lineMiddle) layout["text-rotation-alignment"] = "viewport";
      layout["text-offset"] = bare(toProperty(offsets));
      // Beside the marker the lines line up on its side; above and below it they stay centred (MapLibre's default).
      if (side.x !== 0) layout["text-justify"] = "auto";
    } else {
      layout["text-variable-anchor-offset"] = bare(toProperty(offsets));
      // The lines of a label beside the marker line up on the marker's side; above and below it they stay centred.
      layout["text-justify"] = "auto";
    }
  } else if (moved(offset)) {
    layout["text-offset"] = bare(
      toProperty(
        combine([offset], ([o]) => eachOffset(o, ([x, y]) => ["literal", [em(x), em(y)]]), { kind: "choice" })
      )
    );
  }
  // Unset, MapLibre's own spacing (250 px) and padding (2 px) are the defaults (spec 18.2).
  const perLayerNumber = (path: string) =>
    toProperty(fromForm(perLayer(style, path), "number", DEFAULTS[path] as number));
  if (geometry === "line" && placement === "line") {
    layout["symbol-placement"] = "line";
    if (isSet(style, "label.spacing")) layout["symbol-spacing"] = perLayerNumber("label.spacing");
  }
  if (isSet(style, "label.padding")) layout["text-padding"] = perLayerNumber("label.padding");
  if (center && ctx.vectorSource) sourceLayer = "default_decoration";
  // GeoJSON lines carry no center points: MapLibre places the label at the middle of the line.
  else if (center) layout["symbol-placement"] = "line-center";
  if (geometry === "polygon") {
    sourceLayer = "default_anchor";
    ctx.out.tileParams.label = true;
    // Names of raised polygons sit on their roofs (3D spec 7.5).
    if (extrudes(style)) layout["symbol-height-offset"] = toProperty(heightValue(ctx));
  }
  const priority = perLayer(style, "label.priority");
  if (isObject(priority) && typeof priority.field === "string") {
    const value: Expr = ["to-number", ["get", priority.field], 0];
    layout["symbol-sort-key"] = priority.top === "smallest" ? value : ["-", value];
  }
  if (perLayer(style, "label.allow_overlap") === true) layout["text-allow-overlap"] = true;

  const paint: Record<string, unknown> = {};
  // The text and halo colors, "auto" chosen from the feature's color (spec 18.10); a cluster's number and its halo
  // from the cluster's marker.
  const derive = {
    geometry,
    fields: ctx.fields,
    inputs: ruleInputs(ctx),
    ...(ctx.color !== undefined
      ? {
          follow: (map?: (color: unknown) => Expr) => ({
            expr: ctx.color!(map ?? ((color) => color as Expr)),
          }),
        }
      : {}),
  };
  const keys = ctx.cluster ? "cluster.symbol." : "";
  put(paint, "text-color", derivedValue(style, `${keys}label.color`, derive), ctx, "label.color");
  put(
    paint,
    "text-halo-color",
    derivedValue(style, `${keys}label.halo.color`, derive),
    ctx,
    "label.halo.color"
  );
  put(paint, "text-halo-width", cascade(style, "label.halo.width", c), ctx, "label.halo.width");
  put(
    paint,
    "text-opacity",
    withLayerOpacity(ctx, cascade(style, "label.opacity", { ...c, kind: "number", fallback: 1 })),
    ctx,
    "label.opacity"
  );
  const label = makeLayer(ctx, "label", "symbol", "label", layout, paint, sourceLayer, { ordered: false });
  return [center ? onDecorations(ctx, ["center"], label) : label];
}
