/**
 * Generic Tool Component
 *
 * Renders a tool form dynamically from OGC process description.
 * Handles input state, validation, and execution.
 * Supports section-based layout from x-ui metadata.
 */
import { Box, CircularProgress, Stack, Typography, useTheme } from "@mui/material";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useJobs } from "@/lib/api/processes";
import { useProject } from "@/lib/api/projects";
import { useUserProfile } from "@/lib/api/users";
import { OEV_STATION_CONFIG_DEFAULT } from "@/lib/constants/oev-gueteklassen";
import { setRunningJobIds } from "@/lib/store/jobs/slice";
import { setToolboxStartingPoints } from "@/lib/store/map/slice";
import { creditsErrorMessage } from "@/lib/utils/credits";
import {
  applyDynamicDefaults,
  getDefaultValues,
  getVisibleInputs,
  isFormResetField,
  isSectionEnabled,
  processInputsWithSections,
  validateInputs,
} from "@/lib/utils/ogc-utils";

import type { ProcessedInput, ProcessedSection } from "@/types/map/ogc-processes";
import type { IndicatorBaseProps } from "@/types/map/toolbox";

import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";
import { useProcessDescription, useProcessExecution } from "@/hooks/map/useOgcProcesses";
import { useProjectBundleKinds } from "@/hooks/map/useProjectBundleKinds";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import Container from "@/components/map/panels/Container";
import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";
import ToolboxActionButtons from "@/components/map/panels/common/ToolboxActionButtons";
import ToolsHeader from "@/components/map/panels/common/ToolsHeader";
import LearnMore from "@/components/map/panels/toolbox/common/LearnMore";
import { GenericInput } from "@/components/map/panels/toolbox/generic/inputs";
import { DEFAULT_NETWORK_BUNDLE } from "@/components/map/panels/toolbox/generic/inputs/BundleInput";
import OevStationConfigInput from "@/components/map/panels/toolbox/generic/inputs/OevStationConfigInput";
import { processObjectProperties } from "@/components/map/panels/toolbox/generic/inputs/RepeatableObjectInput";

// Map section icons from backend to ICON_NAME
const SECTION_ICON_MAP: Record<string, ICON_NAME> = {
  layers: ICON_NAME.LAYERS,
  route: ICON_NAME.ROUTE,
  settings: ICON_NAME.SETTINGS,
  hexagon: ICON_NAME.HEXAGON,
  table: ICON_NAME.TABLE,
  tag: ICON_NAME.BOOKMARK,
  grid: ICON_NAME.TABLE,
  list: ICON_NAME.LIST,
  globe: ICON_NAME.GLOBE,
  upload: ICON_NAME.UPLOAD,
  download: ICON_NAME.DOWNLOAD,
  location: ICON_NAME.LOCATION,
  "location-marker": ICON_NAME.LOCATION_MARKER,
  aggregate: ICON_NAME.AGGREGATE,
  chart: ICON_NAME.CHART,
  clock: ICON_NAME.CLOCK,
  save: ICON_NAME.SAVE,
};

/**
 * Groups inputs by inline_group for side-by-side rendering.
 * Consecutive inputs with the same inline_group are collected into arrays.
 * Ungrouped inputs become single-element arrays.
 */
