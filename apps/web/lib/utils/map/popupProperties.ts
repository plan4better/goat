import type { FormatNumberTypes } from "@/lib/validations/common";
import type { PopupProperties } from "@/lib/validations/layer";

import type { MapPopoverInfoProps } from "@/types/map/popover";

/**
 * Internal columns that must never be shown to the user in a popup.
 */
const HIDDEN_SYSTEM_PROPERTIES = new Set([
  "layer_id",
  "id",
  "_rowid",
  "feature_id",
  "h3_3",
  "h3_6",
  "cluster",
  "clustered",
  "point_count",
  "point_count_abbreviated",
  "sqrt_point_count",
  "ags_gemeinde",
  "ags_landkreis",
]);

export function isSystemPropertyKey(key: string): boolean {
  return HIDDEN_SYSTEM_PROPERTIES.has(key);
}

/**
 * Split raw feature properties into the two buckets a feature popup consumes:
 * objects and arrays go to `jsonProperties` (rendered as nested content),
 * everything else stays a primitive property. Vector tiles carry nested values
 * as JSON strings, GeoJSON sources as the objects themselves.
 */
export function splitPopupProperties(raw: Record<string, unknown> | undefined): {
  properties: NonNullable<MapPopoverInfoProps["properties"]>;
  jsonProperties: NonNullable<MapPopoverInfoProps["jsonProperties"]>;
} {
  const jsonProperties: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  if (raw) {
    for (const key in raw) {
      if (isSystemPropertyKey(key)) continue;
      const value = raw[key];
      if (typeof value === "object" && value !== null) {
        jsonProperties[key] = value;
        continue;
      }
      try {
        const parsedValue = JSON.parse(value as string);
        if (typeof parsedValue === "object" && parsedValue !== null) {
          jsonProperties[key] = parsedValue;
        } else {
          throw new Error("Parsed value is not an object");
        }
      } catch {
        properties[key] = value;
      }
    }
  }
  return {
    properties: properties as NonNullable<MapPopoverInfoProps["properties"]>,
    jsonProperties: jsonProperties as NonNullable<MapPopoverInfoProps["jsonProperties"]>,
  };
}

export type PopupTrigger = "click" | "hover" | "click_and_hover";

export type PopupFieldConfig = {
  fieldOrder: string[];
  fieldLabels: Record<string, string>;
  fieldDecorators: Record<string, { prefix?: string; suffix?: string; format?: FormatNumberTypes }>;
  hasFieldList: boolean;
};

/**
 * Field-list metadata from a popup configuration's `fieldList` blocks (a style's
 * popup, `toPopupConfig`): labels, order and decorators, first definition wins.
 */
export function popupFieldConfigOf(popup: PopupProperties | undefined): PopupFieldConfig {
  const fieldLabels: Record<string, string> = {};
  const fieldOrder: string[] = [];
  const fieldDecorators: PopupFieldConfig["fieldDecorators"] = {};
  for (const block of popup?.blocks ?? []) {
    if (block.type !== "fieldList") continue;
    for (const attr of block.attributes ?? []) {
      if (fieldOrder.includes(attr.name)) continue;
      fieldOrder.push(attr.name);
      fieldLabels[attr.name] = attr.label || attr.name;
      if (attr.format || attr.prefix || attr.suffix) {
        fieldDecorators[attr.name] = {
          ...(attr.format ? { format: attr.format as FormatNumberTypes } : {}),
          ...(attr.prefix ? { prefix: attr.prefix } : {}),
          ...(attr.suffix ? { suffix: attr.suffix } : {}),
        };
      }
    }
  }
  return { fieldOrder, fieldLabels, fieldDecorators, hasFieldList: fieldOrder.length > 0 };
}

/**
 * Narrow raw feature properties to the layer's configured field list. Layers
 * without a field list pass all properties through unchanged.
 */
export function selectPopupProperties(
  fieldConfig: PopupFieldConfig,
  raw: Record<string, unknown>
): Record<string, unknown> {
  if (!fieldConfig.hasFieldList) return raw;
  return fieldConfig.fieldOrder.reduce(
    (acc, name) => {
      if (!isSystemPropertyKey(name)) {
        acc[name] = raw[name];
      }
      return acc;
    },
    {} as Record<string, unknown>
  );
}

/**
 * The `fieldLabels` / `fieldOrder` / `fieldDecorators` slice of a `setPopupInfo`
 * payload, empty when the layer has no field list configured.
 */
export function popupFieldInfo(fieldConfig: PopupFieldConfig): {
  fieldLabels?: Record<string, string>;
  fieldOrder?: string[];
  fieldDecorators?: Record<
    string,
    { prefix?: string; suffix?: string; format?: FormatNumberTypes }
  >;
} {
  if (!fieldConfig.hasFieldList) return {};
  return {
    fieldLabels: fieldConfig.fieldLabels,
    fieldOrder: fieldConfig.fieldOrder,
    ...(Object.keys(fieldConfig.fieldDecorators).length > 0 && {
      fieldDecorators: fieldConfig.fieldDecorators,
    }),
  };
}
