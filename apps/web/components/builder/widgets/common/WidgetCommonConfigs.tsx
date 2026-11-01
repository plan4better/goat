/* eslint-disable @typescript-eslint/no-explicit-any */
import { Autocomplete, Box, Button, Checkbox, Chip, Divider, FormControlLabel, Paper, Stack, TextField, Typography, useTheme } from "@mui/material";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { DEFAULT_WIDGET_COLOR, pickerBorderColor, pickerBorderHoverColor } from "@/lib/constants/ui";
import { DEFAULT_COLOR_RANGE } from "@/lib/constants/color";
import { useLayerUniqueValues } from "@/lib/api/layers";
import { useProjectLayers } from "@/lib/api/projects";
import { formatNumber } from "@/lib/utils/format-number";
import { hasNestedSchemaPath } from "@/lib/utils/zod";
import type { FormatNumberTypes, WidgetConfigSchema } from "@/lib/validations/widget";
import {
  formatNumberTypes,
  pieLayoutTypes,
  pieChartTypes,
  labelSizeTypes,
  tableQueryModeTypes,
  tableModeTypes,
  widgetSchemaMap,
  widgetTypes,
} from "@/lib/validations/widget";

import type { SelectorItem } from "@/types/map/common";

import useLayerFields from "@/hooks/map/CommonHooks";
import { useLayerByGeomType, useLayerDatasetId } from "@/hooks/map/ToolsHooks";

import CollapsibleConfigCard from "@/components/builder/widgets/common/CollapsibleConfigCard";
import RichTextEditor from "@/components/builder/widgets/common/RichTextEditor";
import WidgetColorPicker from "@/components/builder/widgets/common/WidgetColorPicker";
import CategoryColorConfig from "@/components/builder/widgets/data/CategoryColorConfig";
import CategoryOrderConfig from "@/components/builder/widgets/data/CategoryOrderConfig";
import FormLabelHelper from "@/components/common/FormLabelHelper";
import { ArrowPopper } from "@/components/ArrowPoper";
import { TargetLayersConfig, WidgetFilterLayout } from "@/components/builder/widgets/data/DataConfig";
import LayerFieldSelector from "@/components/map/common/LayerFieldSelector";
import { StatisticSelector } from "@/components/map/common/StatisticSelector";
import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";
import SegmentedControl from "@/components/map/panels/common/SegmentedControl";
import Selector from "@/components/map/panels/common/Selector";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
const FormulaBuilder = dynamic(() => import("@/components/modals/FormulaBuilder"), { ssr: false });
import type { FormulaField, SqlTable } from "@/components/modals/FormulaBuilder";
import ColorPalette from "@/components/map/panels/style/color/ColorPalette";
import ColorRangeSelector from "@/components/map/panels/style/color/ColorRangeSelector";

export interface WidgetConfigProps {
  active?: boolean;
  sectionLabel?: string;
  config: WidgetConfigSchema;
  onChange: (widget: WidgetConfigSchema) => void;
}

export const NumberFormatSelector = ({
  numberFormat,
  onNumberFormatChange,
}: {
  numberFormat?: FormatNumberTypes;
  onNumberFormatChange?: (format: FormatNumberTypes) => void;
}) => {
  const { t, i18n } = useTranslation("common");

  const numberFormats = useMemo(() => {
    return formatNumberTypes.options.map((format) => {
      let label = format as string;
      switch (format) {
        case "none":
          label = t("none");
          break;
        case "decimal_max":
          label = t("decimal_max");
          break;
        case "integer":
        case "compact":
        case "grouping":
          label = `${formatNumber(1000, format, i18n.language)}`;
          break;
        case "grouping_2d":
        case "signed_2d":
        case "compact_1d":
        case "currency_usd":
        case "currency_eur":
          label = `${formatNumber(12345.678, format, i18n.language)}`;
          break;
        case "percent":
        case "percent_1d":
        case "percent_2d":
          label = `${formatNumber(0.01, "none", i18n.language)} ${t("is")} ${formatNumber(0.01, format, i18n.language)}`;
          break;
        case "decimal_2":
        case "decimal_3":
          label = `${formatNumber(1.234, format, i18n.language)}`;
          break;
        default:
          break;
      }
      return {
        label,
        value: format,
      };
    });
  }, [i18n.language, t]);

  const selectedFormat = useMemo(() => {
    return numberFormat ? numberFormats.find((item) => item.value === numberFormat) : undefined;
  }, [numberFormat, numberFormats]);

  return (
    <Selector
      selectedItems={selectedFormat}
      setSelectedItems={(item: SelectorItem) => {
        onNumberFormatChange?.(item.value as FormatNumberTypes);
      }}
      items={numberFormats}
      label={t("number_format")}
    />
  );
};

export const WidgetInfo = ({ sectionLabel, config, onChange }: WidgetConfigProps) => {
  const { t } = useTranslation("common");
  const schema = widgetSchemaMap[config.type];
  const hasTitleDef = useMemo(() => hasNestedSchemaPath(schema, "setup.title"), [schema]);
  const hasDescriptionDef = useMemo(() => hasNestedSchemaPath(schema, "options.description"), [schema]);
  const hasAltTextDef = useMemo(() => hasNestedSchemaPath(schema, "setup.alt"), [schema]);

  const handleConfigChange = useCallback(
    (parentKey: "setup" | "options", propertyKey: string, value: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const currentParent = (config as any)[parentKey] || {};
      onChange({
        ...config,
        [parentKey]: { ...currentParent, [propertyKey]: value },
      } as WidgetConfigSchema);
    },
    [config, onChange]
  );

  if (!hasTitleDef && !hasDescriptionDef && !hasAltTextDef) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const title = (config.setup as any)?.title ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const description = (config as any)?.options?.description ?? "";

  return (
    <>
      <SectionHeader
        active
        alwaysActive
        label={sectionLabel ?? t("info")}
        icon={ICON_NAME.CIRCLEINFO}
        disableAdvanceOptions
      />
      <SectionOptions
        active
        baseOptions={
          <Stack spacing={1.5}>
            {hasTitleDef && (
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  fontWeight={600}
                  sx={{ mb: 0.5, display: "block" }}>
                  {t("title")}
                </Typography>
                <Box
                  sx={(theme) => ({
                    border: 1,
                    borderColor: "divider",
                    borderRadius: 1,
                    px: 1,
                    py: 0.5,
                    minHeight: 32,
                    "&:focus-within": {
                      borderColor: theme.palette.primary.main,
                      boxShadow: `0 0 0 2px ${theme.palette.primary.main}1A`,
                    },
                  })}>
                  <RichTextEditor
                    value={title}
                    onChange={(html) => handleConfigChange("setup", "title", html)}
                    alwaysEdit
                    singleLine
                    placeholder={t("add_widget_title")}
                    sx={{ fontSize: "0.875rem" }}
                  />
                </Box>
              </Box>
            )}
            {hasDescriptionDef && (
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  fontWeight={600}
                  sx={{ mb: 0.5, display: "block" }}>
                  {t("description")}
                </Typography>
                <Box
                  sx={(theme) => ({
                    border: 1,
                    borderColor: "divider",
                    borderRadius: 1,
                    px: 1,
                    py: 0.5,
                    minHeight: 80,
                    "&:focus-within": {
                      borderColor: theme.palette.primary.main,
                      boxShadow: `0 0 0 2px ${theme.palette.primary.main}1A`,
                    },
                  })}>
                  <RichTextEditor
                    value={description}
                    onChange={(html) => handleConfigChange("options", "description", html)}
                    alwaysEdit
                    placeholder={t("add_widget_description")}
                    sx={{ fontSize: "0.875rem" }}
                  />
                </Box>
              </Box>
            )}
            {hasAltTextDef && (
              <TextFieldInput
                type="text"
                label={t("alternative_text")}
                placeholder={t("add_image_alternative_text")}
                clearable={false}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                value={(config as any)?.setup?.alt || ""}
                onChange={(value: string) => {
                  handleConfigChange("setup", "alt", value);
                }}
              />
            )}
          </Stack>
        }
      />
    </>
  );
};

