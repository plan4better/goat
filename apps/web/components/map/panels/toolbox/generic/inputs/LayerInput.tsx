/**
 * Generic Layer Input Component
 *
 * Renders a layer selector based on OGC process input schema.
 * Filters layers by geometry type constraints from metadata.
 * Also captures and exposes the layer's CQL filter (if any).
 *
 * NOTE: This component stores the project layer ID (integer as string) internally
 * for unique identification. The GenericTool converts this to layer_id (UUID)
 * when submitting to the backend.
 */
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { SelectorItem } from "@/types/map/common";
import type { ProcessedInput } from "@/types/map/ogc-processes";

import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";

import Selector from "@/components/map/panels/common/Selector";

interface LayerInputProps {
  input: ProcessedInput;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** Callback to set the filter associated with the selected layer */
  onFilterChange?: (filter: Record<string, unknown> | undefined) => void;
  disabled?: boolean;
  /** Layer IDs to exclude from the selector (e.g., already selected in other items) */
  excludedLayerIds?: string[];
}

/**
 * Map geometry constraint names to layer types
 */
function mapGeometryToLayerType(geometry: string): string {
  const normalized = geometry.toLowerCase();
  if (normalized === "no_geometry" || normalized === "table") return "no_geometry";
  if (normalized.includes("polygon")) return "polygon";
  if (normalized.includes("line") || normalized.includes("linestring")) return "line";
  if (normalized.includes("point")) return "point";
  return normalized;
}

/** Empty-state message per layer type, matching the wording v1 tools use */
const EMPTY_MESSAGE_KEY: Record<string, string> = {
  polygon: "no_polygon_layer_found",
  point: "no_point_layer_found",
  line: "no_line_layer_found",
  no_geometry: "no_table_layers",
};

export default function LayerInput({
  input,
  value,
  onChange,
  onFilterChange,
  disabled,
  excludedLayerIds = [],
}: LayerInputProps) {
  const { t } = useTranslation("common");
  const { projectId } = useParams();
  const { layers: projectLayers } = useFilteredProjectLayers(projectId as string);

  // Filter layers based on geometry constraints and exclusions
  const filteredLayers = useMemo(() => {
    if (!projectLayers) return [];

    let filtered = projectLayers;

    // Apply geometry constraints if present
    if (input.geometryConstraints && input.geometryConstraints.length > 0) {
      const allowedTypes = input.geometryConstraints.map(mapGeometryToLayerType);
      const allowNoGeometry = allowedTypes.includes("no_geometry");

      filtered = filtered.filter((layer) => {
        const layerGeomType = layer.feature_layer_geometry_type?.toLowerCase();

        // Handle no_geometry constraint - match layers without geometry (tables)
        if (allowNoGeometry && !layerGeomType) {
          return true;
        }

        // If no geometry type on layer and we're not looking for tables, skip
        if (!layerGeomType) return false;

        return allowedTypes.some((allowed) => allowed !== "no_geometry" && layerGeomType.includes(allowed));
      });
    }

    // Exclude already-selected layers (for repeatable objects)
    // excludedLayerIds contains project layer IDs (as strings)
    if (excludedLayerIds.length > 0) {
      filtered = filtered.filter((layer) => !excludedLayerIds.includes(String(layer.id)));
    }

    return filtered;
  }, [projectLayers, input.geometryConstraints, excludedLayerIds]);

  // Convert layers to selector items
  // Use project layer id as the unique selector value to handle duplicates correctly
  const layerItems: SelectorItem[] = useMemo(() => {
    return filteredLayers.map((layer) => ({
      value: String(layer.id), // Use project layer id for uniqueness
      label: layer.name,
    }));
  }, [filteredLayers]);

  // Find selected item by project layer id
  const selectedItem = useMemo(() => {
    if (!value) return undefined;
    return layerItems.find((item) => item.value === value);
  }, [value, layerItems]);

  const handleChange = (item: SelectorItem | SelectorItem[] | undefined) => {
    const selectedLayerItem = Array.isArray(item) ? item[0] : item;
    const projectLayerId = selectedLayerItem?.value as string | undefined;

    // Store the project layer id (this uniquely identifies the layer in the project)
    onChange(projectLayerId);

    // Also notify about the associated filter
    if (onFilterChange) {
      if (!projectLayerId) {
        onFilterChange(undefined);
      } else {
        const numericId = parseInt(projectLayerId, 10);
        const selectedLayer = filteredLayers.find((layer) => layer.id === numericId);
        // Extract CQL filter from the layer's query
        const cqlFilter = selectedLayer?.query?.cql as Record<string, unknown> | undefined;
        onFilterChange(cqlFilter);
      }
    }
  };

  // Build tooltip with geometry constraints info
  const tooltip = useMemo(() => {
    // Use uiMeta description (already translated) or fallback to input.description
    let tip = input.uiMeta?.description || input.description || "";
    if (input.geometryConstraints && input.geometryConstraints.length > 0) {
      tip += tip ? "\n\n" : "";
      tip += `${t("accepted_geometry_types")}: ${input.geometryConstraints.join(", ")}`;
    }
    return tip;
  }, [input.uiMeta?.description, input.description, input.geometryConstraints, t]);

  // Get label from uiMeta (already translated) or fallback to title
  const label = input.uiMeta?.label || input.title;

  // Name the geometry the field needs, so an empty selector explains itself
  const emptyMessage = useMemo(() => {
    const types = [...new Set((input.geometryConstraints ?? []).map(mapGeometryToLayerType))];
    const key = types.length === 1 ? EMPTY_MESSAGE_KEY[types[0]] : undefined;
    return t(key ?? "no_layers_found");
  }, [input.geometryConstraints, t]);

  return (
    <Selector
      selectedItems={selectedItem}
      setSelectedItems={handleChange}
      items={layerItems}
      label={label}
      required={input.required}
      tooltip={tooltip}
      placeholder={t("select_layer")}
      emptyMessage={emptyMessage}
      emptyMessageIcon={ICON_NAME.LAYERS}
      disabled={disabled}
    />
  );
}
