// A print map element's layers for the renderer: the locked ones with their frozen documents, else the project's drawn
// layers; an atlas page hides its coverage layer or shows only its feature (lib/print/mapElements.ts). Time sliders
// without a stored value start at their latest step, as on the project's map.
import { useMemo } from "react";

import type { AtlasPage } from "@/lib/print/atlas-utils";
import { mapElementLayers } from "@/lib/print/mapElements";
import type { RenderLayer } from "@/lib/style/render/mapLayers";
import { renderLayersOf } from "@/lib/style/render/viewLayers";

import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useTimeDefaults } from "@/hooks/map/useTimeSteps";

export function useMapElementRenderLayers(
  layers: MapLayer[],
  config: Record<string, unknown>,
  atlasPage?: AtlasPage | null
): RenderLayer[] {
  const atlasActive =
    !!atlasPage &&
    (config.atlas as { enabled?: boolean } | undefined)?.enabled === true &&
    !!atlasPage.coverageLayerProjectId;
  const drawn = useMemo(
    () =>
      mapElementLayers(layers, config, {
        hide: atlasActive && atlasPage?.hiddenCoverageLayer ? atlasPage.coverageLayerProjectId : undefined,
      }),
    [layers, config, atlasActive, atlasPage]
  );
  const timeDefaults = useTimeDefaults(drawn);
  return useMemo(() => {
    // The atlas page's feature on the coverage layer: a filter on the drawn layer, so the tiles stay the same
    // (hexagon tiles excepted, which geoapi counts for that feature alone).
    const atlas =
      atlasActive && atlasPage?.filterToCurrentFeature && atlasPage.feature
        ? { key: String(atlasPage.coverageLayerProjectId), feature: Number(atlasPage.feature.id) }
        : undefined;
    return renderLayersOf(drawn, { atlas, timeDefaults });
  }, [drawn, atlasActive, atlasPage, timeDefaults]);
}
