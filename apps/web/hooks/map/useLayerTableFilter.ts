"use client";

// The data table's column filters on a project layer: the layer's own filter (useLayerFilter), so the column popover
// and the layer Filter tab read and write the same rows. A save goes through the Filter tab's save, which sends the
// whole query: the switched-off rows, custom rows and a stored metadata stay as they were.
import { useCallback, useMemo, useRef } from "react";

import { type FilterRow, removeRow, upsertRow } from "@/lib/filter/model";
import type { ProjectLayer } from "@/lib/validations/project";

import type { TableFilterController } from "@/types/map/tableFilter";

import { useLayerFilter } from "@/hooks/map/useLayerFilter";

export function useLayerTableFilter(
  projectId: string,
  projectLayer: Pick<ProjectLayer, "id" | "layer_id" | "query">,
  canEdit: boolean
): TableFilterController {
  const { model, fields, canEdit: mayEdit, isLoading, apply } = useLayerFilter(projectId, projectLayer);
  // The rows as of now, so a change made from a callback taken before the last save starts from the latest.
  const latest = useRef(model);
  latest.current = model;

  const upsert = useCallback((row: FilterRow) => apply(upsertRow(latest.current, row)), [apply]);
  const remove = useCallback((id: string) => apply(removeRow(latest.current, id)), [apply]);

  return useMemo(
    // Written without the fields, the rows would guess their types.
    () => ({ model, fields, upsert, remove, canEdit: canEdit && mayEdit && !isLoading }),
    [model, fields, upsert, remove, canEdit, mayEdit, isLoading]
  );
}

export default useLayerTableFilter;