export const WidgetData = ({ sectionLabel, config, onChange }: WidgetConfigProps) => {
  const { t } = useTranslation("common");
  const schema = widgetSchemaMap[config.type];
  const { projectId } = useParams();
  const [formulaBuilderOpen, setFormulaBuilderOpen] = useState(false);
  const [expandedMetricIndex, setExpandedMetricIndex] = useState<number | null>(null);
  const { filteredLayers } = useLayerByGeomType(["feature", "table"], undefined, projectId as string);

  const hasLayerProjectIdDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "setup.layer_project_id");
  }, [schema]);

  const hasColumnNameDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "setup.column_name");
  }, [schema]);

  const hasOperationDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "setup.operation_type");
  }, [schema]);

  const hasGroupColumnNameDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "setup.group_by_column_name");
  }, [schema]);

  const hasModeDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "setup.mode");
  }, [schema]);

  const hasQueryModeDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "setup.query_mode");
  }, [schema]);

  const hasSqlQueryDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "setup.sql_query");
  }, [schema]);

  const hasAdditionalMetricsDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "setup.additional_metrics");
  }, [schema]);

  const hasVisibleColumnsDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "setup.visible_columns");
  }, [schema]);

  const hasSortByDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.sort_by");
  }, [schema]);

  const hasSortingDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.sorting");
  }, [schema]);

  const selectedLayer = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return filteredLayers.find((layer) => layer.value === (config?.setup as any)?.layer_project_id);
  }, [config?.setup, filteredLayers]);

  const selectedLayerDatasetId = useLayerDatasetId(
    selectedLayer?.value as number | undefined,
    projectId as string
  );

  const fieldType = {
    [widgetTypes.Values.histogram_chart]: "number",
  };

  const { layerFields } = useLayerFields(selectedLayerDatasetId || "", fieldType[config.type] ?? undefined);

  const selectedColumnName = useMemo(() => {
    if (!hasColumnNameDef || !selectedLayer) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return layerFields.find((field) => field.name === (config?.setup as any)?.column_name);
  }, [hasColumnNameDef, selectedLayer, layerFields, config?.setup]);

  const selectedMode = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (config?.setup as any)?.mode || tableModeTypes.Values.records;
  }, [config?.setup]);

  const selectedQueryMode = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (config?.setup as any)?.query_mode || tableQueryModeTypes.Values.builder;
  }, [config?.setup]);

  const isSqlMode = selectedQueryMode === tableQueryModeTypes.Values.sql;
  const isTableWidget = config.type === widgetTypes.Enum.table;

  const isRecordsMode = selectedMode === tableModeTypes.Values.records;
  const isGroupedBuilderMode = !isSqlMode && (!hasModeDef || !isRecordsMode);

  const modeOptions = useMemo(
    () => [
      { value: tableModeTypes.Values.records, label: t("records", { defaultValue: "Records" }) },
      { value: tableModeTypes.Values.grouped, label: t("grouped", { defaultValue: "Grouped" }) },
    ],
    [t]
  );

  const selectedModeOption = useMemo(() => {
    return modeOptions.find((option) => option.value === selectedMode);
  }, [modeOptions, selectedMode]);

  const queryModeOptions = useMemo(
    () => [
      {
        value: tableQueryModeTypes.Values.builder,
        label: t("table_data_source_dashboard", { defaultValue: "Dashboard setup" }),
      },
      {
        value: tableQueryModeTypes.Values.sql,
        label: t("table_data_source_sql", { defaultValue: "SQL query" }),
      },
    ],
    [t]
  );

  const selectedQueryModeOption = useMemo(() => {
    return queryModeOptions.find((option) => option.value === selectedQueryMode);
  }, [queryModeOptions, selectedQueryMode]);

  const selectedVisibleColumns = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visibleColumns = (config?.setup as any)?.visible_columns as string[] | undefined;
    if (!visibleColumns?.length) return [];
    return layerFields
      .filter((field) => visibleColumns.includes(field.name))
      .map((field) => ({ value: field.name, label: field.name }));
  }, [config?.setup, layerFields]);

  const visibleColumnOptions = useMemo(() => {
    return layerFields.map((field) => ({ value: field.name, label: field.name }));
  }, [layerFields]);

  const sortByOptions = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const additionalMetrics = ((config?.setup as any)?.additional_metrics || []) as Array<Record<string, unknown>>;

    if (hasModeDef && !isRecordsMode) {
      const hasSecondary = !!(config?.setup as any)?.group_by_secondary_column_name;
      const options = [
        { value: "grouped_value", label: t("group", { defaultValue: "Group" }) },
        ...(hasSecondary
          ? [{ value: "grouped_secondary_value", label: t("secondary_group", { defaultValue: "Secondary group" }) }]
          : []),
        { value: "metric_0", label: t("value", { defaultValue: "Value" }) },
        ...additionalMetrics.map((_, index) => ({
          value: `metric_${index + 1}`,
          label: `${t("value", { defaultValue: "Value" })} ${index + 2}`,
        })),
      ];
      return options;
    }
    return layerFields.map((field) => ({ value: field.name, label: field.name }));
  }, [config?.setup, hasModeDef, isRecordsMode, layerFields, t]);

  const selectedSortBy = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sortBy = (config as any)?.options?.sort_by;
    return sortByOptions.find((option) => option.value === sortBy);
  }, [config, sortByOptions]);

  const sortingOptions = useMemo(
    () => [
      { value: "asc", label: t("ascending", { defaultValue: "Ascending" }) },
      { value: "desc", label: t("descending", { defaultValue: "Descending" }) },
    ],
    [t]
  );

  const selectedSorting = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sorting = (config as any)?.options?.sorting || "desc";
    return sortingOptions.find((option) => option.value === sorting);
  }, [config, sortingOptions]);

  const handleSetupChange = useCallback(
    (key: string, value: any) => {
      onChange({
        ...config,
        setup: {
          ...(config.setup as any),
          [key]: value,
        },
      } as WidgetConfigSchema);
    },
    [config, onChange]
  );

  const handleOptionChange = useCallback(
    (key: string, value: any) => {
      onChange({
        ...config,
        options: {
          ...((config as any).options || {}),
          [key]: value,
        },
      } as WidgetConfigSchema);
    },
    [config, onChange]
  );

  const sqlBuilderFields = useMemo<FormulaField[]>(() => {
    return layerFields.map((field) => ({ name: field.name, type: field.type }));
  }, [layerFields]);

  const sqlTables = useMemo<SqlTable[]>(() => {
    const sqlAlias = "input_1";
    const selectedLayerName = selectedLayer?.label || t("layer", { defaultValue: "Layer" });
    return [
      {
        alias: sqlAlias,
        fields: sqlBuilderFields,
        layerName: String(selectedLayerName),
        layerId: selectedLayerDatasetId,
      },
    ];
  }, [selectedLayer?.label, selectedLayerDatasetId, sqlBuilderFields, t]);

  const additionalMetrics = useMemo(
    () =>
      (((config?.setup as any)?.additional_metrics || []) as Array<{
        operation_type?: string;
        operation_value?: string;
      }>),
    [config?.setup]
  );

  const selectedGroupByField = useMemo(() => {
    const groupByName = (config.setup as any)?.group_by_column_name as string | undefined;
    if (!groupByName) return undefined;
    return layerFields.find((field) => field.name === groupByName);
  }, [config.setup, layerFields]);

  const selectedSecondaryGroupByField = useMemo(() => {
    const name = (config.setup as any)?.group_by_secondary_column_name as string | undefined;
    if (!name) return undefined;
    return layerFields.find((field) => field.name === name);
  }, [config.setup, layerFields]);

  const secondaryGroupByFields = useMemo(() => {
    const primaryName = (config.setup as any)?.group_by_column_name as string | undefined;
    if (!primaryName) return layerFields;
    return layerFields.filter((field) => field.name !== primaryName);
  }, [config.setup, layerFields]);

  const groupedValueColumns = useMemo(
    () => [
      {
        operation_type: (config.setup as any)?.operation_type,
        operation_value: (config.setup as any)?.operation_value,
      },
      ...additionalMetrics,
    ],
    [additionalMetrics, config.setup]
  );

  return (
    <>
      <SectionHeader
        active
        alwaysActive
        label={sectionLabel ?? t("data")}
        disableAdvanceOptions
        icon={ICON_NAME.LAYERS}
      />
      <SectionOptions
        active
        baseOptions={
          <>
            {hasLayerProjectIdDef && (
              <Selector
                selectedItems={selectedLayer}
                setSelectedItems={(item: SelectorItem | undefined) => {
                  // Build updated setup, resetting dependent fields as needed
                  const updatedSetup: Record<string, any> = {
                    ...(config.setup as any),
                    layer_project_id: item?.value,
                    ...(hasColumnNameDef && { column_name: undefined }),
                    ...(hasOperationDef && { operation_type: undefined, operation_value: undefined }),
                    ...(hasGroupColumnNameDef && { group_by_column_name: undefined }),
                    ...(hasGroupColumnNameDef && { group_by_label: undefined, primary_metric_label: undefined }),
                    ...(hasGroupColumnNameDef && { group_by_secondary_column_name: undefined, group_by_secondary_label: undefined }),
                    ...(hasGroupColumnNameDef && { grouped_display_mode: "flat", grouped_collapse_initial: "collapsed", grouped_show_subtotals: true }),
                    ...(hasAdditionalMetricsDef && { additional_metrics: [] }),
                    ...(hasVisibleColumnsDef && { visible_columns: undefined }),
                  };

                  onChange({
                    ...config,
                    setup: updatedSetup,
                  } as WidgetConfigSchema);
                }}
                items={filteredLayers}
                emptyMessage={t("no_layers_found")}
                emptyMessageIcon={ICON_NAME.LAYERS}
                label={t("select_layer")}
                placeholder={t("select_layer")}
              />
            )}
            {selectedLayer && hasQueryModeDef && (
              <Selector
                selectedItems={selectedQueryModeOption}
                setSelectedItems={(item: SelectorItem | undefined) => {
                  const nextQueryMode = item?.value || tableQueryModeTypes.Values.builder;
                  onChange({
                    ...config,
                    setup: {
                      ...(config.setup as any),
                      query_mode: nextQueryMode,
                    },
                  } as WidgetConfigSchema);
                }}
                items={queryModeOptions}
                label={t("table_data_source", { defaultValue: "Data source" })}
              />
            )}
            {selectedLayer && hasModeDef && !isSqlMode && (
              <Selector
                selectedItems={selectedModeOption}
                setSelectedItems={(item: SelectorItem | undefined) => {
                  const nextMode = item?.value || tableModeTypes.Values.records;
                  const currentOptions = { ...((config as any).options || {}) };
                  const currentSetup = (config.setup as any) || {};
                  const groupedOperationType = currentSetup.operation_type || "count";
                  const groupedOperationValue =
                    groupedOperationType === "count" ? undefined : currentSetup.operation_value;

                  if (nextMode === tableModeTypes.Values.records) {
                    delete currentOptions.sort_by;
                  }

                  onChange({
                    ...config,
                    setup: {
                      ...currentSetup,
                      mode: nextMode,
                      ...(nextMode === tableModeTypes.Values.records && {
                        operation_type: undefined,
                        operation_value: undefined,
                        group_by_column_name: undefined,
                        group_by_label: undefined,
                        primary_metric_label: undefined,
                        group_by_secondary_column_name: undefined,
                        group_by_secondary_label: undefined,
                        grouped_display_mode: "flat",
                        additional_metrics: [],
                      }),
                      ...(nextMode === tableModeTypes.Values.grouped && {
                        operation_type: groupedOperationType,
                        operation_value: groupedOperationValue,
                      }),
                    },
                    ...(nextMode === tableModeTypes.Values.records && {
                      options: currentOptions,
                    }),
                    ...(nextMode === tableModeTypes.Values.grouped && {
                      options: {
                        ...currentOptions,
                        sort_by: "metric_0",
                      },
                    }),
                  } as WidgetConfigSchema);
                }}
                items={modeOptions}
                label={t("mode")}
              />
            )}
            {selectedLayer && hasVisibleColumnsDef && isRecordsMode && !isSqlMode && (
              <Selector
                selectedItems={selectedVisibleColumns}
                setSelectedItems={(items: SelectorItem[] | SelectorItem | undefined) => {
                  const nextItems = Array.isArray(items) ? items : [];
                  handleSetupChange(
                    "visible_columns",
                    nextItems.length ? nextItems.map((item) => String(item.value)) : undefined
                  );
                }}
                items={visibleColumnOptions}
                multiple
                enableSearch
                label={t("visible_fields", { defaultValue: "Visible fields" })}
              />
            )}
            {/* For widgets such as filter etc */}
            {selectedLayer && hasColumnNameDef && !hasOperationDef && (
              <LayerFieldSelector
                fields={layerFields}
                selectedField={selectedColumnName}
                disabled={!selectedLayer}
                setSelectedField={(field) => {
                  // handleConfigChange("column_name", field?.name);
                  onChange({
                    ...config,
                    setup: {
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      ...(config.setup as any),
                      column_name: field?.name,
                    },
                  } as WidgetConfigSchema);
                }}
                label={t("select_field")}
              />
            )}
            {/* Grouped mode: unified value columns list + group-by selector */}
            {selectedLayer && hasOperationDef && hasAdditionalMetricsDef && isGroupedBuilderMode && (
              <>
                <Typography variant="body2" color="text.secondary">
                  {t("value_columns", { defaultValue: "Value columns" })}
                </Typography>
                <Stack spacing={1}>
                  {groupedValueColumns.map((metric, index) => {
                    const isPrimaryRow = index === 0;
                    const canRemove = groupedValueColumns.length > 1;
                    const isExpanded = expandedMetricIndex === index;

                    // Build summary for collapsed state
                    const methodLabel = metric.operation_type ? t(metric.operation_type) : "";
                    const fieldLabel = metric.operation_value || "";
                    const summary = [methodLabel, fieldLabel].filter(Boolean).join(" · ");

                    return (
                      <CollapsibleConfigCard
                        key={`metric-${index}`}
                        title={`${t("value_column", { defaultValue: "Value column" })} ${index + 1}`}
                        summary={summary}
                        expanded={isExpanded}
                        onToggle={() => setExpandedMetricIndex(isExpanded ? null : index)}
                        onRemove={() => {
                          if (!canRemove) return;

                          if (isPrimaryRow) {
                            const [nextPrimary, ...remaining] = additionalMetrics;
                            onChange({
                              ...config,
                              setup: {
                                ...(config.setup as any),
                                operation_type: nextPrimary?.operation_type,
                                operation_value: nextPrimary?.operation_value,
                                additional_metrics: remaining,
                              },
                            } as WidgetConfigSchema);
                          } else {
                            const nextMetrics = additionalMetrics.filter(
                              (_, metricIndex) => metricIndex !== index - 1
                            );
                            handleSetupChange("additional_metrics", nextMetrics);
                          }
                          setExpandedMetricIndex(null);
                        }}
                        canRemove={canRemove}>
                        <StatisticSelector
                          layerProjectId={selectedLayer.value as number}
                          hasGroupBy={false}
                          value={{
                            method: metric.operation_type as any,
                            value: metric.operation_value,
                          }}
                          onChange={(nextValue) => {
                            if (isPrimaryRow) {
                              onChange({
                                ...config,
                                setup: {
                                  ...(config.setup as any),
                                  operation_type: nextValue.method,
                                  operation_value: nextValue.value,
                                },
                              } as WidgetConfigSchema);
                            } else {
                              const nextMetrics = [...additionalMetrics];
                              nextMetrics[index - 1] = {
                                ...nextMetrics[index - 1],
                                operation_type: nextValue.method,
                                operation_value: nextValue.value,
                              };
                              handleSetupChange("additional_metrics", nextMetrics);
                            }
                          }}
                        />
                      </CollapsibleConfigCard>
                    );
                  })}
                </Stack>

                <Divider />
                <Button
                  variant="text"
                  fullWidth
                  onClick={() => {
                    const nextMetrics = [...additionalMetrics, { operation_type: "count", operation_value: undefined }];
                    handleSetupChange("additional_metrics", nextMetrics);
                  }}>
                  {t("add_column", { defaultValue: "Add column" })}
                </Button>
              </>
            )}
            {/* Non-table widgets with statistics support (charts/numbers) */}
            {selectedLayer && hasOperationDef && !isTableWidget && (
              <StatisticSelector
                layerProjectId={selectedLayer.value as number}
                hasGroupBy={hasGroupColumnNameDef}
                value={{
                  method: (config.setup as any).operation_type,
                  value: (config.setup as any).operation_value,
                  groupBy: (config.setup as any).group_by_column_name,
                }}
                onChange={(value) => {
                  const currentGroupBy = (config.setup as any).group_by_column_name;
                  const groupByChanged = hasGroupColumnNameDef && value.groupBy !== currentGroupBy;

                  onChange({
                    ...config,
                    setup: {
                      ...(config.setup as any),
                      operation_type: value.method,
                      operation_value: value.value,
                      ...(hasGroupColumnNameDef && { group_by_column_name: value.groupBy }),
                      ...(groupByChanged && { custom_order: undefined }),
                    },
                    ...(groupByChanged && {
                      options: {
                        ...((config as any).options || {}),
                        color_map: undefined,
                      },
                    }),
                  } as WidgetConfigSchema);
                }}
              />
            )}
            {selectedLayer && isTableWidget && hasGroupColumnNameDef && isGroupedBuilderMode && (
              <LayerFieldSelector
                fields={layerFields}
                selectedField={selectedGroupByField}
                disabled={!selectedLayer}
                setSelectedField={(field) => {
                  const currentGroupBy = (config.setup as any).group_by_column_name;
                  const nextGroupBy = field?.name;
                  const groupByChanged = nextGroupBy !== currentGroupBy;

                  onChange({
                    ...config,
                    setup: {
                      ...(config.setup as any),
                      group_by_column_name: nextGroupBy,
                      ...(groupByChanged && { custom_order: undefined }),
                      ...(groupByChanged && {
                        group_by_secondary_column_name: undefined,
                        group_by_secondary_label: undefined,
                        grouped_display_mode: "flat",
                      }),
                    },
                    ...(groupByChanged && {
                      options: {
                        ...((config as any).options || {}),
                        color_map: undefined,
                      },
                    }),
                  } as WidgetConfigSchema);
                }}
                label={t("group_by_field", { defaultValue: "Group-by field" })}
              />
            )}
            {selectedLayer && isTableWidget && hasGroupColumnNameDef && isGroupedBuilderMode && selectedGroupByField && (
              <LayerFieldSelector
                fields={secondaryGroupByFields}
                selectedField={selectedSecondaryGroupByField}
                disabled={!selectedLayer}
                setSelectedField={(field) => {
                  onChange({
                    ...config,
                    setup: {
                      ...(config.setup as any),
                      group_by_secondary_column_name: field?.name,
                      group_by_secondary_label: undefined,
                      ...(!field && {
                        grouped_display_mode: "flat",
                        grouped_collapse_initial: "collapsed",
                        grouped_show_subtotals: true,
                      }),
                    },
                  } as WidgetConfigSchema);
                }}
                label={t("secondary_group_by_field", { defaultValue: "Secondary group-by field (optional)" })}
              />
            )}
            {selectedLayer && hasSqlQueryDef && isSqlMode && (
              <>
                <Button variant="outlined" onClick={() => setFormulaBuilderOpen(true)}>
                  {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    ((config?.setup as any)?.sql_query as string)
                      ? t("edit_sql_query")
                      : t("write_sql_query")
                  }
                </Button>
                <FormulaBuilder
                  open={formulaBuilderOpen}
                  onClose={() => setFormulaBuilderOpen(false)}
                  onApply={(expression: string) => {
                    handleSetupChange("sql_query", expression || undefined);
                    setFormulaBuilderOpen(false);
                  }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  initialExpression={((config?.setup as any)?.sql_query as string) || ""}
                  fields={sqlBuilderFields}
                  mode="sql"
                  tables={sqlTables}
                  title={t("custom_sql_editor")}
                  showGroupBy={false}
                />
              </>
            )}
            {selectedLayer && isTableWidget && hasSortByDef && !isSqlMode && (
              <Selector
                selectedItems={selectedSortBy}
                setSelectedItems={(item: SelectorItem | undefined) => {
                  handleOptionChange("sort_by", item?.value);
                }}
                items={sortByOptions}
                label={t("sort_by")}
              />
            )}
            {selectedLayer && isTableWidget && hasSortingDef && !isSqlMode && (
              <SegmentedControl
                value={selectedSorting?.value}
                onChange={(value) => handleOptionChange("sorting", value)}
                items={sortingOptions}
                label={t("sort")}
              />
            )}
          </>
        }
      />
    </>
  );
};

