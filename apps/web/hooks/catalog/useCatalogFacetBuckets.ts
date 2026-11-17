import useSWR from "swr";

import {
  CATALOG_API_BASE_URL,
  type CatalogSearchParams,
  buildCatalogQuery,
} from "@/lib/api/catalog";
import { fetcher } from "@/lib/api/fetcher";
import type { CatalogAggregationBucket, CatalogAggregations } from "@/lib/validations/catalog";

/** Facet counts, each computed with that facet's *own* selection excluded. */
export const useCatalogFacetBuckets = ({
  facets,
  params,
}: {
  /** Aggregation name and the parameter that narrows it (`goat:filter_param`). */
  facets: { name: string; param: string }[];
  /** The current filters, without paging or sorting. */
  params: CatalogSearchParams;
}) => {
  /** Every value each facet can take, unfiltered. */
  const { data: baseline } = useSWR<Record<string, CatalogAggregationBucket[]>>(
    facets.length && CATALOG_API_BASE_URL
      ? ["catalog-facet-universe", facets.map((facet) => facet.name).join(",")]
      : null,
    async () => {
      const url = `${CATALOG_API_BASE_URL}/aggregate?unit=collections&aggregations=${facets
        .map((facet) => facet.name)
        .join(",")}`;
      const response = (await fetcher(url)) as CatalogAggregations;
      const buckets: Record<string, CatalogAggregationBucket[]> = {};
      for (const aggregation of response.aggregations ?? []) {
        buckets[aggregation.name] = aggregation.buckets ?? [];
      }
      return buckets;
    },
    { revalidateOnFocus: false, dedupingInterval: 60 * 60 * 1000 }
  );

  const isSelected = (param: string) => {
    const value = params[param];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  };

  const shared = facets.filter((facet) => !isSelected(facet.param));
  const own = facets.filter((facet) => isSelected(facet.param));

  /**
   * One request per distinct filter set. Serialised into the SWR key so the cache
   * turns over exactly when a filter changes.
   */
  const plan = [
    ...(shared.length
      ? [{ names: shared.map((facet) => facet.name), query: buildCatalogQuery(params) }]
      : []),
    ...own.map((facet) => ({
      names: [facet.name],
      query: buildCatalogQuery({ ...params, [facet.param]: undefined }),
    })),
  ];

  const { data, isLoading, error } = useSWR<Record<string, CatalogAggregationBucket[]>>(
    plan.length && CATALOG_API_BASE_URL ? ["catalog-facets", JSON.stringify(plan)] : null,
    async () => {
      const results = await Promise.all(
        plan.map(async (step) => {
          const separator = step.query ? "&" : "?";
          const url = `${CATALOG_API_BASE_URL}/aggregate${step.query}${separator}aggregations=${step.names.join(",")}`;
          const response = (await fetcher(url)) as CatalogAggregations;
          return response.aggregations ?? [];
        })
      );
      const buckets: Record<string, CatalogAggregationBucket[]> = {};
      for (const aggregations of results) {
        for (const aggregation of aggregations) {
          buckets[aggregation.name] = aggregation.buckets ?? [];
        }
      }
      return buckets;
    },
    // Keep the previous counts on screen while the next ones load, so the sidebar
    // does not blank out on every tick.
    { keepPreviousData: true }
  );

  /** The value universe, carrying current counts — zero for a value the filters exclude. */
  const buckets: Record<string, CatalogAggregationBucket[]> = {};
  for (const facet of facets) {
    const current = new Map(
      (data?.[facet.name] ?? []).map((bucket) => [bucket.key, bucket] as const)
    );
    const universe = baseline?.[facet.name];
    if (!universe) {
      // Until the baseline lands, show what the filtered query returned rather
      // than nothing.
      buckets[facet.name] = data?.[facet.name] ?? [];
      continue;
    }
    // Values the filters still allow first, each group in the universe's order:
    // a long list (publishers) is unsearchable when the few that apply are
    // scattered among hundreds at zero.
    buckets[facet.name] = universe
      .map((bucket) => current.get(bucket.key) ?? { ...bucket, frequency: 0 })
      .sort((a, b) => Number(b.frequency > 0) - Number(a.frequency > 0));
  }

  return { buckets, isLoading, isError: error };
};
