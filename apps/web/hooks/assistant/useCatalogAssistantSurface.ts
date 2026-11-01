"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import {
  catalogContextFromState,
  catalogHref,
  proposalToSnapshot,
  recordIdForContext,
} from "@/lib/assistant/catalog";
import { useAssistantSurface } from "@/lib/assistant/surface";
import type { CatalogSearchSnapshot } from "@/lib/catalog/searchQuery";
import type { CatalogSpatialFilter } from "@/lib/catalog/spatial";

export interface CatalogSearchForAssistant {
  state: { q?: string | null; sortby?: string | null; from?: string | null; to?: string | null };
  spatial: CatalogSpatialFilter | null;
  facetSelections: Record<string, string[]>;
  snapshot: () => CatalogSearchSnapshot;
  replaceSearch: (next: CatalogSearchSnapshot) => void;
}

/**
 * The catalog surface (spec §10): the page's search as context, and filter
 * proposals applied to the page's own URL state, so the result is an ordinary
 * search with facets, counts, sorting and a shareable URL.
 *
 * The adapter registers again only when the context changes (`contextKey`).
 * It has no preview: the applied search is the preview.
 */
export function useCatalogAssistantSurface(search: CatalogSearchForAssistant): void {
  const { q, sortby, from, to } = search.state;
  const context = useMemo(
    () =>
      catalogContextFromState({
        q,
        sortby,
        from,
        to,
        spatial: search.spatial,
        facetSelections: search.facetSelections,
      }),
    [q, sortby, from, to, search.spatial, search.facetSelections]
  );
  useAssistantSurface({
    surface: "catalog",
    contextKey: JSON.stringify(context),
    getContext: () => context,
    apply: (proposal) => {
      if (proposal.kind !== "catalog.filters") return;
      const before = search.snapshot();
      search.replaceSearch(proposalToSnapshot(proposal.payload));
      return () => {
        search.replaceSearch(before);
      };
    },
  });
}

/** A catalog record page: the record as context; Apply opens the catalog with the filters. */
export function useCatalogRecordAssistantSurface(recordId: string): void {
  const router = useRouter();
  useAssistantSurface({
    surface: "catalog",
    contextKey: recordId,
    getContext: () => {
      const id = recordIdForContext(recordId);
      return id ? { surface: "catalog", selected_record_id: id } : { surface: "catalog" };
    },
    apply: (proposal) => {
      if (proposal.kind === "catalog.filters") router.push(catalogHref(proposal.payload));
    },
  });
}
