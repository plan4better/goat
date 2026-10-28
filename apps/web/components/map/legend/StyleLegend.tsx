"use client";

// A layer's legend (spec 7.2) from its data model (buildLegend): the layer list, the style panel's preview, popups'
// header icons and print draw it with these components.
import { Box, type SxProps, type Theme, Typography } from "@mui/material";
import { Fragment, type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";

import { defaultResolveIcon } from "@/lib/style/compile/images";
import { SQUARE_RADIUS } from "@/lib/style/compile/markerImage";
import { type PatternKind, patternTile } from "@/lib/style/compile/patternImage";
import type { Geometry } from "@/lib/style/compile/types";
import { formatNumberText } from "@/lib/style/editor/labels";
import type { JsonObject } from "@/lib/style/json";
import { type Legend, type Swatch, baseSwatch, classOf, rangeText, valuesText } from "@/lib/style/legend";
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

/** A point's marker as the map draws it (lib/style/render/markerImages.ts): its shape in the fill (a hollow marker
 * without it) with the stroke and the icon on it, or the icon alone; 14 px high whatever its size. */
function MarkerSwatch({ swatch }: { swatch: Swatch }) {
  const marker = swatch.marker ?? {};
  const icon = typeof marker.icon === "string" ? marker.icon : undefined;
  const hollow = marker.fill === false;
  // The marker opacity is the fill's: a hollow marker's outline and icon are not faded by it, as on the map.
  const opacity = hollow ? 1 : num(marker.opacity, 1);
  const box = {
    width: 20,
    height: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
  };
  if (marker.shape === "icon")
    return (
      <span aria-hidden="true" style={{ ...box, opacity }}>
        <MarkerIcon icon={icon ?? "goat:marker"} tint={str(marker.color, "#2bb381")} side={14} />
      </span>
    );
  const side = icon || marker.shape === "square" ? 14 : Math.min(Math.max(num(marker.size, 8), 4), 14);
  const stroke = swatch.outline && num(swatch.outline.opacity, 1) > 0 ? swatch.outline : undefined;
  const shape = markerShapeOf(marker.shape);
  if (shape !== "circle" && shape !== "square") {
    // The other shapes and the pins as their outline, 14 px, the icon in the shape's head.
    const spec = MARKER_SHAPES[shape];
    const iconSide = Math.round(14 * spec.icon.share);
    const width = stroke ? Math.min(num(stroke.width, 1), 2) : 0;
    return (
      <span aria-hidden="true" style={{ ...box, opacity, position: "relative" }}>
        <svg
          data-marker-shape={shape}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          style={{ overflow: "visible" }}>
          <path
            d={spec.path}
            fill={hollow ? "none" : str(marker.color, "#2bb381")}
            stroke={stroke ? str(stroke.color, "#000000") : undefined}
            strokeWidth={width * (24 / 14)}
            strokeLinejoin="round"
          />
        </svg>
        {icon && (
          <span
            style={{
              position: "absolute",
              left: 3 + (spec.icon.cx / 24) * 14 - iconSide / 2,
              top: (spec.icon.cy / 24) * 14 - iconSide / 2,
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
          border: stroke
            ? `${Math.min(num(stroke.width, 1), 2)}px solid ${str(stroke.color, "#000000")}`
            : undefined,
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

/** One swatch: a line, a marker (its icon where it draws one) or an area, 20 by 14 px. */
export function SwatchIcon({ swatch }: { swatch: Swatch }) {
  if (swatch.geometry === "line") {
    const line = swatch.line ?? {};
    return (
      <svg width="20" height="14" aria-hidden="true" style={{ flex: "none" }}>
        <line
          x1="1"
          y1="7"
          x2="19"
          y2="7"
          stroke={str(line.color, "#2166ac")}
          strokeWidth={Math.min(num(line.width, 2), 8)}
          strokeOpacity={num(line.opacity, 1)}
        />
      </svg>
    );
  }
  if (swatch.geometry === "point") return <MarkerSwatch swatch={swatch} />;
  return <AreaSwatch swatch={swatch} />;
}

/** An area: the fill, its pattern at half size (so a few lines show in 20 px), the outline. */
function AreaSwatch({ swatch }: { swatch: Swatch }) {
  const id = useId();
  const fill = swatch.fill ?? {};
  const kind =
    typeof fill.pattern === "string" && fill.pattern !== "none" ? (fill.pattern as PatternKind) : null;
  const width = Math.max(0.6, num(fill.pattern_width, 2) / 2);
  const tile = kind ? patternTile(kind, Math.max(3, num(fill.pattern_spacing, 10) / 2), width) : null;
  const ink = str(fill.pattern_color, str(fill.color, "#2bb381"));
  return (
    <svg width="20" height="14" aria-hidden="true" style={{ flex: "none" }}>
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
        x="1"
        y="1"
        width="18"
        height="12"
        rx="2"
        fill={str(fill.color, "#2bb381")}
        fillOpacity={num(fill.opacity, 1)}
        stroke={str(swatch.outline?.color, "none")}
        strokeWidth={Math.min(num(swatch.outline?.width, 1), 3)}
      />
      {tile && <rect x="1" y="1" width="18" height="12" rx="2" fill={`url(#${id})`} />}
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
      <Typography variant="caption" noWrap={noWrap} sx={itemSx}>
        {value}
      </Typography>
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
        const field = "field" in section ? section.field : undefined;
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
                  <SwatchIcon swatch={entry.swatch} />
                  {text(
                    `${section.id}_${entry.id}`,
                    entry.name ??
                      (entry.values
                        ? valuesText(entry.values, {
                            locale: lang,
                            unit: section.unit,
                            format: section.format,
                          })
                        : entry.range
                          ? rangeText(entry.range, {
                              locale: lang,
                              words,
                              domain: section.domain,
                              unit: section.unit,
                              format: section.format,
                            })
                          : entry.extra
                            ? t(`style_editor.${entry.extra}`)
                            : ""),
                    true
                  )}
                </Box>
              ))}
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
                            `${number(section.domain[end])}${section.unit ? ` ${section.unit}` : ""}`
                        )}
                      </Box>
                    </Fragment>
                  ))}
                </Box>
              </Box>
            )}
            {section.kind === "image" && (
              <Box component="img" src={section.url} alt={title ?? ""} sx={{ maxWidth: "100%" }} />
            )}
            {section.kind === "sizes" && (
              <Box sx={{ display: "flex", alignItems: "flex-end", gap: 1.5 }}>
                {section.samples.map((sample) => (
                  <Box key={sample.value} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                    <SwatchIcon swatch={sample.swatch} />
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
