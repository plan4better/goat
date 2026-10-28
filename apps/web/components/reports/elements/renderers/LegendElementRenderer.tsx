"use client";

import { Box, Stack, Typography } from "@mui/material";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TypographyStyle } from "@/lib/constants/typography";
import { DEFAULT_FONT_FAMILY, LEGEND_TYPOGRAPHY_DEFAULTS } from "@/lib/constants/typography";
import { mapElementLayers } from "@/lib/print/mapElements";
import type { Geometry } from "@/lib/style/compile/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { type Legend, baseSwatch, buildLegend, informative } from "@/lib/style/legend";
import { cleanEditedText } from "@/lib/utils/editableText";
import type { ReportElement } from "@/lib/validations/reportLayout";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import { StyleLegend, SwatchIcon } from "@/components/map/legend/StyleLegend";

/**
 * Convert TypographyStyle to MUI sx props
 */
function typographyToSx(style?: TypographyStyle, role?: string): Record<string, unknown> {
  const defaults = role ? LEGEND_TYPOGRAPHY_DEFAULTS[role] : undefined;
  const sx: Record<string, unknown> = {};
  sx.fontFamily = style?.fontFamily || defaults?.fontFamily || DEFAULT_FONT_FAMILY;
  sx.fontSize = style?.fontSize || defaults?.fontSize;
  sx.fontWeight = style?.fontWeight || defaults?.fontWeight;
  if (style?.fontColor) sx.color = style.fontColor;
  return sx;
}

/**
 * Extract overrides with a given prefix, stripping the prefix from keys.
 * e.g. prefix="legenditem_5_" extracts "legenditem_5_item_0" -> "item_0"
 */
function extractPrefixedOverrides(
  overrides: Record<string, string> | undefined,
  prefix: string
): Record<string, string> | undefined {
  if (!overrides) return undefined;
  const result: Record<string, string> = {};
  let found = false;
  for (const [key, val] of Object.entries(overrides)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = val;
      found = true;
    }
  }
  return found ? result : undefined;
}

/**
 * Legend typography configuration (per text role)
 */
interface LegendTypographyConfig {
  title?: TypographyStyle;
  layerName?: TypographyStyle;
  legendItem?: TypographyStyle;
  caption?: TypographyStyle;
  heading?: TypographyStyle;
}

/**
 * Legend element configuration interface
 */
export interface LegendElementConfig {
  /** Title configuration */
  title?: {
    text?: string;
  };
  /** Map element ID to bind to (null = show all layers) */
  mapElementId?: string | null;
  /** Auto-update legend from connected map (default true) */
  auto_update?: boolean;
  /** Layout options */
  layout?: {
    columns?: number;
    showLayerNames?: boolean;
  };
  /** Typography settings for different text roles */
  typography?: LegendTypographyConfig;
  /** Text overrides when auto_update is off (keyed by "title" or "layer_{id}" or "caption_{id}") */
  textOverrides?: Record<string, string>;
}

/**
 * Inline-editable text component. When editable=true, renders a contentEditable span.
 * On blur, calls onSave with the new text content.
 */
const EditableText: React.FC<{
  text: string;
  editable: boolean;
  onSave: (text: string) => void;
  sx?: Record<string, unknown>;
  variant?: "caption" | "subtitle2" | "body2";
  children?: React.ReactNode;
}> = ({ text, editable, onSave, sx, variant = "caption", children }) => {
  const shownText = cleanEditedText(text);
  const handleBlur = (e: React.FocusEvent<HTMLSpanElement>) => {
    const newText = cleanEditedText(e.currentTarget.textContent ?? "");
    if (newText !== shownText) {
      onSave(newText);
    }
  };

  return (
    <Typography
      variant={variant}
      className={editable ? "legend-editable-text" : undefined}
      sx={{
        ...sx,
        ...(editable && {
          cursor: "text",
          outline: "none",
          "&:hover": { backgroundColor: "rgba(0,0,0,0.04)" },
          "&:focus": { backgroundColor: "rgba(0,0,0,0.08)" },
        }),
      }}
      contentEditable={editable}
      suppressContentEditableWarning
      onBlur={editable ? handleBlur : undefined}>
      {children ?? shownText}
    </Typography>
  );
};

interface LegendElementRendererProps {
  element: ReportElement;
  /** The project's map layers, with their styles. */
  projectLayers?: MapLayer[];
  mapElements?: ReportElement[];
  /** The map's number locale; the viewer's language without one. */
  locale?: string;
  viewOnly?: boolean;
  /** Zoom level to scale content */
  zoom?: number;
  /** Callback for updating element config (needed for inline text editing) */
  onElementUpdate?: (elementId: string, config: Record<string, unknown>) => void;
}

