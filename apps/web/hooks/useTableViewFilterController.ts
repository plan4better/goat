import { useCallback, useMemo, useState } from "react";

import { type Fields, type FilterModel, type FilterRow, removeRow, upsertRow } from "@/lib/filter/model";
import { writeFilter } from "@/lib/filter/write";

import type { TableFilterController } from "@/types/map/tableFilter";

const NO_FILTER: FilterModel = { match: "all", rows: [] };

/**
 * Filter controller for tables with nowhere to persist to: a dashboard table,
 * including a published one.
 *
 * Rows live in component state and are ANDed onto whatever filter the author
 * configured. They are never written back to the project or the published
 * dashboard config, so a viewer narrowing a table cannot change what anyone else
 * sees.
 */
export const useTableViewFilterController = (fields: Fields, options?: { canEdit?: boolean }) => {
  const [model, setModel] = useState<FilterModel>(NO_FILTER);

  const upsert = useCallback((row: FilterRow) => setModel((previous) => upsertRow(previous, row)), []);
  const remove = useCallback((id: string) => setModel((previous) => removeRow(previous, id)), []);
  const clear = useCallback(() => setModel(NO_FILTER), []);

  /** Stringified CQL for the items query, or undefined when nothing is filtered. */
  const cqlFilter = useMemo(() => {
    const { cql } = writeFilter(model, fields);
    return cql ? JSON.stringify(cql) : undefined;
  }, [model, fields]);

  const controller = useMemo<TableFilterController>(
    () => ({ model, fields, upsert, remove, canEdit: options?.canEdit ?? true }),
    [model, fields, upsert, remove, options?.canEdit]
  );

  return { controller, cqlFilter, clear };
};

/** AND two stringified CQL filters, tolerating either being absent. */
export const combineCqlFilters = (...filters: Array<string | undefined>): string | undefined => {
  const present = filters.filter((filter): filter is string => !!filter);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return JSON.stringify({ op: "and", args: present.map((filter) => JSON.parse(filter)) });
};

export default useTableViewFilterController;
