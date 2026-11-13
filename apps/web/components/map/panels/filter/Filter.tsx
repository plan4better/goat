import { Box, Stack, Typography } from "@mui/material";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { v4 } from "uuid";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { updateProjectLayer } from "@/lib/api/projects";
import { setRunningJobIds } from "@/lib/store/jobs/slice";
import { createTheCQLBasedOnExpression, parseCQLQueryToObject } from "@/lib/transformers/filter";
import { creditsErrorMessage } from "@/lib/utils/credits";
import { layerType } from "@/lib/validations/common";
import { type Expression as ExpressionType, FilterType } from "@/lib/validations/filter";
import type { ProjectLayer } from "@/lib/validations/project";

import type { SelectorItem } from "@/types/map/common";

import useLayerFields from "@/hooks/map/CommonHooks";
import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";
import { useProcessExecution } from "@/hooks/map/useOgcProcesses";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import SearchableMenu from "@/components/common/SearchableMenu";
import Selector from "@/components/map/panels/common/Selector";
import Expression from "@/components/map/panels/filter/Expression";
import { FilterFoot } from "@/components/map/panels/filter/FilterFoot";
import { AddButton } from "@/components/map/panels/styleEditor/rows";

/** A fresh, empty expression of one kind, ready to be filled in. */
export const createExpression = (type: FilterType): ExpressionType => ({
  id: v4(),
  attribute: "",
  expression: "",
  value: "",
  type,
});

/**
 * Whether every expression is complete enough to build a query from.
 *
 * The operators that test for absence or a boolean carry no value of their
 * own, so they count as answered without one.
 */
export const validateExpressions = (expressions: ExpressionType[]): boolean =>
  expressions.every((expression) => {
    const valueless =
      expression.expression === "is_empty_string" ||
      expression.expression === "is_not_empty_string" ||
      expression.expression === "is_blank" ||
      expression.expression === "is_not_blank" ||
      expression.expression === "is_true" ||
      expression.expression === "is_false";
    const hasValue = valueless || !!expression.value?.toString();
    return !!expression.attribute && !!expression.expression && hasValue;
  });

