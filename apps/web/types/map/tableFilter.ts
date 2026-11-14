import type { Fields, FilterModel, FilterRow } from "@/lib/filter/model";

/**
 * What a table host gives the column filter popover so it can read and change
 * filters without knowing where they live.
 *
 * The map data table backs this with the project layer's filter (persisted,
 * and shared with the layer Filter panel). A dashboard table backs it with view
 * state ANDed onto the author's base filter, so a viewer's filter is never
 * written into the published config.
 */
export type TableFilterController = {
  /** The filter's rows as the host keeps them. */
  model: FilterModel;
  /** The layer's fields with their types, for writing the rows. */
  fields: Fields;
  /** Replace the row with this id, or append when the id is unknown. */
  upsert: (row: FilterRow) => Promise<void> | void;
  remove: (id: string) => Promise<void> | void;
  /** False for viewers who may not change this host's filters. */
  canEdit: boolean;
};
