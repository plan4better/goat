import { Box, Typography } from "@mui/material";
import type { StyleSpecification } from "maplibre-gl";
import React from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@p4b/ui/components/Icon";

import { type AtlasPage, resolveAtlasText } from "@/lib/print/atlas-utils";
import { mmToPx } from "@/lib/print/units";
import type { ReportElement, ReportElementType } from "@/lib/validations/reportLayout";
import type { WidgetChartConfig, WidgetElementConfig } from "@/lib/validations/widget";
import type { chartTypes } from "@/lib/validations/widget";
import { elementTypes } from "@/lib/validations/widget";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import WidgetChart from "@/components/builder/widgets/chart/WidgetChart";
import WidgetElement from "@/components/builder/widgets/elements/WidgetElement";
import {
  type NorthArrowStyle,
  getNorthArrowIconName,
} from "@/components/reports/elements/config/NorthArrowElementConfig";
import LegendElementRenderer from "@/components/reports/elements/renderers/LegendElementRenderer";
import MapElementRenderer from "@/components/reports/elements/renderers/MapElementRenderer";
import ScalebarElementRenderer from "@/components/reports/elements/renderers/ScalebarElementRenderer";

// Types that are rendered as chart widgets (same as dashboard)
const chartElementTypes: ReportElementType[] = ["histogram_chart", "categories_chart", "pie_chart"];

// Types that are rendered as element widgets (text, image)
const elementElementTypes: ReportElementType[] = ["text", "image"];

export const isChartElementType = (type: ReportElementType): boolean => {
  return chartElementTypes.includes(type);
};

export const isElementElementType = (type: ReportElementType): boolean => {
  return elementElementTypes.includes(type);
};

interface ElementRendererProps {
  element: ReportElement;
  viewOnly?: boolean;
  onElementUpdate?: (elementId: string, config: Record<string, unknown>) => void;
  featureAttributes?: string[];
}

interface ElementContentRendererProps {
  element: ReportElement;
  width: number;
  height: number;
  zoom?: number;
  basemapUrl?: string | StyleSpecification;
  projectLayers?: MapLayer[];
  /** The project's number locale (map labels, legend values); the viewer's language without one. */
  locale?: string;
  allElements?: ReportElement[];
  atlasPage?: AtlasPage | null;
  featureAttributes?: string[];
  viewOnly?: boolean;
  onElementUpdate?: (elementId: string, config: Record<string, unknown>) => void;
  onNavigationModeChange?: (isNavigating: boolean) => void;
  onMapLoaded?: () => void;
}

/**
 * Convert report chart element to WidgetChartConfig
 * Chart configs have: type, setup (title, layer_project_id, ...), options (...)
 * We use type assertion since report element config is stored as Record<string, any>
 */
const toChartConfig = (element: ReportElement, defaultTitle: string): WidgetChartConfig => {
  const chartType = element.type as (typeof chartTypes.Values)[keyof typeof chartTypes.Values];

  // If config is already in the correct format (has setup and options), use it directly
  if (element.config.setup && element.config.options) {
    return {
      type: chartType,
      setup: element.config.setup,
      options: element.config.options,
    } as WidgetChartConfig;
  }

  // Return default config with proper type
  return {
    type: chartType,
    setup: { title: defaultTitle },
    options: {},
  } as WidgetChartConfig;
};

/**
 * Convert report element to WidgetElementConfig
 * Element configs vary by type:
 * - text: { type, setup: { text } }
 * - divider: { type, setup: { size } }
 * - image: { type, setup: { url, alt }, options: { has_padding, description } }
 * We use type assertion since report element config is stored as Record<string, any>
 */
