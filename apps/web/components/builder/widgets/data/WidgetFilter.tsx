/* eslint-disable @typescript-eslint/no-explicit-any */
import { Box } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMap } from "react-map-gl/maplibre";

import { DEFAULT_WIDGET_COLOR } from "@/lib/constants/ui";
import { useDatasetCollectionItems } from "@/lib/api/layers";
import type { TemporaryFilter } from "@/lib/store/map/slice";
import { addTemporaryFilter, removeTemporaryFilter, updateTemporaryFilter } from "@/lib/store/map/slice";
import { zoomToFeatureCollection } from "@/lib/utils/map/navigate";
import { type ProjectLayer } from "@/lib/validations/project";
import { type FilterDataSchema, filterLayoutTypes } from "@/lib/validations/widget";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";
import useLayerFields from "@/hooks/map/CommonHooks";

import { WidgetStatusContainer } from "@/components/builder/widgets/common/WidgetStatusContainer";
import CheckboxFilter from "@/components/builder/widgets/data/CheckboxFilter";
import ChipsFilter from "@/components/builder/widgets/data/ChipsFilter";
import RangeFilter from "@/components/builder/widgets/data/RangeFilter";
import TemporalRangeInput from "@/components/builder/widgets/data/TemporalRangeInput";
import AutocompleteLayerValue from "@/components/builder/widgets/data/AutocompleteLayerValue";

// Deep compare helper
const areFiltersEqual = (a: TemporaryFilter | undefined, b: TemporaryFilter) => {
  if (!a) return false;
  const cleanA = { ...a, id: undefined }; // ignore ID
  const cleanB = { ...b, id: undefined };
  return JSON.stringify(cleanA) === JSON.stringify(cleanB);
};

interface FilterDataProps {
  id: string;
  config: FilterDataSchema;
  projectLayers: ProjectLayer[];
  viewOnly?: boolean;
}

