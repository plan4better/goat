"use client";

import { Stack, Typography } from "@mui/material";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { DEFAULT_WIDGET_COLOR } from "@/lib/constants/ui";
import { hasNestedSchemaPath } from "@/lib/utils/zod";
import type { ReportElement } from "@/lib/validations/reportLayout";
import type { WidgetConfigSchema } from "@/lib/validations/widget";
import { chartTypes, elementTypes, widgetSchemaMap } from "@/lib/validations/widget";

import {
  WidgetData,
  WidgetInfo,
  WidgetOptions,
} from "@/components/builder/widgets/common/WidgetCommonConfigs";

interface ReportElementConfigProps {
  element: ReportElement;
  onChange: (updates: Partial<ReportElement>) => void;
}

// Check if element type is a builder element type
const isBuilderElementType = (type: string): type is "text" | "divider" | "image" => {
  return elementTypes.options.includes(type as "text" | "divider" | "image");
};

// Check if element type is a chart type
const isBuilderChartType = (type: string): type is "histogram_chart" | "categories_chart" | "pie_chart" => {
  return chartTypes.options.includes(type as "histogram_chart" | "categories_chart" | "pie_chart");
};

// Convert report element config to widget config format for the builder config components
const toWidgetConfig = (element: ReportElement): WidgetConfigSchema | null => {
  const elementType = element.type;

  if (isBuilderElementType(elementType)) {
    switch (elementType) {
      case "text":
        return {
          type: "text",
          setup: {
            text: (element.config?.setup?.text ?? element.config?.text ?? "") as string,
          },
        };
      case "image":
        return {
          type: "image",
          setup: {
            url: (element.config?.setup?.url ?? element.config?.url ?? "") as string,
            alt: (element.config?.setup?.alt ?? element.config?.alt ?? "") as string,
          },
          options: {
            has_padding: (element.config?.options?.has_padding ??
              element.config?.has_padding ??
              false) as boolean,
            description: (element.config?.options?.description ??
              element.config?.description ??
              "") as string,
          },
        };
      case "divider":
        return {
          type: "divider",
          setup: {
            size: (element.config?.setup?.size ?? element.config?.size ?? 1) as number,
            orientation: (element.config?.setup?.orientation ?? "horizontal") as "horizontal" | "vertical",
            color: (element.config?.setup?.color ?? "#000000") as string,
            thickness: (element.config?.setup?.thickness ?? 1) as number,
          },
        };
    }
  }

  // For chart type elements - element.type is directly the chart type
  if (isBuilderChartType(elementType)) {
    const chartType = elementType;
    const baseSetup = {
      title: (element.config?.setup?.title ?? element.config?.title ?? "") as string,
      layer_project_id: (element.config?.setup?.layer_project_id ?? element.config?.layer_project_id) as
        | number
        | undefined,
    };

    switch (chartType) {
      case "histogram_chart":
        return {
          type: "histogram_chart",
          setup: {
            ...baseSetup,
            column_name: (element.config?.setup?.column_name ?? element.config?.column_name) as
              | string
              | undefined,
          },
          options: {
            color: (element.config?.options?.color ??
              element.config?.color ??
              DEFAULT_WIDGET_COLOR) as string,
          },
        } as unknown as WidgetConfigSchema;
      case "categories_chart":
        return {
          type: "categories_chart",
          setup: {
            ...baseSetup,
            operation_type: (element.config?.setup?.operation_type ?? element.config?.operation_type) as
              | "count"
              | "sum"
              | "mean"
              | "median"
              | "min"
              | "max"
              | "expression"
              | undefined,
            operation_value: (element.config?.setup?.operation_value ?? element.config?.operation_value) as
              | string
              | undefined,
            group_by_column_name: (element.config?.setup?.group_by_column_name ??
              element.config?.group_by_column_name) as string | undefined,
          },
          options: {
            num_categories: (element.config?.options?.num_categories ??
              element.config?.num_categories ??
              5) as number,
            color: (element.config?.options?.color ??
              element.config?.color ??
              DEFAULT_WIDGET_COLOR) as string,
          },
        } as unknown as WidgetConfigSchema;
      case "pie_chart":
        return {
          type: "pie_chart",
          setup: {
            ...baseSetup,
            operation_type: (element.config?.setup?.operation_type ?? element.config?.operation_type) as
              | "count"
              | "sum"
              | "mean"
              | "median"
              | "min"
              | "max"
              | "expression"
              | undefined,
            operation_value: (element.config?.setup?.operation_value ?? element.config?.operation_value) as
              | string
              | undefined,
            group_by_column_name: (element.config?.setup?.group_by_column_name ??
              element.config?.group_by_column_name) as string | undefined,
          },
          options: {
            num_categories: (element.config?.options?.num_categories ??
              element.config?.num_categories ??
              5) as number,
            cap_others: (element.config?.options?.cap_others ??
              element.config?.cap_others ??
              false) as boolean,
          },
        } as unknown as WidgetConfigSchema;
    }
  }

  return null;
};

