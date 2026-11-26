"use client";

// A layer's legend (spec 7.2) from its data model (buildLegend): the layer list, the style panel's preview, popups'
// header icons and print draw it with these components.
import { Box, ButtonBase, Skeleton, type SxProps, type Theme, Typography } from "@mui/material";
import { Fragment, type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { checkered, seeThrough } from "@/lib/style/checker";
import { isNone, opaque } from "@/lib/style/colors";
import { DASHES } from "@/lib/style/compile/constants";
import { defaultResolveIcon } from "@/lib/style/compile/images";
import { SQUARE_RADIUS } from "@/lib/style/compile/markerImage";
import { type PatternKind, patternTile } from "@/lib/style/compile/patternImage";
import type { Geometry } from "@/lib/style/compile/types";
import { formatNumberText } from "@/lib/style/editor/labels";
import { SCENE_DEFAULTS } from "@/lib/style/generated/scene";
import type { JsonObject } from "@/lib/style/json";
import {
  LEGEND_NEUTRAL,
  type Legend,
  type LegendEntry,
  type LegendSection,
  type Swatch,
  baseSwatch,
  classOf,
  rangeText,
  valuesText,
} from "@/lib/style/legend";
import { MARKER_SHAPES, markerShapeOf } from "@/lib/style/markerShapes";

import { CheckerPattern } from "@/components/map/common/CheckerPattern";

import { rampGradient } from "./rampGradient";

const str = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback);

/** An icon at `side` px: a library icon in `tint` (a mask over the color), emoji and uploads as they are, loaded as
 * CORS requests like the map's icons. */