const toElementConfig = (element: ReportElement): WidgetElementConfig => {
  const elemType = element.type as (typeof elementTypes.Values)[keyof typeof elementTypes.Values];

  if (elemType === elementTypes.Values.text) {
    return {
      type: elementTypes.Values.text,
      setup: {
        text: element.config.setup?.text ?? element.config.text ?? element.config.content ?? "Text",
      },
    };
  }

  if (elemType === elementTypes.Values.image) {
    return {
      type: elementTypes.Values.image,
      setup: {
        url: element.config.setup?.url ?? element.config.url ?? "",
        alt: element.config.setup?.alt ?? element.config.alt ?? "",
      },
      options: {
        has_padding: element.config.options?.has_padding ?? false,
        description: element.config.options?.description,
      },
    };
  }

  if (elemType === elementTypes.Values.divider) {
    return {
      type: elementTypes.Values.divider,
      setup: {
        size: element.config.setup?.size ?? element.config.size ?? 1,
        orientation: (element.config.setup?.orientation ?? "horizontal") as "horizontal" | "vertical",
        color: (element.config.setup?.color ?? "#000000") as string,
        thickness: (element.config.setup?.thickness ?? 1) as number,
      },
    };
  }

  // Fallback
  return {
    type: elementTypes.Values.text,
    setup: { text: "Text" },
  };
};

/**
 * Renders chart elements (histogram, categories, pie) using WidgetChart from builder
 */
export const ChartElementRenderer: React.FC<ElementRendererProps> = ({ element, viewOnly = true }) => {
  const { t } = useTranslation("common");
  if (!isChartElementType(element.type)) {
    return null;
  }

  const chartConfig = toChartConfig(element, t("chart"));

  return <WidgetChart config={chartConfig} viewOnly={viewOnly} />;
};

/**
 * Renders element widgets (text, image, divider) using WidgetElement from builder
 */
export const ElementRenderer: React.FC<ElementRendererProps> = ({
  element,
  viewOnly = true,
  onElementUpdate,
  featureAttributes,
}) => {
  if (!isElementElementType(element.type)) {
    return null;
  }

  const elementConfig = toElementConfig(element);

  const handleWidgetUpdate = (newData: WidgetElementConfig) => {
    if (onElementUpdate) {
      onElementUpdate(element.id, newData as unknown as Record<string, unknown>);
    }
  };

  return (
    <WidgetElement
      config={elementConfig}
      viewOnly={viewOnly}
      onWidgetUpdate={handleWidgetUpdate}
      fitMode="contain"
      context="report"
      featureAttributes={featureAttributes}
    />
  );
};

/**
 * Generic renderer that dispatches to the appropriate renderer based on element type
 */
export const ReportElementRenderer: React.FC<ElementRendererProps> = (props) => {
  const { element } = props;

  if (isChartElementType(element.type)) {
    return <ChartElementRenderer {...props} />;
  }

  if (isElementElementType(element.type)) {
    return <ElementRenderer {...props} />;
  }

  // For other types (map, legend, etc.) - placeholder for now
  return null;
};

/**
 * Content renderer used by the canvas - wraps ReportElementRenderer with proper sizing
 */
