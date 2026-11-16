"use client";

// The filter panel's draft: the rows and the area as the user is editing them, in a small store so that a row's editor
// (drawn once in a popover) reads its row live and a change of one row renders only what shows that row. Unfinished
// rows live here and nowhere else until they are complete. A style rule's conditions are such a draft too
// (styleEditor/editors/RuleConditions.tsx), so its rows and editors are the panel's.
import { createContext, useContext, useSyncExternalStore } from "react";

import type { FilterArea } from "@/lib/filter/area";
import {
  type Fields,
  type FilterCondition,
  type FilterModel,
  type FilterOp,
  type FilterRow,
  isCustomRow,
} from "@/lib/filter/model";
import { rowToCql } from "@/lib/filter/rows";
import { writeFilter } from "@/lib/filter/write";
import type { FieldType } from "@/lib/style/compile/types";

import type { FieldInfo } from "@/components/map/panels/styleEditor/context";

export type DraftAction =
  | { type: "update"; id: string; patch: Partial<FilterCondition> }
  | { type: "remove"; id: string }
  | { type: "toggle"; id: string }
  | { type: "match"; match: FilterModel["match"] }
  | { type: "add"; row: FilterRow }
  | { type: "area"; area: FilterArea | undefined }
  | { type: "clear" };

/** No area is no key: the model compares as it was read. */
function withoutArea(model: FilterModel): FilterModel {
  const { area: _area, ...rest } = model;
  return rest;
}

/** The draft after one action; the same object when the action changes nothing. */
export function reduceDraft(model: FilterModel, action: DraftAction): FilterModel {
  switch (action.type) {
    case "update":
      return {
        ...model,
        rows: model.rows.map((row) =>
          row.id === action.id && !isCustomRow(row) ? { ...row, ...action.patch } : row
        ),
      };
    case "remove":
      return { ...model, rows: model.rows.filter((row) => row.id !== action.id) };
    case "toggle":
      return {
        ...model,
        rows: model.rows.map((row) => (row.id === action.id ? { ...row, enabled: !row.enabled } : row)),
      };
    case "match":
      return action.match === model.match ? model : { ...model, match: action.match };
    case "add":
      return { ...model, rows: [...model.rows, action.row] };
    case "area":
      if (action.area === model.area) return model;
      return action.area ? { ...model, area: action.area } : withoutArea(model);
    case "clear":
      return model.rows.length || model.area ? { ...withoutArea(model), rows: [] } : model;
  }
}

/** The type a row's value is read and written with: the field's, or for a field the layer no longer has the type its
 * saved value showed. */
export const typeOfRow = (row: FilterCondition, fields: Fields): FieldType | undefined =>
  Object.prototype.hasOwnProperty.call(fields, row.field) ? fields[row.field] : row.type;

/** A row that saves nothing yet: no field, no value, or a text the filter cannot search. */
export const isUnfinished = (row: FilterRow, fields: Fields) =>
  rowToCql(row, typeOfRow(row, fields), { orEmpty: true }) === null;

/** What a model saves, as text to compare. */
export const writtenText = (model: FilterModel, fields: Fields) => JSON.stringify(writeFilter(model, fields));

export class DraftStore {
  private model: FilterModel;
  private listeners = new Set<() => void>();

  constructor(model: FilterModel) {
    this.model = model;
  }

  get = (): FilterModel => this.model;

  set(next: FilterModel): void {
    if (next === this.model) return;
    this.model = next;
    this.listeners.forEach((listener) => listener());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}

/** What a row and its editor change the draft with; the functions never change, so memoized rows hold. */
export interface DraftActions {
  update(id: string, patch: Partial<FilterCondition>): void;
  remove(id: string): void;
  toggle(id: string): void;
  setMatch(match: FilterModel["match"]): void;
  add(row: FilterRow): void;
  /** Sets the area, or removes it with nothing. */
  setArea(area: FilterArea | undefined): void;
  clear(): void;
}

export interface FilterPanelContextValue {
  store: DraftStore;
  actions: DraftActions;
  fields: Fields;
  fieldInfos: FieldInfo[];
  /** The dataset the value lists are read from; without it values are typed. */
  layerId?: string;
  /** The comparisons a field of `type` offers, the first one a new row's; the filter's own without it (a style
   * rule's leave out relative dates). */
  operators?: (type: FieldType | undefined) => FilterOp[];
}

export const FilterPanelContext = createContext<FilterPanelContextValue | null>(null);

export function useFilterPanel(): FilterPanelContextValue {
  const value = useContext(FilterPanelContext);
  if (!value) throw new Error("useFilterPanel needs a FilterPanel");
  return value;
}

/** One row of the draft by its id, read live; undefined once it is gone. */
export function useDraftRow(id: string) {
  const { store } = useFilterPanel();
  const read = () => store.get().rows.find((row) => row.id === id);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The draft's area, read live; undefined without one. */
export function useDraftArea(): FilterArea | undefined {
  const { store } = useFilterPanel();
  const read = () => store.get().area;
  return useSyncExternalStore(store.subscribe, read, read);
}
