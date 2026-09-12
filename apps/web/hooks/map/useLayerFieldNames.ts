import useSWR from "swr";

import { fetcher } from "@/lib/api/fetcher";
import { COLLECTIONS_API_BASE_URL } from "@/lib/api/layers";
import type { LayerQueryables } from "@/lib/validations/layer";

/** Columns every layer carries that no tool parameter ever names. */
const HIDDEN_FIELDS = new Set(["layer_id", "id", "h3_3", "h3_6", "geom", "geometry"]);

/**
 * The field names of several layers at once — `layerId → names` — for a
 * check that has to look across a workflow's inputs. Ids are sorted into
 * one request key so the same set shares one cache entry; a layer whose
 * queryables have not answered yet is absent from the map rather than
 * reported empty, so callers can tell "no fields" from "not known yet".
 */
export const useLayerFieldNames = (layerIds: string[]) => {
  const ids = Array.from(new Set(layerIds.filter(Boolean))).sort();

  const { data, isLoading } = useSWR<Record<string, string[]>>(
    ids.length > 0 ? ["layer-field-names", ids.join(",")] : null,
    async () => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          const queryables = (await fetcher([
            `${COLLECTIONS_API_BASE_URL}/${id}/queryables`,
          ])) as LayerQueryables;
          const names = Object.keys(queryables?.properties ?? {}).filter((name) => !HIDDEN_FIELDS.has(name));
          return [id, names] as const;
        })
      );
      return Object.fromEntries(entries);
    },
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );

  return { fieldsByLayerId: data ?? {}, isLoading };
};