/**
 * Legend Element Renderer for print reports
 *
 * Displays layer legends in a configurable multi-column layout.
 * Uses the same legend logic as ProjectLayerTree for consistent rendering.
 */
const LegendElementRenderer: React.FC<LegendElementRendererProps> = ({
  element,
  projectLayers = [],
  mapElements = [],
  locale,
  viewOnly: _viewOnly = true,
  zoom = 1,
  onElementUpdate,
}) => {
  const { t } = useTranslation("common");
  // Extract legend config
  const config = element.config as LegendElementConfig;
  const titleText = config?.title?.text ?? "";
  const layoutConfig = config?.layout ?? { columns: 1, showLayerNames: true };
  const typography = config?.typography;
  const textOverrides = config?.textOverrides;

  // Auto-update: default true. When false, legend freezes at its current content.
  const autoUpdate = config?.auto_update !== false;

  // Whether inline editing is allowed (only when auto_update is off)
  const isEditable = !autoUpdate;

  // Save a text override
  const saveTextOverride = useCallback(
    (key: string, text: string) => {
      if (!onElementUpdate) return;
      const currentOverrides = config?.textOverrides ?? {};
      onElementUpdate(element.id, {
        ...element.config,
        textOverrides: {
          ...currentOverrides,
          [key]: text,
        },
      } as Record<string, unknown>);
    },
    [onElementUpdate, element.id, element.config, config?.textOverrides]
  );

  // The connected map's layers (its locked ones, with their frozen documents), else the project's drawn layers whose
  // style shows a legend.
  const connectedMap =
    config?.mapElementId && mapElements.length > 0
      ? mapElements.find((m) => m.id === config.mapElementId)
      : null;
  const mapZoom = (connectedMap?.config?.viewState as { zoom?: number } | undefined)?.zoom ?? 12;
  const resolvedLayers = useMemo(() => {
    const mapConfig = (connectedMap?.config ?? {}) as Record<string, unknown>;
    if (mapConfig.lock_layers === true && mapConfig.locked_layer_ids)
      return mapElementLayers(projectLayers, mapConfig);
    const ids = connectedMap?.map_config?.layers;
    if (ids) return projectLayers.filter((l) => ids.includes(l.id));
    return projectLayers.filter((layer) => layer.visible && legendShown(layer));
  }, [projectLayers, connectedMap]);

  // Freeze mechanism: when auto_update is off, keep showing the last resolved layers
  const frozenLayersRef = useRef<MapLayer[]>(resolvedLayers);
  useEffect(() => {
    if (autoUpdate) {
      // Auto-update is on: always keep frozen ref in sync
      frozenLayersRef.current = resolvedLayers;
    }
  }, [autoUpdate, resolvedLayers]);

  const filteredLayers = autoUpdate ? resolvedLayers : frozenLayersRef.current;

  // Limit columns to number of layers (no empty columns)
  const columns = Math.min(layoutConfig.columns || 1, filteredLayers.length || 1);

  return (
    <Box
      sx={{
        width: `${100 / zoom}%`,
        height: `${100 / zoom}%`,
        overflow: "hidden",
        p: 1,
        boxSizing: "border-box",
        transform: `scale(${zoom})`,
        transformOrigin: "top left",
      }}>
      {/* Title - only show if text is not empty */}
      {titleText && (
        <EditableText
          text={isEditable && textOverrides?.title ? textOverrides.title : titleText}
          editable={isEditable}
          onSave={(text) => saveTextOverride("title", text)}
          variant="subtitle2"
          sx={{
            mb: 1,
            ...typographyToSx(typography?.title, "title"),
          }}
        />
      )}

      {/* Legend content */}
      {filteredLayers.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          {t("no_layers_to_display")}
        </Typography>
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: `repeat(${columns}, 1fr)`,
            gap: 1,
            overflow: "hidden",
          }}>
          {filteredLayers.map((layer) => (
            <LayerLegendItem
              key={layer.id}
              layer={layer}
              zoom={mapZoom}
              locale={locale}
              showLayerName={layoutConfig.showLayerNames !== false}
              typography={typography}
              editable={isEditable}
              textOverrides={textOverrides}
              onTextSave={saveTextOverride}
            />
          ))}
        </Box>
      )}
    </Box>
  );
};

/** The position keys print layouts used before GOAT Style, by the entry key StyleLegend renders with: entries in order
 * (`item_<n>`), a ramp's ends (`item_min`, `item_max`). */
