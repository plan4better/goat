"use client";

import { Box, Stack } from "@mui/material";
import type { StyleSpecification } from "maplibre-gl";
import React from "react";
import { useTranslation } from "react-i18next";

import type { ReportElement } from "@/lib/validations/reportLayout";
import { chartTypes, elementTypes } from "@/lib/validations/widget";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import SelectedItemContainer from "@/components/map/panels/Container";
import ToolsHeader from "@/components/map/panels/common/ToolsHeader";
import DividerElementConfig from "@/components/reports/elements/config/DividerElementConfig";
import ElementStyleConfig from "@/components/reports/elements/config/ElementStyleConfig";
import LegendElementConfig from "@/components/reports/elements/config/LegendElementConfig";
import MapElementConfig from "@/components/reports/elements/config/MapElementConfig";
import NorthArrowElementConfig from "@/components/reports/elements/config/NorthArrowElementConfig";
import ReportElementConfig from "@/components/reports/elements/config/ReportElementConfig";
import ScalebarElementConfig from "@/components/reports/elements/config/ScalebarElementConfig";

interface ElementConfigurationProps {
  element: ReportElement;
  allElements?: ReportElement[];
  projectLayers?: MapLayer[];
  basemapUrl?: string | StyleSpecification;
  onChange: (updates: Partial<ReportElement>) => void;
  onDelete: () => void;
  onBack: () => void;
  onSyncMapLayers?: (elementId: string) => void;
}

// Check if element type has configuration (like builder's widgetTypesWithoutConfig)
const elementHasConfig = (type: string, config?: ReportElement["config"]): boolean => {
  // Map elements have their own config
  if (type === "map") {
    return true;
  }

  // Legend elements have their own config
  if (type === "legend") {
    return true;
  }

  // North arrow elements have their own config
  if (type === "north_arrow") {
    return true;
  }

  // Scalebar elements have their own config
  if (type === "scalebar") {
    return true;
  }

  // Divider elements have their own config in reports
  if (type === "divider") {
    return true;
  }

  // Text from builder doesn't have config
  if (type === "text") {
    return false;
  }

  // Image has config among element types
  if (elementTypes.options.includes(type as "text" | "divider" | "image")) {
    return type === "image";
  }

  // Chart element always has config
  if (
    type === "chart" ||
    chartTypes.options.includes(type as "histogram_chart" | "categories_chart" | "pie_chart")
  ) {
    return true;
  }

  // Check if it's a chart type via config
  if (
    config?.chart_type &&
    chartTypes.options.includes(config.chart_type as "histogram_chart" | "categories_chart" | "pie_chart")
  ) {
    return true;
  }

  // For other report-specific types
  return false;
};

/**
 * Element Configuration wrapper component
 * Similar to builder's ConfigPanel showConfiguration state
 * Shows header with back button and element config
 */
const ElementConfiguration: React.FC<ElementConfigurationProps> = ({
  element,
  allElements,
  projectLayers,
  basemapUrl,
  onChange,
  onDelete: _onDelete,
  onBack,
  onSyncMapLayers,
}) => {
  const { t } = useTranslation("common");

  // Get the display name for the element type
  const elementTypeName =
    element.type === "chart" ? t((element.config?.chart_type as string) || "chart") : t(element.type);

  const hasConfig = elementHasConfig(element.type, element.config);

  // Get map elements for legend config
  const mapElements = allElements?.filter((el) => el.type === "map") || [];

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <SelectedItemContainer
        disableClose
        header={<ToolsHeader title={`${elementTypeName} - ${t("settings")}`} onBack={onBack} />}
        body={
          <Stack spacing={2} sx={{ p: 2 }}>
            {/* Element-specific configuration */}
            {element.type === "map" ? (
              <MapElementConfig
                element={element}
                projectLayers={projectLayers}
                basemapUrl={basemapUrl}
                onChange={onChange}
                onSyncLayers={() => onSyncMapLayers?.(element.id)}
              />
            ) : element.type === "legend" ? (
              <LegendElementConfig element={element} mapElements={mapElements} onChange={onChange} />
            ) : element.type === "north_arrow" ? (
              <NorthArrowElementConfig element={element} mapElements={mapElements} onChange={onChange} />
            ) : element.type === "scalebar" ? (
              <ScalebarElementConfig element={element} mapElements={mapElements} onChange={onChange} />
            ) : element.type === "divider" ? (
              <DividerElementConfig element={element} onChange={onChange} />
            ) : hasConfig ? (
              <ReportElementConfig element={element} onChange={onChange} />
            ) : null}

            {/* Style configuration - available for all elements except divider (which has its own style) */}
            {element.type !== "divider" && <ElementStyleConfig element={element} onChange={onChange} />}
          </Stack>
        }
        close={() => {}}
      />
    </Box>
  );
};

export default ElementConfiguration;
