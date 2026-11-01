/**
 * Generic Enum Input Component
 *
 * Renders a dropdown selector for enum values from OGC process schema.
 * Supports filtering enum values based on layer geometry types.
 * enum_labels and field labels/descriptions are already translated by the backend.
 */
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { formatInputName } from "@/lib/utils/ogc-utils";

import type { SelectorItem } from "@/types/map/common";
import type { ProcessedInput } from "@/types/map/ogc-processes";

import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";

import Selector from "@/components/map/panels/common/Selector";

// Set of valid icon names for runtime validation
const VALID_ICONS = new Set(Object.values(ICON_NAME));

interface EnumInputProps {
  input: ProcessedInput;
  value: string | number | boolean | undefined;
  onChange: (value: string | number | boolean | undefined) => void;
  disabled?: boolean;
  /** Form values for geometry-based filtering */
  formValues?: Record<string, unknown>;
}

export default function EnumInput({ input, value, onChange, disabled, formValues = {} }: EnumInputProps) {
  const { t } = useTranslation("common");
  const { projectId } = useParams();
  const { layers: projectLayers } = useFilteredProjectLayers(projectId as string);

  // Get icon and label mappings from x-ui metadata
  const enumIcons = input.uiMeta?.enum_icons;
  const enumLabels = input.uiMeta?.enum_labels as Record<string, string> | undefined;

  // Check for geometry-based enum filtering
  const enumGeometryFilter = input.uiMeta?.widget_options?.enum_geometry_filter as
    | { source_layer: string; [enumValue: string]: string | string[] }
    | undefined;

  // Get the geometry type of the selected layer (if filtering is enabled)
  const selectedLayerGeometry = useMemo(() => {
    if (!enumGeometryFilter || !projectLayers) return null;

    const sourceLayerField = enumGeometryFilter.source_layer;
    const selectedLayerId = formValues[sourceLayerField];

    if (!selectedLayerId || typeof selectedLayerId !== "string") return null;

    const layer = projectLayers.find(
      (l) => l.id === Number(selectedLayerId) || l.layer_id === selectedLayerId
    );

    return layer?.feature_layer_geometry_type || null;
  }, [enumGeometryFilter, formValues, projectLayers]);

  // Filter enum values based on geometry constraints
  const filteredEnumValues = useMemo(() => {
    if (!input.enumValues) return [];

    // If no geometry filter or no layer selected, show all options
    if (!enumGeometryFilter || !selectedLayerGeometry) {
      return input.enumValues;
    }

    return input.enumValues.filter((enumValue) => {
      const allowedGeometries = enumGeometryFilter[String(enumValue)];

      // If no constraint for this enum value, always show it
      if (!allowedGeometries) return true;

      // Check if the selected layer's geometry matches allowed types
      const allowedList = Array.isArray(allowedGeometries) ? allowedGeometries : [allowedGeometries];
      return allowedList.some((allowed) =>
        selectedLayerGeometry.toLowerCase().includes(allowed.toLowerCase())
      );
    });
  }, [input.enumValues, enumGeometryFilter, selectedLayerGeometry]);

  // Convert enum values to selector items
  const enumItems: SelectorItem[] = useMemo(() => {
    return filteredEnumValues.map((enumValue) => {
      // Get label: use enum_labels if provided (already translated from backend), otherwise format the value
      let label: string;
      const enumKey = String(enumValue);
      if (enumLabels && enumLabels[enumKey]) {
        // enum_labels are already translated by the backend
        label = enumLabels[enumKey];
      } else {
        // Fallback to formatted enum value
        label = formatInputName(enumKey);
      }

      const item: SelectorItem = {
        value: enumValue as string | number,
        label,
      };
      // Add icon if available from x-ui metadata and valid
      if (enumIcons && enumIcons[enumKey]) {
        const iconName = enumIcons[enumKey];
        // Only add icon if it's a valid ICON_NAME, otherwise skip (graceful fallback)
        if (VALID_ICONS.has(iconName as ICON_NAME)) {
          item.icon = iconName as ICON_NAME;
        }
      }
      return item;
    });
  }, [filteredEnumValues, enumIcons, enumLabels]);

  // Find selected item
  const selectedItem = useMemo(() => {
    if (value === undefined || value === null) return undefined;
    return enumItems.find((item) => item.value === value);
  }, [value, enumItems]);

  const handleChange = (item: SelectorItem | SelectorItem[] | undefined) => {
    if (Array.isArray(item)) {
      onChange(item[0]?.value as string | number | undefined);
    } else {
      onChange(item?.value as string | number | undefined);
    }
  };

  // Get label and description - already translated from backend via x-ui metadata
  const label = input.uiMeta?.label || input.title;
  const description = input.uiMeta?.description || input.description;

  // Don't render if no items available (prevents MUI empty state loop)
  if (enumItems.length === 0) {
    return null;
  }

  return (
    <Selector
      selectedItems={selectedItem}
      setSelectedItems={handleChange}
      items={enumItems}
      label={label}
      required={input.required}
      tooltip={description}
      // Sharing a row is what makes a wrapped label a problem: it pushes the
      // field beside it out of shape. A field on its own row wraps as before.
      truncateLabel={!!input.uiMeta?.inline_group}
      placeholder={t("select_option")}
      disabled={disabled}
    />
  );
}
