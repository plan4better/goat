// A hexagon's popup (spec 8.3): a hexagon groups many points, so it shows its own values instead of a feature's
// fields, its number of points and the sum or mean it is colored by, in the layer's popup settings (enabled,
// trigger, layout).
import type { TFunction } from "i18next";

import type { LayerStyle } from "@/lib/style/generated/types";
import { isObject } from "@/lib/style/json";
import { type PopupProperties, popupProperties } from "@/lib/validations/layer";

/** The part a click or hover finds a hexagon on. */
export const HEXAGON_PART = "h3-fill";

/** Whether a rendered feature is a hexagon of geoapi's H3 tiles (their source layer `h3`). */
export const isHexagon = (feature: { sourceLayer?: string }): boolean => feature.sourceLayer === "h3";

/** A hexagon's popup values from its tile properties (`value`, `count`). */
export function hexagonValues(
  properties: Record<string, unknown> | null | undefined
): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof properties?.value === "number") out.h3_value = properties.value;
  if (typeof properties?.count === "number") out.h3_count = properties.count;
  return out;
}

/** The popup of a hexagon of the layer `document`, from the layer's popup `config`; undefined when it shows none. */
export function hexagonPopup(
  config: PopupProperties | undefined,
  document: LayerStyle | undefined,
  t: TFunction
): PopupProperties | undefined {
  if (!config || config.enabled === false) return undefined;
  const render = (document as { render?: unknown } | undefined)?.render;
  const value = isObject(render) && isObject(render.value) ? render.value : {};
  const op = value.op === "sum" || value.op === "mean" ? value.op : "count";
  const attributes = [
    ...(op !== "count" && typeof value.field === "string"
      ? [
          {
            name: "h3_value",
            label: t(`style_editor.h3_value_${op}`, { field: value.field }),
            type: "number" as const,
          },
        ]
      : []),
    { name: "h3_count", label: t("style_editor.h3_value_count"), type: "number" as const },
  ];
  return popupProperties.parse({
    ...config,
    mode: "simple",
    blocks: [{ type: "fieldList", attributes }],
  });
}