function MarkerIcon({ icon, tint, side }: { icon: string; tint: string; side: number }) {
  const image = defaultResolveIcon(icon);
  if (!image) return null;
  if (!image.sdf)
    return (
      <img
        src={image.url}
        alt=""
        crossOrigin="anonymous"
        width={side}
        height={side}
        style={{ objectFit: "contain", display: "block" }}
      />
    );
  const mask = `url("${image.url}")`;
  return (
    <span
      data-marker-icon={image.url}
      style={{
        display: "block",
        width: side,
        height: side,
        background: checkered(tint),
        maskImage: mask,
        WebkitMaskImage: mask,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}

/** Every swatch is a fixed 20 by 14 px box, whatever the symbol's size on the map: a legend stays calm and does not
 * jump with the zoom. Only a block that is about size (classes by size, the samples of a size by attribute) draws its
 * entries at different sizes: in the ratio they have to each other, the largest no bigger than the caps below. */
const BOX = { width: 20, height: 14 };
const CAPS = { marker: 28, line: 12, outline: 6 };

/** The size the style gives a swatch's symbol: a marker's size, a line's width, an area's outline width. */
function sizeOf(swatch: Swatch): number {
  if (swatch.geometry === "point") return num(swatch.marker?.size, 8);
  if (swatch.geometry === "line") return num(swatch.line?.width, 2);
  return num(swatch.outline?.width, 1);
}

/** The factor a block of sizes is drawn at: 1 while its largest entry fits the cap, else what brings the largest
 * down to the cap. One factor for the whole block, so its entries keep their ratio to each other. */
export function sizeScale(swatches: Swatch[]): number {
  if (!swatches.length) return 1;
  const cap = { point: CAPS.marker, line: CAPS.line, polygon: CAPS.outline }[swatches[0].geometry];
  const largest = Math.max(...swatches.map(sizeOf));
  return largest > cap ? cap / largest : 1;
}

/** The width the swatches of a block of sizes share: room for its largest marker, so the symbols share a middle
 * and the texts line up. */
export function sizeColumn(swatches: Swatch[], scale: number): number {
  if (!swatches.length || swatches[0].geometry !== "point") return BOX.width;
  const largest = Math.max(...swatches.map((s) => markerSide(s.marker ?? {}, scale)));
  return Math.max(BOX.width, Math.ceil(largest) + 4);
}

/** A marker's side in a block of sizes: its share of the cap, at least 3 px so the smallest still shows. */
function markerSide(marker: Record<string, unknown>, scale: number): number {
  return Math.min(Math.max(num(marker.size, 8) * scale, 3), CAPS.marker);
}

/** `stroke-dasharray` of a dash at a stroke width (`DASHES` are in line widths); none for a solid line. */
function dashOf(dash: unknown, width: number): string | undefined {
  const pattern = typeof dash === "string" && dash !== "solid" ? DASHES[dash] : undefined;
  return pattern?.map((part) => Math.max(part * Math.max(width, 1), 1)).join(" ");
}

interface SwatchProps {
  swatch: Swatch;
  /** In a block of sizes: the block's scale (`sizeScale`); the symbol is drawn at its size times it. */
  sized?: number;
  /** The width of a marker's box where a legend holds a block of sizes: all its swatches share it (`sizeColumn`). */
  width?: number;
  /** In a block that sets the outline alone: no fill and a ring of at least 2 px, so the outline reads. */
  ring?: boolean;
  /** The most a marker's side may be outside a block of sizes, in px (a marker on an area or a line). */
  cap?: number;
  /** Drawn inside another swatch, which is the one hidden from screen readers. */
  nested?: boolean;
}

/** A cluster's badge (spec 8.2 `count: badge`): a dot in its fill color at the marker's upper right, with its ring. */
function BadgeDot({ badge }: { badge: NonNullable<Swatch["badge"]> }) {
  return (
    <span
      data-cluster-badge
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        boxSizing: "border-box",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: checkered(badge.color),
        border: `1px solid ${badge.ring}`,
      }}
    />
  );
}

/** A point's marker as the map draws it (lib/style/render/markerImages.ts): its shape in the fill (a hollow marker
 * without it) with the stroke and the icon on it, or the icon alone. It is 14 px high whatever the marker's size, except
 * in a block of sizes. */
function MarkerSwatch({ swatch, sized, width, ring, cap, nested }: SwatchProps) {
  const hidden = nested ? undefined : ("true" as const);
  const marker = swatch.marker ?? {};
  const icon = typeof marker.icon === "string" ? marker.icon : undefined;
  const hollow = marker.fill === false || ring === true;
  const checker = useId();
  // A None fill draws nothing; one that is not opaque lies over the checkerboard.
  const fillColor = str(marker.color, "#2bb381");
  const filled = !hollow && !isNone(fillColor);
  // The marker opacity is the fill's: a hollow marker's outline and icon are not faded by it, as on the map.
  const opacity = hollow ? 1 : num(marker.opacity, 1);
  const stroke = swatch.outline && num(swatch.outline.opacity, 1) > 0 ? swatch.outline : undefined;
  // A None marker with nothing else to draw shows the checkerboard alone, as the panel shows a None color.
  const alone = !hollow && isNone(fillColor) && !stroke && !icon;
  const clear = (filled && seeThrough(fillColor)) || alone;
  const strokeWidth = stroke ? (ring ? 2 : Math.min(num(stroke.width, 1), 2)) : 0;
  const shape = markerShapeOf(marker.shape);
  const round = shape === "circle" || shape === "square";
  // 14 px; a plain circle its own size up to that.
  const fixed = icon || !round || marker.shape === "square" || marker.shape === "icon";
  const small = fixed ? 14 : Math.min(Math.max(num(marker.size, 8), 4), 14);
  const side = sized !== undefined ? markerSide(marker, sized) : Math.min(small, cap ?? small);
  const box = {
    width: width ?? BOX.width,
    height: sized !== undefined ? Math.max(BOX.height, side) : BOX.height,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    position: "relative" as const,
  };
  const badge = swatch.badge ? <BadgeDot badge={swatch.badge} /> : null;
  if (marker.shape === "icon")
    return (
      <span aria-hidden={hidden} style={{ ...box, opacity }}>
        <MarkerIcon icon={icon ?? "goat:marker"} tint={str(marker.color, "#2bb381")} side={side} />
        {badge}
      </span>
    );
  if (!round) {
    // The other shapes and the pins as their outline, the icon in the shape's head.
    const spec = MARKER_SHAPES[shape];
    const iconSide = Math.round(side * spec.icon.share);
    return (
      <span aria-hidden={hidden} style={{ ...box, opacity }}>
        <svg
          data-marker-shape={shape}
          width={side}
          height={side}
          viewBox="0 0 24 24"
          style={{ overflow: "visible" }}>
          {clear && (
            <defs>
              <CheckerPattern id={checker} />
            </defs>
          )}
          {clear && <path data-checker-under d={spec.path} fill={`url(#${checker})`} />}
          <path
            d={spec.path}
            fill={filled ? fillColor : "none"}
            stroke={stroke ? str(stroke.color, "#000000") : undefined}
            strokeWidth={strokeWidth * (24 / side)}
            strokeLinejoin="round"
          />
        </svg>
        {icon && (
          <span
            style={{
              position: "absolute",
              left: (box.width - side) / 2 + (spec.icon.cx / 24) * side - iconSide / 2,
              top: (box.height - side) / 2 + (spec.icon.cy / 24) * side - iconSide / 2,
            }}>
            <MarkerIcon icon={icon} tint={str(marker.icon_color, "#ffffff")} side={iconSide} />
          </span>
        )}
        {badge}
      </span>
    );
  }
  return (
    <span aria-hidden={hidden} style={{ ...box, opacity }}>
      <span
        data-marker-shape={marker.shape === "square" ? "square" : "circle"}
        style={{
          boxSizing: "border-box",
          width: side,
          height: side,
          borderRadius: marker.shape === "square" ? side * SQUARE_RADIUS : "50%",
          background: filled || alone ? checkered(fillColor) : "transparent",
          border: stroke ? `${strokeWidth}px solid ${str(stroke.color, "#000000")}` : undefined,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
        {icon && (
          <MarkerIcon
            icon={icon}
            tint={str(marker.icon_color, "#ffffff")}
            side={Math.round(side * MARKER_SHAPES[shape].icon.share)}
          />
        )}
      </span>
      {badge}
    </span>
  );
}

/** A line with its casing under it and its dash. */
function LineSwatch({ swatch, sized, nested }: SwatchProps) {
  const line = swatch.line ?? {};
  const stroke =
    sized !== undefined
      ? Math.min(Math.max(num(line.width, 2) * sized, 0.5), CAPS.line)
      : Math.min(num(line.width, 2), 8);
  const casing = swatch.casing;
  // The casing shows on each side of the line, inside the box.
  const around = casing ? Math.min(stroke + 2 * Math.min(num(casing.width, 1), 2), 12) : 0;
  const { width, height } = BOX;
  const checker = useId();
  // A color that is not opaque shows the checkerboard where nothing of the layer lies under it; a None line on no casing
  // shows it alone, as the panel shows a None color.
  const casingShows = casing !== undefined && !isNone(casing.color);
  const casingClear = casingShows && seeThrough(casing.color);
  const lineClear = !casingShows && seeThrough(line.color);
  const under = (strokeWidth: number) => (
    <line
      data-checker-under
      x1="1"
      y1={height / 2}
      x2={width - 1}
      y2={height / 2}
      stroke={`url(#${checker})`}
      strokeWidth={strokeWidth}
    />
  );
  return (
    <svg width={width} height={height} aria-hidden={nested ? undefined : "true"} style={{ flex: "none" }}>
      {(casingClear || lineClear) && (
        <defs>
          <CheckerPattern id={checker} />
        </defs>
      )}
      {casingClear && under(around)}
      {lineClear && under(stroke)}
      {casing && (
        <line
          data-casing
          x1="1"
          y1={height / 2}
          x2={width - 1}
          y2={height / 2}
          stroke={str(casing.color, "#ffffff")}
          strokeWidth={around}
          strokeOpacity={num(casing.opacity, 1)}
        />
      )}
      <line
        x1="1"
        y1={height / 2}
        x2={width - 1}
        y2={height / 2}
        stroke={str(line.color, "#2166ac")}
        strokeWidth={stroke}
        strokeOpacity={num(line.opacity, 1)}
        strokeDasharray={dashOf(line.dash, stroke)}
      />
    </svg>
  );
}

/** A marker on an area or a line is at most this high in its swatch, so the area or the line shows around it. */
const MARKER_ON_AREA = 10;

/** The icon a line's arrows draw (spec 3.2 `arrows.icon`), as the map draws it: its top along the line in the
 * drawing direction (left to right here), against it, or both ways, or upright where it does not turn with the line;
 * in the middle, or at the ends it is placed at. */
function ArrowIcons({ arrows }: { arrows: Record<string, unknown> }) {
  const turns =
    arrows.turn_with_line === false
      ? [0]
      : arrows.direction === "both"
        ? [90, -90]
        : [arrows.direction === "backward" ? -90 : 90];
  const justify =
    arrows.placement === "start"
      ? "flex-start"
      : arrows.placement === "end"
        ? "flex-end"
        : arrows.placement === "both_ends"
          ? "space-between"
          : "center";
  const places = arrows.placement === "both_ends" ? ["start", "end"] : ["one"];
  return (
    <span
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: justify,
      }}>
      {places.map((place) => (
        <span
          key={place}
          style={{ position: "relative", width: MARKER_ON_AREA, height: MARKER_ON_AREA, flex: "none" }}>
          {turns.map((turn) => (
            <span
              key={turn}
              data-arrow-icon
              style={{ position: "absolute", inset: 0, transform: `rotate(${turn}deg)` }}>
              <MarkerIcon
                icon={str(arrows.icon, "")}
                tint={str(arrows.color, "#2166ac")}
                side={MARKER_ON_AREA}
              />
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

/** One swatch: a line, a marker (its icon where it draws one, a cluster's badge) or an area, 20 by 14 px. A line or an
 * area with a marker (spec 3.3) has the marker in its middle; a line's arrows of an icon the style picks show it. */
export function SwatchIcon({ swatch, sized, width, ring }: SwatchProps) {
  if (swatch.geometry === "point")
    return <MarkerSwatch swatch={swatch} sized={sized} width={width} ring={ring} />;
  const nested = swatch.marker !== undefined || swatch.arrows !== undefined;
  const shape =
    swatch.geometry === "line" ? (
      <LineSwatch swatch={swatch} sized={sized} nested={nested} />
    ) : (
      <AreaSwatch swatch={swatch} sized={sized} ring={ring} nested={nested} />
    );
  if (!nested) return shape;
  return (
    <span
      aria-hidden="true"
      style={{
        position: "relative",
        display: "inline-flex",
        flex: "none",
        width: BOX.width,
        height: BOX.height,
      }}>
      {shape}
      {swatch.arrows && <ArrowIcons arrows={swatch.arrows} />}
      {swatch.marker && (
        <span style={{ position: "absolute", inset: 0, display: "flex" }}>
          <MarkerSwatch swatch={{ geometry: "point", marker: swatch.marker }} cap={MARKER_ON_AREA} nested />
        </span>
      )}
    </span>
  );
}

/** An area: the fill, its pattern at half size (so a few lines show in 20 px), the outline with its dash. */
function AreaSwatch({ swatch, sized, ring, nested }: SwatchProps) {
  const id = useId();
  const fill = swatch.fill ?? {};
  const kind =
    typeof fill.pattern === "string" && fill.pattern !== "none" ? (fill.pattern as PatternKind) : null;
  const width = Math.max(0.6, num(fill.pattern_width, 2) / 2);
  const tile = kind ? patternTile(kind, Math.max(3, num(fill.pattern_spacing, 10) / 2), width) : null;
  // A pattern color that is not set takes the fill's hue, opaque (spec 4.6).
  const ink = str(fill.pattern_color, opaque(str(fill.color, "#2bb381")));
  const checker = useId();
  // A None fill draws nothing (an outline alone); one that is not opaque lies over the checkerboard, and a None fill
  // with nothing else to draw shows the checkerboard alone, as the panel shows a None color.
  const fillColor = str(fill.color, "#2bb381");
  const drawn = swatch.fill !== undefined && !ring && !isNone(fillColor);
  const outlined = swatch.outline !== undefined && !isNone(swatch.outline.color);
  const alone = swatch.fill !== undefined && !ring && !drawn && !outlined && !tile;
  const clear = (drawn && seeThrough(fillColor)) || alone;
  const stroke =
    sized !== undefined
      ? Math.min(Math.max(num(swatch.outline?.width, 1) * sized, 0.5), CAPS.outline)
      : Math.min(num(swatch.outline?.width, 1), 3);
  const edge = ring ? Math.max(stroke, 2) : stroke;
  // The outline stays inside the box however wide it is.
  const inset = Math.max(1, edge / 2);
  const rect = { x: inset, y: inset, width: BOX.width - 2 * inset, height: BOX.height - 2 * inset, rx: 2 };
  return (
    <svg
      width={BOX.width}
      height={BOX.height}
      aria-hidden={nested ? undefined : "true"}
      style={{ flex: "none" }}>
      {clear && (
        <defs>
          <CheckerPattern id={checker} />
        </defs>
      )}
      {clear && <rect data-checker-under {...rect} fill={`url(#${checker})`} />}
      {tile && (
        <defs>
          <pattern id={id} patternUnits="userSpaceOnUse" width={tile.size} height={tile.size}>
            <path
              d={tile.path}
              data-pattern={kind ?? undefined}
              fill={tile.dots ? ink : "none"}
              stroke={tile.dots ? "none" : ink}
              strokeWidth={width}
            />
          </pattern>
        </defs>
      )}
      <rect
        {...rect}
        fill={drawn ? fillColor : "none"}
        fillOpacity={num(fill.opacity, 1)}
        stroke={str(swatch.outline?.color, "none")}
        strokeWidth={edge}
        strokeOpacity={num(swatch.outline?.opacity, 1)}
        strokeDasharray={dashOf(swatch.outline?.dash, edge)}
      />
      {tile && !ring && <rect {...rect} fill={`url(#${id})`} />}
    </svg>
  );
}

/** A class of the height: a bar as tall as its share of the block's tallest class. */
function HeightBar({ height, tallest }: { height: number; tallest: number }) {
  const bar = 3 + Math.round(11 * (tallest > 0 ? Math.min(Math.max(height / tallest, 0), 1) : 0));
  return (
    <svg data-height-bar width={BOX.width} height={BOX.height} aria-hidden="true" style={{ flex: "none" }}>
      <rect x="7" y={BOX.height - bar} width="6" height={bar} rx="1" fill={LEGEND_NEUTRAL} />
    </svg>
  );
}

const GEOMETRIES = new Set(["point", "line", "polygon"]);

/** A layer's icon: the swatch of its base look. */
export function layerSwatchIcon(
  layer: { style?: { document: unknown } | null; feature_layer_geometry_type?: string | null } | undefined,
  zoom = 12
): ReactNode | undefined {
  const geometry = layer?.feature_layer_geometry_type?.toLowerCase();
  if (!layer?.style || !geometry || !GEOMETRIES.has(geometry)) return undefined;
  return (
    <SwatchIcon
      swatch={baseSwatch(layer.style.document as JsonObject, { geometry: geometry as Geometry, zoom })}
    />
  );
}

/** A raster layer's icon, as the layer list shows it beside its name. */
export function RasterLayerIcon() {
  return (
    <Icon
      iconName={ICON_NAME.RASTER}
      fontSize="small"
      data-testid="raster-layer-icon"
      sx={{ fontSize: "1rem", color: "action.active" }}
    />
  );
}

/** A popup header's icon: the swatch of the class the clicked feature falls in; a raster layer's, as the layer list
 * shows it. */
export function featureSwatchIcon(
  layer:
    | {
        type?: string | null;
        style?: { document: unknown } | null;
        feature_layer_geometry_type?: string | null;
      }
    | undefined,
  properties: Record<string, unknown> | undefined,
  zoom = 12
): ReactNode | undefined {
  if (layer?.type === "raster") return <RasterLayerIcon />;
  const geometry = layer?.feature_layer_geometry_type?.toLowerCase();
  if (!layer?.style || !geometry || !GEOMETRIES.has(geometry)) return undefined;
  const swatch = classOf(layer.style.document as JsonObject, properties, {
    geometry: geometry as Geometry,
    zoom,
  });
  return <SwatchIcon swatch={swatch} />;
}

interface StyleLegendProps {
  legend: Legend;
  /** The heading where the legend has no title (the panel's preview; a layer list row shows the name itself). */
  layerName?: string;
  /** `panel`: framed, with a heading; `tree`: plain, under a layer list row. */
  variant?: "panel" | "tree";
  /** Leave out section headings (the field a classification reads). */
  hideHeading?: boolean;
  /** The number locale (the map's); the viewer's language without one. */
  locale?: string;
  /** Typography of the entries, the section headings and the caption (print, the detail maps' legend). */
  itemSx?: SxProps<Theme>;
  headingSx?: SxProps<Theme>;
  captionSx?: SxProps<Theme>;
  /** Draws an entry's text, keyed `<section>_<entry>` (print's inline edits); a caption by default. */
  renderText?: (key: string, text: string) => ReactNode;
  /** A block that holds at least `MIN_HIDDEN` entries more than this shows that many and "Show N more" (the layer
   * list, the layer widget); print lists every entry. */
  collapseAfter?: number;
}

/** The fewest entries "Show N more" hides: the link takes a row itself, so one or two more entries show as they are. */
const MIN_HIDDEN = 3;

export function StyleLegend({
  legend,
  layerName,
  variant = "panel",
  hideHeading = false,
  locale,
  itemSx,
  headingSx,
  captionSx,
  renderText,
  collapseAfter,
}: StyleLegendProps) {
  const { t, i18n } = useTranslation("common");
  // The blocks whose every entry shows, by id.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const words = {
    under: t("style_editor.range_under"),
    to: t("style_editor.range_to"),
    andMore: t("style_editor.range_and_more"),
  };
  const lang = locale ?? i18n.language;
  const number = (n: number) => formatNumberText(n, {}, lang);
  const text = (key: string, value: string, noWrap = false) =>
    renderText ? (
      renderText(key, value)
    ) : (
      // A name the row cuts off shows in full on hover.
      <Typography variant="caption" noWrap={noWrap} title={noWrap ? value : undefined} sx={itemSx}>
        {value}
      </Typography>
    );
  const heightText = (section: Extract<LegendSection, { kind: "height" }>) => {
    const n = (v?: number) => (v === undefined ? "" : number(v));
    switch (section.mode) {
      case "fixed":
        return t("style_editor.legend_height_fixed", { value: n(section.value) });
      case "zoom":
        return t("style_editor.legend_height_zoom", { max: n(section.max) });
      case "field":
        return t("style_editor.legend_height_field", { field: section.field });
      case "storeys":
        return t("style_editor.legend_height_storeys", {
          field: section.field,
          storey: n(SCENE_DEFAULTS.storey_height),
        });
      case "classes":
        return t("style_editor.legend_height_classes", { field: section.field, count: section.count });
      case "range":
        return t("style_editor.legend_height_range", {
          field: section.field,
          from: n(section.from),
          to: n(section.to),
        });
      case "h3":
        return t("style_editor.legend_height_h3", {
          value_label: t(`style_editor.h3_value_${section.op ?? "count"}`, { field: section.field }),
        });
    }
  };
  /** An entry's text: its name, else its values or its range, else what kind of entry it is; a class of the
   * height with its height after it. */
  const entryText = (section: Extract<LegendSection, { kind: "entries" }>, entry: LegendEntry): string => {
    const label =
      entry.name ??
      (entry.values
        ? valuesText(entry.values, {
            locale: lang,
            unit: section.unit,
            format: section.format,
            flags: { yes: t("style_editor.legend_yes"), no: t("style_editor.legend_no") },
          })
        : entry.range
          ? rangeText(entry.range, {
              locale: lang,
              words,
              domain: section.domain,
              unit: section.unit,
              format: section.format,
            })
          : entry.extra === "cluster"
            ? section.op && section.op !== "count"
              ? `${t("style_editor.legend_clusters")} · ${t(`style_editor.h3_value_${section.op}`, { field: section.field })}`
              : t("style_editor.legend_clusters")
            : entry.extra === "rest"
              ? t("style_editor.legend_other_features")
              : entry.extra === "points"
                ? t("style_editor.legend_single_points")
                : entry.extra === "h3"
                  ? t(`style_editor.h3_value_${section.op ?? "count"}`, { field: section.field })
                  : entry.extra
                    ? t(`style_editor.${entry.extra}`)
                    : "");
    return entry.height === undefined ? label : `${label} · ${number(entry.height)} m`;
  };
  /** The scale of a block of sizes; none for any other block, whose swatches all keep the fixed box. */
  const scaleOf = (section: Extract<LegendSection, { kind: "entries" }>) =>
    section.sized ? sizeScale(section.entries.map((e) => e.swatch)) : undefined;
  // One swatch column for the whole legend, as wide as its widest block of sizes needs: the texts of all blocks
  // start at the same place.
  const column = Math.max(
    20,
    ...legend.sections.map((section) =>
      section.kind === "entries" && section.sized
        ? sizeColumn(
            section.entries.map((e) => e.swatch),
            scaleOf(section) ?? 1
          )
        : 0
    )
  );
  const title = variant === "panel" ? (legend.title ?? layerName) : legend.title;
  return (
    <Box
      data-testid="legend-preview"
      sx={
        variant === "panel"
          ? { mx: 2, my: 2, p: 3, borderRadius: 2, border: 1, borderColor: "divider" }
          : { py: 0.5 }
      }>
      {/* One line, cut, the full name on hover, as the entries. Print, which passes `renderText`, keeps it wrapping:
          paper has no hover. */}
      {title && (
        <Typography
          variant="body2"
          noWrap={!renderText}
          title={renderText ? undefined : title}
          sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      )}
      {/* The caption under the layer's name, where the layer list and print place it too. */}
      {legend.caption && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={[{ display: "block" }, ...(Array.isArray(captionSx) ? captionSx : [captionSx])]}>
          {legend.caption}
        </Typography>
      )}
      {legend.sections.map((section) => {
        // The Height line and the Clusters entry name their field in their own text.
        const field =
          "field" in section && section.kind !== "height" && section.id !== "cluster"
            ? section.field
            : undefined;
        // Two classification blocks of one field tell themselves apart by the property each sets.
        const properties = section.kind === "entries" ? section.properties : undefined;
        // A cluster value's range says how the value is computed.
        const op =
          (section.kind === "ramp" || section.kind === "sizes") && section.op ? section.op : undefined;
        const heading = hideHeading
          ? undefined
          : (section.title ??
            (op
              ? t(`style_editor.h3_value_${op}`, { field })
              : properties?.length && field
                ? `${properties.map((key) => t(key)).join(", ")} · ${field}`
                : field));
        // How many entries a long list shows, with "Show N more", until it is opened; undefined where it shows all.
        const limit =
          section.kind === "entries" &&
          collapseAfter !== undefined &&
          !expanded.has(section.id) &&
          section.entries.length >= collapseAfter + MIN_HIDDEN
            ? collapseAfter
            : undefined;
        return (
          <Box key={section.id} sx={{ pt: 0.5 }}>
            {heading && (
              <Typography variant="caption" color="text.secondary" sx={headingSx}>
                {heading}
              </Typography>
            )}
            {section.kind === "entries" &&
              (limit !== undefined ? section.entries.slice(0, limit) : section.entries).map((entry) => (
                <Box key={entry.id} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  {section.bars && entry.height !== undefined ? (
                    <HeightBar
                      height={entry.height}
                      tallest={Math.max(...section.entries.map((e) => e.height ?? 0))}
                    />
                  ) : (
                    // A block of sizes draws its entries at their sizes; every other block in the fixed box.
                    <SwatchIcon
                      swatch={entry.swatch}
                      sized={scaleOf(section)}
                      width={column}
                      ring={section.hollow}
                    />
                  )}
                  {text(`${section.id}_${entry.id}`, entryText(section, entry), true)}
                </Box>
              ))}
            {section.kind === "entries" && limit !== undefined && (
              <ButtonBase
                onClick={() => setExpanded((now) => new Set(now).add(section.id))}
                sx={{ borderRadius: 0.5, "&:hover": { textDecoration: "underline" } }}>
                <Typography variant="caption" color="primary" sx={itemSx}>
                  {t("show_more_count", { count: section.entries.length - limit })}
                </Typography>
              </ButtonBase>
            )}
            {section.kind === "entries" && !!section.pending && (
              // Its classes are still being counted: placeholder rows, so the legend never lists every class first.
              <Box data-legend-pending aria-busy="true">
                {Array.from({ length: section.pending }, (_, i) => (
                  <Box key={i} data-legend-placeholder sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <Skeleton variant="rounded" width={column} height={12} sx={{ flex: "none" }} />
                    <Skeleton variant="text" width={`${60 - i * 12}%`} />
                  </Box>
                ))}
              </Box>
            )}
            {section.kind === "ramp" && (
              <Box>
                {/* At the features' own opacity, as on the map; the layer's opacity does not fade it. */}
                <Box
                  data-legend-ramp
                  sx={{
                    height: 10,
                    borderRadius: 0.5,
                    background: checkered(rampGradient(section)),
                    opacity: section.opacity ?? 1,
                  }}
                />
                {/* A gap, so the end labels never run together ("0255") however narrow the box. */}
                <Box
                  data-legend-ramp-labels
                  sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}>
                  {[0, 1].map((end) => (
                    <Fragment key={end}>
                      {end === 1 && section.middle !== undefined && (
                        // On a sqrt or log scale the middle of the ramp is not the middle of the values.
                        <Box data-legend-middle>{text(`${section.id}_middle`, number(section.middle))}</Box>
                      )}
                      <Box>
                        {text(
                          `${section.id}_${end}`,
                          section.labels?.[end] ??
                            (section.ends === "low_high"
                              ? t(end === 0 ? "style_editor.legend_low" : "style_editor.legend_high")
                              : `${number(section.domain[end])}${section.unit ? ` ${section.unit}` : ""}`)
                        )}
                      </Box>
                    </Fragment>
                  ))}
                </Box>
              </Box>
            )}
            {section.kind === "empty" && (
              <Typography
                data-legend-empty
                variant="caption"
                color="text.secondary"
                sx={{ display: "block" }}>
                {t(`style_editor.legend_none_${section.classes}`)}
              </Typography>
            )}
            {section.kind === "height" && text(section.id, heightText(section), true)}
            {section.kind === "image" && (
              <Box component="img" src={section.url} alt={title ?? ""} sx={{ maxWidth: "100%" }} />
            )}
            {section.kind === "sizes" && (
              <Box sx={{ display: "flex", alignItems: "flex-end", gap: 1.5 }}>
                {section.samples.map((sample) => (
                  <Box key={sample.value} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                    <SwatchIcon
                      swatch={sample.swatch}
                      sized={sizeScale(section.samples.map((s) => s.swatch))}
                      width={Math.max(
                        20,
                        Math.ceil(
                          Math.min(
                            Number(sample.swatch.marker?.size ?? 0) *
                              sizeScale(section.samples.map((s) => s.swatch)),
                            28
                          )
                        ) + 4
                      )}
                    />
                    {text(`${section.id}_${sample.value}`, number(sample.value))}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