export const WidgetLayout = ({ config, onChange }: WidgetConfigProps) => {
  const { t } = useTranslation("common");
  const isTableWidget = config.type === widgetTypes.Enum.table;
  if (!isTableWidget) return null;

  const selectedQueryMode = (config?.setup as any)?.query_mode || tableQueryModeTypes.Values.builder;
  const isSqlMode = selectedQueryMode === tableQueryModeTypes.Values.sql;
  const selectedMode = (config?.setup as any)?.mode || tableModeTypes.Values.records;
  const isGroupedBuilderMode = !isSqlMode && selectedMode === tableModeTypes.Values.grouped;
  const hasSecondaryGroup = !!(config?.setup as any)?.group_by_secondary_column_name;

  // Collapsible options only for: builder grouped mode with secondary group, or SQL mode
  const showCollapsibleOptions = (isGroupedBuilderMode && hasSecondaryGroup) || isSqlMode;

  const groupedDisplayMode = ((config?.setup as any)?.grouped_display_mode || "flat") as string;
  const isCollapsible = groupedDisplayMode === "collapsible";

  const handleSetupChange = (key: string, value: unknown) => {
    onChange({
      ...config,
      setup: { ...(config.setup as any), [key]: value },
    } as WidgetConfigSchema);
  };

  const handleOptionChange = (key: string, value: unknown) => {
    onChange({
      ...config,
      options: { ...(config.options as any), [key]: value },
    } as WidgetConfigSchema);
  };

  return (
    <>
      <SectionHeader
        active
        alwaysActive
        label={t("layout", { defaultValue: "Layout" })}
        disableAdvanceOptions
        icon={ICON_NAME.TABLE}
      />
      <SectionOptions
        active
        baseOptions={
          <Stack spacing={2}>
            <Stack spacing={0}>
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    color="primary"
                    checked={((config as any)?.options?.sticky_header ?? true) === true}
                    onChange={(e) => {
                      handleOptionChange("sticky_header", e.target.checked);
                    }}
                  />
                }
                label={<Typography variant="body2">{t("sticky_header", { defaultValue: "Sticky header" })}</Typography>}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    color="primary"
                    checked={!!(config as any)?.options?.show_totals}
                    onChange={(e) => {
                      handleOptionChange("show_totals", e.target.checked);
                    }}
                  />
                }
                label={<Typography variant="body2">{t("show_totals", { defaultValue: "Show totals" })}</Typography>}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    color="primary"
                    checked={((config as any)?.options?.show_sort_action ?? true) === true}
                    onChange={(e) => {
                      handleOptionChange("show_sort_action", e.target.checked);
                    }}
                  />
                }
                label={
                  <Typography variant="body2">
                    {t("allow_sorting", { defaultValue: "Allow sorting" })}
                  </Typography>
                }
              />
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    color="primary"
                    checked={((config as any)?.options?.show_filter_action ?? true) === true}
                    onChange={(e) => {
                      handleOptionChange("show_filter_action", e.target.checked);
                    }}
                  />
                }
                label={
                  <Typography variant="body2">
                    {t("allow_filtering", { defaultValue: "Allow filtering" })}
                  </Typography>
                }
              />
            </Stack>
            {showCollapsibleOptions && (
              <>
                <Selector
                  selectedItems={{
                    value: groupedDisplayMode,
                    label: isCollapsible
                      ? t("collapsible", { defaultValue: "Collapsible" })
                      : t("flat", { defaultValue: "Flat" }),
                  }}
                  setSelectedItems={(item: SelectorItem | undefined) => {
                    handleSetupChange("grouped_display_mode", item?.value || "flat");
                  }}
                  items={[
                    { value: "flat", label: t("flat", { defaultValue: "Flat" }) },
                    { value: "collapsible", label: t("collapsible", { defaultValue: "Collapsible" }) },
                  ]}
                  label={t("display_mode", { defaultValue: "Display mode" })}
                />
                {isCollapsible && (
                  <Stack spacing={0} sx={{ mt: -1 }}>
                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          checked={((config.setup as any)?.grouped_collapse_initial || "collapsed") === "expanded"}
                          onChange={(event) => {
                            handleSetupChange("grouped_collapse_initial", event.target.checked ? "expanded" : "collapsed");
                          }}
                        />
                      }
                      label={
                        <Typography variant="body2">
                          {t("start_expanded", { defaultValue: "Start expanded" })}
                        </Typography>
                      }
                    />
                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          checked={(config.setup as any)?.grouped_show_subtotals !== false}
                          onChange={(event) => {
                            handleSetupChange("grouped_show_subtotals", event.target.checked);
                          }}
                        />
                      }
                      label={
                        <Typography variant="body2">
                          {t("show_subtotals", { defaultValue: "Show subtotals" })}
                        </Typography>
                      }
                    />
                  </Stack>
                )}
              </>
            )}
          </Stack>
        }
      />
    </>
  );
};