function groupInputsByInlineGroup(inputs: ProcessedInput[]): ProcessedInput[][] {
  const groups: ProcessedInput[][] = [];
  let currentGroup: ProcessedInput[] = [];
  let currentGroupKey: string | undefined = undefined;

  for (const input of inputs) {
    const groupKey = input.uiMeta?.inline_group;
    if (groupKey && groupKey === currentGroupKey) {
      currentGroup.push(input);
    } else {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [input];
      currentGroupKey = groupKey;
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }
  return groups;
}

interface GenericToolProps extends IndicatorBaseProps {
  processId: string;
}

export default function GenericTool({ processId, onBack, onClose }: GenericToolProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { projectId } = useParams();
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);

  // Fetch process description
  const { process, isLoading: isLoadingProcess, error: processError } = useProcessDescription(processId);

  // Process execution
  const { execute, isExecuting } = useProcessExecution();

  // Jobs mutation for refreshing job list
  const { mutate: mutateJobs } = useJobs({ read: false });

  // User profile for user_id
  const { userProfile } = useUserProfile();

  // Project (used for folder_id in the tool payload)
  const { project } = useProject(projectId as string);

  // Project layers for geometry type detection
  const { layers: projectLayers } = useFilteredProjectLayers(projectId as string);

  // Compute default values synchronously when process changes
  // This ensures visibility conditions work correctly on the first render
  const defaultValues = useMemo(() => {
    if (!process) return {};
    return getDefaultValues(process);
  }, [process]);

  // Form state - initialize with defaults
  const [values, setValues] = useState<Record<string, unknown>>({});

  // Layer filters state - maps layer input names to their CQL filters
  // e.g., { "input_layer_id": { "op": "=", ... }, "overlay_layer_id": { ... } }
  const [layerFilters, setLayerFilters] = useState<Record<string, Record<string, unknown> | undefined>>({});

  // Nested layer filters for repeatable objects
  // Structure: { "opportunities": [{ "input_layer_id": {...filter...} }, {...}] }
  const [nestedLayerFilters, setNestedLayerFilters] = useState<
    Record<string, Record<string, Record<string, unknown> | undefined>[]>
  >({});

  // Section collapse state
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  // Advanced options collapse state (for the settings icon)
  const [advancedCollapsed, setAdvancedCollapsed] = useState<Record<string, boolean>>({});

  // Field validation errors - tracks which fields currently have errors
  const [fieldErrors, setFieldErrors] = useState<Record<string, boolean>>({});

  // Process inputs into sections
  const sections = useMemo(() => {
    if (!process) {
      return [];
    }
    return processInputsWithSections(process);
  }, [process]);

  // Initialize default values and collapsed states when process loads
  useEffect(() => {
    if (process) {
      const defaults = getDefaultValues(process);
      setValues(defaults);

      // Initialize collapsed states from section definitions
      const collapsed: Record<string, boolean> = {};
      const advCollapsed: Record<string, boolean> = {};
      for (const section of sections) {
        collapsed[section.id] = section.collapsed;
        // Advanced options start collapsed by default
        advCollapsed[section.id] = true;
      }
      setCollapsedSections(collapsed);
      setAdvancedCollapsed(advCollapsed);
    }
  }, [process, sections]);

  useEffect(() => {
    if (processId !== "oev_gueteklassen") {
      return;
    }

    setValues((prev) => {
      if (prev.station_config) {
        return prev;
      }
      return {
        ...prev,
        station_config: OEV_STATION_CONFIG_DEFAULT,
      };
    });
  }, [processId]);

  // Get all inputs from all sections (flattened)
  const allInputs = useMemo(() => {
    return sections.flatMap((section) => section.inputs);
  }, [sections]);

  // Which networks this project holds, for the sections that ask which one to
  // route on. A project fact rather than anything derived from the form, so it
  // is computed once and merged in beside the geometry flags below.
  // Each selector answers for itself: its own bundle type and artifact kind
  // decide whether the project holds something it could offer.
  const bundleSelectors = useMemo(
    () =>
      allInputs
        .filter((input) => input.uiMeta?.widget === "bundle-selector")
        .map((input) => ({
          name: input.name,
          bundleType: input.uiMeta?.widget_options?.bundle_type as string | undefined,
          artifactKind: input.uiMeta?.widget_options?.artifact_kind as string | undefined,
        })),
    [allInputs]
  );
  const projectBundleValues = useProjectBundleKinds(projectId as string, bundleSelectors);

  // Whether each selector names a bundle, as opposed to the default network.
  // Fields that used to key off the selector being unset cannot ask that any
  // more: the default is now an answer with a value, so "is there a value" and
  // "is a bundle chosen" have come apart. A PT date picker belongs to an
  // uploaded feed's window; the weekday dropdown belongs to the default
  // network's anchors — this is what still tells them apart.
  const bundleChoiceValues = useMemo((): Record<string, unknown> => {
    const merged = { ...defaultValues, ...values };
    const flags: Record<string, unknown> = {};
    for (const selector of bundleSelectors) {
      const chosen = merged[selector.name];
      flags[`_${selector.name}_is_custom`] =
        typeof chosen === "string" && chosen !== "" && chosen !== DEFAULT_NETWORK_BUNDLE;
    }
    return flags;
  }, [bundleSelectors, values, defaultValues]);

  // Compute layer geometry types for visibility conditions
  // Creates computed values like _target_layer_id_has_geometry, _join_layer_id_has_geometry
  const layerGeometryValues = useMemo(() => {
    if (!projectLayers) return {};

    const computed: Record<string, boolean> = {};
    const effectiveValues = { ...defaultValues, ...values };

    // Find all layer inputs and compute their geometry status
    for (const input of allInputs) {
      if (input.inputType === "layer") {
        const projectLayerId = effectiveValues[input.name] as string | undefined;
        if (projectLayerId) {
          // LayerInput stores project layer ID (integer as string), so find by id
          const numericId = parseInt(projectLayerId, 10);
          const layer = projectLayers.find((l) => l.id === numericId);
          // A layer has geometry if it has a feature_layer_geometry_type
          computed[`_${input.name}_has_geometry`] = !!layer?.feature_layer_geometry_type;
        } else {
          computed[`_${input.name}_has_geometry`] = false;
        }
      }
    }

    // Compute combined values for common patterns
    // _any_layer_has_geometry: true if ANY selected layer has geometry
    // _all_layers_have_geometry: true if ALL selected layers have geometry (and at least one is selected)
    const geometryFlags = Object.values(computed);
    computed["_any_layer_has_geometry"] = geometryFlags.some((v) => v === true);
    computed["_all_layers_have_geometry"] =
      geometryFlags.length > 0 && geometryFlags.every((v) => v === true);

    return computed;
  }, [projectLayers, allInputs, values, defaultValues]);

  // Reset form to defaults. `overrides` keep the field the user just changed
  // and rebuild every default keyed on it (see getDefaultValues).
  const handleReset = useCallback(
    (overrides?: Record<string, unknown>) => {
      if (process) {
        setValues(getDefaultValues(process, overrides));
        setLayerFilters({});
        setNestedLayerFilters({});
        setFieldErrors({});
        // Clear starting points from Redux
        dispatch(setToolboxStartingPoints(undefined));
      }
    },
    [process, dispatch]
  );

  // Update a single input value, applying dynamic defaults to dependent fields
  const handleInputChange = useCallback(
    (name: string, value: unknown) => {
      // A field marked `resets_form` starts the form over when it changes: the
      // transport mode decides which measures, budgets and legs are meaningful,
      // so carrying anything across would leave values that no longer apply.
      if (isFormResetField(allInputs, name) && values[name] !== undefined && values[name] !== value) {
        handleReset({ [name]: value });
        return;
      }

      setValues((prev) => applyDynamicDefaults(allInputs, prev, name, value));
    },
    [allInputs, values, handleReset]
  );

  // Update filter for a layer input
  const handleFilterChange = useCallback((inputName: string, filter: Record<string, unknown> | undefined) => {
    setLayerFilters((prev) => ({
      ...prev,
      [inputName]: filter,
    }));
  }, []);

  // Update nested filters for a repeatable object input
  const handleNestedFiltersChange = useCallback(
    (inputName: string, filters: Record<string, Record<string, unknown> | undefined>[]) => {
      setNestedLayerFilters((prev) => ({
        ...prev,
        [inputName]: filters,
      }));
    },
    []
  );

  // Toggle section collapse
  const toggleSection = useCallback((sectionId: string) => {
    setCollapsedSections((prev) => ({
      ...prev,
      [sectionId]: !prev[sectionId],
    }));
  }, []);

  // Handle field validation state changes
  const handleFieldValidation = useCallback((fieldName: string, hasError: boolean) => {
    setFieldErrors((prev) => {
      if (prev[fieldName] === hasError) return prev;
      return { ...prev, [fieldName]: hasError };
    });
  }, []);

  // Toggle advanced options collapse
  const toggleAdvanced = useCallback((sectionId: string) => {
    setAdvancedCollapsed((prev) => ({
      ...prev,
      [sectionId]: !prev[sectionId],
    }));
  }, []);

  // Validate and check if form is ready
  const isValid = useMemo(() => {
    if (!process) return false;

    // Merge defaults with user values and computed layer geometry for validation checks
    const effectiveValues = {
      ...defaultValues,
      ...values,
      ...layerGeometryValues,
      ...projectBundleValues,
      ...bundleChoiceValues,
    };

    // Helper to check if a value is empty
    const isEmpty = (value: unknown): boolean => {
      if (value === undefined || value === null || value === "") return true;
      if (Array.isArray(value) && value.length === 0) return true;
      return false;
    };

    // Check required fields across all sections
    for (const section of sections) {
      const visibleInputs = getVisibleInputs(section.inputs, effectiveValues);
      for (const input of visibleInputs) {
        // A field is required if:
        // 1. It's explicitly required (minOccurs > 0), OR
        // 2. It has visible_when condition and no default value (conditional field that must be filled when shown)
        //    UNLESS it's explicitly marked as optional in x-ui metadata
        // Note: defaultValue is null when Python field has Field(None, ...), undefined when no default at all
        const isExplicitlyOptional = input.uiMeta?.optional === true;
        const hasConditionalVisibility = !!input.uiMeta?.visible_when;
        const hasNoDefault = input.defaultValue === undefined || input.defaultValue === null;
        const isConditionallyRequired = hasConditionalVisibility && hasNoDefault && !isExplicitlyOptional;

        const isRequired = input.required || isConditionallyRequired;

        if (isRequired) {
          const value = effectiveValues[input.name];
          if (isEmpty(value)) {
            return false;
          }
        }

        // For repeatable-object inputs, every added item must have its
        // visible required fields filled. If the user adds a slot and
        // leaves it blank, the form should not be runnable.
        if (input.inputType === "repeatable-object" && Array.isArray(effectiveValues[input.name])) {
          const items = effectiveValues[input.name] as Record<string, unknown>[];
          // Resolve item schema (handle $ref and anyOf nullable patterns)
          let itemSchema = input.schema.items;
          if (!itemSchema && input.schema.anyOf) {
            const arrayVariant = input.schema.anyOf.find(
              (v: { type?: string; items?: unknown }) => v.type === "array" && v.items
            );
            if (arrayVariant) itemSchema = arrayVariant.items;
          }
          if (itemSchema?.$ref && process.$defs) {
            const refName = itemSchema.$ref.replace("#/$defs/", "");
            itemSchema = process.$defs[refName] || itemSchema;
          }
          if (itemSchema) {
            const itemInputs = processObjectProperties(itemSchema, process.$defs);
            const allItemsComplete =
              items.length > 0 &&
              items.every((item) => {
                const mergedItemValues = { ...effectiveValues, ...item };
                const visibleItemInputs = getVisibleInputs(itemInputs, mergedItemValues);
                // Mirror the top-level conditional-required logic: a field
                // is required if it's explicitly required OR if it has a
                // visible_when condition with no default (i.e. once shown,
                // the user must fill it).
                return visibleItemInputs.every((ii) => {
                  const isExplicitlyOptional = ii.uiMeta?.optional === true;
                  const hasConditionalVisibility = !!ii.uiMeta?.visible_when;
                  const hasNoDefault = ii.defaultValue === undefined || ii.defaultValue === null;
                  const isConditionallyRequired =
                    hasConditionalVisibility && hasNoDefault && !isExplicitlyOptional;
                  const isItemRequired = ii.required || isConditionallyRequired;
                  return !isItemRequired || !isEmpty(item[ii.name]);
                });
              });
            if (!allItemsComplete) {
              return false;
            }
          }
        }
      }
    }

    // Check for any field validation errors
    if (Object.values(fieldErrors).some((hasError) => hasError)) {
      return false;
    }

    return true;
  }, [
    process,
    sections,
    values,
    defaultValues,
    layerGeometryValues,
    projectBundleValues,
    bundleChoiceValues,
    fieldErrors,
  ]);

  // Execute the process
  const handleRun = async () => {
    if (!process || !userProfile) {
      toast.error(t("error_running_tool"));
      return;
    }

    // Merge defaults with user values and computed layer geometry
    const effectiveValues = {
      ...defaultValues,
      ...values,
      ...layerGeometryValues,
      ...projectBundleValues,
      ...bundleChoiceValues,
    };

    // Build filter fields from layer filters
    // Convention: layer field "input_layer_id" -> filter field "input_layer_filter"
    const filterFields: Record<string, unknown> = {};
    for (const [layerFieldName, filter] of Object.entries(layerFilters)) {
      if (filter) {
        // Convert layer_id suffix to _filter suffix
        const filterFieldName = layerFieldName.replace(/_id$/, "_filter");
        filterFields[filterFieldName] = filter;
      }
    }

    // Get all visible input names to filter out invisible fields
    const visibleInputNames = new Set<string>();
    for (const section of sections) {
      const sectionEnabled = isSectionEnabled(section, effectiveValues);
      if (sectionEnabled) {
        const visibleInputs = getVisibleInputs(section.inputs, effectiveValues);
        for (const input of visibleInputs) {
          visibleInputNames.add(input.name);
        }
      }
    }

    // Build payload with only visible inputs (to avoid sending conditional fields that shouldn't be set)
    const visibleValues: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(effectiveValues)) {
      if (visibleInputNames.has(key)) {
        // "Use the network GOAT ships" is an answer to the question, not a
        // bundle: the field is asked so the choice is made deliberately, and
        // the backend hears it as the absence of a bundle, which is what it
        // already treats as the default network.
        if (value === DEFAULT_NETWORK_BUNDLE) continue;
        visibleValues[key] = value;
      }
    }

    if (processId === "oev_gueteklassen" && effectiveValues.station_config) {
      visibleValues.station_config = effectiveValues.station_config;
    }

    // Convert project layer IDs to layer_ids (UUIDs) for layer inputs
    // LayerInput stores project layer id (integer as string) but backend expects layer_id (UUID)
    // This handles both top-level layer inputs and layer inputs inside repeatable-object arrays
    if (projectLayers) {
      const convertProjectLayerIdToLayerId = (projectLayerId: string): string | undefined => {
        const numericId = parseInt(projectLayerId, 10);
        if (isNaN(numericId)) return undefined;
        const layer = projectLayers.find((l) => l.id === numericId);
        return layer?.layer_id;
      };

      for (const input of allInputs) {
        if (input.inputType === "layer" && visibleValues[input.name]) {
          // Top-level layer input
          const layerId = convertProjectLayerIdToLayerId(visibleValues[input.name] as string);
          if (layerId) {
            visibleValues[input.name] = layerId;
          }
        } else if (input.inputType === "repeatable-object" && Array.isArray(visibleValues[input.name])) {
          // Repeatable object array - check for layer inputs inside each item
          // Layer inputs inside repeatable objects use x-ui.widget = "layer-selector"
          const itemSchema = input.schema?.items;
          const itemsAnyOf = input.schema?.anyOf?.find(
            (v: { type?: string; items?: unknown }) => v.type === "array" && v.items
          );
          let resolvedItemSchema = itemSchema || itemsAnyOf?.items;

          // Resolve $ref if present (e.g., { "$ref": "#/$defs/OpportunityGravity" })
          if (resolvedItemSchema?.$ref && process.$defs) {
            const refName = resolvedItemSchema.$ref.replace("#/$defs/", "");
            resolvedItemSchema = process.$defs[refName] || resolvedItemSchema;
          }

          if (resolvedItemSchema?.properties) {
            // Find layer field names and their corresponding filter field names
            const layerFieldNames: string[] = [];
            const layerToFilterMap: Record<string, string> = {};

            for (const [fieldName, fieldSchema] of Object.entries(resolvedItemSchema.properties)) {
              const schema = fieldSchema as Record<string, unknown>;
              const uiMeta = schema["x-ui"] as { widget?: string } | undefined;
              if (uiMeta?.widget === "layer-selector") {
                layerFieldNames.push(fieldName);

                // Find corresponding filter field by looking for fields that contain 'filter' in their name
                // Common patterns: input_layer_filter, input_path_filter, etc.
                for (const [filterFieldName, filterFieldSchema] of Object.entries(
                  resolvedItemSchema.properties
                )) {
                  const filterSchema = filterFieldSchema as Record<string, unknown>;
                  const filterUiMeta = filterSchema["x-ui"] as { hidden?: boolean } | undefined;
                  // Filter fields are typically hidden and contain 'filter' in the name
                  if (filterUiMeta?.hidden && filterFieldName.includes("filter")) {
                    layerToFilterMap[fieldName] = filterFieldName;
                    break;
                  }
                }
              }
            }

            // If the item schema declares `layer_project_id`, forward the
            // selected project-layer id before it's converted to a dataset UUID.
            const hasLayerProjectIdField = Boolean(
              (resolvedItemSchema.properties as Record<string, unknown>)?.layer_project_id
            );

            // Convert layer IDs in each array item and inject filters
            if (layerFieldNames.length > 0) {
              const items = visibleValues[input.name] as Record<string, unknown>[];
              const itemFilters = nestedLayerFilters[input.name] || [];

              visibleValues[input.name] = items.map((item, itemIndex) => {
                const convertedItem = { ...item };
                for (const fieldName of layerFieldNames) {
                  if (convertedItem[fieldName]) {
                    if (hasLayerProjectIdField && convertedItem.layer_project_id == null) {
                      const pid = parseInt(convertedItem[fieldName] as string, 10);
                      if (!isNaN(pid)) {
                        convertedItem.layer_project_id = pid;
                      }
                    }
                    const layerId = convertProjectLayerIdToLayerId(convertedItem[fieldName] as string);
                    if (layerId) {
                      convertedItem[fieldName] = layerId;
                    }
                  }

                  // Inject filter for this layer field using the mapped filter field name
                  const filterFieldName = layerToFilterMap[fieldName];
                  const filter = itemFilters[itemIndex]?.[fieldName];
                  if (filter && filterFieldName) {
                    convertedItem[filterFieldName] = filter;
                  }
                }
                // Remove internal _id field used for React keys
                delete convertedItem._id;
                return convertedItem;
              });
            }
          }
        }
      }
    }

    // Build full payload with hidden fields and filters
    const payload = {
      ...visibleValues,
      ...filterFields,
      user_id: userProfile.id,
      project_id: projectId,
      folder_id: project?.folder_id,
      save_results: true,
    };

    // Validate
    const errors = validateInputs(process, payload, (field) => t("field_is_required", { field }));
    if (errors.length > 0) {
      errors.forEach((error) => toast.error(error));
      return;
    }

    try {
      const result = await execute(processId, payload);

      if (result?.jobID) {
        toast.info(`${process.title} - ${t("job_started")}`);
        mutateJobs();
        dispatch(setRunningJobIds([...runningJobIds, result.jobID]));
      }

      // Reset form after successful submission
      handleReset();
    } catch (error) {
      console.error("Process execution error:", error);
      const creditsMessage = creditsErrorMessage(error, t);
      if (creditsMessage) {
        toast.error(creditsMessage, { autoClose: 10000 });
        return;
      }
      toast.error(t("error_running_tool"));
    }
  };

  // Get icon for section
  const getSectionIcon = (section: ProcessedSection): ICON_NAME => {
    if (section.icon && SECTION_ICON_MAP[section.icon]) {
      return SECTION_ICON_MAP[section.icon];
    }
    return ICON_NAME.LAYERS;
  };

  // Loading state
  if (isLoadingProcess) {
    return (
      <Container
        disablePadding={false}
        header={<ToolsHeader onBack={onBack} title={t("loading")} />}
        close={onClose}
        body={
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress />
          </Box>
        }
      />
    );
  }

  // Error state
  if (processError || !process) {
    return (
      <Container
        disablePadding={false}
        header={<ToolsHeader onBack={onBack} title={t("error")} />}
        close={onClose}
        body={
          <Typography color="error" variant="body2">
            {t("error_loading_tool")}
          </Typography>
        }
      />
    );
  }

  return (
    <Container
      disablePadding={false}
      header={<ToolsHeader onBack={onBack} title={process.title} />}
      close={onClose}
      body={
        <Box sx={{ display: "flex", flexDirection: "column" }}>
          {/* Description */}
          <Typography variant="body2" sx={{ fontStyle: "italic", mb: theme.spacing(4) }}>
            {process.description}
            <LearnMore
              docsPath={
                process.links?.find((l) => l.rel === "describedby")?.href ??
                `/toolbox/geoprocessing/${processId}`
              }
            />
          </Typography>

          {/* Render sections dynamically */}
          {sections.map((section) => {
            // Merge defaults with user values and computed layer geometry for visibility checks
            const effectiveValues = {
              ...defaultValues,
              ...values,
              ...layerGeometryValues,
              ...projectBundleValues,
              ...bundleChoiceValues,
            };
            let visibleInputs = getVisibleInputs(section.inputs, effectiveValues);
            const sectionEnabled = isSectionEnabled(section, effectiveValues);

            // Auto-hide "advanced-toggle" widgets that have no dependent fields
            // currently visible. A toggle field controls others via visible_when
            // referencing its name; if toggling on reveals nothing extra, hide it.
            const toggleField = visibleInputs.find((i) => i.uiMeta?.widget === "advanced-toggle");
            if (toggleField) {
              const otherInputs = section.inputs.filter((i) => i.name !== toggleField.name);
              const visibleWhenOn = getVisibleInputs(otherInputs, {
                ...effectiveValues,
                [toggleField.name]: true,
              });
              const visibleWhenOff = getVisibleInputs(otherInputs, {
                ...effectiveValues,
                [toggleField.name]: false,
              });
              if (visibleWhenOn.length <= visibleWhenOff.length) {
                visibleInputs = visibleInputs.filter((i) => i.name !== toggleField.name);
              }
            }

            // Skip empty sections
            if (visibleInputs.length === 0) {
              return null;
            }

            // Split into base and advanced inputs
            const baseInputs = visibleInputs.filter((input) => !input.advanced);
            const advancedInputs = visibleInputs.filter((input) => input.advanced);
            const hasAdvancedOptions = advancedInputs.length > 0;
            const shouldRenderOevStationConfigFallback =
              processId === "oev_gueteklassen" &&
              section.id === "configuration" &&
              !visibleInputs.some((input) => input.name === "station_config");

            const isCollapsed = collapsedSections[section.id] ?? section.collapsed;
            const isAdvancedCollapsed = advancedCollapsed[section.id] ?? true;
            const isFirstSection = sections.indexOf(section) === 0;
            const isDisabled = !sectionEnabled;

            return (
              <Box
                key={section.id}
                sx={{
                  opacity: isDisabled ? 0.5 : 1,
                  pointerEvents: isDisabled ? "none" : "auto",
                  transition: "opacity 0.2s ease",
                }}>
                <SectionHeader
                  active={!isCollapsed && !isDisabled}
                  alwaysActive={!section.collapsible || isFirstSection}
                  label={section.label}
                  icon={getSectionIcon(section)}
                  disableAdvanceOptions={!hasAdvancedOptions}
                  collapsed={hasAdvancedOptions ? isAdvancedCollapsed : isCollapsed || isDisabled}
                  setCollapsed={
                    hasAdvancedOptions
                      ? () => toggleAdvanced(section.id)
                      : section.collapsible
                        ? () => toggleSection(section.id)
                        : undefined
                  }
                  onToggleChange={
                    section.collapsible && !isFirstSection ? () => toggleSection(section.id) : undefined
                  }
                />
                {!isCollapsed && !isDisabled && (
                  <SectionOptions
                    active={true}
                    collapsed={isAdvancedCollapsed}
                    baseOptions={
                      <Stack spacing={2}>
                        {groupInputsByInlineGroup(baseInputs).map((group) =>
                          group.length === 1 ? (
                            <GenericInput
                              key={group[0].name}
                              input={group[0]}
                              value={effectiveValues[group[0].name]}
                              onChange={(value) => handleInputChange(group[0].name, value)}
                              onFilterChange={
                                group[0].inputType === "layer"
                                  ? (filter) => handleFilterChange(group[0].name, filter)
                                  : undefined
                              }
                              onNestedFiltersChange={
                                group[0].inputType === "repeatable-object"
                                  ? (filters) => handleNestedFiltersChange(group[0].name, filters)
                                  : undefined
                              }
                              disabled={isExecuting}
                              formValues={effectiveValues}
                              schemaDefs={process.$defs}
                              processId={processId}
                              onValidationChange={(hasError) =>
                                handleFieldValidation(group[0].name, hasError)
                              }
                            />
                          ) : (
                            <Stack
                              key={group[0].uiMeta?.inline_group}
                              direction="row"
                              spacing={2}
                              sx={{ width: "100%", alignItems: "flex-start" }}>
                              {group.map((input) => (
                                <Box
                                  key={input.name}
                                  sx={{ flex: input.uiMeta?.inline_flex ?? "0 1 auto", minWidth: 0 }}>
                                  <GenericInput
                                    input={input}
                                    value={effectiveValues[input.name]}
                                    onChange={(value) => handleInputChange(input.name, value)}
                                    onFilterChange={
                                      input.inputType === "layer"
                                        ? (filter) => handleFilterChange(input.name, filter)
                                        : undefined
                                    }
                                    onNestedFiltersChange={
                                      input.inputType === "repeatable-object"
                                        ? (filters) => handleNestedFiltersChange(input.name, filters)
                                        : undefined
                                    }
                                    disabled={isExecuting}
                                    formValues={effectiveValues}
                                    schemaDefs={process.$defs}
                                    processId={processId}
                                    onValidationChange={(hasError) =>
                                      handleFieldValidation(input.name, hasError)
                                    }
                                  />
                                </Box>
                              ))}
                            </Stack>
                          )
                        )}
                        {shouldRenderOevStationConfigFallback && (
                          <OevStationConfigInput
                            input={{ name: "station_config", title: "Station configuration" }}
                            value={effectiveValues.station_config}
                            onChange={(value) => handleInputChange("station_config", value)}
                            disabled={isExecuting}
                          />
                        )}
                      </Stack>
                    }
                    advancedOptions={
                      hasAdvancedOptions ? (
                        <Stack spacing={2}>
                          {groupInputsByInlineGroup(advancedInputs).map((group) =>
                            group.length === 1 ? (
                              <GenericInput
                                key={group[0].name}
                                input={group[0]}
                                value={effectiveValues[group[0].name]}
                                onChange={(value) => handleInputChange(group[0].name, value)}
                                onFilterChange={
                                  group[0].inputType === "layer"
                                    ? (filter) => handleFilterChange(group[0].name, filter)
                                    : undefined
                                }
                                onNestedFiltersChange={
                                  group[0].inputType === "repeatable-object"
                                    ? (filters) => handleNestedFiltersChange(group[0].name, filters)
                                    : undefined
                                }
                                disabled={isExecuting}
                                formValues={effectiveValues}
                                schemaDefs={process.$defs}
                                processId={processId}
                                onValidationChange={(hasError) =>
                                  handleFieldValidation(group[0].name, hasError)
                                }
                              />
                            ) : (
                              <Stack
                                key={group[0].uiMeta?.inline_group}
                                direction="row"
                                spacing={2}
                                sx={{ width: "100%", alignItems: "flex-start" }}>
                                {group.map((input) => (
                                  <Box
                                    key={input.name}
                                    sx={{ flex: input.uiMeta?.inline_flex ?? "0 1 auto", minWidth: 0 }}>
                                    <GenericInput
                                      input={input}
                                      value={effectiveValues[input.name]}
                                      onChange={(value) => handleInputChange(input.name, value)}
                                      onFilterChange={
                                        input.inputType === "layer"
                                          ? (filter) => handleFilterChange(input.name, filter)
                                          : undefined
                                      }
                                      onNestedFiltersChange={
                                        input.inputType === "repeatable-object"
                                          ? (filters) => handleNestedFiltersChange(input.name, filters)
                                          : undefined
                                      }
                                      disabled={isExecuting}
                                      formValues={effectiveValues}
                                      schemaDefs={process.$defs}
                                      processId={processId}
                                      onValidationChange={(hasError) =>
                                        handleFieldValidation(input.name, hasError)
                                      }
                                    />
                                  </Box>
                                ))}
                              </Stack>
                            )
                          )}
                        </Stack>
                      ) : undefined
                    }
                  />
                )}
              </Box>
            );
          })}
        </Box>
      }
      action={
        <ToolboxActionButtons
          runDisabled={!isValid || isExecuting}
          resetFunction={() => handleReset()}
          runFunction={handleRun}
          isBusy={isExecuting}
        />
      }
    />
  );
}