export const FilterDataWidget = ({ id, config: rawConfig, projectLayers }: FilterDataProps) => {
  const dispatch = useAppDispatch();
  const { map } = useMap();
  // Range + picker (temporal) both drive the range state / dispatch effect.
  const isRangeLayout =
    rawConfig?.setup?.layout === filterLayoutTypes.Values.range ||
    rawConfig?.setup?.layout === filterLayoutTypes.Values.picker;

  // Local dropdown state (for select, chips, checkbox)
  const [selectedValues, setSelectedValues] = useState<string[] | string | undefined>(
    rawConfig?.setup?.multiple ? [] : ""
  );

  // Local range state — numbers for numeric range, ISO strings for temporal.
  const [selectedRange, setSelectedRange] = useState<
    [number, number] | [string, string] | null
  >(null);

  // Flash animation when filter is updated via map click
  const [isFlashing, setIsFlashing] = useState(false);

  // Track previous selection to only zoom when the user actually changes the selection
  const prevSelectedValuesRef = useRef(selectedValues);

  const existingFilter = useAppSelector((state) =>
    state.map.temporaryFilters.find((filter) => filter.id === id)
  );

  // Get all temporary filters (for cross-filtering options)
  const allTemporaryFilters = useAppSelector((state) => state.map.temporaryFilters);

  // Clicked feature for filter-by-map-click
  const clickedFeatureForFilter = useAppSelector(
    (state) => state.map.clickedFeatureForFilter
  );

  const layer = useMemo(() => {
    return projectLayers?.find((l) => l.id === rawConfig?.setup?.layer_project_id) ?? null;
  }, [projectLayers, rawConfig?.setup?.layer_project_id]);

  const { layerFields } = useLayerFields(layer?.layer_id ?? "");
  const isTemporal = useMemo<boolean>(() => {
    const field = layerFields.find((f) => f.name === rawConfig?.setup?.column_name);
    return field?.type === "date";
  }, [layerFields, rawConfig?.setup?.column_name]);

  /**
   * React to map feature clicks: if filter_by_map_click is enabled and the clicked
   * feature's layer matches this widget's layer, update the selected value(s).
   */
  useEffect(() => {
    if (!clickedFeatureForFilter) return;
    if (!rawConfig?.options?.filter_by_map_click) return;
    if (!layer || clickedFeatureForFilter.layerProjectId !== layer.id) return;
    if (isRangeLayout) return;

    const columnName = rawConfig?.setup?.column_name;
    if (!columnName) return;

    const rawValue = clickedFeatureForFilter.properties[columnName];
    if (rawValue == null) return;

    const value = String(rawValue);

    if (rawConfig?.setup?.multiple) {
      // Toggle: add if not present, remove if present
      setSelectedValues((prev) => {
        const arr = Array.isArray(prev) ? prev : prev ? [prev] : [];
        if (arr.includes(value)) {
          return arr.filter((v) => v !== value);
        }
        return [...arr, value];
      });
    } else {
      setSelectedValues(value);
    }

    // Trigger flash animation
    setIsFlashing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clickedFeatureForFilter?.timestamp]);

  useEffect(() => {
    if (!isFlashing) return;
    const timer = setTimeout(() => setIsFlashing(false), 600);
    return () => clearTimeout(timer);
  }, [isFlashing]);

  /**
   * Build combined CQL filter for cross-filtering options.
   * This combines the layer's base CQL with all other filters targeting the same layer
   * (excluding this filter's own ID to avoid circular filtering).
   * Also considers filters that target this layer via additional_targets.
   * Additionally supports bidirectional cross-filtering: if this filter targets Layer X,
   * and another filter is on Layer X, apply that filter's effect back to this filter.
   */
  const crossFilterCql = useMemo(() => {
    if (!rawConfig?.options?.cross_filter_options || !layer) {
      return layer?.query?.cql;
    }

    const filterArgs: object[] = [];

    // Get the layers that THIS filter targets (for reverse lookup)
    // Map: target layer ID -> { targetColumnName, thisColumnName }
    const targetLayerMapping = new Map<number, { targetColumn: string; thisColumn: string }>();
    rawConfig?.options?.target_layers?.forEach((t) => {
      if (t.layer_project_id && t.column_name && rawConfig?.setup?.column_name) {
        targetLayerMapping.set(t.layer_project_id, {
          targetColumn: t.column_name,
          thisColumn: rawConfig.setup.column_name,
        });
      }
    });

    // Helper function to transform a filter by replacing column names
    const transformFilter = (filter: any, fromColumn: string, toColumn: string): any => {
      if (!filter || typeof filter !== "object") return filter;

      // Handle property references
      if (filter.property === fromColumn) {
        return { ...filter, property: toColumn };
      }

      // Recursively transform args
      if (filter.args && Array.isArray(filter.args)) {
        return {
          ...filter,
          args: filter.args.map((arg: any) => transformFilter(arg, fromColumn, toColumn)),
        };
      }

      return filter;
    };

    // Check all other filters (excluding this filter)
    allTemporaryFilters
      .filter((f) => f.id !== id)
      .forEach((f) => {
        // Case 1: Filter's primary layer matches this layer
        if (f.layer_id === layer.id) {
          filterArgs.push(f.filter);
        }
        // Case 2: This layer is in the filter's additional_targets
        else {
          const targetForThisLayer = f.additional_targets?.find((target) => target.layer_id === layer.id);
          if (targetForThisLayer) {
            filterArgs.push(targetForThisLayer.filter);
          }
        }

        // Case 3 (Bidirectional): This filter targets the other filter's layer
        // Transform the other filter's selection to use this filter's column name,
        // but only if the transformation actually changed something (meaning the
        // other filter uses the expected target column). If unchanged, the filter
        // is for an unrelated column and should not be applied to this layer.
        const mapping = targetLayerMapping.get(f.layer_id);
        if (mapping) {
          const transformedFilter = transformFilter(f.filter, mapping.targetColumn, mapping.thisColumn);
          if (JSON.stringify(transformedFilter) !== JSON.stringify(f.filter)) {
            filterArgs.push(transformedFilter);
          }
        }
      });

    if (filterArgs.length === 0) {
      return layer?.query?.cql;
    }

    // Combine with layer's base CQL if it exists
    const baseCql = layer?.query?.cql;
    if (baseCql) {
      filterArgs.push(baseCql);
    }

    // If only one filter, return it directly
    if (filterArgs.length === 1) {
      return filterArgs[0];
    }

    // Combine with AND
    return {
      op: "and",
      args: filterArgs,
    };
  }, [
    allTemporaryFilters,
    id,
    layer,
    rawConfig?.options?.cross_filter_options,
    rawConfig?.options?.target_layers,
    rawConfig?.setup?.column_name,
  ]);

  /**
   * Sync local state with config changes.
   * If user changes column/layer in the config panel, wipe local state + related filter/highlight.
   */
  useEffect(() => {
    setSelectedValues(rawConfig?.setup?.multiple ? [] : "");
    setSelectedRange(null);
    if (existingFilter) {
      dispatch(removeTemporaryFilter(id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawConfig?.setup?.column_name, rawConfig?.setup?.layer_project_id]);

  /**
   * Sync local state when filter is removed externally
   * (e.g. FilterConfigPanel removes it).
   */
  useEffect(() => {
    if (!existingFilter) {
      setSelectedValues(rawConfig?.setup?.multiple ? [] : "");
      setSelectedRange(null);
    }
  }, [existingFilter, rawConfig?.setup?.multiple]);

  // Fetch geometry data for zoom functionality
  const geometryDataQueryParams = useMemo(() => {
    const values = Array.isArray(selectedValues) ? selectedValues : [selectedValues];
    if (
      !selectedValues?.length ||
      !rawConfig?.setup?.column_name ||
      !layer ||
      !rawConfig?.options?.zoom_to_selection
    )
      return undefined;

    return {
      limit: 50,
      offset: 0,
      filter: JSON.stringify({
        op: "or",
        args: values.map((value) => ({
          op: "=",
          args: [{ property: rawConfig.setup.column_name }, value],
        })),
      }),
    };
  }, [selectedValues, rawConfig, layer]);

  const { data: geometryData } = useDatasetCollectionItems(layer?.layer_id || "", geometryDataQueryParams);

  /**
   * Build additional targets for multi-layer filtering
   */
  const buildAdditionalTargets = useCallback(
    (filterValues: string[]) => {
      const targetLayers = rawConfig?.options?.target_layers;
      if (!targetLayers?.length || !filterValues.length) return undefined;

      return targetLayers
        .map((target) => {
          if (!target.column_name) return null;
          const targetLayer = projectLayers.find((l) => l.id === target.layer_project_id);
          if (!targetLayer) return null;

          return {
            layer_id: targetLayer.id,
            filter: {
              op: "or",
              args: filterValues.map((value) => ({
                op: "=",
                args: [{ property: target.column_name }, value],
              })),
            },
          };
        })
        .filter(Boolean) as { layer_id: number; filter: object }[];
    },
    [projectLayers, rawConfig?.options?.target_layers]
  );

  /**
   * Build additional targets for range filter
   */
  const buildAdditionalTargetsRange = useCallback(
    (min: number | string, max: number | string) => {
      const targetLayers = rawConfig?.options?.target_layers;
      if (!targetLayers?.length) return undefined;

      return targetLayers
        .map((target) => {
          if (!target.column_name) return null;
          const targetLayer = projectLayers.find((l) => l.id === target.layer_project_id);
          if (!targetLayer) return null;

          return {
            layer_id: targetLayer.id,
            filter: {
              op: "and",
              args: [
                { op: ">=", args: [{ property: target.column_name }, min] },
                { op: "<=", args: [{ property: target.column_name }, max] },
              ],
            },
          };
        })
        .filter(Boolean) as { layer_id: number; filter: object }[];
    },
    [projectLayers, rawConfig?.options?.target_layers]
  );

  /**
   * Keep store in sync with selected values (for select, chips, checkbox)
   */
  useEffect(() => {
    // Skip for range layout - handled separately
    if (isRangeLayout) return;

    // Nothing selected or invalid config
    if (
      !selectedValues ||
      (Array.isArray(selectedValues) && selectedValues.length === 0) ||
      !layer ||
      !rawConfig?.setup?.column_name
    ) {
      if (existingFilter) dispatch(removeTemporaryFilter(id));
      return;
    }

    const normalizedValues = Array.isArray(selectedValues) ? selectedValues : [selectedValues];

    const filterObject = {
      op: "or",
      args: normalizedValues.map((value) => ({
        op: "=",
        args: [{ property: rawConfig.setup.column_name }, value],
      })),
    };

    const newFilter: TemporaryFilter = {
      id,
      layer_id: layer.id,
      filter: filterObject,
      additional_targets: buildAdditionalTargets(normalizedValues),
      excludeFromSourceLayer: !!rawConfig?.options?.filter_by_map_click,
    };

    // Zoom to selection if enabled and we have geometry data,
    // but only when the user actually changed their selection (not on unrelated re-renders).
    // Only update the ref after a successful zoom so we retry when geometryData arrives late.
    const selectionChanged =
      JSON.stringify(prevSelectedValuesRef.current) !== JSON.stringify(selectedValues);
    if (selectionChanged && rawConfig?.options?.zoom_to_selection) {
      if (geometryData?.features?.length && map) {
        zoomToFeatureCollection(map, geometryData as GeoJSON.FeatureCollection, {
          duration: 200,
          maxZoom: 14,
        });
        prevSelectedValuesRef.current = selectedValues;
      }
    } else if (!rawConfig?.options?.zoom_to_selection) {
      prevSelectedValuesRef.current = selectedValues;
    }

    if (!areFiltersEqual(existingFilter, newFilter)) {
      if (existingFilter) {
        dispatch(updateTemporaryFilter(newFilter));
      } else {
        dispatch(addTemporaryFilter(newFilter));
      }
    }
  }, [
    buildAdditionalTargets,
    dispatch,
    existingFilter,
    geometryData,
    id,
    isRangeLayout,
    layer,
    map,
    rawConfig?.options?.filter_by_map_click,
    rawConfig?.options?.zoom_to_selection,
    rawConfig.setup.column_name,
    selectedValues,
  ]);

  /**
   * Keep store in sync with selected range (for range filter)
   */
  useEffect(() => {
    // Skip for non-range layouts
    if (!isRangeLayout) return;

    // No range selected or invalid config
    if (!selectedRange || !layer || !rawConfig?.setup?.column_name) {
      if (existingFilter) dispatch(removeTemporaryFilter(id));
      return;
    }

    const [min, max] = selectedRange;

    if (min === "" || max === "" || min == null || max == null) {
      if (existingFilter) dispatch(removeTemporaryFilter(id));
      return;
    }

    const filterObject = {
      op: "and",
      args: [
        {
          op: ">=",
          args: [{ property: rawConfig.setup.column_name }, min],
        },
        {
          op: "<=",
          args: [{ property: rawConfig.setup.column_name }, max],
        },
      ],
    };

    const newFilter: TemporaryFilter = {
      id,
      layer_id: layer.id,
      filter: filterObject,
      additional_targets: buildAdditionalTargetsRange(min, max),
    };

    if (!areFiltersEqual(existingFilter, newFilter)) {
      if (existingFilter) {
        dispatch(updateTemporaryFilter(newFilter));
      } else {
        dispatch(addTemporaryFilter(newFilter));
      }
    }
  }, [
    buildAdditionalTargetsRange,
    dispatch,
    existingFilter,
    id,
    isRangeLayout,
    layer,
    rawConfig?.setup?.column_name,
    selectedRange,
  ]);

  return (
    <Box
      sx={{
        mb: 2,
        transition: "background-color 0.3s ease",
        backgroundColor: isFlashing
          ? `${rawConfig?.options?.color || DEFAULT_WIDGET_COLOR}18`
          : "transparent",
        borderRadius: 1,
      }}>
      <WidgetStatusContainer isNotConfigured={!layer || !rawConfig?.setup?.column_name} height={100} />
      {layer &&
        rawConfig?.setup.column_name &&
        rawConfig?.setup.layout === filterLayoutTypes.Values.select && (
          <AutocompleteLayerValue
            selectedValues={selectedValues as any}
            onSelectedValuesChange={(values: string[] | string | null) => {
              if (values === null || (Array.isArray(values) && values.length === 0)) {
                setSelectedValues(rawConfig?.setup.multiple ? [] : "");
                return;
              }
              setSelectedValues(values as any);
            }}
            layerId={layer.layer_id}
            fieldName={rawConfig?.setup.column_name}
            placeholder={rawConfig?.setup.placeholder}
            multiple={rawConfig?.setup.multiple}
            cqlFilter={crossFilterCql}
            labelMap={rawConfig?.options?.label_map}
          />
        )}
      {layer &&
        rawConfig?.setup.column_name &&
        rawConfig?.setup.layout === filterLayoutTypes.Values.chips && (
          <ChipsFilter
            layerId={layer.layer_id}
            fieldName={rawConfig?.setup.column_name}
            selectedValues={
              Array.isArray(selectedValues) ? selectedValues : selectedValues ? [selectedValues] : []
            }
            onSelectedValuesChange={(values: string[]) => {
              setSelectedValues(values);
            }}
            minVisibleOptions={rawConfig?.setup.min_visible_options}
            multiple={rawConfig?.setup.multiple}
            wrap={rawConfig?.setup.wrap}
            customOrder={rawConfig?.setup.custom_order}
            cqlFilter={crossFilterCql}
            color={rawConfig?.options?.color}
            labelMap={rawConfig?.options?.label_map}
            showAllOption={rawConfig?.setup.show_all_option}
          />
        )}
      {layer &&
        rawConfig?.setup.column_name &&
        rawConfig?.setup.layout === filterLayoutTypes.Values.checkbox && (
          <CheckboxFilter
            layerId={layer.layer_id}
            fieldName={rawConfig?.setup.column_name}
            selectedValues={
              Array.isArray(selectedValues) ? selectedValues : selectedValues ? [selectedValues] : []
            }
            onSelectedValuesChange={(values: string[]) => {
              setSelectedValues(values);
            }}
            minVisibleOptions={rawConfig?.setup.min_visible_options}
            multiple={rawConfig?.setup.multiple}
            customOrder={rawConfig?.setup.custom_order}
            cqlFilter={crossFilterCql}
            color={rawConfig?.options?.color}
            labelMap={rawConfig?.options?.label_map}
          />
        )}
      {layer &&
        rawConfig?.setup.column_name &&
        isTemporal &&
        (rawConfig?.setup.layout === filterLayoutTypes.Values.range ||
          rawConfig?.setup.layout === filterLayoutTypes.Values.picker) && (
          <TemporalRangeInput
            inputStyle={
              rawConfig?.setup.layout === filterLayoutTypes.Values.picker ? "picker" : "range"
            }
            granularity={rawConfig?.setup.granularity}
            layerId={layer.layer_id}
            fieldName={rawConfig.setup.column_name}
            showHistogram={rawConfig?.setup.show_histogram}
            color={rawConfig?.options?.color}
            selectedRange={selectedRange as [string, string] | null}
            onSelectedRangeChange={setSelectedRange}
          />
        )}
      {/* Numeric field: standard range slider */}
      {layer &&
        rawConfig?.setup.column_name &&
        !isTemporal &&
        rawConfig?.setup.layout === filterLayoutTypes.Values.range && (
          <RangeFilter
            layerId={layer.layer_id}
            fieldName={rawConfig?.setup.column_name}
            selectedRange={selectedRange as [number, number] | null}
            onSelectedRangeChange={setSelectedRange}
            showHistogram={rawConfig?.setup.show_histogram}
            steps={rawConfig?.setup.steps}
            showSlider={rawConfig?.setup.show_slider}
            cqlFilter={crossFilterCql}
            color={rawConfig?.options?.color}
          />
        )}
    </Box>
  );
};