export const WidgetSetup = ({ config, onChange }: WidgetConfigProps) => {
  return (
    <>
      {config.type === widgetTypes.Enum.filter && <WidgetFilterLayout config={config} onChange={onChange} />}
    </>
  );
};

// Widget types that handle their own style configuration
const widgetTypesWithCustomStyle = [widgetTypes.Enum.filter];

export const WidgetOptions = ({ active = true, sectionLabel, config, onChange }: WidgetConfigProps) => {
  const { t } = useTranslation("common");
  const { projectId } = useParams();
  const schema = widgetSchemaMap[config.type];

  const hasTargetLayersDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.target_layers");
  }, [schema]);

  const hasFilterViewPortDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.filter_by_viewport");
  }, [schema]);

  const hasNumberFormatDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.format");
  }, [schema]);

  const hasPaddingDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.has_padding");
  }, [schema]);

  const hasSelectionResponseDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.selection_response");
  }, [schema]);

  const hasPageSizeDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.page_size");
  }, [schema]);

  // Get project layers for target layer selection
  const { layers: projectLayers } = useProjectLayers(projectId as string);

  // Selection response options for chart widgets
  const selectionResponseOptions = useMemo(
    () => [
      { value: "filter", label: t("filter") },
      { value: "highlight", label: t("highlight") },
    ],
    [t]
  );

  const selectedSelectionResponse = useMemo(() => {
    const mode = (config as any)?.options?.selection_response || "filter";
    return selectionResponseOptions.find((opt) => opt.value === mode);
  }, [config, selectionResponseOptions]);

  const handleOptionChange = useCallback(
    (key: string, value: any) => {
      const updatedOptions = {
        ...((config as any).options || {}),
        [key]: value, // Dynamically set the property based on the 'key' argument.
      };
      onChange({
        ...config,
        options: updatedOptions,
      } as WidgetConfigSchema); // Assert the type for the onChange callback.
    },
    [config, onChange]
  );

  const hasOption = useMemo(() => {
    return (
      hasTargetLayersDef ||
      hasFilterViewPortDef ||
      hasNumberFormatDef ||
      hasPaddingDef ||
      hasSelectionResponseDef ||
      hasPageSizeDef
    );
  }, [
    hasTargetLayersDef,
    hasFilterViewPortDef,
    hasNumberFormatDef,
    hasPaddingDef,
    hasSelectionResponseDef,
    hasPageSizeDef,
  ]);

  const pageSizeOptions = useMemo(
    () => {
      if (config.type === widgetTypes.Enum.table) {
        return Array.from({ length: 20 }, (_, index) => {
          const value = index + 1;
          return { value, label: String(value) };
        });
      }
      return [10, 25, 50, 100].map((value) => ({ value, label: String(value) }));
    },
    [config.type]
  );

  const selectedPageSize = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawPageSize = Number((config as any)?.options?.page_size || (config.type === widgetTypes.Enum.table ? 10 : 25));
    const clampedPageSize =
      config.type === widgetTypes.Enum.table
        ? Math.max(1, Math.min(20, Number.isFinite(rawPageSize) ? rawPageSize : 10))
        : rawPageSize;
    return pageSizeOptions.find((option) => option.value === clampedPageSize) || pageSizeOptions[0];
  }, [config, pageSizeOptions]);

  return (
    <>
      {hasOption && (
        <>
          <SectionHeader
            active={active}
            alwaysActive
            label={sectionLabel ?? t("options")}
            disableAdvanceOptions
            icon={ICON_NAME.SLIDERS}
          />
          <SectionOptions
            active={active}
            baseOptions={
              <Stack spacing={2}>
                {/* Selection response for chart widgets (filter vs highlight) */}
                {hasSelectionResponseDef && (config as any)?.options?.cross_filter && (
                  <Selector
                    selectedItems={selectedSelectionResponse}
                    setSelectedItems={(item: SelectorItem) => {
                      handleOptionChange("selection_response", item?.value);
                    }}
                    items={selectionResponseOptions}
                    label={t("selection_response")}
                    tooltip={t("selection_response_tooltip")}
                  />
                )}

                {/* Target layers config for multi-layer filtering */}
                {hasTargetLayersDef &&
                  (config.setup as any)?.layer_project_id &&
                  (config.setup as any)?.column_name && (
                    <TargetLayersConfig
                      layerProjectId={(config.setup as any)?.layer_project_id}
                      targetLayers={(config as any)?.options?.target_layers}
                      projectLayers={projectLayers || []}
                      onTargetLayersChange={(targets) => {
                        handleOptionChange("target_layers", targets?.length ? targets : undefined);
                      }}
                    />
                  )}

                {hasFilterViewPortDef && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        color="primary"
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        checked={!!(config as any)?.options?.filter_by_viewport}
                        onChange={(e) => {
                          handleOptionChange("filter_by_viewport", e.target.checked);
                        }}
                      />
                    }
                    label={<Typography variant="body2">{t("filter_viewport")}</Typography>}
                  />
                )}

                {hasNumberFormatDef && config.type !== widgetTypes.Enum.table && (
                  <Stack sx={{ mt: 2 }}>
                    <NumberFormatSelector
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      numberFormat={(config as any)?.options?.format}
                      onNumberFormatChange={(format) => handleOptionChange("format", format)}
                    />
                  </Stack>
                )}

                {hasPageSizeDef && (
                  <Selector
                    selectedItems={selectedPageSize}
                    setSelectedItems={(item: SelectorItem) => {
                      const fallback = config.type === widgetTypes.Enum.table ? 10 : 25;
                      handleOptionChange("page_size", Number(item?.value || fallback));
                    }}
                    items={pageSizeOptions}
                    label={
                      config.type === widgetTypes.Enum.table
                        ? t("rows_shown", { defaultValue: "Rows shown" })
                        : t("rows_per_page", { defaultValue: "Rows per page" })
                    }
                    tooltip={
                      config.type === widgetTypes.Enum.table
                        ? t("rows_shown_tooltip", {
                            defaultValue: "Initial rows shown and load chunk size while scrolling.",
                          })
                        : undefined
                    }
                  />
                )}

                {hasPaddingDef && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        color="primary"
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        checked={!!(config as any)?.options?.has_padding}
                        onChange={(e) => {
                          handleOptionChange("has_padding", e.target.checked);
                        }}
                      />
                    }
                    label={<Typography variant="body2">{t("padding")}</Typography>}
                  />
                )}
              </Stack>
            }
          />
        </>
      )}
    </>
  );
};