// Convert widget config back to report element config
// Store in the same format as builder widgets: { type, setup, options }
const fromWidgetConfig = (
  widgetConfig: WidgetConfigSchema,
  currentConfig: ReportElement["config"]
): ReportElement["config"] => {
  const result: Record<string, unknown> = { ...currentConfig };

  if (widgetConfig.type === "text") {
    result.setup = { text: widgetConfig.setup.text };
  } else if (widgetConfig.type === "image") {
    result.setup = {
      url: widgetConfig.setup.url,
      alt: widgetConfig.setup.alt,
    };
    result.options = {
      has_padding: widgetConfig.options?.has_padding,
      description: widgetConfig.options?.description,
    };
  } else if (widgetConfig.type === "divider") {
    result.setup = { size: widgetConfig.setup.size };
  } else if (
    widgetConfig.type === "histogram_chart" ||
    widgetConfig.type === "categories_chart" ||
    widgetConfig.type === "pie_chart"
  ) {
    // Store in the same format as builder widget configs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setup = widgetConfig.setup as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options = widgetConfig.options as any;

    result.setup = { ...setup };
    result.options = { ...options };
  }

  return result;
};

/**
 * Report Element Configuration component
 * Reuses the builder's WidgetInfo, WidgetData, and WidgetOptions components
 * for configuring text, image, divider, and chart elements.
 */
const ReportElementConfig: React.FC<ReportElementConfigProps> = ({ element, onChange }) => {
  const { t } = useTranslation("common");

  // Convert report element to widget config format
  const widgetConfig = useMemo(() => toWidgetConfig(element), [element]);

  // Get the schema for this widget type
  const schema = useMemo(() => {
    if (!widgetConfig) return null;
    return widgetSchemaMap[widgetConfig.type];
  }, [widgetConfig]);

  // Check if this widget type has data configuration
  const hasDataConfig = useMemo(() => {
    if (!schema) return false;
    return hasNestedSchemaPath(schema, "setup.layer_project_id");
  }, [schema]);

  // Handle config changes from the builder components
  const handleConfigChange = (newWidgetConfig: WidgetConfigSchema) => {
    const newConfig = fromWidgetConfig(newWidgetConfig, element.config);
    onChange({ config: newConfig });
  };

  // If we can't convert to widget config, show message
  if (!widgetConfig || !schema) {
    return (
      <Stack spacing={2} sx={{ p: 2, textAlign: "center" }}>
        <Typography variant="body2" color="text.secondary">
          {t("no_configuration_available")}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack direction="column" spacing={2} justifyContent="space-between">
      <WidgetInfo config={widgetConfig} onChange={handleConfigChange} />
      {hasDataConfig && <WidgetData config={widgetConfig} onChange={handleConfigChange} />}
      <WidgetOptions config={widgetConfig} onChange={handleConfigChange} />
    </Stack>
  );
};

export default ReportElementConfig;
