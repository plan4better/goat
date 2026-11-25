import { useMemo } from "react";

import { useLayerQueryables } from "@/lib/api/layers";

type PseudoFieldName = "$area" | "$length" | "$perimeter";

interface PseudoField {
  name: PseudoFieldName;
  type: "string" | "number" | "object";
  kind?: string;
  is_computed?: boolean;
  is_locked?: boolean;
  allowed_values?: (string | number)[];
  allow_other?: boolean;
  default_value?: string | number | boolean | null;
  display_config?: Record<string, unknown>;
}

/** One array for every call, so the fields memo below holds across renders. */
const HIDDEN_FIELDS = ["layer_id", "id", "h3_3", "h3_6", "geom", "geometry"];

const useLayerFields = (
  dataset_id: string,
  filterType?: "string" | "number" | "date" | undefined,
  hiddenFields: string[] = HIDDEN_FIELDS,
  includePseudoFields: boolean = false
) => {
  const { queryables, isLoading, isError } = useLayerQueryables(dataset_id || "");

  const layerFields = useMemo(() => {
    if (!queryables || !dataset_id) return [];

    // Get fields from queryables
    // API returns "integer" for int columns, normalize to "number" for frontend
    const normalizeType = (prop: { type: string; kind?: string; format?: string }) => {
      if (prop.kind === "datetime" || prop.format === "date-time") return "date";
      return prop.type === "integer" ? "number" : prop.type;
    };

    const queryableFields = Object.entries(queryables.properties)
      .filter(([key, value]) => {
        if (hiddenFields.includes(key)) {
          return false;
        }
        const normalizedType = normalizeType(value);
        if (filterType) {
          return normalizedType === filterType;
        } else {
          return (
            normalizedType === "string" ||
            normalizedType === "number" ||
            normalizedType === "object" ||
            normalizedType === "date" ||
            normalizedType === "boolean"
          );
        }
      })
      .map(([key, value]) => {
        const v = value as {
          type: string;
          kind?: string;
          format?: string;
          is_computed?: boolean;
          is_locked?: boolean;
          is_generated?: boolean;
          allowed_values?: (string | number)[];
          allow_other?: boolean;
          default_value?: string | number | boolean | null;
          display_config?: Record<string, unknown>;
          formula?: string;
          output_kind?: string;
        };
        return {
          name: key,
          type: normalizeType(v),
          kind: v.kind,
          is_computed: v.is_computed ?? false,
          is_locked: v.is_locked ?? false,
          is_generated: v.is_generated ?? false,
          allowed_values: v.allowed_values,
          allow_other: v.allow_other ?? false,
          default_value: v.default_value,
          display_config: v.display_config ?? {},
          formula: v.formula,
          output_kind: v.output_kind,
        };
      });

    // Determine pseudo fields based on geometry type
    let pseudoFields: PseudoField[] = [];

    if (includePseudoFields && queryables.properties?.geom) {
      const geomRef = queryables.properties.geom?.$ref;

      if (geomRef) {
        // Check for Polygon or MultiPolygon
        if (geomRef.includes("Polygon")) {
          pseudoFields = [{ name: "$area", type: "number" }];
        }
        // Check for LineString or MultiLineString
        else if (geomRef.includes("LineString")) {
          pseudoFields = [{ name: "$length", type: "number" }];
        }
        // Point or MultiPoint - no pseudo fields
      }
    }

    // Filter pseudo fields based on filterType if specified
    const filteredPseudoFields = pseudoFields.filter((field) => {
      if (filterType) {
        return field.type === filterType;
      }
      return true;
    });

    // Combine queryable fields with pseudo fields
    return [...queryableFields, ...filteredPseudoFields];
  }, [dataset_id, filterType, queryables, hiddenFields, includePseudoFields]);

  return {
    layerFields,
    isLoading,
    isError,
  };
};

export default useLayerFields;
export type { PseudoField, PseudoFieldName };
