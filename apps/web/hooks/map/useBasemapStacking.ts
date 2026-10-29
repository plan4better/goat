// A custom vector basemap's layer settings (`layer_config`): hidden basemap layers, and basemap layers promoted above
// project layers. Declarative: every pass starts from the basemap's pristine order and applies the current settings,
// so turning a setting off restores the layer. Project layers come from the renderer's registry.
import type { Map as MaplibreMap } from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";

import { mapLayerIdsOf } from "@/lib/style/render/mapLayers";
import { computeStackOrder, resolveTarget } from "@/lib/utils/map/basemapLayers";
import type { BasemapLayerConfig } from "@/lib/validations/project";

import { useAppSelector } from "@/hooks/store/ContextHooks";

// Overlays (the active feature's pulse, pending edits, drawing, measuring, the PT network Explorer) stay above every
// data layer: they annotate features, so they are neither data nor basemap.
const isOverlayId = (id: string) =>
  id.startsWith("popup-active-feature") ||
  id.startsWith("pending-features") ||
  id.startsWith("gl-draw") ||
  id.startsWith("mapbox-gl-draw") ||
  id.startsWith("__measure") ||
  id.startsWith("explorer-");

/** Applies the active custom basemap's layer settings around the project layers `keys` (top first). */
export function useBasemapStacking(map: MaplibreMap | undefined, keys: string[]): void {
  const activeBasemap = useAppSelector((state) => state.map.activeBasemap);
  const override = useAppSelector((state) => state.map.basemapLayerConfigOverride);
  const config = useMemo<BasemapLayerConfig>(() => {
    // A live preview (the dialog is open) wins over the stored settings.
    if (override !== undefined) return override;
    if (activeBasemap && activeBasemap.source === "custom" && activeBasemap.type === "vector")
      return (activeBasemap.layer_config as BasemapLayerConfig | undefined) ?? {};
    return {};
  }, [activeBasemap, override]);
  const applied = useRef(false);
  const keyList = keys.join("|");

  useEffect(() => {
    if (!map) return;
    const projectKeys = keyList ? keyList.split("|") : [];
    const apply = () => {
      // Only the style JSON must be loaded: isStyleLoaded() stays false while tiles load, which is exactly when
      // project layers are added; moveLayer and setLayoutProperty are safe meanwhile.
      const styleLayers = map.getStyle()?.layers;
      if (!styleLayers) return;
      const hasConfig = Object.keys(config).length > 0;
      if (!hasConfig && !applied.current) return;

      const allIdsBottomToTop = styleLayers.map((l) => l.id);
      const styleIds = new Set(allIdsBottomToTop);
      const userLayers = projectKeys
        .map((key) => ({
          id: key,
          sublayers: mapLayerIdsOf(map, key)
            .filter((id) => styleIds.has(id))
            .reverse(),
        }))
        .filter((u) => u.sublayers.length > 0);
      const userSubIds = new Set(userLayers.flatMap((u) => u.sublayers));

      // The basemap's pristine order, captured once per basemap (keyed by its layer ids).
      const basemapIds = allIdsBottomToTop.filter((id) => !userSubIds.has(id) && !isOverlayId(id));
      const styleKey = [...basemapIds].sort().join("|");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cache = map as any;
      if (!cache.__basemapPristine || cache.__basemapPristine.key !== styleKey) {
        cache.__basemapPristine = { key: styleKey, order: basemapIds.slice() };
      }
      const pristineTopToBottom: string[] = [...cache.__basemapPristine.order]
        .reverse()
        .filter((id: string) => styleIds.has(id));

      // 1) Visibility: every basemap layer follows the settings (visible by default).
      for (const id of pristineTopToBottom) {
        const desired = (config[id]?.visible ?? true) ? "visible" : "none";
        try {
          if ((map.getLayoutProperty(id, "visibility") ?? "visible") !== desired)
            map.setLayoutProperty(id, "visibility", desired);
        } catch {
          /* layer not ready */
        }
      }

      // 2) Stacking: promoted basemap layers move among the project layers, the rest stays below in pristine order.
      // A target that names a removed layer resolves to "all", so "below all" falls back to the native position.
      const userMainIds = new Set(userLayers.map((u) => u.id));
      const promoted = pristineTopToBottom
        .filter((id) => {
          const s = config[id];
          if (!s) return false;
          return !(s.relation === "below" && resolveTarget(s.target, userMainIds) === "all");
        })
        .map((id) => ({ id, relation: config[id].relation, target: config[id].target }));
      const promotedIds = new Set(promoted.map((p) => p.id));
      const desiredOrder = [
        ...computeStackOrder(userLayers, promoted),
        ...pristineTopToBottom.filter((id) => !promotedIds.has(id)),
      ];

      applied.current = hasConfig;
      if (desiredOrder.length === 0) return;

      const orderSet = new Set(desiredOrder);
      const current = allIdsBottomToTop
        .slice()
        .reverse()
        .filter((id) => orderSet.has(id));
      if (current.length === desiredOrder.length && current.every((id, i) => id === desiredOrder[i])) return;

      // The top layer goes just below the lowest overlay, the others each below the one before.
      const lowestOverlayId = allIdsBottomToTop.find(isOverlayId);
      try {
        if (lowestOverlayId) map.moveLayer(desiredOrder[0], lowestOverlayId);
        else map.moveLayer(desiredOrder[0]);
      } catch {
        /* not ready */
      }
      for (let i = 1; i < desiredOrder.length; i++) {
        try {
          map.moveLayer(desiredOrder[i], desiredOrder[i - 1]);
        } catch {
          /* not ready */
        }
      }
    };

    apply();
    map.on("styledata", apply);
    // Project layers are added after the style's own styledata; a persistent idle listener applies once everything
    // settled, and the order check makes repeated passes cheap.
    map.on("idle", apply);
    return () => {
      map.off("styledata", apply);
      map.off("idle", apply);
    };
  }, [map, keyList, config]);
}
