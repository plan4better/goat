"use client";

import { useMemo } from "react";

import { PAGE_SIZE, type SortDir } from "@/lib/api/usage";

export interface LocalListOptions<T> {
  /** The text a row is found by; without it the query filters nothing. */
  search?: (row: T) => string;
  query: string;
  /** A column's key: the sort a list's header asks for. Rows without a value
   * for it sort last. */
  sort: { key: string; dir: SortDir };
  /** 1-based. */
  page: number;
  pageSize?: number;
}

/** Strings in the reader's collation, numbers by value. */
const compareValues = (a: unknown, b: unknown): number =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));

/**
 * Search, sort and page over rows that are all in memory, for the lists that
 * are small by nature (tools, members, days, periods): case-insensitive
 * substring search, rows without a value for the sort key last in both
 * directions, and the page held within the pages left after a search. `page`
 * is the page it holds, which the range text and the pager show.
 */
export function useLocalList<T extends object>(
  rows: T[] | undefined,
  { search, query, sort, page, pageSize = PAGE_SIZE }: LocalListOptions<T>
): { pageRows: T[]; total: number; pageCount: number; page: number } {
  const { key, dir } = sort;
  const needle = query.trim().toLowerCase();

  const sorted = useMemo(() => {
    const found =
      needle && search
        ? (rows ?? []).filter((row) => search(row).toLowerCase().includes(needle))
        : [...(rows ?? [])];
    return found.sort((a, b) => {
      const x = (a as Record<string, unknown>)[key];
      const y = (b as Record<string, unknown>)[key];
      const xMissing = x === null || x === undefined;
      const yMissing = y === null || y === undefined;
      if (xMissing || yMissing) return Number(xMissing) - Number(yMissing);
      return dir === "asc" ? compareValues(x, y) : compareValues(y, x);
    });
  }, [rows, search, needle, key, dir]);

  const total = sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  const pageRows = useMemo(
    () => sorted.slice((current - 1) * pageSize, current * pageSize),
    [sorted, current, pageSize]
  );
  return { pageRows, total, pageCount, page: current };
}
