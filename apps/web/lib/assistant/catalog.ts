import { fitContext } from "@/lib/assistant/chips";
import type { CatalogContext, CatalogFiltersPayload } from "@/lib/assistant/types";
import { type CatalogSearchSnapshot, DEFAULT_SORT } from "@/lib/catalog/searchQuery";
import type { CatalogSpatialFilter } from "@/lib/catalog/spatial";

/**
 * The catalog page with a proposal's search and filters in its URL. The page
 * keeps its state in the query string (useCatalogSearchState), so outside the
 * catalog a page-state proposal is a link (spec §8.2).
 *
 * List values are joined with a literal comma, the page's list separator, so
 * each value is encoded on its own: a comma inside a value becomes %2C and
 * stays part of that value.
 */
export function catalogHref(payload: CatalogFiltersPayload): string {
  const parts: string[] = [];
  const add = (key: string, value: string) => parts.push(`${key}=${value}`);
  const list = (key: string, values: string[]) => {
    if (values.length) add(key, values.map(encodeURIComponent).join(","));
  };
  if (payload.q) add("q", encodeURIComponent(payload.q));
  for (const [key, values] of Object.entries(payload.facets)) list(encodeURIComponent(key), values);
  if (payload.from) add("from", encodeURIComponent(payload.from));
  if (payload.to) add("to", encodeURIComponent(payload.to));
  list("nuts", payload.nuts);
  if (payload.sortby) add("sortby", encodeURIComponent(payload.sortby));
  return parts.length ? `/catalog?${parts.join("&")}` : "/catalog";
}

/** The server's patterns for catalog context (context.py): a value that does not match is left out. */
const FACET_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const NUTS_ID = /^[A-Z]{2}[A-Z0-9]{0,3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SORTBY = /^-?[A-Za-z0-9_.:]+(,-?[A-Za-z0-9_.:]+)*$/;
const RECORD_ID = /^[A-Za-z0-9._:-]{1,300}$/;

/** The server counts characters, not UTF-16 units, and cutting inside a surrogate pair would leave half of one. */
const cut = (value: string, max: number): string => Array.from(value).slice(0, max).join("");

/** `YYYY-MM-DD` naming a real day (the server parses it as a date). */
export function isCalendarDate(value: string): boolean {
  // Python's date has no year 0, and Date would read "0000" as year 0 too.
  if (!DATE.test(value) || value.startsWith("0000")) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

/** A record id as the server accepts it, decoded from the URL segment it came from; undefined otherwise. */
export function recordIdForContext(raw: string): string | undefined {
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // not percent-encoded: use it as it is
  }
  return RECORD_ID.test(id) ? id : undefined;
}

export interface CatalogPageState {
  q?: string | null;
  sortby?: string | null;
  from?: string | null;
  to?: string | null;
  spatial?: CatalogSpatialFilter | null;
  facetSelections: Record<string, string[]>;
  selectedRecordId?: string | null;
}

/** The catalog page's context (spec §6.3), within the limits the server enforces. */
export function catalogContextFromState(state: CatalogPageState): CatalogContext {
  const context: CatalogContext = { surface: "catalog" };
  const q = state.q?.trim();
  if (q) context.q = cut(q, 500);
  const facets = Object.entries(state.facetSelections)
    .filter(([key, values]) => FACET_KEY.test(key) && values.length > 0)
    .slice(0, 20)
    .map(([key, values]) => [key, values.slice(0, 50).map((value) => cut(value, 200))] as const);
  if (facets.length) context.facets = Object.fromEntries(facets);
  const from = state.from && isCalendarDate(state.from) ? state.from : undefined;
  const to = state.to && isCalendarDate(state.to) ? state.to : undefined;
  // The server refuses a range that ends before it starts: say nothing about it.
  if (!(from && to && from > to)) {
    if (from) context.from = from;
    if (to) context.to = to;
  }
  // A drawn shape or a buffered point is not a NUTS region; only regions travel as context.
  const nuts =
    state.spatial?.kind === "region"
      ? state.spatial.nutsIds.filter((id) => NUTS_ID.test(id)).slice(0, 20)
      : [];
  if (nuts.length) context.nuts = nuts;
  // Cut short, a sort expression could stop matching; one that does not match is left out.
  if (
    state.sortby &&
    state.sortby !== DEFAULT_SORT &&
    state.sortby.length <= 100 &&
    SORTBY.test(state.sortby)
  ) {
    context.sortby = state.sortby;
  }
  const recordId = state.selectedRecordId ? recordIdForContext(state.selectedRecordId) : undefined;
  if (recordId) context.selected_record_id = recordId;
  // The composer fits the final body (sources included) again; this keeps the page's part alone within the limit.
  return fitContext(context) as CatalogContext;
}

/** A filters proposal as the page's URL values: it replaces search, filters and the spatial filter. */
export function proposalToSnapshot(payload: CatalogFiltersPayload): CatalogSearchSnapshot {
  return {
    q: payload.q,
    sortby: payload.sortby ?? DEFAULT_SORT,
    from: payload.from,
    to: payload.to,
    nuts: payload.nuts.length ? payload.nuts.join(",") : null,
    pt: null,
    poly: null,
    facets: payload.facets,
  };
}