function legacyItemKeys(legend: Legend | null): Record<string, string> {
  const keys: Record<string, string> = {};
  let n = 0;
  for (const section of legend?.sections ?? []) {
    if (section.kind === "entries")
      for (const entry of section.entries) keys[`${section.id}_${entry.id}`] = `item_${n++}`;
    if (section.kind === "ramp") {
      keys[`${section.id}_0`] = "item_min";
      keys[`${section.id}_1`] = "item_max";
    }
  }
  return keys;
}

/** Whether a layer's style shows a legend (spec 7.2). */
const legendShown = (layer: MapLayer): boolean => {
  const legend = (layer.style?.document as { legend?: unknown } | undefined)?.legend;
  return legend !== false && !(isObject(legend) && legend.show === false);
};

const GEOMETRIES = new Set(["point", "line", "polygon"]);

/**
 * One layer's legend: the same model and drawing as the layer list's (StyleLegend). A layer whose legend is only its
 * base look shows that swatch beside its name.
 */
interface LayerLegendItemProps {
  layer: MapLayer;
  /** The connected map's zoom: legend values by zoom read it. */
  zoom: number;
  locale?: string;
  showLayerName?: boolean;
  typography?: LegendTypographyConfig;
  editable?: boolean;
  textOverrides?: Record<string, string>;
  onTextSave?: (key: string, text: string) => void;
}

const LayerLegendItem: React.FC<LayerLegendItemProps> = ({
  layer,
  zoom,
  locale,
  showLayerName = true,
  typography,
  editable = false,
  textOverrides,
  onTextSave,
}) => {
  const style = (layer.style?.document ?? null) as JsonObject | null;
  const type = layer.feature_layer_geometry_type?.toLowerCase();
  const geometry = type && GEOMETRIES.has(type) ? (type as Geometry) : undefined;
  const legend = style
    ? buildLegend(style, {
        geometry,
        zoom,
        serviceLegendUrl: (layer.other_properties as { legend_urls?: string[] } | null)?.legend_urls?.[0],
      })
    : null;
  const detailed = informative(legend);
  const legendOptions = style && isObject(style.legend) ? style.legend : undefined;
  const caption = typeof legendOptions?.caption === "string" ? legendOptions.caption : undefined;
  const itemOverrides = editable
    ? extractPrefixedOverrides(textOverrides, `legenditem_${layer.id}_`)
    : undefined;
  // Layouts saved before GOAT Style keyed their entries by position (`item_<n>`, a ramp's `item_min` and `item_max`).
  const legacyKeys = useMemo(() => legacyItemKeys(legend), [legend]);
  const overrideOf = (key: string) =>
    itemOverrides?.[key] ?? (legacyKeys[key] ? itemOverrides?.[legacyKeys[key]] : undefined);
  const itemSx = typographyToSx(typography?.legendItem, "legendItem");

  const layerNameKey = `layer_${layer.id}`;
  // Hide the layer name row entirely when the user has cleared the text.
  const layerNameCleared =
    editable && textOverrides?.[layerNameKey] != null && !textOverrides[layerNameKey].trim();

  return (
    <Box sx={{ minWidth: 0 }}>
      {showLayerName && !layerNameCleared && (
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
          {!detailed && style && geometry && (
            <Box sx={{ flexShrink: 0, display: "flex" }}>
              <SwatchIcon swatch={baseSwatch(style, { geometry, zoom })} />
            </Box>
          )}
          <EditableText
            text={editable && textOverrides?.[layerNameKey] ? textOverrides[layerNameKey] : layer.name}
            editable={editable}
            onSave={(text) => onTextSave?.(layerNameKey, text)}
            variant="caption"
            sx={{
              wordBreak: "break-word",
              ...typographyToSx(typography?.layerName, "layerName"),
            }}
          />
        </Stack>
      )}

      {caption && (
        <EditableText
          text={
            editable && textOverrides?.[`caption_${layer.id}`] ? textOverrides[`caption_${layer.id}`] : caption
          }
          editable={editable}
          onSave={(text) => onTextSave?.(`caption_${layer.id}`, text)}
          variant="caption"
          sx={{ display: "block", mb: 0.5, ...typographyToSx(typography?.caption, "caption") }}
        />
      )}

      {legend && detailed && (
        <StyleLegend
          legend={{ ...legend, caption: undefined }}
          variant="tree"
          locale={locale}
          itemSx={itemSx}
          headingSx={typographyToSx(typography?.heading, "heading")}
          renderText={(key, text) => (
            <EditableText
              text={overrideOf(key) ?? text}
              editable={editable}
              onSave={(next) => onTextSave?.(`legenditem_${layer.id}_${key}`, next)}
              variant="caption"
              sx={itemSx}
            />
          )}
        />
      )}
    </Box>
  );
};

export default LegendElementRenderer;
