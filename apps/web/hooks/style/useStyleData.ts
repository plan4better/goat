"use client";

// What the style panel knows about a layer's data: its fields with types for the compiler, field profiles on demand,
// a sample feature for previews, the feature count, and the user's uploaded icons.
import { useCallback, useMemo, useRef } from "react";

import { useAssets } from "@/lib/api/assets";
import { getLayerClassBreaks, getLayerUniqueValues, useLayerQueryables } from "@/lib/api/layers";
import { useFeatureCount } from "@/lib/api/processes";
import { useRasterInfo } from "@/lib/api/rasters";
import type { FieldType, Geometry } from "@/lib/style/compile/types";
import type { StyleSourceInfo } from "@/lib/style/layerSource";
import { assetTypeEnum } from "@/lib/validations/assets";

import type {
  FieldInfo,
  FieldProfile,
  ProfileSource,
  StyleData,
} from "@/components/map/panels/styleEditor/context";
import { useSampleFeature } from "@/components/map/popover/sampleFeature";

const HIDDEN = new Set(["layer_id", "id", "geom", "geometry"]);
const PROFILE_VALUES = 3;

interface Queryable {
  type?: string;
  format?: string;
  kind?: string;
  display_config?: Record<string, unknown>;
}

function fieldType(q: Queryable): FieldType | null {
  if (q.type === "integer") return "integer";
  if (q.type === "number") return "number";
  if (q.type === "boolean") return "boolean";
  if (q.type !== "string") return null;
  if (q.format === "date") return "date";
  if (q.format === "date-time" || q.kind === "datetime") return "datetime";
  return "string";
}

export function fieldsOf(properties: Record<string, Queryable> | undefined): FieldInfo[] {
  if (!properties) return [];
  return Object.entries(properties).flatMap(([name, q]) => {
    const type = fieldType(q);
    if (!type || HIDDEN.has(name) || /^h3_\d+$/.test(name)) return [];
    const label = typeof q.display_config?.label === "string" ? q.display_config.label : name;
    return [{ name, type, label }];
  });
}

async function loadProfile(
  layerId: string,
  field: string,
  type: FieldType | undefined
): Promise<FieldProfile | undefined> {
  if (type === "number" || type === "integer") {
    const stats = await getLayerClassBreaks(layerId, "equal_interval", field, 1);
    return { min: stats.min, max: stats.max };
  }
  if (type === "string") {
    const page = await getLayerUniqueValues(layerId, field, PROFILE_VALUES);
    return { values: page.items.map((item) => String(item.value)), count: page.total };
  }
  return undefined;
}

/** One layer's profiles: each field asked once; listeners hear every arrival. A new layer gets a new source, so a
 * profile still on its way for the old layer never lands in the new one. */
function profileSource(layerId: string, typeOf: (field: string) => FieldType | undefined): ProfileSource {
  const cache = new Map<string, FieldProfile>();
  const requested = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    get: (field) => cache.get(field),
    load: (field) => {
      if (requested.has(field)) return;
      requested.add(field);
      loadProfile(layerId, field, typeOf(field))
        .then((loaded) => {
          if (!loaded) return;
          cache.set(field, loaded);
          listeners.forEach((listener) => listener());
        })
        .catch(() => requested.delete(field));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStyleData(layer: {
  id: string;
  name?: string;
  geometry?: Geometry;
  source?: StyleSourceInfo;
}): StyleData {
  const layerId = layer.id;
  const { source } = layer;
  // Fields, a sample feature and the feature count belong to vector data.
  const vectorId = source ? "" : layerId;
  const { queryables } = useLayerQueryables(vectorId);
  const { assets } = useAssets({ asset_type: assetTypeEnum.Enum.icon });
  const { feature } = useSampleFeature(vectorId, true);
  const { featureCount } = useFeatureCount(vectorId || undefined);
  // A raster file is read by the raster service: the dataset's info and band statistics.
  const rasterDataset = source?.kind === "cog" ? layerId : undefined;
  const { info: rasterInfo, error: rasterError } = useRasterInfo(rasterDataset);
  const raster = useMemo(
    () =>
      rasterDataset
        ? { dataset: rasterDataset, info: rasterInfo, ...(rasterError ? { error: rasterError } : {}) }
        : undefined,
    [rasterDataset, rasterInfo, rasterError]
  );
  const service = useMemo(
    () =>
      source && source.kind !== "cog"
        ? {
            kind: source.kind,
            url: source.url,
            layers: source.layers?.length ?? 1,
            layerNames: source.layers ?? [],
            styles: source.styles ?? [],
            ...(source.legendUrls?.[0] ? { legendUrl: source.legendUrls[0] } : {}),
          }
        : undefined,
    [source]
  );

  const fields = useMemo(
    () => fieldsOf(queryables?.properties as Record<string, Queryable> | undefined),
    [queryables]
  );
  const fieldTypes = useMemo(() => Object.fromEntries(fields.map((f) => [f.name, f.type])), [fields]);
  const types = useRef(fieldTypes);
  types.current = fieldTypes;

  const profiles = useMemo(() => profileSource(layerId, (field) => types.current[field]), [layerId]);
  const profile = useCallback(
    (field: string) => {
      // Asked while rendering: the request starts after the render, once per field.
      if (profiles.get(field) === undefined) queueMicrotask(() => profiles.load(field));
      return profiles.get(field);
    },
    [profiles]
  );

  const uploads = useMemo(() => assets ?? [], [assets]);

  const sample = feature?.properties as Record<string, unknown> | undefined;
  const geometry = layer.geometry;
  const layerName = layer.name;
  return useMemo(
    () => ({
      layerId,
      layerName,
      geometry,
      fields,
      fieldTypes,
      profile,
      profiles,
      raster,
      service,
      sample,
      featureCount,
      uploads,
    }),
    [
      layerId,
      layerName,
      geometry,
      fields,
      fieldTypes,
      profile,
      profiles,
      raster,
      service,
      sample,
      featureCount,
      uploads,
    ]
  );
}
