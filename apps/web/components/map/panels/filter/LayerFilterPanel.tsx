"use client";

// The filter tab of a project layer: the filter panel on the layer's saved filter (useLayerFilter), with the
// project's other polygon layers as what its area can be picked from and, for who may edit, the foot that saves the
// filtered features as a new layer.
import { useMemo } from "react";

import { SYSTEM_LAYERS_IDS } from "@/lib/constants";
import type { LayerType } from "@/lib/validations/layer";
import type { ProjectLayer } from "@/lib/validations/project";

import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";
import { useLayerFilter } from "@/hooks/map/useLayerFilter";
import { useMapLayers } from "@/hooks/map/useMapLayers";

import { layerSwatchIcon } from "@/components/map/legend/StyleLegend";
import { FilterPanel } from "@/components/map/panels/filter/FilterPanel";
import { SaveAsLayer } from "@/components/map/panels/filter/SaveAsLayer";
import type { AreaLayer } from "@/components/map/panels/filter/area/AreaTools";

// Stable: the hook sorts the layers again whenever its lists are new ones.
const NO_TYPES: LayerType[] = [];
const SYSTEM_LAYERS = [...SYSTEM_LAYERS_IDS];

export function LayerFilterPanel({
  projectId,
  projectLayer,
  visible = true,
}: {
  projectId: string;
  projectLayer: Pick<ProjectLayer, "id" | "layer_id" | "name" | "query" | "type">;
  /** Whether its tab is the open one: a tab once opened stays mounted, hidden. */
  visible?: boolean;
}) {
  const { model, fields, fieldInfos, issues, canEdit, isLoading, apply } = useLayerFilter(
    projectId,
    projectLayer
  );
  // The layers the user can pick from (no locked ones), without the filtered layer itself; a dataset in the
  // project twice is offered once.
  const { layers } = useFilteredProjectLayers(projectId, NO_TYPES, SYSTEM_LAYERS);
  // The styles come with the map document: each layer is listed with its legend.
  const { layers: mapLayers } = useMapLayers(projectId);
  const areaLayers = useMemo(() => {
    const styled = new Map(mapLayers.map((layer) => [layer.id, layer]));
    const out = new Map<string, AreaLayer>();
    for (const layer of layers) {
      if (layer.type !== "feature" || layer.feature_layer_geometry_type !== "polygon") continue;
      if (layer.layer_id === projectLayer.layer_id || out.has(layer.layer_id)) continue;
      out.set(layer.layer_id, {
        id: layer.layer_id,
        name: layer.name,
        icon: layerSwatchIcon(styled.get(layer.id)),
      });
    }
    return [...out.values()];
  }, [layers, mapLayers, projectLayer.layer_id]);
  // Read without the fields the rows would guess their types and every row would look broken.
  if (isLoading) return null;
  return (
    <FilterPanel
      // A draft per layer: another layer starts from its own saved filter.
      key={projectLayer.id}
      model={model}
      fields={fields}
      fieldInfos={fieldInfos}
      issues={issues}
      canEdit={canEdit}
      onApply={apply}
      layerId={projectLayer.layer_id}
      shown={visible}
      scope={projectLayer.id}
      // A table has no geometry an area could be held against.
      area={projectLayer.type === "feature"}
      areaLayers={areaLayers}
      resultAction={canEdit && <SaveAsLayer projectId={projectId} projectLayer={projectLayer} />}
    />
  );
}

export default LayerFilterPanel;
