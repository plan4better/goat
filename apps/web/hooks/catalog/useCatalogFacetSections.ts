"use client";

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { CatalogSearchParams } from "@/lib/api/catalog";
import type { CatalogAggregation } from "@/lib/validations/catalog";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useCatalogFacetBuckets } from "@/hooks/catalog/useCatalogFacetBuckets";
import { useGetMetadataValueTranslation } from "@/hooks/map/DatasetHooks";

import type { CatalogFacetSection } from "@/components/dashboard/catalog/CatalogFilterPanel";

/**
 * The sidebar's facet sections: which facets to offer, their labels and their
 * bucket counts under the filters currently in force.
 *
 * Shared because two surfaces show the same sidebar — the catalog page and the Add
 * Layer picker. Keeping it in one place is what stops their filters from drifting
 * apart, which is the sort of difference nobody notices until the counts disagree.
 */

const FACET_ICONS: Record<string, ICON_NAME> = {
  type: ICON_NAME.LAYERS,
  geometry_type: ICON_NAME.POLYGON_FEATURE,
  themes: ICON_NAME.DATA_CATEGORY,
  publisher: ICON_NAME.ORGANIZATION,
  language: ICON_NAME.LANGUAGE,
  license: ICON_NAME.LICENSE,
};

/** Buckets are published under a facet's own name; values are translated through
 * the metadata vocabulary, which names two of them differently. */
const FACET_VOCABULARY: Record<string, string> = {
  themes: "data_category",
  language: "language_code",
};

/**
 * Headings that differ from the metadata field names: as a pair of filter
 * categories, "Type" next to "Geometry type" makes a reader work out which type is
 * which, so a browse filter takes the shorter noun.
 */
const FACET_LABEL_KEYS: Record<string, string> = {
  type: "catalog_facet_type",
  geometry_type: "catalog_facet_geometry",
};

/** Facets whose buckets are too sparse to be worth a sidebar section. */
const MIN_BUCKETS_TO_OFFER = 2;

/**
 * Facets the sidebar does not offer, whatever the server reports.
 *
 * `geographical_code` is a coarse country/continent code on 71 of 3,834 datasets,
 * all but one saying `AT`. The spatial filter answers the same question against
 * real geometry, so offering both put two "where" controls in one sidebar, one of
 * which covers 1.9% of the catalog and would disagree with the other. Hidden here
 * rather than dropped server-side: the aggregation and `?geographical_code=` stay
 * part of the API for other clients, and a detail page still states the value.
 *
 * Exported because callers filter their aggregations with it before deriving the
 * search parameters — a hidden facet must not become a query parameter either.
 */
export const FACET_HIDDEN = new Set(["geographical_code"]);

/** Bucket values a facet does not offer. Narrows the picker, not the API. */
export const FACET_HIDDEN_VALUES: Record<string, Set<string>> = {
  license: new Set(["other", "proprietary"]),
};

/**
 * Sidebar order, most-asked question first.
 *
 * The server returns aggregations in mirror-column order, which put Geometry above
 * Data type. Browsing asks in roughly this sequence: where is it, what is it about,
 * what kind of thing is it (then which geometry), whose is it, may I use it, and
 * last — when is it from, the least populated field (`datetime` is null on 52% of
 * items). Anything the server adds that is not listed keeps its place at the end.
 */
const FACET_ORDER = ["themes", "type", "geometry_type", "publisher", "license", "language"];

export const useCatalogFacetSections = ({
  aggregations,
  facetQueryParams,
}: {
  aggregations: CatalogAggregation[];
  facetQueryParams: CatalogSearchParams;
}): { sections: CatalogFacetSection[]; facetLabel: (param: string) => string; optionLabel: (param: string, value: string) => string } => {
  const { t } = useTranslation("common");
  const translateMetadataValue = useGetMetadataValueTranslation();

  /**
   * The facets, in the order the server offers them, each with the parameter that
   * narrows it. The parameter comes from `goat:filter_param`, never from the
   * facet's name — `category_count` is narrowed with `?themes=`.
   */
  const facetPlan = useMemo(() => {
    const plan = aggregations
      .filter((aggregation) => aggregation.name !== "total_count")
      .flatMap((aggregation) => {
        const param = aggregation["goat:filter_param"];
        return param ? [{ name: aggregation.name, param }] : [];
      });
    const rank = (param: string) => {
      const index = FACET_ORDER.indexOf(param);
      return index === -1 ? FACET_ORDER.length : index;
    };
    return [...plan].sort((a, b) => rank(a.param) - rank(b.param));
  }, [aggregations]);

  const { buckets } = useCatalogFacetBuckets({ facets: facetPlan, params: facetQueryParams });

  const facetLabel = useCallback(
    (param: string) =>
      FACET_LABEL_KEYS[param]
        ? t(FACET_LABEL_KEYS[param])
        : t(`common:metadata.headings.${param}`, param),
    [t]
  );
  const optionLabel = useCallback(
    (param: string, value: string) =>
      translateMetadataValue(FACET_VOCABULARY[param] ?? param, value),
    [translateMetadataValue]
  );

  const sections = useMemo(
    () =>
      facetPlan.flatMap(({ name, param }) => {
        const hidden = FACET_HIDDEN_VALUES[name];
        const options = (buckets[name] ?? [])
          .filter((bucket) => bucket.key !== null && !hidden?.has(bucket.key))
          .map((bucket) => ({
            value: bucket.key as string,
            label: optionLabel(param, bucket.key as string),
            count: bucket.frequency,
          }));
        if (options.length < MIN_BUCKETS_TO_OFFER) return [];
        return [
          {
            param,
            label: facetLabel(param),
            icon: FACET_ICONS[param] ?? ICON_NAME.FILTER,
            options,
          },
        ];
      }),
    [facetPlan, buckets, optionLabel, facetLabel]
  );

  return { sections, facetLabel, optionLabel };
};