const FilterPanel = ({ activeLayer, projectId }: { activeLayer: ProjectLayer; projectId: string }) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const [previousLayerId, setPreviousLayerId] = useState<string | null>(null);
  const { layerFields } = useLayerFields(activeLayer?.layer_id || "");
  const { layers: projectLayers, mutate: mutateProjectLayers } = useFilteredProjectLayers(projectId);
  const { execute: executeProcess } = useProcessExecution();
  const [isSaving, setIsSaving] = useState(false);

  // Add filter expression
  const [addExpressionAnchorEl, setAddExpressionAnchorEl] = React.useState<null | HTMLElement>(null);
  // The menu opens under the button, its left edge on the content's (the button's plus sits on that edge, its box
  // reaches into the gutter); Escape gives the focus back to the button.
  const addMenuEdge = React.useRef<HTMLDivElement>(null);
  const [addButton, setAddButton] = React.useState<HTMLButtonElement | null>(null);
  const handleAddExpressionClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (activeLayer?.type === layerType.Values.feature) {
      setAddButton(event.currentTarget);
      setAddExpressionAnchorEl(addMenuEdge.current);
    } else {
      addExpression(FilterType.Logical);
    }
  };
  const addExpressionItems = [
    { sourceType: FilterType.Logical, iconName: ICON_NAME.TABLE, label: t("logical_expression") },
    { sourceType: FilterType.Spatial, iconName: ICON_NAME.MAP, label: t("spatial_expression") },
  ];

  const [expressions, setExpressions] = useState<ExpressionType[]>([]);

  const defaultLogicalOperator: SelectorItem = {
    value: "and",
    label: t("and"),
  };
  const logicalOperators = useMemo(() => {
    return [
      {
        value: "and",
        label: t("match_all_filters"),
      },
      {
        value: "or",
        label: t("match_at_least_one_filter"),
      },
    ];
  }, [t]);

  const [logicalOperator, setLogicalOperator] = useState<SelectorItem | undefined>(defaultLogicalOperator);

  const addExpression = (type: FilterType) => {
    if (expressions) {
      setExpressions([...expressions, createExpression(type)]);
    }
  };

  // Load existing expressions — re-sync when CQL changes externally (e.g. quick filter popover)
  const cqlArgsCount = (activeLayer?.query?.cql as { args?: unknown[] })?.args?.length ?? 0;
  useEffect(() => {
    if (activeLayer?.layer_id !== previousLayerId && activeLayer?.layer_id) {
      setPreviousLayerId(activeLayer?.layer_id);
      setExpressions([]);
    }
    // Skip only if local expressions already match the CQL arg count
    if (expressions.length && expressions.length >= cqlArgsCount) return;
    const existingExpressions = parseCQLQueryToObject(
      activeLayer?.query?.cql as { op: string; args: unknown[] }
    );
    if (activeLayer?.query?.cql?.["op"] && activeLayer.query.cql !== null) {
      const operator = activeLayer.query.cql["op"];
      if (operator) {
        setLogicalOperator(logicalOperators.find((item) => item.value === operator));
      }
    }
    setExpressions(existingExpressions);
  }, [activeLayer, expressions.length, cqlArgsCount, logicalOperators, previousLayerId]);

  const areAllExpressionsValid = useMemo(() => {
    return validateExpressions(expressions);
  }, [expressions]);

  const updateLayer = async (query) => {
    if (!activeLayer) return;
    const layers = JSON.parse(JSON.stringify(projectLayers));
    const index = layers.findIndex((l) => l.id === activeLayer.id);
    const layerToUpdate = layers[index];
    if (query === null) {
      layerToUpdate.query = null;
    } else {
      layerToUpdate.query = {
        cql: query,
      };
    }
    await mutateProjectLayers(layers, false);
    await updateProjectLayer(projectId, activeLayer.id, { query: layerToUpdate.query });
  };

  const updateLayerQuery = async (expressions, logicalOperator) => {
    if (expressions.length === 0) {
      await updateLayer(null);
      return;
    }
    if (!activeLayer || !logicalOperator || !validateExpressions(expressions)) return;
    const query = createTheCQLBasedOnExpression(
      expressions,
      layerFields,
      logicalOperator.value as "and" | "or"
    );
    await updateLayer(query);
  };

  const clearFilter = async () => {
    setExpressions([]);
    await updateLayer(null);
  };

  const saveAsNewLayer = async () => {
    if (!activeLayer?.query?.cql) return;
    setIsSaving(true);
    try {
      const result = await executeProcess("layer_create_filtered", {
        source_layer_id: activeLayer.layer_id,
        cql_filter: activeLayer.query.cql,
        project_id: projectId,
        result_layer_name: `${activeLayer.name} (${t("filtered")})`,
        // The new layer takes this project layer's active style.
        source_layer_project_id: activeLayer.id,
      });
      if (result?.jobID) {
        toast.info(`${t("save_as_new_layer")} - ${t("job_started")}`);
        dispatch(setRunningJobIds([...runningJobIds, result.jobID]));
      }
    } catch (error) {
      toast.error(creditsErrorMessage(error, t) ?? t("save_as_new_layer_error"));
    } finally {
      setIsSaving(false);
    }
  };

  // The body scrolls; the foot with the actions stays under it, in view.
  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 3, pt: 3, pb: 4 }}>
        {!expressions?.length && (
          <Typography variant="caption" component="p" color="text.secondary">
            {t("filter_layer_message")}
          </Typography>
        )}
        {/* The expressions, each closed by its own rule; with two or more, how they combine heads them. */}
        {!!expressions?.length && (
          <Stack spacing={4}>
            {expressions.length > 1 && (
              <Selector
                selectedItems={logicalOperator}
                setSelectedItems={(item: SelectorItem[] | SelectorItem | undefined) => {
                  setLogicalOperator(item as SelectorItem);
                  updateLayerQuery(expressions, item);
                }}
                items={logicalOperators}
                label={t("filter_results")}
              />
            )}
            {expressions.map((expression: ExpressionType) => (
              <Expression
                key={expression.id}
                expression={expression}
                onDelete={async (expression) => {
                  const updatedExpressions = expressions.filter((e) => e.id !== expression.id);
                  setExpressions(updatedExpressions);
                  await updateLayerQuery(updatedExpressions, logicalOperator);
                }}
                onDuplicate={async (expression: ExpressionType) => {
                  const updatedExpressions = [...expressions, { ...expression, id: v4() }];
                  setExpressions(updatedExpressions);
                  await updateLayerQuery(updatedExpressions, logicalOperator);
                }}
                onUpdate={async (expression: ExpressionType) => {
                  const updatedExpressions = expressions.map((e) =>
                    e.id === expression.id ? expression : e
                  );
                  setExpressions(updatedExpressions);
                  await updateLayerQuery(updatedExpressions, logicalOperator);
                }}
              />
            ))}
          </Stack>
        )}

        {/* Under the last expression, its plus on the content's edge (as a rule's "Add a condition"). */}
        {activeLayer && (
          <AddButton
            onClick={handleAddExpressionClick}
            disabled={!areAllExpressionsValid}
            sx={{ ml: -2.5, mt: 2 }}>
            {t("add_expression")}
          </AddButton>
        )}
        <Box ref={addMenuEdge} sx={{ width: 0, height: 0 }} />
        {activeLayer?.type === layerType.Values.feature && (
          <SearchableMenu
            anchorEl={addExpressionAnchorEl}
            role="menu"
            placement="bottom-start"
            items={addExpressionItems.map((item) => ({
              label: item.label,
              icon: item.iconName,
              onClick: () => addExpression(item.sourceType),
            }))}
            focusOnClose={addButton}
            onClose={() => setAddExpressionAnchorEl(null)}
          />
        )}
      </Box>

      {!!expressions?.length && (
        <FilterFoot
          onClear={clearFilter}
          action={{
            label: t("save_as_new_layer"),
            onClick: saveAsNewLayer,
            loading: isSaving,
            // A filter that is saved and complete: the new layer is made from the stored query.
            disabled: !activeLayer?.query?.cql || !areAllExpressionsValid,
          }}
        />
      )}
    </Box>
  );
};

export default FilterPanel;
