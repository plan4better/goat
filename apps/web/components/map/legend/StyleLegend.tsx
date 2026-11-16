"use client";

// A layer's legend (spec 7.2) from its data model (buildLegend): the layer list, the style panel's preview, popups'
// header icons and print draw it with these components.
import { Box, Skeleton, type SxProps, type Theme, Typography } from "@mui/material";
import { Fragment, type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";

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

const str = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback);

/** An icon at `side` px: a library icon in `tint` (a mask over the color), emoji and uploads as they are. */
function MarkerIcon({ icon, tint, side }: { icon: string; tint: string; side: number }) {
  const image = defaultResolveIcon(icon);
  if (!image) return null;
  if (!image.sdf)
    return (
      <img
        src={image.url}
        alt=""
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
        backgroundColor: tint,
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
}

/** A point's marker as the map draws it (lib/style/render/markerImages.ts): its shape in the fill (a hollow marker
 * without it) with the stroke and the icon on it, or the icon alone. It is 14 px high whatever the marker's size, except
 * in a block of sizes. */
function MarkerSwatch({ swatch, sized, width, ring }: SwatchProps) {
  const marker = swatch.marker ?? {};
  const icon = typeof marker.icon === "string" ? marker.icon : undefined;
  const hollow = marker.fill === false || ring === true;
  // The marker opacity is the fill's: a hollow marker's outline and icon are not faded by it, as on the map.
  const opacity = hollow ? 1 : num(marker.opacity, 1);
  const stroke = swatch.outline && num(swatch.outline.opacity, 1) > 0 ? swatch.outline : undefined;
  const strokeWidth = stroke ? (ring ? 2 : Math.min(num(stroke.width, 1), 2)) : 0;
  const shape = markerShapeOf(marker.shape);
  const round = shape === "circle" || shape === "square";
  // 14 px; a plain circle its own size up to that.
  const fixed = icon || !round || marker.shape === "square" || marker.shape === "icon";
  const small = fixed ? 14 : Math.min(Math.max(num(marker.size, 8), 4), 14);
  const side = sized !== undefined ? markerSide(marker, sized) : small;
  const box = {
    width: width ?? BOX.width,
    height: sized !== undefined ? Math.max(BOX.height, side) : BOX.height,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
  };
  if (marker.shape === "icon")
    return (
      <span aria-hidden="true" style={{ ...box, opacity }}>
        <MarkerIcon icon={icon ?? "goat:marker"} tint={str(marker.color, "#2bb381")} side={side} />
      </span>
    );
  if (!round) {
    // The other shapes and the pins as their outline, the icon in the shape's head.
    const spec = MARKER_SHAPES[shape];
    const iconSide = Math.round(side * spec.icon.share);
    return (
      <span aria-hidden="true" style={{ ...box, opacity, position: "relative" }}>
        <svg
          data-marker-shape={shape}
          width={side}
          height={side}
          viewBox="0 0 24 24"
          style={{ overflow: "visible" }}>
          <path
            d={spec.path}
            fill={hollow ? "none" : str(marker.color, "#2bb381")}
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
      </span>
    );
  }
  return (
    <span aria-hidden="true" style={{ ...box, opacity }}>
      <span
        data-marker-shape={marker.shape === "square" ? "square" : "circle"}
        style={{
          boxSizing: "border-box",
          width: side,
          height: side,
          borderRadius: marker.shape === "square" ? side * SQUARE_RADIUS : "50%",
          backgroundColor: hollow ? "transparent" : str(marker.color, "#2bb381"),
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
    </span>
  );
}

/** A line with its casing under it and its dash. */
function LineSwatch({ swatch, sized }: SwatchProps) {
  const line = swatch.line ?? {};
  const stroke =
    sized !== undefined
      ? Math.min(Math.max(num(line.width, 2) * sized, 0.5), CAPS.line)
      : Math.min(num(line.width, 2), 8);
  const casing = swatch.casing;
  // The casing shows on each side of the line, inside the box.
  const around = casing ? Math.min(stroke + 2 * Math.min(num(casing.width, 1), 2), 12) : 0;
  const { width, height } = BOX;
  return (
    <svg width={width} height={height} aria-hidden="true" style={{ flex: "none" }}>
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

/** One swatch: a line, a marker (its icon where it draws one) or an area, 20 by 14 px. */
export function SwatchIcon({ swatch, sized, width, ring }: SwatchProps) {
  if (swatch.geometry === "line") return <LineSwatch swatch={swatch} sized={sized} />;
  if (swatch.geometry === "point")
    return <MarkerSwatch swatch={swatch} sized={sized} width={width} ring={ring} />;
  return <AreaSwatch swatch={swatch} sized={sized} ring={ring} />;
}

/** An area: the fill, its pattern at half size (so a few lines show in 20 px), the outline with its dash. */
function AreaSwatch({ swatch, sized, ring }: SwatchProps) {
  const id = useId();
  const fill = swatch.fill ?? {};
  const kind =
    typeof fill.pattern === "string" && fill.pattern !== "none" ? (fill.pattern as PatternKind) : null;
  const width = Math.max(0.6, num(fill.pattern_width, 2) / 2);
  const tile = kind ? patternTile(kind, Math.max(3, num(fill.pattern_spacing, 10) / 2), width) : null;
  const ink = str(fill.pattern_color, str(fill.color, "#2bb381"));
  const stroke =
    sized !== undefined
      ? Math.min(Math.max(num(swatch.outline?.width, 1) * sized, 0.5), CAPS.outline)
      : Math.min(num(swatch.outline?.width, 1), 3);
  const edge = ring ? Math.max(stroke, 2) : stroke;
  // The outline stays inside the box however wide it is.
  const inset = Math.max(1, edge / 2);
  const rect = { x: inset, y: inset, width: BOX.width - 2 * inset, height: BOX.height - 2 * inset, rx: 2 };
  return (
    <svg width={BOX.width} height={BOX.height} aria-hidden="true" style={{ flex: "none" }}>
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
        fill={swatch.fill && !ring ? str(fill.color, "#2bb381") : "none"}
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

/** A popup header's icon: the swatch of the class the clicked feature falls in. */
export function featureSwatchIcon(
  layer: { style?: { document: unknown } | null; feature_layer_geometry_type?: string | null } | undefined,
  properties: Record<string, unknown> | undefined,
  zoom = 12
): ReactNode | undefined {
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
  /** Typography of the entries and the section headings (print). */
  itemSx?: SxProps<Theme>;
  headingSx?: SxProps<Theme>;
  /** Draws an entry's text, keyed `<section>_<entry>` (print's inline edits); a caption by default. */
  renderText?: (key: string, text: string) => ReactNode;
}

export function StyleLegend({
  legend,
  layerName,
  variant = "panel",
  hideHeading = false,
  locale,
  itemSx,
  headingSx,
  renderText,
}: StyleLegendProps) {
  const { t, i18n } = useTranslation("common");
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
            ? t("style_editor.legend_clusters")
            : entry.extra === "rest"
              ? t("style_editor.legend_other_features")
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
      {title && (
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      )}
      {/* The caption under the layer's name, where the layer list and print place it too. */}
      {legend.caption && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
          {legend.caption}
        </Typography>
      )}
      {legend.sections.map((section) => {
        // The Height line names its field in its own text.
        const field = "field" in section && section.kind !== "height" ? section.field : undefined;
        // Two classification blocks of one field tell themselves apart by the property each sets.
        const properties = section.kind === "entries" ? section.properties : undefined;
        const heading = hideHeading
          ? undefined
          : (section.title ??
            (properties?.length && field
              ? `${properties.map((key) => t(key)).join(", ")} · ${field}`
              : field));
        return (
          <Box key={section.id} sx={{ pt: 0.5 }}>
            {heading && (
              <Typography variant="caption" color="text.secondary" sx={headingSx}>
                {heading}
              </Typography>
            )}
            {section.kind === "entries" &&
              section.entries.map((entry) => (
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
                <Box
                  data-legend-ramp
                  sx={{
                    height: 10,
                    borderRadius: 0.5,
                    background: `linear-gradient(90deg, ${section.colors.join(", ")})`,
                  }}
                />
                <Box sx={{ display: "flex", justifyContent: "space-between" }}>
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