export const ElementContentRenderer: React.FC<ElementContentRendererProps> = ({
  element,
  width: _width,
  height: _height,
  zoom = 1,
  basemapUrl,
  projectLayers,
  locale,
  allElements,
  atlasPage,
  featureAttributes,
  viewOnly = true,
  onElementUpdate,
  onNavigationModeChange,
  onMapLoaded,
}) => {
  // For chart and element types, use the widget renderers
  if (isChartElementType(element.type) || isElementElementType(element.type)) {
    // Apply atlas dynamic text substitution for text elements in viewOnly (print) mode
    let renderElement = element;
    if (element.type === "text" && viewOnly) {
      const originalText =
        element.config.setup?.text ?? element.config.text ?? element.config.content ?? "";
      const resolvedText = resolveAtlasText(originalText as string, atlasPage);
      if (resolvedText !== originalText) {
        renderElement = {
          ...element,
          config: {
            ...element.config,
            setup: { ...element.config.setup, text: resolvedText },
          },
        };
      }
    }

    return (
      <Box
        sx={{
          width: `${100 / zoom}%`,
          height: `${100 / zoom}%`,
          overflow: "hidden",
          pointerEvents: viewOnly ? "none" : "all",
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
        }}>
        <ReportElementRenderer
          element={renderElement}
          viewOnly={viewOnly}
          onElementUpdate={onElementUpdate}
          featureAttributes={featureAttributes}
        />
      </Box>
    );
  }

  // For map elements - use MapElementRenderer (reads snapshot from element.config)
  if (element.type === "map") {
    return (
      <Box
        sx={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}>
        <MapElementRenderer
          element={element}
          basemapUrl={basemapUrl}
          layers={projectLayers}
          locale={locale}
          zoom={zoom}
          atlasPage={atlasPage}
          viewOnly={viewOnly}
          onElementUpdate={onElementUpdate}
          onNavigationModeChange={onNavigationModeChange}
          onMapLoaded={onMapLoaded}
        />
      </Box>
    );
  }

  // For legend elements - use LegendElementRenderer
  if (element.type === "legend") {
    // Get map elements from allElements for legend binding
    const mapElements = allElements?.filter((el) => el.type === "map") || [];
    return (
      <Box
        sx={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}>
        <LegendElementRenderer
          element={element}
          projectLayers={projectLayers}
          mapElements={mapElements}
          locale={locale}
          viewOnly={viewOnly}
          zoom={zoom}
          onElementUpdate={onElementUpdate}
        />
      </Box>
    );
  }

  // For scalebar elements - use ScalebarElementRenderer
  if (element.type === "scalebar") {
    const mapElements = allElements?.filter((el) => el.type === "map") || [];
    return (
      <Box
        sx={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}>
        <ScalebarElementRenderer element={element} mapElements={mapElements} zoom={zoom} />
      </Box>
    );
  }

  // For north arrow elements
  if (element.type === "north_arrow") {
    const style = (element.config?.style as NorthArrowStyle) ?? "default";
    const iconName = getNorthArrowIconName(style);
    const mapElementId = element.config?.mapElementId as string | null | undefined;

    // Get the connected map's bearing (rotation)
    let rotation = 0;
    if (mapElementId && allElements) {
      const connectedMap = allElements.find((el) => el.id === mapElementId && el.type === "map");
      if (connectedMap?.config?.viewState?.bearing !== undefined) {
        // Negate the bearing to point north correctly (map bearing is clockwise, we rotate counter-clockwise)
        rotation = -(connectedMap.config.viewState.bearing as number);
      }
    }

    return (
      <Box
        sx={{
          width: `${100 / zoom}%`,
          height: `${100 / zoom}%`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
        }}>
        <Icon
          iconName={iconName}
          sx={{
            fontSize: "min(80%, 64px)",
            width: "100%",
            height: "100%",
            maxWidth: "64px",
            maxHeight: "64px",
            transform: rotation !== 0 ? `rotate(${rotation}deg)` : undefined,
            transition: "transform 0.3s ease",
            // Explicitly set color to black to ensure visibility on any background
            // (SVG uses fill="currentColor" which inherits from CSS color property)
            color: "#000000",
          }}
        />
      </Box>
    );
  }

  // For divider elements - render a centered line
  if (element.type === "divider") {
    const orientation = (element.config?.setup?.orientation as "horizontal" | "vertical") ?? "horizontal";
    const color = (element.config?.setup?.color as string) ?? "#000000";
    const thicknessMm = (element.config?.setup?.thickness as number) ?? 1;
    // Convert mm to pixels for rendering
    const thicknessPx = mmToPx(thicknessMm);

    return (
      <Box
        sx={{
          width: `${100 / zoom}%`,
          height: `${100 / zoom}%`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
        }}>
        <Box
          sx={{
            width: orientation === "horizontal" ? "100%" : `${thicknessPx}px`,
            height: orientation === "horizontal" ? `${thicknessPx}px` : "100%",
            backgroundColor: color,
          }}
        />
      </Box>
    );
  }

  // Default placeholder for unknown types
  return (
    <Box
      sx={{
        width: `${100 / zoom}%`,
        height: `${100 / zoom}%`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(200, 220, 255, 0.3)",
        p: 1,
        transform: `scale(${zoom})`,
        transformOrigin: "top left",
      }}>
      <Typography variant="caption" color="text.secondary" noWrap>
        {element.type}
      </Typography>
    </Box>
  );
};

export default ReportElementRenderer;
