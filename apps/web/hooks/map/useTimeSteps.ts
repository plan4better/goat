// The time sliders' steps (spec 7.3), from the field's distinct values: the layer tree's slider moves over them, and the
// map starts a slider without a stored value at the latest one. Both ask through one promise per dataset, field, step
// and data version, so a map and its tree send one request.
import { useMemo } from "react";
import useSWR from "swr";

import { getLayerUniqueValues } from "@/lib/api/layers";
import type { Time } from "@/lib/style/generated/types";
import { isObject } from "@/lib/style/json";
import type { ViewLayer } from "@/lib/style/render/viewLayers";
import { type TimeStep, timeStepsOf } from "@/lib/style/time";

/** The most distinct values the unique values answer. */
const MAX_VALUES = 1000;

const asked = new Map<string, Promise<TimeStep[]>>();

const keyOf = (datasetId: string, time: Time, version?: string | null) =>
  [datasetId, time.field, String(time.step ?? ""), version ?? ""].join("|");

export function fetchTimeSteps(datasetId: string, time: Time, version?: string | null): Promise<TimeStep[]> {
  const key = keyOf(datasetId, time, version);
  let steps = asked.get(key);
  if (!steps) {
    steps = getLayerUniqueValues(datasetId, time.field, MAX_VALUES).then((result) =>
      timeStepsOf(
        result.items.map((item) => String(item.value)),
        time
      )
    );
    // A failed request is asked again next time.
    steps.catch(() => asked.delete(key));
    asked.set(key, steps);
  }
  return steps;
}

export const timeOf = (style: unknown): Time | undefined =>
  isObject(style) && isObject(style.time) && typeof style.time.field === "string"
    ? (style.time as unknown as Time)
    : undefined;

/** One slider's steps. */
export function useTimeSteps(
  datasetId: string | null | undefined,
  time: Time | undefined,
  version?: string | null
) {
  const { data } = useSWR(datasetId && time ? ["time-steps", keyOf(datasetId, time, version)] : null, () =>
    fetchTimeSteps(datasetId as string, time as Time, version)
  );
  return data;
}

/** Where each time-enabled layer without a stored slider value starts: its latest step, by layer key. */
export function useTimeDefaults(layers: ViewLayer[] | undefined): Record<string, TimeStep> | undefined {
  const pending = useMemo(
    () =>
      (layers ?? []).flatMap((layer) => {
        const time = timeOf(layer.style?.document);
        if (!time || layer.entry?.time?.value != null) return [];
        return [
          {
            key: String(layer.id),
            dataset: String(layer.layer_id ?? layer.id),
            time,
            version: layer.dataset_updated_at,
          },
        ];
      }),
    [layers]
  );
  const swrKey = pending.length
    ? ["time-defaults", ...pending.map((p) => `${p.key}=${keyOf(p.dataset, p.time, p.version)}`)]
    : null;
  const { data } = useSWR(swrKey, async () => {
    const out: Record<string, TimeStep> = {};
    await Promise.all(
      pending.map(async (p) => {
        const steps = await fetchTimeSteps(p.dataset, p.time, p.version).catch(() => []);
        if (steps.length) out[p.key] = steps[steps.length - 1];
      })
    );
    return out;
  });
  return data;
}
