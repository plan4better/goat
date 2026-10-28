import { useCallback, useMemo } from "react";
import useSWR, { unstable_serialize, useSWRConfig } from "swr";

import { fetcher } from "@/lib/api/fetcher";
import { COLLECTIONS_API_BASE_URL } from "@/lib/api/layers";
import type { LayerQueryables } from "@/lib/validations/layer";

import type { SearchLayersById } from "@/components/map/controls/search/SearchResultsList";
import type { MapLayer } from "@/hooks/map/useMapLayers";

import { layerSwatchIcon } from "@/components/map/legend/StyleLegend";

const NAME_HINTS = ["name", "title", "label", "bezeichnung", "street", "strasse"];
const MAX_COLUMNS = 3;
/** `layer-search` accepts at most 20 layer entries per request. */
const MAX_LAYERS = 20;
const HIDDEN_FIELDS = ["layer_id", "id", "h3_3", "h3_6", "geom", "geometry"];

export type EditorSearchLayer = {
  layer_id: string;
  columns: string[];
  label_column?: string;
};

export function pickSearchColumns(fields: { name: string; type: string }[]): string[] {
  const scored = fields
    .filter((field) => field.type === "string")
    .map((field) => ({
      name: field.name,
      score: NAME_HINTS.findIndex((hint) => field.name.toLowerCase().includes(hint)),
    }));
  const hinted = scored
    .filter((entry) => entry.score !== -1)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.name);
  const rest = scored.filter((entry) => entry.score === -1).map((entry) => entry.name);
  return [...hinted, ...rest].slice(0, MAX_COLUMNS);
}

function stringColumnsFromQueryables(queryables: LayerQueryables): string[] {
  const properties = queryables?.properties ?? {};
  const fields = Object.entries(properties)
    .filter(([name]) => !HIDDEN_FIELDS.includes(name))
    .filter(([, value]) => value?.kind !== "datetime" && value?.format !== "date-time")
    .map(([name, value]) => ({ name, type: value?.type ?? "" }));
  return pickSearchColumns(fields);
}

/**
 * The SWR key `useLayerQueryables` (lib/api/layers.ts) uses for one dataset —
 * reused verbatim so both share a single cache entry per dataset.
 */
function queryablesKey(datasetId: string): [string] {
  return [`${COLLECTIONS_API_BASE_URL}/${datasetId}/queryables`];
}

/**
 * Editor-mode search scope: the visible feature layers of the project, each
 * contributing up to three name-like string columns. Queryables are only
 * fetched once `enabled` flips (i.e. the user opened the search control).
 */
export function useEditorSearchLayers(projectLayers: MapLayer[], enabled: boolean) {
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const visible: MapLayer[] = [];
    for (const layer of projectLayers) {
      if (layer.type !== "feature") continue;
      if (!layer.visible) continue;
      // D7: a locked layer is not searched, or its dataset's queryables (and
      // then its features) would be requested from geoapi for a layer this
      // viewer has no access to.
      if (layer.locked) continue;
      if (seen.has(layer.layer_id)) continue;
      seen.add(layer.layer_id);
      visible.push(layer);
      if (visible.length === MAX_LAYERS) break;
    }
    return visible;
  }, [projectLayers]);

  const datasetIds = useMemo(() => candidates.map((layer) => layer.layer_id), [candidates]);
  const cacheKey = datasetIds.join(",");

  const { cache, mutate } = useSWRConfig();

  // Queryables are read from — and written back to — the global SWR cache one
  // dataset at a time, so this shares its fetches with every `useLayerFields` /
  // `useLayerQueryables` caller and a visibility toggle only fetches the
  // dataset that was actually added. The aggregate entry below is pure
  // orchestration over that per-dataset cache.
  const fetchSearchColumns = useCallback(
    async (datasetIds: string[]): Promise<Record<string, string[]>> => {
      const entries = await Promise.all(
        datasetIds.map(async (datasetId) => {
          const key = queryablesKey(datasetId);
          try {
            const cached = cache.get(unstable_serialize(key))?.data as
              | LayerQueryables
              | undefined;
            if (cached) return [datasetId, stringColumnsFromQueryables(cached)] as const;
            const queryables = (await fetcher(key)) as LayerQueryables;
            await mutate(key, queryables, { revalidate: false });
            return [datasetId, stringColumnsFromQueryables(queryables)] as const;
          } catch {
            return [datasetId, []] as const;
          }
        })
      );
      return Object.fromEntries(entries);
    },
    [cache, mutate]
  );

  const { data: columnsByDataset } = useSWR(
    enabled && cacheKey ? ["editor-search-columns", cacheKey] : null,
    ([, ids]: [string, string]) => fetchSearchColumns(ids.split(","))
  );

  const searchLayers = useMemo<EditorSearchLayer[]>(() => {
    if (!columnsByDataset) return [];
    return datasetIds
      .map((datasetId) => ({
        layer_id: datasetId,
        columns: columnsByDataset[datasetId] ?? [],
      }))
      .filter((entry) => entry.columns.length > 0)
      .map((entry) => ({ ...entry, label_column: entry.columns[0] }));
  }, [columnsByDataset, datasetIds]);

  const layersById = useMemo<SearchLayersById>(() => {
    const map: SearchLayersById = new Map();
    candidates.forEach((layer) => {
      map.set(layer.layer_id, {
        projectLayerId: layer.id,
        datasetId: layer.layer_id,
        name: layer.name ?? "",
        icon: layerSwatchIcon(layer),
        layer,
      });
    });
    return map;
  }, [candidates]);

  return { searchLayers, layersById };
}
