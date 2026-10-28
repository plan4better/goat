import { useCallback, useMemo } from "react";

import { updateProjectLayer, useProjectLayers } from "@/lib/api/projects";
import { createTheCQLBasedOnExpression, parseCQLQueryToObject } from "@/lib/transformers/filter";
import { FilterType, type Expression } from "@/lib/validations/filter";
import type { ProjectLayer } from "@/lib/validations/project";

import type { TableFilterController } from "@/types/map/tableFilter";

import useLayerFields from "@/hooks/map/CommonHooks";

/**
 * Map-mode filter controller: expressions live on the project layer's CQL, so
 * the column popover and the layer Filter panel read and write the same object.
 */
export const useProjectLayerFilterController = ({
  projectId,
  projectLayer,
  canEdit = true,
}: {
  projectId: string;
  projectLayer: ProjectLayer;
  canEdit?: boolean;
}): TableFilterController => {
  const { layers: projectLayers, mutate: mutateProjectLayers } = useProjectLayers(projectId);
  const { layerFields } = useLayerFields(projectLayer.layer_id);

  const cql = projectLayer.query?.cql as { op: string; args: unknown[] } | undefined;

  // parseCQLQueryToObject mints a fresh uuid per call, so an id captured when
  // the popover opened would no longer match after any unrelated layer update.
  // Re-key by position instead: stable for a given CQL, which is all upsert needs.
  const expressions = useMemo(
    () => parseCQLQueryToObject(cql).map((e, index) => ({ ...e, id: `cql-${index}` })),
    [cql]
  );

  const logicalOperator: "and" | "or" = cql?.op === "or" ? "or" : "and";

  const save = useCallback(
    async (next: Expression[]) => {
      if (!projectLayers) return;
      const layers = JSON.parse(JSON.stringify(projectLayers)) as ProjectLayer[];
      const index = layers.findIndex((l) => l.id === projectLayer.id);
      if (index < 0) return;

      layers[index].query = next.length
        ? { cql: createTheCQLBasedOnExpression(next, layerFields, logicalOperator) }
        : null;

      await mutateProjectLayers(layers, false);
      await updateProjectLayer(projectId, projectLayer.id, { query: layers[index].query });
    },
    [projectLayers, projectLayer.id, layerFields, logicalOperator, mutateProjectLayers, projectId]
  );

  const upsert = useCallback(
    async (expression: Expression) => {
      const withType = { ...expression, type: expression.type ?? FilterType.Logical };
      const index = expressions.findIndex((e) => e.id === withType.id);
      const next =
        index >= 0
          ? expressions.map((e) => (e.id === withType.id ? withType : e))
          : [...expressions, withType];
      await save(next);
    },
    [expressions, save]
  );

  const remove = useCallback(
    async (id: string) => {
      await save(expressions.filter((e) => e.id !== id));
    },
    [expressions, save]
  );

  return { expressions, logicalOperator, upsert, remove, canEdit };
};

export default useProjectLayerFilterController;
