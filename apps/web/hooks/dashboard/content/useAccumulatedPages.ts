"use client";

import { useEffect, useMemo, useState } from "react";

import type { ContentItem, ContentPage } from "@/lib/validations/content";

/** Whether a page already accumulated is the one just fetched. SWR hands
 * back fresh objects on every revalidation, so the rows are compared by
 * content, not by reference — storing an equal page again would re-render
 * for nothing, and re-render endlessly where the fetched object is new on
 * every render. Identity and `updated_at` alone are not enough: sharing,
 * restricting or publishing an item changes its row without touching
 * `updated_at`, and the page must pick those up so the audience chip
 * follows the change without a reload. */
const samePage = (stored: ContentItem[] | undefined, fetched: ContentItem[]): boolean =>
  !!stored &&
  stored.length === fetched.length &&
  stored.every((item, index) => JSON.stringify(item) === JSON.stringify(fetched[index]));

export interface AccumulatedPages {
  /** Every page listed so far for this collection, in page order. */
  items: ContentItem[];
  /** How many rows the collection holds, as the last page reported. */
  total: number;
  /** Whether the feed has answered for this collection at all — rows, or a
   * page that came back empty. A caller stands a skeleton until it has, so a
   * collection still in flight is never reported as empty. */
  loaded: boolean;
  /** Whether the collection holds more than the pages listed so far. */
  hasMore: boolean;
}

/**
 * Accumulates the pages of one content feed. "Load more" asks for the next
 * page at a fixed size — the content endpoint caps `size` at 100, so a
 * request that grew the size instead would 422 from the third page on and
 * leave the rest of a large space unreachable — which means the pages
 * already listed have to be kept here rather than re-read.
 *
 * `collectionKey` is what the feed is being asked for, page aside: another
 * space, folder, view, search, filter or sort starts the accumulation over,
 * during the render that asks for it, so pages of two different orderings
 * are never listed together.
 */
export const useAccumulatedPages = (
  fetchedPage: ContentPage | undefined,
  requestedPage: number,
  collectionKey: string | null
): AccumulatedPages => {
  const [fetched, setFetched] = useState<{ pages: Record<number, ContentItem[]>; total: number }>({
    pages: {},
    total: 0,
  });

  const [fetchedKey, setFetchedKey] = useState(collectionKey);
  if (fetchedKey !== collectionKey) {
    setFetchedKey(collectionKey);
    setFetched({ pages: {}, total: 0 });
  }

  useEffect(() => {
    if (!fetchedPage) return;
    setFetched((prev) =>
      prev.total === fetchedPage.total && samePage(prev.pages[requestedPage], fetchedPage.items)
        ? prev
        : { pages: { ...prev.pages, [requestedPage]: fetchedPage.items }, total: fetchedPage.total }
    );
  }, [fetchedPage, requestedPage]);

  const items = useMemo(
    () =>
      Object.keys(fetched.pages)
        .map(Number)
        .sort((a, b) => a - b)
        .flatMap((number) => fetched.pages[number]),
    [fetched]
  );

  return {
    items,
    total: fetched.total,
    loaded: items.length > 0 || !!fetchedPage,
    hasMore: fetched.total > items.length,
  };
};
