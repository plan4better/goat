"use client";

// A dataset's fields as the filter reads and writes them: by name with their types, a date told from a moment (the
// filter writes "is on" a day differently for each). The same request as the layer's other field lists.
import { useMemo } from "react";

import { useLayerQueryables } from "@/lib/api/layers";
import type { Fields } from "@/lib/filter/model";

import { fieldsOf } from "@/hooks/style/useStyleData";

import type { FieldInfo } from "@/components/map/panels/styleEditor/context";

export function useFilterFields(layerId: string | undefined): {
  fields: Fields;
  fieldInfos: FieldInfo[];
  /** Still loading: rows read now would guess their fields' types. */
  isLoading: boolean;
} {
  const { queryables, isLoading } = useLayerQueryables(layerId || "");
  const fieldInfos = useMemo(
    () => fieldsOf(queryables?.properties as Parameters<typeof fieldsOf>[0]),
    [queryables]
  );
  const fields = useMemo<Fields>(
    () => Object.fromEntries(fieldInfos.map((f) => [f.name, f.type])),
    [fieldInfos]
  );
  return { fields, fieldInfos, isLoading: !!layerId && !queryables && !!isLoading };
}
