/**
 * Multi-Select Enum Input Component
 *
 * Renders a multi-select dropdown for array of enum values.
 * Used for fields like pt_modes where users can select multiple options.
 * enum_labels and field labels/descriptions are already translated by the backend.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { formatInputName, getEffectiveSchema } from "@/lib/utils/ogc-utils";

import type { SelectorItem } from "@/types/map/common";
import type { OGCInputSchema } from "@/types/map/ogc-processes";
import type { ProcessedInput } from "@/types/map/ogc-processes";

import Selector from "@/components/map/panels/common/Selector";

// Set of valid icon names for runtime validation
const VALID_ICONS = new Set(Object.values(ICON_NAME));

interface MultiEnumInputProps {
  input: ProcessedInput;
  value: (string | number)[] | undefined;
  onChange: (value: (string | number)[] | undefined) => void;
  disabled?: boolean;
  /** Schema definitions ($defs) for resolving $ref */
  schemaDefs?: Record<string, OGCInputSchema>;
}

export default function MultiEnumInput({
  input,
  value,
  onChange,
  disabled,
  schemaDefs,
}: MultiEnumInputProps) {
  const { t } = useTranslation("common");

  // Get icon and label mappings from x-ui metadata
  const enumIcons = input.uiMeta?.enum_icons;
  const enumLabels = input.uiMeta?.enum_labels as Record<string, string> | undefined;

  // Get enum values from the items schema, resolving $ref if needed
  const enumValues = useMemo(() => {
    const effectiveSchema = getEffectiveSchema(input.schema);
    let itemSchema = effectiveSchema.items;

    if (!itemSchema) return [];

    // Resolve $ref if present
    if (itemSchema.$ref && schemaDefs) {
      const refName = itemSchema.$ref.replace("#/$defs/", "");
      const resolvedSchema = schemaDefs[refName];
      if (resolvedSchema) {
        itemSchema = resolvedSchema;
      }
    }

    // Get enum values from item schema
    if (itemSchema.enum) {
      return itemSchema.enum as (string | number)[];
    }

    // Fallback to input's enumValues if available
    return input.enumValues || [];
  }, [input.schema, input.enumValues, schemaDefs]);

  // Convert enum values to selector items
  const enumItems: SelectorItem[] = useMemo(() => {
    return enumValues.map((enumValue) => {
      // Get label: use enum_labels if provided (already translated from backend), otherwise format the value
      let label: string;
      if (enumLabels && typeof enumValue === "string" && enumLabels[enumValue]) {
        // enum_labels are already translated by the backend
        label = enumLabels[enumValue];
      } else {
        // Fallback to formatted enum value
        label = formatInputName(String(enumValue));
      }

      const item: SelectorItem = {
        value: enumValue as string | number,
        label,
      };

      // Add icon if available from x-ui metadata and valid
      if (enumIcons && typeof enumValue === "string" && enumIcons[enumValue]) {
        const iconName = enumIcons[enumValue];
        // Only add icon if it's a valid ICON_NAME, otherwise skip (graceful fallback)
        if (VALID_ICONS.has(iconName as ICON_NAME)) {
          item.icon = iconName as ICON_NAME;
        }
      }
      return item;
    });
  }, [enumValues, enumIcons, enumLabels]);

  // Find selected items
  const selectedItems = useMemo(() => {
    if (!value || value.length === 0) return [];
    return enumItems.filter((item) => value.includes(item.value as string | number));
  }, [value, enumItems]);

  const handleChange = (item: SelectorItem | SelectorItem[] | undefined) => {
    if (!item) {
      onChange(undefined);
      return;
    }

    const items = Array.isArray(item) ? item : [item];
    const values = items.map((i) => i.value as string | number);
    onChange(values.length > 0 ? values : undefined);
  };

  // Get label and description - already translated from backend via x-ui metadata
  const label = input.uiMeta?.label || input.title;
  const description = input.uiMeta?.description || input.description;

  return (
    <Selector
      selectedItems={selectedItems}
      setSelectedItems={handleChange}
      items={enumItems}
      multiple
      label={label}
      required={input.required}
      tooltip={description}
      placeholder={t("select_options")}
      allSelectedLabel={t("all")}
      disabled={disabled}
    />
  );
}
