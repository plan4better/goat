import { LoadingButton } from "@mui/lab";
import {
  Box,
  Button,
  ClickAwayListener,
  Divider,
  ListItemIcon,
  Menu,
  MenuItem,
  MenuList,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { v4 } from "uuid";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

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

import Selector from "@/components/map/panels/common/Selector";
import Expression from "@/components/map/panels/filter/Expression";

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
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const [previousLayerId, setPreviousLayerId] = useState<string | null>(null);
  const { layerFields } = useLayerFields(activeLayer?.layer_id || "");
  const { layers: projectLayers, mutate: mutateProjectLayers } = useFilteredProjectLayers(projectId);
  const { execute: executeProcess } = useProcessExecution();
  const [isSaving, setIsSaving] = useState(false);

  // Add filter expression
  const [addExpressionAnchorEl, setAddExpressionAnchorEl] = React.useState<null | HTMLElement>(null);
  const handleAddExpressionClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (activeLayer?.type === layerType.Values.feature) {
      setAddExpressionAnchorEl(event.currentTarget);
    } else {
      addExpression(FilterType.Logical);
    }
  };
  const handleAddExpressionClose = () => {
    setAddExpressionAnchorEl(null);
  };
  const open = Boolean(addExpressionAnchorEl);
  const addExpressionItems = [
    {
      sourceType: FilterType.Logical,
      iconName: ICON_NAME.TABLE,
      label: t("logical_expression"),
    },
    {
      sourceType: FilterType.Spatial,
      iconName: ICON_NAME.MAP,
      label: t("spatial_expression"),
    },
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
    await updateProjectLayer(projectId, activeLayer.id, layerToUpdate);
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
        source_properties: activeLayer.properties ?? undefined,
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

  return (
    <Box sx={{ p: 3 }}>
      {/* DESCRIPTION */}
      {!expressions?.length && (
        <Typography variant="body2" sx={{ fontStyle: "italic", marginBottom: theme.spacing(4) }}>
          {t("filter_layer_message")}
        </Typography>
      )}
      {expressions && expressions?.length > 1 && (
        <>
          <Divider />
          <Selector
            selectedItems={logicalOperator}
            setSelectedItems={(item: SelectorItem[] | SelectorItem | undefined) => {
              setLogicalOperator(item as SelectorItem);
              updateLayerQuery(expressions, item);
            }}
            items={logicalOperators}
            label={t("filter_results")}
          />
        </>
      )}

      {expressions && !!expressions?.length && (
        <Stack spacing={4} sx={{ pt: 4 }}>
          <Divider />
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
                const updatedExpressions = expressions.map((e) => (e.id === expression.id ? expression : e));
                setExpressions(updatedExpressions);
                await updateLayerQuery(updatedExpressions, logicalOperator);
              }}
            />
          ))}
        </Stack>
      )}

      {activeLayer && (
        <Stack spacing={2} sx={{ pt: 4 }}>
          {/* ADD EXPRESSION */}
          <Button
            onClick={handleAddExpressionClick}
            fullWidth
            size="small"
            disabled={!areAllExpressionsValid}
            startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: "15px" }} />}>
            <Typography variant="body2" fontWeight="bold" color="inherit">
              {t("common:add_expression")}
            </Typography>
          </Button>
          {activeLayer.type === layerType.Values.feature && (
            <Menu
              anchorEl={addExpressionAnchorEl}
              sx={{
                "& .MuiPaper-root": {
                  boxShadow: "0px 0px 10px 0px rgba(58, 53, 65, 0.1)",
                },
              }}
              anchorOrigin={{ vertical: "top", horizontal: "center" }}
              transformOrigin={{ vertical: "bottom", horizontal: "center" }}
              open={open}
              MenuListProps={{
                "aria-labelledby": "basic-button",
                sx: {
                  width: addExpressionAnchorEl && addExpressionAnchorEl.offsetWidth - 10,
                  p: 0,
                },
              }}
              onClose={handleAddExpressionClose}>
              <Box>
                <ClickAwayListener onClickAway={handleAddExpressionClose}>
                  <MenuList>
                    {addExpressionItems.map((item, index) => (
                      <MenuItem
                        key={index}
                        onClick={() => {
                          addExpression(item.sourceType);
                          handleAddExpressionClose();
                        }}>
                        <ListItemIcon>
                          <Icon iconName={item.iconName} style={{ fontSize: "15px" }} />
                        </ListItemIcon>
                        <Typography variant="body2">{item.label}</Typography>
                      </MenuItem>
                    ))}
                  </MenuList>
                </ClickAwayListener>
              </Box>
            </Menu>
          )}
          {/* CLEAR FILTER */}
          <Button
            variant="outlined"
            fullWidth
            size="small"
            color="error"
            disabled={!expressions?.length}
            onClick={clearFilter}>
            <Typography variant="body2" color="inherit">
              {t("common:clear_filter")}
            </Typography>
          </Button>
          {/* SAVE AS NEW LAYER */}
          {activeLayer?.query?.cql && expressions?.length > 0 && areAllExpressionsValid && (
            <>
              <Divider />
              <LoadingButton
                fullWidth
                size="small"
                loading={isSaving}
                startIcon={<Icon iconName={ICON_NAME.SAVE} style={{ fontSize: "15px" }} />}
                onClick={saveAsNewLayer}>
                <Typography variant="body2" fontWeight="bold" color="inherit">
                  {t("save_as_new_layer")}
                </Typography>
              </LoadingButton>
            </>
          )}
        </Stack>
      )}
    </Box>
  );
};

export default FilterPanel;
