import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ClearIcon from "@mui/icons-material/Clear";
import EditIcon from "@mui/icons-material/Edit";
import FilterAltIcon from "@mui/icons-material/FilterAlt";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import { Box, Button, Chip, IconButton, Popover, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { previewSql } from "@/lib/api/expressions";
import { apiRequestAuth } from "@/lib/api/fetcher";
import { useDatasetCollectionItems } from "@/lib/api/layers";
import { PROCESSES_API_BASE_URL } from "@/lib/api/processes";
import { isCustomRow } from "@/lib/filter/model";
import { usePublicProjectId } from "@/lib/providers/PublicProjectProvider";
import { appendUniqueFeatures } from "@/lib/utils/features";
import { formatNumber } from "@/lib/utils/format-number";
import { formatFieldValue } from "@/lib/utils/formatFieldValue";
import { resolveProjectLayer } from "@/lib/utils/map/layer";
import type { FieldKind } from "@/lib/validations/layer";
import { resolveDisplayKind } from "@/lib/validations/layer";
import type { DatasetCollectionItems, GetCollectionItemsQueryParams } from "@/lib/validations/layer";
import type { AggregationStatsQueryParams, ProjectLayer } from "@/lib/validations/project";
import { aggregationStatsQueryParams } from "@/lib/validations/project";
import {
  type TableDataSchema,
  tableDataConfigSchema,
  tableModeTypes,
  tableQueryModeTypes,
} from "@/lib/validations/widget";
import type { FormatNumberTypes } from "@/lib/validations/widget";

import useLayerFields from "@/hooks/map/CommonHooks";
import { useChartWidget } from "@/hooks/map/DashboardBuilderHooks";
import { useFilterFields } from "@/hooks/map/useFilterFields";
import { combineCqlFilters, useTableViewFilterController } from "@/hooks/useTableViewFilterController";

import { NumberFormatSelector } from "@/components/builder/widgets/common/WidgetCommonConfigs";
import { WidgetStatusContainer } from "@/components/builder/widgets/common/WidgetStatusContainer";
import WidgetAggregateTable from "@/components/builder/widgets/data/WidgetAggregateTable";
import FeatureTable from "@/components/common/FeatureTable";
import { fieldIndicatorKind } from "@/components/common/FieldKindIcon";
import ColumnFilterPopover, { canFilterColumn } from "@/components/map/panels/ColumnFilterPopover";
import { rowSentence } from "@/components/map/panels/filter/ConditionRow";

interface TableDataWidgetProps {
  widgetId: string;
  config: TableDataSchema;
  projectLayers: ProjectLayer[];
  viewOnly?: boolean;
  onConfigChange?: (nextConfig: TableDataSchema) => void;
}

type GroupedMetricConfig = {
  operation_type: NonNullable<TableDataSchema["setup"]["operation_type"]>;
  operation_value?: string;
  label?: string;
};

type GroupedRow = {
  grouped_value: string;
  grouped_secondary_value?: string;
  metrics: number[];
};

export const TableDataWidget = ({
  widgetId,
  config: rawConfig,
  projectLayers,
  viewOnly,
  onConfigChange,
}: TableDataWidgetProps) => {
  const { t, i18n } = useTranslation("common");
  const { config, queryParams, cqlFilter, layerId, isLayerLocked } = useChartWidget(
    rawConfig,
    tableDataConfigSchema,
    aggregationStatsQueryParams
  );
  const rowsShownSetting = Math.max(1, Math.min(20, Number(config?.options?.page_size ?? 10)));

  const queryMode = config?.setup?.query_mode ?? tableQueryModeTypes.Values.builder;
  const isSqlMode = queryMode === tableQueryModeTypes.Values.sql;
  const mode = config?.setup?.mode ?? tableModeTypes.Values.records;
  const isGroupedMode = mode === tableModeTypes.Values.grouped;
  const stickyHeaderEnabled = (config?.options?.sticky_header ?? true) === true;
  // Viewer-facing column actions, both opt-out.
  const sortingEnabled = (config?.options?.show_sort_action ?? true) === true;
  const filteringEnabled = (config?.options?.show_filter_action ?? true) === true;
  const headerColor = config?.options?.header_color;

  const secondaryGroupByColumn = config?.setup?.group_by_secondary_column_name;
  const hasSecondaryGroup = isGroupedMode && !!secondaryGroupByColumn;
  const groupedDisplayMode = config?.setup?.grouped_display_mode ?? "flat";
  const isCollapsibleMode = hasSecondaryGroup && groupedDisplayMode === "collapsible";
  const collapseInitial = config?.setup?.grouped_collapse_initial ?? "collapsed";
  const showSubtotals = config?.setup?.grouped_show_subtotals !== false;

  const [recordsPage, setRecordsPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(rowsShownSetting);
  const [recordsAccumulatedData, setRecordsAccumulatedData] = useState<DatasetCollectionItems | undefined>(
    undefined
  );
  const [recordsHasMore, setRecordsHasMore] = useState(true);
  const [groupedVisibleCount, setGroupedVisibleCount] = useState(rowsShownSetting);
  const [groupedRows, setGroupedRows] = useState<GroupedRow[]>([]);
  const [isGroupedLoading, setIsGroupedLoading] = useState(false);
  const [groupedError, setGroupedError] = useState<string | null>(null);
  const [sqlRows, setSqlRows] = useState<Array<Record<string, unknown>>>([]);
  const [sqlColumns, setSqlColumns] = useState<Array<{ name: string; type: string }>>([]);
  const [sqlPage, setSqlPage] = useState(0);
  const [sqlHasMore, setSqlHasMore] = useState(true);
  const [isSqlLoading, setIsSqlLoading] = useState(false);
  const [isSqlNextPagePending, setIsSqlNextPagePending] = useState(false);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [recordsColumnWidths, setRecordsColumnWidths] = useState<Record<string, number>>({});
  const [groupedColumnWidths, setGroupedColumnWidths] = useState<Record<string, number>>({});
  const [sqlColumnWidths, setSqlColumnWidths] = useState<Record<string, number>>({});
  const [isRecordsOverflowing, setIsRecordsOverflowing] = useState(false);
  const [isGroupedOverflowing, setIsGroupedOverflowing] = useState(false);
  const [isSqlOverflowing, setIsSqlOverflowing] = useState(false);
  const [areWidthsHydrated, setAreWidthsHydrated] = useState(false);
  const [isResizingColumns, setIsResizingColumns] = useState(false);
  const [columnEditAnchorEl, setColumnEditAnchorEl] = useState<HTMLElement | null>(null);
  const [columnEditHeaderKey, setColumnEditHeaderKey] = useState<string | null>(null);
  const [columnEditLabel, setColumnEditLabel] = useState("");
  const [columnEditFormat, setColumnEditFormat] = useState<FormatNumberTypes | undefined>(undefined);
  const [columnEditIsNumeric, setColumnEditIsNumeric] = useState(false);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [interactiveSort, setInteractiveSort] = useState<{
    column: string;
    direction: "asc" | "desc";
  } | null>(null);

  const recordsScrollRef = useRef<HTMLDivElement | null>(null);
  const groupedScrollRef = useRef<HTMLDivElement | null>(null);
  const sqlScrollRef = useRef<HTMLDivElement | null>(null);
  const lastSqlQuerySignatureRef = useRef("");
  const activeResizeRef = useRef<{
    tableType: "records" | "grouped" | "sql";
    columnKey: string;
    startX: number;
    startWidth: number;
  } | null>(null);

  const twoLineClampSx = useMemo(
    () => ({
      display: "-webkit-box",
      WebkitLineClamp: 2,
      WebkitBoxOrient: "vertical" as const,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "normal",
      wordBreak: "break-word",
      lineHeight: 1.25,
      maxHeight: "2.5em",
    }),
    []
  );

  useEffect(() => {
    setRowsPerPage(rowsShownSetting);
  }, [rowsShownSetting]);

  useEffect(() => {
    setGroupedVisibleCount(rowsShownSetting);
  }, [rowsShownSetting]);

  useEffect(() => {
    setInteractiveSort(null);
  }, [config?.setup?.layer_project_id, config?.setup?.query_mode, mode]);

  // D7: resolved the same locked-refusing way as `useChartWidget`'s own
  // `layerId` below — `projectLayers` here is the widget's own prop, a
  // second, independent lookup of `layer_project_id` that must not leak a
  // locked layer's dataset id through the "prefer the prop" fallback.
  const selectedLayerId = useMemo(
    () => resolveProjectLayer(projectLayers, config?.setup?.layer_project_id).layerId,
    [projectLayers, config?.setup?.layer_project_id]
  );

  // Prefer explicit selected layer from props, but fall back to hook-resolved layer id.
  // This avoids SQL mode becoming "not configured" when projectLayers is temporarily stale.
  const recordsLayerId = selectedLayerId || layerId;

  // In a public view the viewer is anonymous; preview-sql runs for them only
  // as this published project's own saved query, so the request names it.
  const publicProjectId = usePublicProjectId();

  const tableMetrics = useMemo(() => {
    if (!isGroupedMode || isSqlMode) return [] as GroupedMetricConfig[];

    const metrics: GroupedMetricConfig[] = [];

    if (config?.setup?.operation_type) {
      metrics.push({
        operation_type: config.setup.operation_type,
        operation_value: config.setup.operation_value,
      });
    }

    const additionalMetrics = config?.setup?.additional_metrics || [];
    additionalMetrics.forEach((metric) => {
      if (!metric.operation_type) return;
      metrics.push({
        operation_type: metric.operation_type,
        operation_value: metric.operation_value,
        label: metric.label,
      });
    });

    return metrics;
  }, [
    config?.setup?.additional_metrics,
    config?.setup?.operation_type,
    config?.setup?.operation_value,
    isGroupedMode,
    isSqlMode,
  ]);

  const groupedMetricLabels = useMemo(() => {
    return tableMetrics.map((metric, index) => {
      if (index === 0) {
        if (config?.setup?.primary_metric_label) return config.setup.primary_metric_label;
        const operationValue = config?.setup?.operation_value;
        if (operationValue) return operationValue;
        const operationType = config?.setup?.operation_type;
        if (!operationType) return t("value", { defaultValue: "Value" });
        if (operationType === "expression") return t("expression", { defaultValue: "Expression" });
        return operationType.toUpperCase();
      }
      if (metric.label) return metric.label;
      if (metric.operation_value) return metric.operation_value;
      if (metric.operation_type === "expression") return t("expression", { defaultValue: "Expression" });
      return metric.operation_type.toUpperCase();
    });
  }, [
    config?.setup?.operation_type,
    config?.setup?.operation_value,
    config?.setup?.primary_metric_label,
    t,
    tableMetrics,
  ]);

  const { layerFields, isLoading: areFieldsLoading } = useLayerFields(recordsLayerId || "");

  // The fields as the filter writes them (a date told from a moment).
  const { fields: filterFields } = useFilterFields(recordsLayerId || "");

  // A dashboard has no Filter panel, so a viewer's column filters live in view
  // state and are ANDed onto whatever the author configured.
  const {
    controller: viewFilterController,
    cqlFilter: viewCqlFilter,
    clear: clearViewFilters,
  } = useTableViewFilterController(filterFields);
  const [filterColumn, setFilterColumn] = useState<string | null>(null);
  const [filterAnchorEl, setFilterAnchorEl] = useState<HTMLElement | null>(null);

  // A filter written for one layer means nothing on the next one. Dropping the
  // filter action has to clear them too, or the chips and the menu both
  // disappear and the viewer cannot undo what they applied.
  useEffect(() => {
    clearViewFilters();
  }, [config?.setup?.layer_project_id, config?.setup?.query_mode, mode, filteringEnabled, clearViewFilters]);

  const visibleFields = useMemo(() => {
    const selectedVisibleColumns = config?.setup?.visible_columns;
    if (!selectedVisibleColumns || selectedVisibleColumns.length === 0) return [];
    const fieldMap = new Map(layerFields.map((field) => [field.name, field]));
    return selectedVisibleColumns
      .map((name) => fieldMap.get(name))
      .filter((field): field is (typeof layerFields)[number] => Boolean(field));
  }, [layerFields, config?.setup?.visible_columns]);

  const isRecordsColumnsConfigured = visibleFields.length > 0;

  const recordNumericFieldNames = useMemo(() => {
    return new Set(visibleFields.filter((f) => f.type === "number").map((f) => f.name));
  }, [visibleFields]);

  // Field kind + display_config per column, for kind-aware value formatting
  // (datetime/boolean) of record cells and grouped labels.
  const fieldMetaByName = useMemo(() => {
    const meta: Record<string, { kind?: string; display_config?: Record<string, unknown> }> = {};
    for (const f of layerFields) {
      meta[f.name] = { kind: resolveDisplayKind(f), display_config: f.display_config };
    }
    return meta;
  }, [layerFields]);

  const formatByKind = useCallback(
    (columnKey: string, value: unknown): string | null => {
      const meta = fieldMetaByName[columnKey];
      if (!meta?.kind || meta.kind === "string" || meta.kind === "number") return null;
      if (value === null || value === undefined || typeof value === "object") return null;
      return formatFieldValue(value, meta.kind as FieldKind, meta.display_config ?? {});
    },
    [fieldMetaByName]
  );

  const recordsQueryParams = useMemo(() => {
    if (!recordsLayerId || isGroupedMode || isSqlMode || !isRecordsColumnsConfigured) return undefined;

    const params: GetCollectionItemsQueryParams = {
      limit: rowsPerPage,
      offset: recordsPage * rowsPerPage,
    };

    // Cross-filter (built by useChartWidget independently of query schema
    // validation), plus any column filters the viewer applied here.
    const combined = combineCqlFilters(cqlFilter, viewCqlFilter);
    if (combined) {
      params.filter = combined;
    }

    const configuredSortBy = config?.options?.sort_by;
    const isGroupedOnlySortKey =
      typeof configuredSortBy === "string" &&
      (configuredSortBy === "grouped_value" || configuredSortBy.startsWith("metric_"));

    const activeSortColumn =
      interactiveSort?.column ??
      (!isGroupedOnlySortKey && configuredSortBy ? configuredSortBy : visibleFields[0]?.name);
    const activeSortDirection = interactiveSort?.direction ?? config?.options?.sorting ?? "desc";

    if (activeSortColumn) {
      params.sortby = `${activeSortDirection === "desc" ? "-" : ""}${activeSortColumn}`;
    }

    return params;
  }, [
    recordsLayerId,
    isGroupedMode,
    isSqlMode,
    rowsPerPage,
    recordsPage,
    cqlFilter,
    viewCqlFilter,
    config?.options?.sort_by,
    config?.options?.sorting,
    interactiveSort,
    visibleFields,
    isRecordsColumnsConfigured,
  ]);

  const {
    data: recordsData,
    isLoading: isRecordsLoading,
    isError: isRecordsError,
  } = useDatasetCollectionItems(recordsLayerId || "", recordsQueryParams);

  const recordsQuerySignature = useMemo(() => {
    const sortBy = interactiveSort?.column ?? config?.options?.sort_by ?? "";
    const sorting = interactiveSort?.direction ?? config?.options?.sorting ?? "desc";
    return `${recordsLayerId || ""}|${rowsPerPage}|${sortBy}|${sorting}|${isGroupedMode}|${isSqlMode}|${cqlFilter || ""}|${viewCqlFilter || ""}`;
  }, [
    config?.options?.sort_by,
    config?.options?.sorting,
    interactiveSort,
    isGroupedMode,
    isSqlMode,
    cqlFilter,
    viewCqlFilter,
    recordsLayerId,
    rowsPerPage,
  ]);

  useEffect(() => {
    setRecordsPage(0);
    setRecordsAccumulatedData(undefined);
    setRecordsHasMore(true);
  }, [recordsQuerySignature]);

  useEffect(() => {
    if (!recordsData || isGroupedMode || isSqlMode) return;

    if (recordsPage === 0) {
      setRecordsAccumulatedData(recordsData);
      setRecordsHasMore(recordsData.features.length >= rowsPerPage);
      return;
    }

    setRecordsAccumulatedData((previous) => {
      if (!previous) return recordsData;
      // recordsPage advances before SWR has the matching payload, so this can
      // run while recordsData is still the page already accumulated.
      const features = appendUniqueFeatures(previous.features, recordsData.features);
      return { ...recordsData, features, numberReturned: features.length };
    });
    setRecordsHasMore(recordsData.features.length >= rowsPerPage);
  }, [isGroupedMode, isSqlMode, recordsData, recordsPage, rowsPerPage]);

  useEffect(() => {
    let isCancelled = false;

    async function loadGroupedRows() {
      if (!isGroupedMode || isSqlMode || !layerId || tableMetrics.length === 0) {
        if (!isCancelled) {
          setGroupedRows([]);
          setGroupedError(null);
          setIsGroupedLoading(false);
        }
        return;
      }

      setIsGroupedLoading(true);
      setGroupedError(null);

      try {
        const aggregationQuery = queryParams as AggregationStatsQueryParams | undefined;
        const size = 5000;
        const order = config?.options?.sorting === "asc" ? "ascendent" : "descendent";
        const filter = aggregationQuery?.query;
        const groupByColumn = config?.setup?.group_by_column_name || aggregationQuery?.group_by_column_name;

        const responses = await Promise.all(
          tableMetrics.map(async (metric) => {
            const inputs: Record<string, unknown> = {
              collection: layerId,
              operation: metric.operation_type,
              operation_column: metric.operation_value,
              group_by_column: groupByColumn,
              limit: size,
              order,
              filter,
            };

            if (secondaryGroupByColumn) {
              inputs.group_by_secondary_column = secondaryGroupByColumn;
            }

            if (!metric.operation_value) {
              delete inputs.operation_column;
            }

            const response = await apiRequestAuth(`${PROCESSES_API_BASE_URL}/aggregation-stats/execution`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ inputs }),
            });

            if (!response.ok) {
              const error = await response.json();
              throw new Error(error.detail?.detail || error.detail || "Failed to get aggregation stats");
            }

            const result = await response.json();
            return (result.items || []) as Array<{
              grouped_value: string;
              grouped_secondary_value?: string;
              operation_value: number;
            }>;
          })
        );

        if (isCancelled) return;

        if (secondaryGroupByColumn) {
          // Two-level grouping: build composite key from primary + secondary
          const groupedMap = new Map<string, number[]>();
          const secondaryMap = new Map<string, string>();

          responses.forEach((items, metricIndex) => {
            items.forEach((item) => {
              const primary = String(item.grouped_value ?? "-");
              const secondary = String(item.grouped_secondary_value ?? "-");
              const compositeKey = `${primary}\x00${secondary}`;
              if (!groupedMap.has(compositeKey)) {
                groupedMap.set(compositeKey, new Array(tableMetrics.length).fill(0));
                secondaryMap.set(compositeKey, secondary);
              }
              const values = groupedMap.get(compositeKey)!;
              values[metricIndex] = item.operation_value ?? 0;
            });
          });

          setGroupedRows(
            Array.from(groupedMap.entries()).map(([compositeKey, metrics]) => {
              const primary = compositeKey.split("\x00")[0];
              return {
                grouped_value: primary,
                grouped_secondary_value: secondaryMap.get(compositeKey),
                metrics,
              };
            })
          );
        } else {
          const groupedMap = new Map<string, number[]>();

          responses.forEach((items, metricIndex) => {
            items.forEach((item) => {
              const groupedValue = String(item.grouped_value ?? "-");
              if (!groupedMap.has(groupedValue)) {
                groupedMap.set(groupedValue, new Array(tableMetrics.length).fill(0));
              }
              const values = groupedMap.get(groupedValue)!;
              values[metricIndex] = item.operation_value ?? 0;
            });
          });

          setGroupedRows(
            Array.from(groupedMap.entries()).map(([grouped_value, metrics]) => ({ grouped_value, metrics }))
          );
        }
      } catch (error) {
        if (!isCancelled) {
          setGroupedRows([]);
          setGroupedError(error instanceof Error ? error.message : "Failed to load grouped table data");
        }
      } finally {
        if (!isCancelled) {
          setIsGroupedLoading(false);
        }
      }
    }

    void loadGroupedRows();

    return () => {
      isCancelled = true;
    };
  }, [
    config?.options?.sorting,
    config?.setup?.group_by_column_name,
    isGroupedMode,
    isSqlMode,
    layerId,
    queryParams,
    secondaryGroupByColumn,
    tableMetrics,
  ]);

  const sqlQuerySignature = useMemo(() => {
    return `${recordsLayerId || ""}|${config?.setup?.sql_query || ""}|${rowsPerPage}|${isSqlMode}|${cqlFilter || ""}`;
  }, [config?.setup?.sql_query, isSqlMode, recordsLayerId, rowsPerPage, cqlFilter]);

  useEffect(() => {
    setSqlPage(0);
    setSqlHasMore(true);
    setSqlRows([]);
    setIsSqlNextPagePending(false);
  }, [sqlQuerySignature]);
  useEffect(() => {
    let isCancelled = false;

    async function loadSqlPreview() {
      const currentSqlQuerySignature = sqlQuerySignature;

      if (!isSqlMode || !recordsLayerId || !config?.setup?.sql_query) {
        lastSqlQuerySignatureRef.current = currentSqlQuerySignature;
        if (!isCancelled) {
          setSqlPage(0);
          setSqlHasMore(true);
          setSqlRows([]);
          setSqlColumns([]);
          setSqlError(null);
          setIsSqlLoading(false);
        }
        return;
      }

      if (sqlPage > 0 && currentSqlQuerySignature !== lastSqlQuerySignatureRef.current) {
        return;
      }

      lastSqlQuerySignatureRef.current = currentSqlQuerySignature;

      setIsSqlLoading(true);
      setSqlError(null);

      try {
        const sqlAlias = "input_1";
        const pageOffset = sqlPage * rowsPerPage;
        const result = await previewSql({
          sql_query: config.setup.sql_query,
          layers: { [sqlAlias]: recordsLayerId },
          limit: rowsPerPage,
          offset: pageOffset,
          filter_expr: cqlFilter ?? null,
          project_id: publicProjectId ?? undefined,
        });

        if (isCancelled) return;

        setSqlColumns((previous) =>
          sqlPage === 0 || previous.length === 0 ? result.columns || [] : previous
        );

        const incomingRows = (result.rows || []).map((row) => row.values || {});
        setSqlRows((previous) => (sqlPage === 0 ? incomingRows : [...previous, ...incomingRows]));

        setSqlHasMore(result.has_more ?? incomingRows.length >= rowsPerPage);
      } catch (error) {
        if (!isCancelled) {
          setSqlRows([]);
          setSqlColumns([]);
          setSqlHasMore(false);
          setSqlError(error instanceof Error ? error.message : "Failed to preview SQL");
        }
      } finally {
        if (!isCancelled) {
          setIsSqlLoading(false);
          setIsSqlNextPagePending(false);
        }
      }
    }

    void loadSqlPreview();

    return () => {
      isCancelled = true;
    };
  }, [
    config?.setup?.sql_query,
    publicProjectId,
    isSqlMode,
    recordsLayerId,
    rowsPerPage,
    sqlPage,
    sqlQuerySignature,
  ]);

  const startColumnResize = useCallback(
    (event: React.MouseEvent, tableType: "records" | "grouped" | "sql", columnKey: string) => {
      event.preventDefault();
      event.stopPropagation();

      const widthMap =
        tableType === "records"
          ? recordsColumnWidths
          : tableType === "grouped"
            ? groupedColumnWidths
            : sqlColumnWidths;
      const currentRenderedWidth = (
        event.currentTarget.parentElement as HTMLElement | null
      )?.getBoundingClientRect().width;
      activeResizeRef.current = {
        tableType,
        columnKey,
        startX: event.clientX,
        startWidth: widthMap[columnKey] ?? currentRenderedWidth ?? 140,
      };
      setIsResizingColumns(true);
    },
    [groupedColumnWidths, recordsColumnWidths, sqlColumnWidths]
  );

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const activeResize = activeResizeRef.current;
      if (!activeResize) return;

      const nextWidth = Math.max(
        0,
        Math.min(900, activeResize.startWidth + (event.clientX - activeResize.startX))
      );
      if (activeResize.tableType === "records") {
        setRecordsColumnWidths((previous) => ({
          ...previous,
          [activeResize.columnKey]: nextWidth,
        }));
      } else if (activeResize.tableType === "grouped") {
        setGroupedColumnWidths((previous) => ({
          ...previous,
          [activeResize.columnKey]: nextWidth,
        }));
      } else {
        setSqlColumnWidths((previous) => ({
          ...previous,
          [activeResize.columnKey]: nextWidth,
        }));
      }
    };

    const handleMouseUp = () => {
      activeResizeRef.current = null;
      setIsResizingColumns(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const sortedGroupedRows = useMemo(() => {
    const items = groupedRows;
    const sortByRaw = config?.options?.sort_by;
    const sortBy =
      interactiveSort?.column ??
      (sortByRaw === "grouped_value" || sortByRaw === "grouped_secondary_value"
        ? sortByRaw
        : sortByRaw || "metric_0");
    const sorting = interactiveSort?.direction ?? config?.options?.sorting ?? "desc";

    return [...items].sort((left, right) => {
      const direction = sorting === "asc" ? 1 : -1;
      if (sortBy === "grouped_value") {
        return (
          String(left.grouped_value).localeCompare(String(right.grouped_value), i18n.language, {
            numeric: true,
            sensitivity: "base",
          }) * direction
        );
      }
      if (sortBy === "grouped_secondary_value") {
        return (
          String(left.grouped_secondary_value ?? "-").localeCompare(
            String(right.grouped_secondary_value ?? "-"),
            i18n.language,
            { numeric: true, sensitivity: "base" }
          ) * direction
        );
      }
      const metricIndex = Number(sortBy.replace("metric_", ""));
      const leftMetric = left.metrics[Number.isNaN(metricIndex) ? 0 : metricIndex] ?? 0;
      const rightMetric = right.metrics[Number.isNaN(metricIndex) ? 0 : metricIndex] ?? 0;
      return (leftMetric - rightMetric) * direction;
    });
  }, [groupedRows, config?.options?.sort_by, config?.options?.sorting, interactiveSort, i18n.language]);

  useEffect(() => {
    // Grouped rows are already fully fetched; render the full list to keep both table views consistent.
    setGroupedVisibleCount(sortedGroupedRows.length);
  }, [sortedGroupedRows.length]);

  const recordColumnMenuItems = useCallback(
    (fieldName: string) => {
      const isSorted = interactiveSort?.column === fieldName;
      return [
        ...(!sortingEnabled
          ? []
          : [
              {
                key: "sort-asc",
                label: t("sort_asc"),
                icon: <ArrowUpwardIcon />,
                onSelect: () => setInteractiveSort({ column: fieldName, direction: "asc" }),
              },
              {
                key: "sort-desc",
                label: t("sort_desc"),
                icon: <ArrowDownwardIcon />,
                onSelect: () => setInteractiveSort({ column: fieldName, direction: "desc" }),
              },
              ...(isSorted
                ? [
                    {
                      key: "sort-clear",
                      label: t("clear_sorting", { defaultValue: "Clear sorting" }),
                      icon: <ClearIcon />,
                      onSelect: () => setInteractiveSort(null),
                    },
                  ]
                : []),
            ]),
        ...(!filteringEnabled || !canFilterColumn(viewFilterController, fieldName)
          ? []
          : [
              {
                key: "filter",
                label: viewFilterController.model.rows.some(
                  (row) => !isCustomRow(row) && row.field === fieldName
                )
                  ? t("edit_filter", { defaultValue: "Edit filter" })
                  : t("add_filter", { defaultValue: "Add filter" }),
                icon: <FilterAltIcon />,
                dividerBefore: sortingEnabled,
                onSelect: (anchorEl: HTMLElement) => {
                  setFilterAnchorEl(anchorEl);
                  setFilterColumn(fieldName);
                },
              },
            ]),
      ];
    },
    [interactiveSort, t, viewFilterController, sortingEnabled, filteringEnabled]
  );

  const handleInteractiveSortClick = useCallback((columnKey: string) => {
    setInteractiveSort((prev) => {
      if (!prev || prev.column !== columnKey) return { column: columnKey, direction: "asc" };
      if (prev.direction === "asc") return { column: columnKey, direction: "desc" };
      return null;
    });
  }, []);

  const toggleParent = useCallback((parentValue: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentValue)) {
        next.delete(parentValue);
      } else {
        next.add(parentValue);
      }
      return next;
    });
  }, []);

  const totalGroupedMetrics = useMemo(() => {
    if (!config?.options?.show_totals) return [] as Array<number | null>;
    return tableMetrics.map((metric, metricIndex) => {
      if (!["count", "sum"].includes(metric.operation_type)) return null;
      return sortedGroupedRows.reduce((accumulator, row) => accumulator + (row.metrics[metricIndex] ?? 0), 0);
    });
  }, [config?.options?.show_totals, tableMetrics, sortedGroupedRows]);

  const sqlNumericColumnNames = useMemo(() => {
    return sqlColumns
      .filter((column) => {
        const type = (column.type || "").toLowerCase();
        return (
          type.includes("int") ||
          type.includes("decimal") ||
          type.includes("numeric") ||
          type.includes("double") ||
          type.includes("float") ||
          type.includes("real")
        );
      })
      .map((column) => column.name);
  }, [sqlColumns]);

  const columnFormats = useMemo(() => {
    return config?.options?.column_formats || {};
  }, [config?.options?.column_formats]);

  const getColumnFormat = useCallback(
    (columnKey: string): FormatNumberTypes => {
      return columnFormats[columnKey] || config?.options?.format || "none";
    },
    [columnFormats, config?.options?.format]
  );

  // Detect SQL group columns for collapsible mode.
  // Priority: explicitly configured group columns -> non-numeric columns -> first two SQL columns.
  const sqlGroupColumns = useMemo(() => {
    const configuredPrimary = config?.setup?.group_by_column_name;
    const configuredSecondary = config?.setup?.group_by_secondary_column_name;
    const hasConfiguredPair =
      !!configuredPrimary &&
      !!configuredSecondary &&
      sqlColumns.some((column) => column.name === configuredPrimary) &&
      sqlColumns.some((column) => column.name === configuredSecondary);

    if (hasConfiguredPair) {
      return [configuredPrimary, configuredSecondary] as string[];
    }

    const nonNumericColumns = sqlColumns
      .filter((column) => !sqlNumericColumnNames.includes(column.name))
      .map((column) => column.name);

    if (nonNumericColumns.length >= 2) {
      return nonNumericColumns;
    }

    return sqlColumns.slice(0, 2).map((column) => column.name);
  }, [
    config?.setup?.group_by_column_name,
    config?.setup?.group_by_secondary_column_name,
    sqlColumns,
    sqlNumericColumnNames,
  ]);

  const sqlGroupPrimaryColumn = sqlGroupColumns[0] as string | undefined;
  const sqlGroupSecondaryColumn = sqlGroupColumns.length >= 2 ? sqlGroupColumns[1] : undefined;
  const hasSqlMultipleGroups = !!sqlGroupPrimaryColumn && !!sqlGroupSecondaryColumn;
  const isSqlCollapsibleMode = isSqlMode && hasSqlMultipleGroups && groupedDisplayMode === "collapsible";

  // Reset expanded parents when data or collapsible settings change
  useEffect(() => {
    if (!isCollapsibleMode && !isSqlCollapsibleMode) {
      setExpandedParents(new Set());
      return;
    }
    if (collapseInitial === "expanded") {
      if (isCollapsibleMode) {
        const allParents = new Set(sortedGroupedRows.map((row) => row.grouped_value));
        setExpandedParents(allParents);
      } else if (isSqlCollapsibleMode && sqlGroupPrimaryColumn) {
        const allParents = new Set(sqlRows.map((row) => String(row[sqlGroupPrimaryColumn] ?? "-")));
        setExpandedParents(allParents);
      }
    } else {
      setExpandedParents(new Set());
    }
  }, [
    collapseInitial,
    isCollapsibleMode,
    isSqlCollapsibleMode,
    sortedGroupedRows,
    sqlRows,
    sqlGroupPrimaryColumn,
  ]);

  const sqlColumnLabelMap = useMemo(() => {
    return config?.setup?.sql_column_labels || {};
  }, [config?.setup?.sql_column_labels]);

  const sqlTotals = useMemo(() => {
    if (!config?.options?.show_totals) return {} as Record<string, number>;
    const totals: Record<string, number> = {};

    sqlNumericColumnNames.forEach((columnName) => {
      totals[columnName] = sqlRows.reduce((sum, row) => {
        const value = row[columnName];
        if (typeof value === "number" && Number.isFinite(value)) return sum + value;
        if (typeof value === "string") {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? sum + parsed : sum;
        }
        return sum;
      }, 0);
    });

    return totals;
  }, [config?.options?.show_totals, sqlNumericColumnNames, sqlRows]);

  const sortedSqlRows = useMemo(() => {
    if (!interactiveSort || isSqlCollapsibleMode) return sqlRows;
    const { column, direction } = interactiveSort;
    const dirMul = direction === "asc" ? 1 : -1;
    return [...sqlRows].sort((a, b) => {
      const aVal = a[column];
      const bVal = b[column];
      const aNull = aVal === null || aVal === undefined;
      const bNull = bVal === null || bVal === undefined;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      if (typeof aVal === "number" && typeof bVal === "number") return (aVal - bVal) * dirMul;
      return (
        String(aVal).localeCompare(String(bVal), undefined, { numeric: true, sensitivity: "base" }) * dirMul
      );
    });
  }, [sqlRows, interactiveSort, isSqlCollapsibleMode]);

  const isRecordsConfigured = !!recordsLayerId && isRecordsColumnsConfigured;
  const isGroupedConfigured = !!layerId && tableMetrics.length > 0;
  const isSqlConfigured = !!recordsLayerId && !!config?.setup?.sql_query;

  const displayRecordsData = recordsAccumulatedData ?? recordsData;

  const hasMoreRecords = useMemo(() => {
    if (!displayRecordsData) return false;

    const loadedCount = displayRecordsData.features.length;
    const totalMatched = displayRecordsData.numberMatched;

    if (typeof totalMatched === "number" && Number.isFinite(totalMatched)) {
      if (loadedCount < totalMatched) return true;
      return recordsHasMore;
    }

    return recordsHasMore;
  }, [displayRecordsData, recordsHasMore]);

  const visibleGroupedRows = useMemo(() => {
    return sortedGroupedRows.slice(0, groupedVisibleCount);
  }, [groupedVisibleCount, sortedGroupedRows]);

  const hasMoreGroupedRows = groupedVisibleCount < sortedGroupedRows.length;

  const groupedTableColumns = useMemo(() => {
    const baseColumns = [
      {
        key: "grouped_value",
        label:
          config?.setup?.group_by_label ||
          config?.setup?.group_by_column_name ||
          t("group", { defaultValue: "Group" }),
        align: "left" as const,
      },
      ...(!isCollapsibleMode && hasSecondaryGroup
        ? [
            {
              key: "grouped_secondary_value",
              label:
                config?.setup?.group_by_secondary_label ||
                config?.setup?.group_by_secondary_column_name ||
                t("secondary_group", { defaultValue: "Secondary group" }),
              align: "left" as const,
            },
          ]
        : []),
      ...groupedMetricLabels.map((label, index) => ({
        key: `metric_${index}`,
        label,
        align: "right" as const,
      })),
    ];

    const configuredOrder = config?.setup?.grouped_column_order || [];
    if (!configuredOrder.length) return baseColumns;

    const byKey = new Map(baseColumns.map((column) => [column.key, column]));
    const ordered = configuredOrder.map((key) => byKey.get(key)).filter(Boolean) as typeof baseColumns;
    const missing = baseColumns.filter((column) => !configuredOrder.includes(column.key));

    return [...ordered, ...missing];
  }, [
    config?.setup?.group_by_column_name,
    config?.setup?.group_by_label,
    config?.setup?.group_by_secondary_column_name,
    config?.setup?.group_by_secondary_label,
    config?.setup?.grouped_column_order,
    groupedMetricLabels,
    hasSecondaryGroup,
    isCollapsibleMode,
    t,
  ]);

  const groupedTableRows = useMemo(() => {
    if (!isCollapsibleMode) {
      // Flat mode: one row per combination
      return visibleGroupedRows.map((item) => {
        const row: Record<string, unknown> = {
          grouped_value: item.grouped_value ?? "-",
          ...(hasSecondaryGroup && { grouped_secondary_value: item.grouped_secondary_value ?? "-" }),
        };
        item.metrics.forEach((value, metricIndex) => {
          row[`metric_${metricIndex}`] = value;
        });
        return row;
      });
    }

    // Collapsible mode: build parent/child rows
    const parentOrder: string[] = [];
    const childrenByParent = new Map<string, GroupedRow[]>();

    visibleGroupedRows.forEach((item) => {
      const parent = item.grouped_value ?? "-";
      if (!childrenByParent.has(parent)) {
        parentOrder.push(parent);
        childrenByParent.set(parent, []);
      }
      childrenByParent.get(parent)!.push(item);
    });

    const rows: Array<Record<string, unknown>> = [];

    parentOrder.forEach((parent) => {
      const children = childrenByParent.get(parent) || [];
      const isExpanded = expandedParents.has(parent);

      // Parent row: compute subtotals across all children
      const parentRow: Record<string, unknown> = {
        grouped_value: parent,
        _isParent: true,
        _isExpanded: isExpanded,
        _childCount: children.length,
      };

      if (showSubtotals) {
        const metricCount = children[0]?.metrics?.length || 0;
        for (let i = 0; i < metricCount; i++) {
          parentRow[`metric_${i}`] = children.reduce((sum, child) => sum + (child.metrics[i] ?? 0), 0);
        }
      }

      rows.push(parentRow);

      if (isExpanded) {
        // Sub-header row showing the secondary column name
        const subHeaderRow: Record<string, unknown> = {
          grouped_value:
            config?.setup?.group_by_secondary_label ||
            config?.setup?.group_by_secondary_column_name ||
            t("secondary_group", { defaultValue: "Secondary group" }),
          _isSubHeader: true,
        };
        groupedMetricLabels.forEach((label, metricIndex) => {
          subHeaderRow[`metric_${metricIndex}`] = label;
        });
        rows.push(subHeaderRow);

        children.forEach((child) => {
          const childRow: Record<string, unknown> = {
            grouped_value: child.grouped_secondary_value ?? "-",
            _isChild: true,
          };
          child.metrics.forEach((value, metricIndex) => {
            childRow[`metric_${metricIndex}`] = value;
          });
          rows.push(childRow);
        });
      }
    });

    return rows;
  }, [
    config?.setup?.group_by_secondary_column_name,
    config?.setup?.group_by_secondary_label,
    expandedParents,
    groupedMetricLabels,
    hasSecondaryGroup,
    isCollapsibleMode,
    showSubtotals,
    t,
    visibleGroupedRows,
  ]);

  const groupedTotalsRow = useMemo(() => {
    if (!totalGroupedMetrics.some((value) => value !== null)) return undefined;
    const row: Record<string, unknown> = { grouped_value: t("total", { defaultValue: "Total" }) };
    totalGroupedMetrics.forEach((value, metricIndex) => {
      row[`metric_${metricIndex}`] = value;
    });
    return row;
  }, [t, totalGroupedMetrics]);

  const formatRecordCell = useCallback(
    (columnKey: string, value: unknown) => {
      if (value === null || value === undefined) return "";
      if (
        recordNumericFieldNames.has(columnKey) &&
        (typeof value === "number" || typeof value === "string")
      ) {
        const parsed = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(parsed)) {
          return formatNumber(parsed, getColumnFormat(columnKey), i18n.language);
        }
      }
      const byKind = formatByKind(columnKey, value);
      if (byKind !== null) return byKind;
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    },
    [formatByKind, getColumnFormat, i18n.language, recordNumericFieldNames]
  );

  const formatGroupedCell = useCallback(
    (columnKey: string, value: unknown, row?: Record<string, unknown>) => {
      // Group labels come from the group-by columns — format datetime/boolean
      // values by their field kind (formatFieldValue falls back to String for
      // anything that doesn't parse, e.g. the synthetic "Total" row).
      const primaryColumn = config?.setup?.group_by_column_name;
      const secondaryColumn = config?.setup?.group_by_secondary_column_name;
      const groupLabel = (v: unknown, column?: string): string => {
        if (v === null || v === undefined) return "-";
        return (column ? formatByKind(column, v) : null) ?? String(v);
      };
      if (columnKey === "grouped_value") {
        if (isCollapsibleMode && row?._isParent) {
          const isExpanded = row._isExpanded as boolean;
          const childCount = row._childCount as number;
          const ArrowIcon = isExpanded ? KeyboardArrowDownIcon : KeyboardArrowRightIcon;
          return (
            <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
              <ArrowIcon sx={{ fontSize: 18, color: "text.secondary", flexShrink: 0 }} />
              <Box component="span" sx={{ fontWeight: 600 }}>
                {groupLabel(value, primaryColumn)}
              </Box>
              <Box component="span" sx={{ color: "text.disabled", fontSize: "0.75rem", ml: 0.25 }}>
                ({childCount})
              </Box>
            </Box>
          );
        }
        if (isCollapsibleMode && row?._isSubHeader) {
          return (
            <Box
              component="span"
              sx={{ pl: 3.5, fontWeight: 600, fontSize: "0.75rem", color: "text.secondary" }}>
              {groupLabel(value, secondaryColumn ?? primaryColumn)}
            </Box>
          );
        }
        if (isCollapsibleMode && row?._isChild) {
          return (
            <Box component="span" sx={{ pl: 3.5 }}>
              {groupLabel(value, secondaryColumn ?? primaryColumn)}
            </Box>
          );
        }
        return groupLabel(value, primaryColumn);
      }
      if (columnKey === "grouped_secondary_value") {
        return groupLabel(value, secondaryColumn);
      }
      if (columnKey.startsWith("metric_")) {
        if (isCollapsibleMode && row?._isSubHeader) {
          return (
            <Box component="span" sx={{ fontWeight: 600, fontSize: "0.75rem", color: "text.secondary" }}>
              {String(value ?? "")}
            </Box>
          );
        }
        if (isCollapsibleMode && row?._isParent && !showSubtotals) return "";
        if (value === null || value === undefined) return "-";
        return formatNumber(value as number, getColumnFormat(columnKey), i18n.language);
      }
      return String(value ?? "-");
    },
    [
      config?.setup?.group_by_column_name,
      config?.setup?.group_by_secondary_column_name,
      formatByKind,
      getColumnFormat,
      i18n.language,
      isCollapsibleMode,
      showSubtotals,
    ]
  );

  const sqlTableColumns = useMemo(() => {
    const baseColumns = sqlColumns.map((column, index) => {
      const align: "left" | "right" =
        index === 0 || !sqlNumericColumnNames.includes(column.name) ? "left" : "right";

      return {
        key: column.name,
        label: sqlColumnLabelMap[column.name] || column.name,
        align,
      };
    });

    const configuredOrder = config?.setup?.sql_column_order || [];
    if (!configuredOrder.length) return baseColumns;

    const byKey = new Map(baseColumns.map((column) => [column.key, column]));
    const ordered = configuredOrder.map((key) => byKey.get(key)).filter(Boolean) as typeof baseColumns;
    const missing = baseColumns.filter((column) => !configuredOrder.includes(column.key));

    return [...ordered, ...missing];
  }, [config?.setup?.sql_column_order, sqlColumnLabelMap, sqlColumns, sqlNumericColumnNames]);

  const reorderKeys = useCallback((keys: string[], fromColumnKey: string, toColumnKey: string) => {
    const fromIndex = keys.indexOf(fromColumnKey);
    const toIndex = keys.indexOf(toColumnKey);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return keys;

    const next = [...keys];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
  }, []);

  const handleReorderColumn = useCallback(
    (tableType: "records" | "grouped" | "sql", fromColumnKey: string, toColumnKey: string) => {
      if (!onConfigChange || viewOnly) return;

      const currentSetup = { ...(config?.setup || {}) } as TableDataSchema["setup"];

      if (tableType === "records") {
        const current = currentSetup.visible_columns?.length
          ? [...currentSetup.visible_columns]
          : visibleFields.map((field) => field.name);
        const nextColumns = reorderKeys(current, fromColumnKey, toColumnKey);
        currentSetup.visible_columns = nextColumns;
      }

      if (tableType === "grouped") {
        const current = groupedTableColumns.map((column) => column.key);
        const nextColumns = reorderKeys(current, fromColumnKey, toColumnKey);
        currentSetup.grouped_column_order = nextColumns;
      }

      if (tableType === "sql") {
        const current = sqlTableColumns.map((column) => column.key);
        const nextColumns = reorderKeys(current, fromColumnKey, toColumnKey);
        currentSetup.sql_column_order = nextColumns;
      }

      onConfigChange({
        type: "table",
        ...config,
        setup: currentSetup,
      } as TableDataSchema);
    },
    [config, groupedTableColumns, onConfigChange, reorderKeys, sqlTableColumns, viewOnly, visibleFields]
  );

  const sqlTotalsRow = useMemo(() => {
    if (!config?.options?.show_totals || sqlColumns.length === 0) return undefined;
    const row: Record<string, unknown> = {};
    sqlColumns.forEach((column, index) => {
      row[column.name] =
        index === 0
          ? t("total", { defaultValue: "Total" })
          : column.name in sqlTotals
            ? sqlTotals[column.name]
            : "-";
    });
    return row;
  }, [config?.options?.show_totals, sqlColumns, sqlTotals, t]);

  const formatSqlCell = useCallback(
    (columnKey: string, value: unknown) => {
      if (value === null || value === undefined) return "-";
      if (typeof value === "string" && value === "-") return value;
      if (
        sqlNumericColumnNames.includes(columnKey) &&
        (typeof value === "number" || typeof value === "string")
      ) {
        const parsed = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(parsed)) {
          return formatNumber(parsed, getColumnFormat(columnKey), i18n.language);
        }
      }
      return String(value);
    },
    [getColumnFormat, i18n.language, sqlNumericColumnNames]
  );

  // SQL collapsible mode: columns, rows, cell formatter
  const sqlCollapsibleColumns = useMemo(() => {
    if (!isSqlCollapsibleMode) return sqlTableColumns;
    // In collapsible mode, hide the secondary group column from headers
    return sqlTableColumns.filter((col) => col.key !== sqlGroupSecondaryColumn);
  }, [isSqlCollapsibleMode, sqlGroupSecondaryColumn, sqlTableColumns]);

  const sqlCollapsibleRows = useMemo(() => {
    if (!isSqlCollapsibleMode || !sqlGroupPrimaryColumn || !sqlGroupSecondaryColumn) return sqlRows;

    const parentOrder: string[] = [];
    const childrenByParent = new Map<string, Array<Record<string, unknown>>>();

    sqlRows.forEach((row) => {
      const parent = String(row[sqlGroupPrimaryColumn] ?? "-");
      if (!childrenByParent.has(parent)) {
        parentOrder.push(parent);
        childrenByParent.set(parent, []);
      }
      childrenByParent.get(parent)!.push(row);
    });

    const rows: Array<Record<string, unknown>> = [];

    parentOrder.forEach((parent) => {
      const children = childrenByParent.get(parent) || [];
      const isExpanded = expandedParents.has(parent);

      // Parent row with subtotals
      const parentRow: Record<string, unknown> = {
        [sqlGroupPrimaryColumn]: parent,
        _isParent: true,
        _isExpanded: isExpanded,
        _childCount: children.length,
      };

      if (showSubtotals) {
        sqlNumericColumnNames.forEach((numCol) => {
          if (numCol === sqlGroupPrimaryColumn || numCol === sqlGroupSecondaryColumn) return;
          parentRow[numCol] = children.reduce((sum, child) => {
            const val = typeof child[numCol] === "number" ? (child[numCol] as number) : Number(child[numCol]);
            return sum + (Number.isFinite(val) ? val : 0);
          }, 0);
        });
      }

      rows.push(parentRow);

      if (isExpanded) {
        // Sub-header row showing secondary column name + metric column names
        const subHeaderRow: Record<string, unknown> = {
          [sqlGroupPrimaryColumn]:
            sqlTableColumns.find((c) => c.key === sqlGroupSecondaryColumn)?.label || sqlGroupSecondaryColumn,
          _isSubHeader: true,
        };
        sqlTableColumns.forEach((col) => {
          if (col.key !== sqlGroupPrimaryColumn && col.key !== sqlGroupSecondaryColumn) {
            subHeaderRow[col.key] = col.label;
          }
        });
        rows.push(subHeaderRow);

        children.forEach((child) => {
          const childRow: Record<string, unknown> = {
            ...child,
            // Override primary column with secondary value for tree display
            [sqlGroupPrimaryColumn]: child[sqlGroupSecondaryColumn] ?? "-",
            _isChild: true,
          };
          rows.push(childRow);
        });
      }
    });

    return rows;
  }, [
    expandedParents,
    isSqlCollapsibleMode,
    showSubtotals,
    sqlGroupPrimaryColumn,
    sqlGroupSecondaryColumn,
    sqlNumericColumnNames,
    sqlRows,
    sqlTableColumns,
  ]);

  const formatSqlCellCollapsible = useCallback(
    (columnKey: string, value: unknown, row?: Record<string, unknown>) => {
      if (columnKey === sqlGroupPrimaryColumn) {
        if (row?._isParent) {
          const isExpanded = row._isExpanded as boolean;
          const childCount = row._childCount as number;
          const ArrowIcon = isExpanded ? KeyboardArrowDownIcon : KeyboardArrowRightIcon;
          return (
            <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
              <ArrowIcon sx={{ fontSize: 18, color: "text.secondary", flexShrink: 0 }} />
              <Box component="span" sx={{ fontWeight: 600 }}>
                {String(value ?? "-")}
              </Box>
              <Box component="span" sx={{ color: "text.disabled", fontSize: "0.75rem", ml: 0.25 }}>
                ({childCount})
              </Box>
            </Box>
          );
        }
        if (row?._isSubHeader) {
          return (
            <Box
              component="span"
              sx={{ pl: 3.5, fontWeight: 600, fontSize: "0.75rem", color: "text.secondary" }}>
              {String(value ?? "-")}
            </Box>
          );
        }
        if (row?._isChild) {
          return (
            <Box component="span" sx={{ pl: 3.5 }}>
              {String(value ?? "-")}
            </Box>
          );
        }
      }
      // Sub-header for non-primary columns
      if (row?._isSubHeader) {
        return (
          <Box component="span" sx={{ fontWeight: 600, fontSize: "0.75rem", color: "text.secondary" }}>
            {String(value ?? "")}
          </Box>
        );
      }
      // Numeric columns: hide subtotals for parent if showSubtotals is off
      if (sqlNumericColumnNames.includes(columnKey) && row?._isParent && !showSubtotals) return "";
      // Fall through to standard SQL formatting
      return formatSqlCell(columnKey, value);
    },
    [formatSqlCell, showSubtotals, sqlGroupPrimaryColumn, sqlNumericColumnNames]
  );

  const hasMoreSqlRows = sqlHasMore;

  useEffect(() => {
    const container = isSqlMode
      ? sqlScrollRef.current
      : isGroupedMode
        ? groupedScrollRef.current
        : recordsScrollRef.current;
    if (!container) return;

    const measureHeights = () => {
      const isOverflowing = container.scrollHeight > container.clientHeight + 1;
      if (isSqlMode) {
        setIsSqlOverflowing(isOverflowing);
      } else if (isGroupedMode) {
        setIsGroupedOverflowing(isOverflowing);
      } else {
        setIsRecordsOverflowing(isOverflowing);
      }
    };

    measureHeights();

    const resizeObserver = new ResizeObserver(() => {
      measureHeights();
    });

    resizeObserver.observe(container);

    const headerEl = container.querySelector("thead") as HTMLElement | null;
    if (headerEl) {
      resizeObserver.observe(headerEl);
    }

    const firstBodyRow = container.querySelector("tbody tr") as HTMLElement | null;
    if (firstBodyRow) {
      resizeObserver.observe(firstBodyRow);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [
    config?.setup?.visible_columns,
    displayRecordsData?.features?.length,
    groupedColumnWidths,
    groupedVisibleCount,
    isGroupedMode,
    isSqlMode,
    recordsColumnWidths,
    sqlColumnWidths,
    sqlRows.length,
  ]);

  useEffect(() => {
    if (isSqlMode) {
      setIsRecordsOverflowing(false);
      setIsGroupedOverflowing(false);
      return;
    }
    if (isGroupedMode) {
      setIsRecordsOverflowing(false);
      setIsSqlOverflowing(false);
      return;
    }
    setIsGroupedOverflowing(false);
    setIsSqlOverflowing(false);
  }, [isGroupedMode, isSqlMode]);

  const tableViewportHeight = useMemo(() => {
    return Math.max(180, 44 + rowsPerPage * 40);
  }, [rowsPerPage]);

  const tableScrollSx = {
    flex: 1,
    minHeight: 0,
    maxHeight: `${tableViewportHeight}px`,
    overflowX: "auto" as const,
    overflowY: "auto" as const,
    overscrollBehaviorY: "auto" as const,
    pb: 2,
    scrollPaddingBottom: 16,
    scrollbarWidth: "none" as const,
    "&::-webkit-scrollbar": { display: "none" },
  };

  // Sentinel-based infinite scroll: loads more when sentinel enters viewport
  const recordsSentinelRef = useRef<HTMLDivElement>(null);
  // Use refs so the observer callback always reads fresh state
  const canLoadMoreRecords = useRef(false);
  canLoadMoreRecords.current = hasMoreRecords && !isRecordsLoading && !!displayRecordsData;

  useEffect(() => {
    const sentinel = recordsSentinelRef.current;
    const container = recordsScrollRef.current;
    if (!sentinel || !container) return;
    if (isGroupedMode || isSqlMode) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && canLoadMoreRecords.current) {
          setRecordsPage((previous) => previous + 1);
        }
      },
      { root: container, rootMargin: "200px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // Re-create when data changes (sentinel position moves) or loading finishes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRecordsData, hasMoreRecords, isRecordsLoading, isGroupedMode, isSqlMode]);

  useEffect(() => {
    if (!isGroupedMode || isSqlMode) return;
    if (!hasMoreGroupedRows) return;
    const target = groupedScrollRef.current;
    if (!target) return;

    if (target.scrollHeight <= target.clientHeight + 1) {
      setGroupedVisibleCount((previous) => Math.min(previous + rowsPerPage, sortedGroupedRows.length));
    }
  }, [hasMoreGroupedRows, isGroupedMode, isSqlMode, rowsPerPage, sortedGroupedRows.length]);

  useEffect(() => {
    if (!isSqlMode || isGroupedMode) return;
    if (!hasMoreSqlRows || isSqlLoading || isSqlNextPagePending) return;
    if (sqlColumns.length === 0) return;
    const target = sqlScrollRef.current;
    if (!target) return;

    const currentPageLoaded = sqlRows.length >= (sqlPage + 1) * rowsPerPage;
    if (!currentPageLoaded) return;

    if (target.scrollHeight <= target.clientHeight + 1) {
      setIsSqlNextPagePending(true);
      setSqlPage((previous) => previous + 1);
    }
  }, [
    hasMoreSqlRows,
    isGroupedMode,
    isSqlLoading,
    isSqlMode,
    isSqlNextPagePending,
    rowsPerPage,
    sqlColumns.length,
    sqlPage,
    sqlRows.length,
  ]);

  const handleGroupedScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!hasMoreGroupedRows) return;
      const target = event.currentTarget;
      const reachedBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 48;
      if (reachedBottom) {
        setGroupedVisibleCount((previous) => Math.min(previous + rowsPerPage, sortedGroupedRows.length));
      }
    },
    [hasMoreGroupedRows, rowsPerPage, sortedGroupedRows.length]
  );

  const sqlSentinelRef = useRef<HTMLDivElement>(null);
  const canLoadMoreSql = useRef(false);
  canLoadMoreSql.current = hasMoreSqlRows && !isSqlLoading && !isSqlNextPagePending;

  useEffect(() => {
    const sentinel = sqlSentinelRef.current;
    const container = sqlScrollRef.current;
    if (!sentinel || !container) return;
    if (!isSqlMode || isGroupedMode) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && canLoadMoreSql.current) {
          setIsSqlNextPagePending(true);
          setSqlPage((previous) => previous + 1);
        }
      },
      { root: container, rootMargin: "200px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMoreSqlRows, isSqlLoading, isSqlNextPagePending, isGroupedMode, isSqlMode]);

  const handleSqlWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      const canScrollVertically = target.scrollHeight > target.clientHeight + 1;
      if (!canScrollVertically) return;

      const atTop = target.scrollTop <= 0;
      const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 1;
      const scrollingUp = event.deltaY < 0;
      const scrollingDown = event.deltaY > 0;

      // Keep wheel focus inside table while it can still scroll; hand off only at edges.
      if (!((scrollingUp && atTop) || (scrollingDown && atBottom))) {
        event.stopPropagation();
      }

      // If user keeps scrolling down at the bottom, trigger the next SQL page.
      if (scrollingDown && atBottom && hasMoreSqlRows && !isSqlLoading && !isSqlNextPagePending) {
        setIsSqlNextPagePending(true);
        setSqlPage((previous) => previous + 1);
      }
    },
    [hasMoreSqlRows, isSqlLoading, isSqlNextPagePending]
  );

  const trapWheelInTable = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const canScrollVertically = target.scrollHeight > target.clientHeight + 1;
    if (!canScrollVertically) return;

    const atTop = target.scrollTop <= 0;
    const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 1;
    const scrollingUp = event.deltaY < 0;
    const scrollingDown = event.deltaY > 0;

    // Keep wheel focus inside table while it can still scroll; hand off only at bounds.
    if ((scrollingUp && atTop) || (scrollingDown && atBottom)) {
      return;
    }

    event.stopPropagation();
  }, []);

  const widthStorageKey = useMemo(() => {
    const layerKey = config?.setup?.layer_project_id ?? "no-layer";
    const queryModeKey = config?.setup?.query_mode ?? "builder";
    return `table-widget-widths:${widgetId}:${layerKey}:${queryModeKey}`;
  }, [config?.setup?.layer_project_id, config?.setup?.query_mode, widgetId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.localStorage.getItem(widthStorageKey);
      if (!saved) return;
      const parsed = JSON.parse(saved) as {
        records?: Record<string, number>;
        grouped?: Record<string, number>;
        sql?: Record<string, number>;
      };
      if (parsed.records) {
        setRecordsColumnWidths(parsed.records);
      }
      if (parsed.grouped) {
        setGroupedColumnWidths(parsed.grouped);
      }
      if (parsed.sql) {
        setSqlColumnWidths(parsed.sql);
      }
    } catch {
      // Ignore malformed localStorage data.
    } finally {
      setAreWidthsHydrated(true);
    }
  }, [widthStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!areWidthsHydrated) return;
    if (isResizingColumns) return;

    const persistTimer = window.setTimeout(() => {
      window.localStorage.setItem(
        widthStorageKey,
        JSON.stringify({
          records: recordsColumnWidths,
          grouped: groupedColumnWidths,
          sql: sqlColumnWidths,
        })
      );
    }, 150);

    return () => {
      window.clearTimeout(persistTimer);
    };
  }, [
    areWidthsHydrated,
    groupedColumnWidths,
    isResizingColumns,
    recordsColumnWidths,
    sqlColumnWidths,
    widthStorageKey,
  ]);

  const recordsColWidth = useCallback(
    (columnKey: string) => recordsColumnWidths[columnKey],
    [recordsColumnWidths]
  );
  const groupedColWidth = useCallback(
    (columnKey: string) => groupedColumnWidths[columnKey],
    [groupedColumnWidths]
  );

  const sqlColWidth = useCallback((columnKey: string) => sqlColumnWidths[columnKey], [sqlColumnWidths]);

  const recordColumnLabelMap = useMemo(() => {
    return config?.setup?.record_column_labels || {};
  }, [config?.setup?.record_column_labels]);

  const beginColumnEdit = useCallback(
    (anchorEl: HTMLElement, headerKey: string, currentLabel: string, isNumeric: boolean) => {
      if (viewOnly || !onConfigChange) return;
      setColumnEditAnchorEl(anchorEl);
      setColumnEditHeaderKey(headerKey);
      setColumnEditLabel(currentLabel);
      setColumnEditIsNumeric(isNumeric);
      // Resolve the actual column key for format lookup
      let formatKey = headerKey;
      if (headerKey.startsWith("record:")) formatKey = headerKey.slice(7);
      else if (headerKey.startsWith("sql:")) formatKey = headerKey.slice(4);
      setColumnEditFormat(columnFormats[formatKey] || undefined);
    },
    [columnFormats, onConfigChange, viewOnly]
  );

  const closeColumnEdit = useCallback(() => {
    setColumnEditAnchorEl(null);
    setColumnEditHeaderKey(null);
  }, []);

  const applyColumnEdit = useCallback(() => {
    if (!columnEditHeaderKey || !onConfigChange) {
      closeColumnEdit();
      return;
    }

    const nextLabel = columnEditLabel.trim();
    const nextSetup = {
      ...(config?.setup || {}),
    } as TableDataSchema["setup"];

    // Apply label rename
    if (columnEditHeaderKey === "grouped_value") {
      nextSetup.group_by_label = nextLabel || undefined;
    } else if (columnEditHeaderKey === "grouped_secondary_value") {
      nextSetup.group_by_secondary_label = nextLabel || undefined;
    } else if (columnEditHeaderKey.startsWith("record:")) {
      const sourceColumnName = columnEditHeaderKey.slice(7);
      const recordLabels = { ...(nextSetup.record_column_labels || {}) };
      if (nextLabel) {
        recordLabels[sourceColumnName] = nextLabel;
      } else {
        delete recordLabels[sourceColumnName];
      }
      nextSetup.record_column_labels = Object.keys(recordLabels).length ? recordLabels : undefined;
    } else if (columnEditHeaderKey === "metric_0") {
      nextSetup.primary_metric_label = nextLabel || undefined;
    } else if (columnEditHeaderKey.startsWith("metric_")) {
      const metricNumber = Number(columnEditHeaderKey.replace("metric_", ""));
      const additionalMetricIndex = metricNumber - 1;
      const additionalMetrics = [...(nextSetup.additional_metrics || [])];
      if (additionalMetricIndex >= 0 && additionalMetricIndex < additionalMetrics.length) {
        additionalMetrics[additionalMetricIndex] = {
          ...additionalMetrics[additionalMetricIndex],
          label: nextLabel || undefined,
        };
        nextSetup.additional_metrics = additionalMetrics;
      }
    } else if (columnEditHeaderKey.startsWith("sql:")) {
      const sourceColumnName = columnEditHeaderKey.slice(4);
      const sqlLabels = { ...(nextSetup.sql_column_labels || {}) };
      if (nextLabel) {
        sqlLabels[sourceColumnName] = nextLabel;
      } else {
        delete sqlLabels[sourceColumnName];
      }
      nextSetup.sql_column_labels = Object.keys(sqlLabels).length ? sqlLabels : undefined;
    }

    // Apply per-column format
    let formatKey = columnEditHeaderKey;
    if (formatKey.startsWith("record:")) formatKey = formatKey.slice(7);
    else if (formatKey.startsWith("sql:")) formatKey = formatKey.slice(4);
    const nextColumnFormats: Record<string, FormatNumberTypes> = {
      ...(config?.options?.column_formats || {}),
    };
    if (columnEditFormat) {
      nextColumnFormats[formatKey] = columnEditFormat;
    } else {
      delete nextColumnFormats[formatKey];
    }

    onConfigChange({
      type: "table",
      ...config,
      setup: nextSetup,
      options: {
        ...(config?.options || {}),
        column_formats: Object.keys(nextColumnFormats).length ? nextColumnFormats : undefined,
      },
    } as TableDataSchema);
    closeColumnEdit();
  }, [closeColumnEdit, columnEditFormat, columnEditHeaderKey, columnEditLabel, config, onConfigChange]);

  const renderHeaderLabel = useCallback(
    (headerKey: string, label: string, align: "left" | "right" = "left", isNumeric = false) => {
      const canEdit = !viewOnly && !!onConfigChange;
      return (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: align === "right" ? "flex-end" : "flex-start",
            gap: 0,
            "&:hover .column-edit-btn": canEdit ? { opacity: 1 } : {},
          }}>
          <Typography
            variant="body2"
            fontWeight="bold"
            align={align}
            sx={{
              ...twoLineClampSx,
              pr: canEdit ? 0 : 1,
              flex: 1,
              minWidth: 0,
            }}>
            {label}
          </Typography>
          {canEdit && (
            <IconButton
              className="column-edit-btn"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                beginColumnEdit(event.currentTarget, headerKey, label, isNumeric);
              }}
              sx={{
                opacity: 0,
                transition: "opacity 0.15s",
                p: 0,
                ml: -0.25,
                flexShrink: 0,
              }}>
              <EditIcon sx={{ fontSize: 14, color: "text.secondary" }} />
            </IconButton>
          )}
        </Box>
      );
    },
    [beginColumnEdit, onConfigChange, twoLineClampSx, viewOnly]
  );

  return (
    <Box sx={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <WidgetStatusContainer
        isLoading={
          isSqlMode
            ? isSqlLoading && sqlRows.length === 0
            : isGroupedMode
              ? isGroupedLoading && groupedRows.length === 0
              : isRecordsLoading && !displayRecordsData
        }
        isNotConfigured={
          isSqlMode ? !isSqlConfigured : isGroupedMode ? !isGroupedConfigured : !isRecordsConfigured
        }
        isNotConfiguredMessage={isLayerLocked ? t("layer_locked_hint") : undefined}
        isError={isSqlMode ? !!sqlError : isGroupedMode ? !!groupedError : !!isRecordsError}
        height={140}
      />

      {!isSqlMode && !isGroupedMode && displayRecordsData && isRecordsConfigured && (
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {filteringEnabled && viewFilterController.model.rows.length > 0 && (
            <Stack direction="row" flexWrap="wrap" gap={1} sx={{ pb: 2 }}>
              {viewFilterController.model.rows.map((row) => {
                // The popover adds condition rows only.
                if (isCustomRow(row)) return null;
                const columnLabel = recordColumnLabelMap[row.field] || row.field;
                // A chip has to stay narrow enough that several fit on one row, so
                // long values still truncate — the tooltip is how you read them.
                // Worded as the layer Filter panel words its rows.
                return (
                  <Tooltip key={row.id} title={rowSentence(row, columnLabel, t)} placement="top">
                    <Chip
                      size="small"
                      variant="outlined"
                      label={
                        <Typography variant="caption" noWrap>
                          <b>{columnLabel}</b> {rowSentence(row, "", t)}
                        </Typography>
                      }
                      onDelete={() => viewFilterController.remove(row.id)}
                      sx={{ maxWidth: 280 }}
                    />
                  </Tooltip>
                );
              })}
            </Stack>
          )}
          <Box ref={recordsScrollRef} sx={tableScrollSx} onWheel={trapWheelInTable}>
            <FeatureTable
              fields={visibleFields}
              data={displayRecordsData}
              isLoading={areFieldsLoading}
              variant="bordered"
              stickyHeader={stickyHeaderEnabled}
              headerColor={headerColor}
              headerLabelMap={recordColumnLabelMap}
              getColumnWidth={recordsColWidth}
              formatCellValue={formatRecordCell}
              renderHeaderLabel={(fieldName, label) =>
                renderHeaderLabel(
                  `record:${fieldName}`,
                  label,
                  "left",
                  recordNumericFieldNames.has(fieldName)
                )
              }
              onReorderColumns={(fromColumnKey, toColumnKey) => {
                handleReorderColumn("records", fromColumnKey, toColumnKey);
              }}
              onHeaderResizeStart={
                viewOnly || !onConfigChange
                  ? undefined
                  : (event, fieldName) => startColumnResize(event, "records", fieldName)
              }
              columnMenuItems={sortingEnabled || filteringEnabled ? recordColumnMenuItems : undefined}
              sortColumn={interactiveSort?.column}
              sortDirection={interactiveSort?.direction}
            />
            <div ref={recordsSentinelRef} style={{ height: 1 }} />
          </Box>
          {(hasMoreRecords || isRecordsOverflowing) && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
              {t("scroll_to_load_more", { defaultValue: "Scroll to see all features" })}
            </Typography>
          )}
        </Box>
      )}

      {!isSqlMode && isGroupedMode && isGroupedConfigured && (
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Box
            ref={groupedScrollRef}
            sx={tableScrollSx}
            onWheel={trapWheelInTable}
            onScroll={handleGroupedScroll}>
            <WidgetAggregateTable
              stickyHeaderEnabled={stickyHeaderEnabled}
              headerColor={headerColor}
              tableColumns={groupedTableColumns}
              tableRows={groupedTableRows}
              totalsRow={groupedTotalsRow}
              formatCellValueForColumn={formatGroupedCell}
              emptyMessage={
                <Typography variant="body2" color="text.secondary">
                  {t("no_data_for_current_filters", { defaultValue: "No data for current filters." })}
                </Typography>
              }
              getColumnWidth={groupedColWidth}
              renderHeaderLabel={(columnKey, label, align) =>
                renderHeaderLabel(columnKey, label, align || "left", columnKey.startsWith("metric_"))
              }
              onReorderColumns={(fromColumnKey, toColumnKey) => {
                handleReorderColumn("grouped", fromColumnKey, toColumnKey);
              }}
              onHeaderResizeStart={
                viewOnly || !onConfigChange
                  ? undefined
                  : (event, columnKey) => startColumnResize(event, "grouped", columnKey)
              }
              onColumnSortClick={sortingEnabled ? handleInteractiveSortClick : undefined}
              sortColumn={interactiveSort?.column}
              sortDirection={interactiveSort?.direction}
              {...(isCollapsibleMode && {
                onRowClick: (row) => {
                  if (row._isParent) {
                    toggleParent(String(row.grouped_value));
                  }
                },
                getRowSx: (row) => {
                  if (row._isSubHeader) {
                    return {
                      backgroundColor: "action.hover",
                    };
                  }
                  if (row._isParent) {
                    return {
                      backgroundColor: "action.hover",
                      "&:hover": { backgroundColor: "action.selected" },
                    };
                  }
                  return undefined;
                },
              })}
            />
          </Box>
          {(hasMoreGroupedRows || isGroupedOverflowing) && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
              {t("scroll_to_load_more", { defaultValue: "Scroll to see all features" })}
            </Typography>
          )}
        </Box>
      )}

      {isSqlMode && isSqlConfigured && (
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Box ref={sqlScrollRef} sx={tableScrollSx} onWheel={handleSqlWheel}>
            <WidgetAggregateTable
              stickyHeaderEnabled={stickyHeaderEnabled}
              headerColor={headerColor}
              tableColumns={isSqlCollapsibleMode ? sqlCollapsibleColumns : sqlTableColumns}
              tableRows={isSqlCollapsibleMode ? sqlCollapsibleRows : sortedSqlRows}
              formatCellValueForColumn={isSqlCollapsibleMode ? formatSqlCellCollapsible : formatSqlCell}
              emptyMessage={
                <Typography variant="body2" color="text.secondary">
                  {t("no_data_for_current_filters", { defaultValue: "No data for current filters." })}
                </Typography>
              }
              getColumnWidth={sqlColWidth}
              renderHeaderLabel={(columnKey, label, align) =>
                renderHeaderLabel(
                  `sql:${columnKey}`,
                  label,
                  align || "left",
                  sqlNumericColumnNames.includes(columnKey)
                )
              }
              onReorderColumns={(fromColumnKey, toColumnKey) => {
                handleReorderColumn("sql", fromColumnKey, toColumnKey);
              }}
              onHeaderResizeStart={
                viewOnly || !onConfigChange
                  ? undefined
                  : (event, columnKey) => startColumnResize(event, "sql", columnKey)
              }
              onColumnSortClick={
                isSqlCollapsibleMode || !sortingEnabled ? undefined : handleInteractiveSortClick
              }
              sortColumn={isSqlCollapsibleMode ? undefined : interactiveSort?.column}
              sortDirection={isSqlCollapsibleMode ? undefined : interactiveSort?.direction}
              {...(isSqlCollapsibleMode && {
                onRowClick: (row) => {
                  if (row._isParent && sqlGroupPrimaryColumn) {
                    toggleParent(String(row[sqlGroupPrimaryColumn]));
                  }
                },
                getRowSx: (row) => {
                  if (row._isSubHeader) {
                    return {
                      backgroundColor: "action.hover",
                    };
                  }
                  if (row._isParent) {
                    return {
                      backgroundColor: "action.hover",
                      "&:hover": { backgroundColor: "action.selected" },
                    };
                  }
                  return undefined;
                },
              })}
            />
            <div ref={sqlSentinelRef} style={{ height: 1 }} />
          </Box>
          {sqlTotalsRow && !isSqlCollapsibleMode && sqlTableColumns.length > 0 && (
            <Box sx={{ overflowX: "auto" }}>
              <Box component="table" sx={{ tableLayout: "fixed", width: "100%", borderCollapse: "collapse" }}>
                <Box component="tbody">
                  <Box component="tr">
                    {sqlTableColumns.map((column) => (
                      <Box
                        key={`sql-total-outside-${column.key}`}
                        component="td"
                        sx={{
                          width: sqlColWidth(column.key),
                          p: 1,
                          borderTop: 1,
                          borderColor: "divider",
                          borderRight: 1,
                          backgroundColor: "background.paper",
                          textAlign: column.align || "left",
                          verticalAlign: "top",
                          "&:last-of-type": {
                            borderRight: 0,
                          },
                        }}>
                        <Typography variant="body2" fontWeight="bold">
                          {formatSqlCell(column.key, sqlTotalsRow[column.key])}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                </Box>
              </Box>
            </Box>
          )}
          {(hasMoreSqlRows || isSqlOverflowing) && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
              {t("scroll_to_load_more", { defaultValue: "Scroll to see all features" })}
            </Typography>
          )}
        </Box>
      )}

      {/* Column filter popover — records mode only; grouped and SQL rows are computed. */}
      {filterColumn && (
        <ColumnFilterPopover
          key={filterColumn}
          anchorEl={filterAnchorEl}
          columnName={filterColumn}
          iconKind={fieldIndicatorKind(
            layerFields.find((field) => field.name === filterColumn) ?? { type: "string" }
          )}
          layerId={recordsLayerId || ""}
          controller={viewFilterController}
          onClose={() => {
            setFilterAnchorEl(null);
            setFilterColumn(null);
          }}
        />
      )}

      {/* Column edit popover */}
      <Popover
        open={Boolean(columnEditAnchorEl)}
        anchorEl={columnEditAnchorEl}
        onClose={closeColumnEdit}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}>
        <Stack spacing={1.5} sx={{ p: 1.5, width: 280 }}>
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary">
              {t("column_name", { defaultValue: "Column name" })}
            </Typography>
            <TextField
              size="small"
              value={columnEditLabel}
              onChange={(event) => setColumnEditLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyColumnEdit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeColumnEdit();
                }
              }}
              autoFocus
              fullWidth
            />
          </Stack>
          {columnEditIsNumeric && (
            <NumberFormatSelector
              numberFormat={columnEditFormat}
              onNumberFormatChange={(format) => setColumnEditFormat(format)}
            />
          )}
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button size="small" onClick={closeColumnEdit} variant="text" sx={{ borderRadius: 0 }}>
              <Typography variant="body2" fontWeight="bold">
                {t("cancel")}
              </Typography>
            </Button>
            <Button
              size="small"
              variant="text"
              color="primary"
              onClick={applyColumnEdit}
              sx={{ borderRadius: 0 }}>
              <Typography variant="body2" fontWeight="bold" color="inherit">
                {t("apply", { defaultValue: "Apply" })}
              </Typography>
            </Button>
          </Stack>
        </Stack>
      </Popover>
    </Box>
  );
};