export const WidgetStyle = ({ active = true, sectionLabel, config, onChange }: WidgetConfigProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { projectId } = useParams();
  const schema = widgetSchemaMap[config.type];
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [isClickAwayEnabled, setIsClickAwayEnabled] = useState(true);
  const latestConfigRef = useRef(config);

  useEffect(() => {
    latestConfigRef.current = config;
  }, [config]);

  // Check if this widget handles its own style configuration
  const hasCustomStyleHandling = widgetTypesWithCustomStyle.includes(config.type as any);

  const hasColorDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.color");
  }, [schema]);

  const hasHighlightColorDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.highlight_color");
  }, [schema]);

  const hasSelectedColorDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.selected_color");
  }, [schema]);

  const hasColorMapDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.color_map");
  }, [schema]);

  const hasColorRangeDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.color_range");
  }, [schema]);

  const hasCustomOrderDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "setup.custom_order");
  }, [schema]);

  const hasContextLabelDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.context_label");
  }, [schema]);

  const hasPieLayoutDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.layout") && config.type === widgetTypes.Enum.pie_chart;
  }, [schema, config.type]);

  const hasPieChartTypeDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.chart_type") && config.type === widgetTypes.Enum.pie_chart;
  }, [schema, config.type]);

  const hasLabelSizeDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.label_size") && config.type === widgetTypes.Enum.pie_chart;
  }, [schema, config.type]);

  const hasDisplayFieldLabelDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.display_field_label");
  }, [schema]);

  const hasHistogramNumBinsDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.num_bins");
  }, [schema]);

  const hasHistogramXAxisTicksDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.x_axis_ticks");
  }, [schema]);

  const hasHeaderColorDef = useMemo(() => {
    return hasNestedSchemaPath(schema, "options.header_color");
  }, [schema]);

  // Check if we're in highlight mode (for showing selected color option)
  const isHighlightMode = (config as any)?.options?.selection_response === "highlight";
  const isCategoriesChart = config.type === widgetTypes.Enum.categories_chart;
  const isHistogramChart = config.type === widgetTypes.Enum.histogram_chart;

  // Categories chart supports simple single-color and value-based styling
  const supportsAttributeStylingToggle = isCategoriesChart && hasColorDef && hasColorRangeDef;
  const isAttributeStylingEnabled = (config as any)?.options?.attribute_based_styling !== false;
  const showSimpleColorPicker = hasColorDef && (!supportsAttributeStylingToggle || !isAttributeStylingEnabled);
  const valueColorScale = (config as any)?.options?.value_color_scale || "quantile";
  const styleAttributeSource = (config as any)?.options?.style_attribute_source || "statistics";
  const currentChartType = (config as any)?.options?.chart_type || "donut";
  const isFullPieType = currentChartType === pieChartTypes.Values.pie;
  const rawPieLayout = (config as any)?.options?.layout || pieLayoutTypes.Values.center_active;
  // Full pie can't use center_active — fall back to legend (matches Pie.tsx effectiveLayout logic)
  const pieLayout = isFullPieType && rawPieLayout === pieLayoutTypes.Values.center_active
    ? pieLayoutTypes.Values.legend
    : rawPieLayout;

  const valueColorScaleOptions = useMemo(
    () => [
      { value: "quantile", label: t("quantile") },
      { value: "equal_interval", label: t("equal_interval") },
      { value: "standard_deviation", label: t("standard_deviation") },
      { value: "heads_and_tails", label: t("heads_and_tails") },
    ],
    [t]
  );

  const selectedValueColorScale = useMemo(() => {
    return valueColorScaleOptions.find((opt) => opt.value === valueColorScale);
  }, [valueColorScaleOptions, valueColorScale]);

  const styleAttributeSourceOptions = useMemo(() => {
    const options: SelectorItem[] = [];
    const operationValueFieldName = (config?.setup as any)?.operation_value;
    const groupByFieldName = (config?.setup as any)?.group_by_column_name;
    if (operationValueFieldName || (config as any)?.setup?.operation_type === "count") {
      options.push({ value: "statistics", label: t("statistics_field") });
    }
    if (groupByFieldName) {
      options.push({ value: "group_by", label: t("group_by_field") });
    }
    return options;
  }, [config, t]);

  const selectedStyleAttributeSource = useMemo(() => {
    return styleAttributeSourceOptions.find((option) => option.value === styleAttributeSource);
  }, [styleAttributeSourceOptions, styleAttributeSource]);

  const pieLayoutOptions = useMemo(
    () => {
      const allOptions = [
        { value: pieLayoutTypes.Values.center_active, label: t("pie_layout_center_active") },
        { value: pieLayoutTypes.Values.all_labels_outside, label: t("pie_layout_all_labels_outside") },
        { value: pieLayoutTypes.Values.legend, label: t("pie_layout_legend") },
      ];
      // Full pie has no hole, so center_active is not applicable
      if (isFullPieType) {
        return allOptions.filter((o) => o.value !== pieLayoutTypes.Values.center_active);
      }
      return allOptions;
    },
    [t, isFullPieType]
  );

  const selectedPieLayout = useMemo(() => {
    return pieLayoutOptions.find((option) => option.value === pieLayout);
  }, [pieLayoutOptions, pieLayout]);

  const pieChartTypeOptions = useMemo(
    () => [
      { value: pieChartTypes.Values.donut, label: t("pie_chart_type_donut") },
      { value: pieChartTypes.Values.pie, label: t("pie_chart_type_pie") },
      { value: pieChartTypes.Values.half_donut, label: t("pie_chart_type_half_donut") },
    ],
    [t]
  );

  const selectedPieChartType = useMemo(() => {
    const chartType = (config as any)?.options?.chart_type || "donut";
    return pieChartTypeOptions.find((option) => option.value === chartType);
  }, [pieChartTypeOptions, config]);

  const labelSizeOptions = useMemo(
    () => [
      { value: labelSizeTypes.Values.sm, label: t("label_size_sm") },
      { value: labelSizeTypes.Values.md, label: t("label_size_md") },
      { value: labelSizeTypes.Values.lg, label: t("label_size_lg") },
    ],
    [t]
  );

  const selectedLabelSize = useMemo(() => {
    const labelSizeVal = (config as any)?.options?.label_size || "md";
    return labelSizeOptions.find((option) => option.value === labelSizeVal);
  }, [labelSizeOptions, config]);

  const histogramXAxisTickValues = useMemo(() => {
    const values = (config as any)?.options?.x_axis_ticks;
    if (!Array.isArray(values)) return [] as string[];
    return values
      .map((value: unknown) => Number(value))
      .filter((value: number) => Number.isFinite(value))
      .sort((a: number, b: number) => a - b)
      .map((value: number) => String(value));
  }, [config]);

  const [histogramXAxisTickInput, setHistogramXAxisTickInput] = useState("");

  const normalizedHighlightColor = useMemo(() => {
    const currentColor = (config as any)?.options?.highlight_color;
    if (!currentColor) return "#f5b704";
    if (String(currentColor).toLowerCase() === "#3b82f6") return "#f5b704";
    return currentColor;
  }, [config]);

  const usesStatisticsStyleSource = styleAttributeSource === "statistics";
  const usesGroupByStyleSource = styleAttributeSource === "group_by";

  const selectedColorRange = ((config as any)?.options?.color_range || DEFAULT_COLOR_RANGE) as any;

  // Get layer dataset ID for color/order config
  const selectedLayerForStyle = useMemo(() => {
    return (config?.setup as any)?.layer_project_id;
  }, [config?.setup]);

  const selectedLayerDatasetIdForStyle = useLayerDatasetId(
    selectedLayerForStyle as number | undefined,
    projectId as string
  );

  // Get the group_by_column_name for category styling
  const groupByColumnNameForStyle = useMemo(() => {
    return (config?.setup as any)?.group_by_column_name;
  }, [config?.setup]);

  const styleValueCountQueryParams = useMemo(
    () => ({
      size: 100,
      page: 1,
      order: "descendent" as const,
    }),
    []
  );

  const { data: styleValueCountData } = useLayerUniqueValues(
    selectedLayerDatasetIdForStyle || "",
    groupByColumnNameForStyle || "",
    selectedLayerDatasetIdForStyle && groupByColumnNameForStyle ? styleValueCountQueryParams : undefined
  );

  const maxStatisticsColorSteps = useMemo(() => {
    if (!isCategoriesChart || !usesStatisticsStyleSource) {
      return undefined;
    }

    const groupedValueCount = styleValueCountData?.items?.length;
    if (!groupedValueCount || groupedValueCount < 1) {
      return undefined;
    }

    return groupedValueCount;
  }, [isCategoriesChart, usesStatisticsStyleSource, styleValueCountData?.items?.length]);

  // Get layer fields for context label field selection
  const { layerFields: contextLabelFields } = useLayerFields(selectedLayerDatasetIdForStyle || "");

  // Extract options for dependency tracking (text widgets don't have options)
  const configOptions = (config as any)?.options;

  const contextLabel = useMemo(() => {
    return configOptions?.context_label;
  }, [configOptions]);

  const statisticValueFieldName = useMemo(() => {
    return (config?.setup as any)?.operation_value;
  }, [config?.setup]);

  const selectedContextField = useMemo(() => {
    const selectedFieldName = contextLabel?.field || statisticValueFieldName;
    if (!selectedFieldName) return undefined;
    return contextLabelFields.find((f) => f.name === selectedFieldName);
  }, [contextLabel?.field, contextLabelFields, statisticValueFieldName]);

  const handleOptionChange = useCallback(
    (key: string, value: any) => {
      const latestConfig = latestConfigRef.current as any;
      const updatedOptions = {
        ...(latestConfig.options || {}),
        [key]: value,
      };
      onChange({
        ...latestConfig,
        options: updatedOptions,
      } as WidgetConfigSchema);
    },
    [onChange]
  );

  const commitHistogramXAxisTicks = useCallback(
    (values: string[]) => {
      const parsed = values
        .flatMap((value) => String(value).split(/[;,\s]+/))
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value));

      handleOptionChange(
        "x_axis_ticks",
        parsed.length ? Array.from(new Set(parsed)).sort((a, b) => a - b) : undefined
      );
      setHistogramXAxisTickInput("");
    },
    [handleOptionChange]
  );

  const handleSetupChange = useCallback(
    (key: string, value: any) => {
      const latestConfig = latestConfigRef.current as any;
      onChange({
        ...latestConfig,
        setup: {
          ...(latestConfig.setup || {}),
          [key]: value,
        },
      } as WidgetConfigSchema);
    },
    [onChange]
  );

  const hasStyle = useMemo(() => {
    // Skip for widgets that handle their own style configuration
    if (hasCustomStyleHandling) return false;
    return (
      hasColorDef ||
      hasHighlightColorDef ||
      hasSelectedColorDef ||
      hasColorMapDef ||
      hasColorRangeDef ||
      hasCustomOrderDef ||
      hasContextLabelDef ||
      hasPieChartTypeDef ||
      hasLabelSizeDef ||
      hasPieLayoutDef ||
      hasDisplayFieldLabelDef ||
      hasHistogramNumBinsDef ||
      hasHistogramXAxisTicksDef ||
      hasHeaderColorDef
    );
  }, [
    hasColorDef,
    hasHighlightColorDef,
    hasSelectedColorDef,
    hasColorMapDef,
    hasColorRangeDef,
    hasCustomOrderDef,
    hasContextLabelDef,
    hasPieChartTypeDef,
    hasLabelSizeDef,
    hasPieLayoutDef,
    hasDisplayFieldLabelDef,
    hasHistogramNumBinsDef,
    hasHistogramXAxisTicksDef,
    hasHeaderColorDef,
    hasCustomStyleHandling,
  ]);

  return (
    <>
      {hasStyle && (
        <>
          <SectionHeader
            active={active}
            alwaysActive
            label={sectionLabel ?? t("style")}
            disableAdvanceOptions
            icon={ICON_NAME.STYLE}
          />
          <SectionOptions
            active={active}
            baseOptions={
              <Stack spacing={2}>
                {/* Base color for charts */}
                {showSimpleColorPicker && (
                  <WidgetColorPicker
                    label={t("base_color")}
                    color={(config as any)?.options?.color || DEFAULT_WIDGET_COLOR}
                    onChange={(color) => handleOptionChange("color", color)}
                  />
                )}

                {/* Header color for tables */}
                {hasHeaderColorDef && (
                  <WidgetColorPicker
                    label={t("header_color")}
                    color={(config as any)?.options?.header_color || "#ffffff"}
                    onChange={(color) => handleOptionChange("header_color", color)}
                  />
                )}

                {/* Toggle between simple and value-based styling */}
                {supportsAttributeStylingToggle && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        color="primary"
                        checked={isAttributeStylingEnabled}
                        onChange={(e) => {
                          handleOptionChange("attribute_based_styling", e.target.checked);
                        }}
                      />
                    }
                    label={<Typography variant="body2">{t("value_based_styling")}</Typography>}
                  />
                )}

                {supportsAttributeStylingToggle && isAttributeStylingEnabled && (
                  <Selector
                    selectedItems={selectedStyleAttributeSource}
                    setSelectedItems={(item: SelectorItem) => {
                      const nextStyleSource = item?.value || "statistics";

                      if (
                        nextStyleSource === "group_by" &&
                        Array.isArray((config as any)?.setup?.custom_order) &&
                        (config as any).setup.custom_order.length === 0
                      ) {
                        onChange({
                          ...config,
                          setup: {
                            ...((config as any).setup || {}),
                            custom_order: undefined,
                          },
                          options: {
                            ...((config as any).options || {}),
                            style_attribute_source: nextStyleSource,
                          },
                        } as WidgetConfigSchema);
                        return;
                      }

                      handleOptionChange("style_attribute_source", nextStyleSource);
                    }}
                    items={styleAttributeSourceOptions}
                    label={t("styling_field")}
                  />
                )}

                {supportsAttributeStylingToggle && isAttributeStylingEnabled && usesStatisticsStyleSource && (
                  <Selector
                    selectedItems={selectedValueColorScale}
                    setSelectedItems={(item: SelectorItem) => handleOptionChange("value_color_scale", item?.value)}
                    items={valueColorScaleOptions}
                    label={t("color_scale")}
                  />
                )}

                {supportsAttributeStylingToggle &&
                  isAttributeStylingEnabled &&
                  usesStatisticsStyleSource &&
                  hasColorRangeDef &&
                  !isCategoriesChart && (
                  <ArrowPopper
                    open={paletteOpen}
                    placement="bottom"
                    arrow={false}
                    isClickAwayEnabled={isClickAwayEnabled}
                    onClose={() => setPaletteOpen(false)}
                    content={
                      <Paper
                        sx={{
                          py: 3,
                          boxShadow: "rgba(0, 0, 0, 0.16) 0px 6px 12px 0px",
                          width: "235px",
                          maxHeight: "500px",
                        }}>
                        <ColorRangeSelector
                          scaleType={valueColorScale}
                          maxSteps={maxStatisticsColorSteps}
                          selectedColorRange={selectedColorRange}
                          onSelectColorRange={(colorRange) => {
                            handleOptionChange("color_range", colorRange);
                            setPaletteOpen(false);
                          }}
                          setIsBusy={(busy) => setIsClickAwayEnabled(!busy)}
                          setIsOpen={setPaletteOpen}
                        />
                      </Paper>
                    }>
                    <Stack spacing={1}>
                      <Typography variant="body2" color={paletteOpen ? "primary.main" : "text.primary"}>
                        {t("palette")}
                      </Typography>
                      <Stack
                        onClick={() => setPaletteOpen(!paletteOpen)}
                        direction="row"
                        alignItems="center"
                        sx={{
                          borderRadius: theme.spacing(1.2),
                          border: "1px solid",
                          outline: "2px solid transparent",
                          minHeight: "40px",
                          borderColor: pickerBorderColor(theme),
                          ...(paletteOpen && {
                            outline: `2px solid ${theme.palette.primary.main}`,
                          }),
                          cursor: "pointer",
                          p: 2,
                          "&:hover": {
                            ...(!paletteOpen && {
                              borderColor: pickerBorderHoverColor(theme),
                            }),
                          },
                        }}>
                        <ColorPalette colors={selectedColorRange?.colors || []} />
                      </Stack>
                    </Stack>
                  </ArrowPopper>
                )}

                {/* Hover color - always visible when defined */}
                {hasHighlightColorDef && (
                  <WidgetColorPicker
                    label={t("highlight_color")}
                    color={normalizedHighlightColor}
                    onChange={(color) => handleOptionChange("highlight_color", color)}
                  />
                )}

                {hasPieChartTypeDef && (
                  <Selector
                    selectedItems={selectedPieChartType}
                    setSelectedItems={(item: SelectorItem) => {
                      handleOptionChange("chart_type", item?.value);
                    }}
                    items={pieChartTypeOptions}
                    label={t("pie_chart_type")}
                  />
                )}

                {hasLabelSizeDef && (
                  <Selector
                    selectedItems={selectedLabelSize}
                    setSelectedItems={(item: SelectorItem) => {
                      handleOptionChange("label_size", item?.value);
                    }}
                    items={labelSizeOptions}
                    label={t("label_size")}
                  />
                )}

                {hasPieLayoutDef && (
                  <Selector
                    selectedItems={selectedPieLayout}
                    setSelectedItems={(item: SelectorItem) => {
                      handleOptionChange("layout", item?.value);
                    }}
                    items={pieLayoutOptions}
                    label={t("layout")}
                  />
                )}

                {hasDisplayFieldLabelDef && (
                  <TextFieldInput
                    type="text"
                    label={t("field_display_name")}
                    placeholder={t("field_display_name_placeholder")}
                    clearable
                    value={(config as any)?.options?.display_field_label || ""}
                    onChange={(value: string) => {
                      handleOptionChange("display_field_label", value || undefined);
                    }}
                  />
                )}

                {isHistogramChart && hasHistogramNumBinsDef && (
                  <TextFieldInput
                    type="number"
                    label={t("number_of_bins")}
                    clearable={false}
                    value={String((config as any)?.options?.num_bins || 10)}
                    onChange={(value: string) => {
                      const parsed = Number.parseInt(value, 10);
                      const sanitized = Number.isFinite(parsed)
                        ? Math.min(20, Math.max(1, parsed))
                        : 10;
                      handleOptionChange("num_bins", sanitized);
                    }}
                  />
                )}

                {isHistogramChart && hasHistogramXAxisTicksDef && (
                  <Stack spacing={0.5}>
                    <FormLabelHelper
                      label={t("x_axis_tick_values")}
                      tooltip={t("x_axis_tick_values_help")}
                      color="inherit"
                    />
                    <Autocomplete
                      multiple
                      freeSolo
                      size="small"
                      options={[]}
                      value={histogramXAxisTickValues}
                      inputValue={histogramXAxisTickInput}
                      filterSelectedOptions
                      onInputChange={(_, value) => {
                        setHistogramXAxisTickInput(value);
                      }}
                      onChange={(_, values) => {
                        commitHistogramXAxisTicks(values as string[]);
                      }}
                      renderTags={(value, getTagProps) =>
                        value.map((option, index) => {
                          const { key, ...tagProps } = getTagProps({ index });
                          return <Chip key={key} label={option} size="small" {...tagProps} />;
                        })
                      }
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          size="small"
                          placeholder={t("x_axis_tick_values_placeholder")}
                          onKeyDown={(event) => {
                            if (
                              (event.key === "Enter" || event.key === ",") &&
                              histogramXAxisTickInput.trim()
                            ) {
                              event.preventDefault();
                              commitHistogramXAxisTicks([
                                ...histogramXAxisTickValues,
                                histogramXAxisTickInput,
                              ]);
                            }
                          }}
                          onBlur={() => {
                            const pendingInput = histogramXAxisTickInput.trim();
                            if (!pendingInput) return;

                            commitHistogramXAxisTicks([
                              ...histogramXAxisTickValues,
                              pendingInput,
                            ]);
                          }}
                        />
                      )}
                    />
                  </Stack>
                )}

                {/* Selection color - only shown when selection_response is "highlight" */}
                {hasSelectedColorDef && isHighlightMode && (
                  <WidgetColorPicker
                    label={t("selected_color")}
                    color={(config as any)?.options?.selected_color || "#9333EA"}
                    onChange={(color) => handleOptionChange("selected_color", color)}
                  />
                )}

                {/* Category order + colors for charts (integrated like layer styling ordinal) */}
                {hasColorMapDef &&
                  hasCustomOrderDef &&
                  isAttributeStylingEnabled &&
                  (!isCategoriesChart || usesGroupByStyleSource || usesStatisticsStyleSource) &&
                  selectedLayerDatasetIdForStyle &&
                  groupByColumnNameForStyle && (
                    <CategoryColorConfig
                      layerId={selectedLayerDatasetIdForStyle}
                      fieldName={groupByColumnNameForStyle}
                      customOrder={(config as any)?.setup?.custom_order}
                      colorMap={(config as any)?.options?.color_map}
                      labelMap={(config as any)?.options?.label_map}
                      colorRange={(config as any)?.options?.color_range}
                      colorPalette={(config as any)?.options?.color_range?.colors}
                      onChange={(order, colorMap, labelMap) => {
                        // Update setup.custom_order + options.color_map + options.label_map atomically
                        onChange({
                          ...config,
                          setup: {
                            ...((config as any).setup || {}),
                            custom_order: order,
                          },
                          options: {
                            ...((config as any).options || {}),
                            color_map: colorMap,
                            label_map: labelMap,
                          },
                        } as WidgetConfigSchema);
                      }}
                      onPaletteChange={(colorRange, order, colorMap, labelMap) => {
                        // Update color_range, custom_order, color_map and label_map atomically
                        onChange({
                          ...config,
                          setup: {
                            ...((config as any).setup || {}),
                            custom_order: order,
                          },
                          options: {
                            ...((config as any).options || {}),
                            color_range: colorRange,
                            color_map: colorMap,
                            label_map: labelMap,
                          },
                        } as WidgetConfigSchema);
                      }}
                    />
                  )}

                {/* Category order only (no color picking) - for widgets with custom_order but no color_map */}
                {hasCustomOrderDef &&
                  !hasColorMapDef &&
                  isAttributeStylingEnabled &&
                  (!isCategoriesChart || usesGroupByStyleSource) &&
                  selectedLayerDatasetIdForStyle &&
                  groupByColumnNameForStyle && (
                    <CategoryOrderConfig
                      layerId={selectedLayerDatasetIdForStyle}
                      fieldName={groupByColumnNameForStyle}
                      customOrder={(config as any)?.setup?.custom_order}
                      onOrderChange={(order) => {
                        handleSetupChange("custom_order", order.length ? order : undefined);
                      }}
                    />
                  )}

                {/* Context label configuration (disabled for pie charts) */}
                {hasContextLabelDef &&
                  selectedLayerDatasetIdForStyle &&
                  !isCategoriesChart &&
                  config.type !== widgetTypes.Enum.pie_chart && (
                  <>
                    <LayerFieldSelector
                      fields={contextLabelFields}
                      selectedField={selectedContextField}
                      setSelectedField={(field) => {
                        handleOptionChange(
                          "context_label",
                          field?.name
                            ? { field: field.name, default_value: contextLabel?.default_value }
                            : undefined
                        );
                      }}
                      label={t("context_field")}
                      tooltip={t("context_field_tooltip")}
                    />
                    {contextLabel?.field && (
                      <TextFieldInput
                        type="text"
                        label={t("default_label")}
                        placeholder={t("default_label_placeholder")}
                        clearable
                        value={contextLabel?.default_value || ""}
                        onChange={(value: string) => {
                          handleOptionChange("context_label", {
                            field: contextLabel.field,
                            default_value: value || undefined,
                          });
                        }}
                        tooltip={t("default_label_tooltip")}
                      />
                    )}
                  </>
                )}
              </Stack>
            }
          />
        </>
      )}
    </>
  );
};
