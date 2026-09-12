"use client";

import { Box, Typography, alpha, useTheme } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { AppDispatch } from "@/lib/store";
import { selectEdges, selectNodes } from "@/lib/store/workflow/selectors";
import { updateNode } from "@/lib/store/workflow/slice";
import {
  type CanvasNode,
  type MissingField,
  datasetRows,
  isToolNode,
  missingFieldRefs,
  replaceDatasetLayers,
  sameShapeLayers,
} from "@/lib/utils/workflowDatasets";
import type { ProjectLayer } from "@/lib/validations/project";

import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";
import { useLayerFieldNames } from "@/hooks/map/useLayerFieldNames";
import { useProcessDescriptions } from "@/hooks/map/useOgcProcesses";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import Selector from "@/components/map/panels/common/Selector";
import { DialogGroupLabel } from "@/components/modals/content/ContentDialogChrome";

export interface ReplaceDatasetsDialogProps {
  projectId: string;
  workflowName: string;
  onClose: () => void;
}

const GEOMETRY_ICON: Record<string, ICON_NAME> = {
  point: ICON_NAME.POINT_FEATURE,
  line: ICON_NAME.LINE_FEATURE,
  polygon: ICON_NAME.POLYGON_FEATURE,
};

const geometryIconFor = (geometryType: string | null | undefined): ICON_NAME =>
  (geometryType && GEOMETRY_ICON[geometryType]) || ICON_NAME.TABLE;

/**
 * "Replace datasets…" from the workflow menu: one row per dataset node of
 * the open workflow, each offering the project's layers of the same shape.
 * Replace re-points the picked nodes (and any tool config that named the
 * old layer) through the store, so the canvas auto-save persists it. Field
 * references the new layers do not carry are named before the click; the
 * tool nodes keep flagging them afterwards.
 */
const ReplaceDatasetsDialog = ({ projectId, workflowName, onClose }: ReplaceDatasetsDialogProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useDispatch<AppDispatch>();
  const nodes = useSelector(selectNodes);
  const edges = useSelector(selectEdges);
  const { layers } = useFilteredProjectLayers(projectId);
  const [picks, setPicks] = useState<Record<string, string>>({});

  const rows = useMemo(() => datasetRows(nodes, edges), [nodes, edges]);
  const processIds = useMemo(() => nodes.filter(isToolNode).map((node) => node.data.processId), [nodes]);
  const { processes } = useProcessDescriptions(processIds);

  const pickedLayers = useMemo(() => {
    const byNode: Record<string, ProjectLayer> = {};
    for (const [nodeId, layerId] of Object.entries(picks)) {
      const layer = (layers ?? []).find((candidate) => candidate.layer_id === layerId);
      if (layer) byNode[nodeId] = layer;
    }
    return byNode;
  }, [picks, layers]);

  const changes = useMemo(() => replaceDatasetLayers(nodes, pickedLayers), [nodes, pickedLayers]);
  const { fieldsByLayerId } = useLayerFieldNames(Object.values(pickedLayers).map((layer) => layer.layer_id));

  // What the tools would be missing once the picks are applied: the check
  // runs against the nodes as they would be, so only the new layers, whose
  // fields are fetched above, are judged.
  const warnings = useMemo<MissingField[]>(() => {
    if (changes.length === 0) return [];
    const byId = new Map(changes.map((change) => [change.id, change.changes.data]));
    const next: CanvasNode[] = nodes.map((node) =>
      byId.has(node.id) ? { ...node, data: byId.get(node.id) as CanvasNode["data"] } : node
    );
    return next
      .filter(isToolNode)
      .flatMap((node) =>
        missingFieldRefs(node, processes[node.data.processId], edges, next, fieldsByLayerId)
      );
  }, [changes, nodes, edges, processes, fieldsByLayerId]);

  const handleReplace = () => {
    for (const change of changes) dispatch(updateNode(change));
    toast.success(t("datasets_replaced"));
    onClose();
  };

  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.REFRESH}
      title={t("replace_datasets").replace(/…$/, "")}
      subtitle={`${workflowName} · ${t("datasets")} ${rows.length}`}
      maxWidth={620}
      closeLabel={t("cancel")}
      bodySx={{ padding: "22px", maxHeight: "60vh" }}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          primaryLabel={t("replace")}
          onPrimary={handleReplace}
          primaryDisabled={changes.length === 0}
        />
      }>
      <>
        <DialogGroupLabel first>{t("datasets_in_this_workflow")}</DialogGroupLabel>
        {rows.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: theme.palette.text.secondary }}>
            {t("no_datasets_in_workflow")}
          </Typography>
        ) : (
          <Box
            sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: "10px", overflow: "hidden" }}>
            {rows.map((row, index) => {
              const candidates = sameShapeLayers(layers ?? [], row.data).filter(
                (layer) => layer.layer_id !== row.data.layerId
              );
              // The layer the node reads now, when it says more than the
              // node's own label; a node without a layer is what a template's
              // open slot leaves behind.
              const current =
                row.data.layerName && row.data.layerName !== row.data.label ? row.data.layerName : null;
              const picked = pickedLayers[row.node.id];
              const detail = [
                row.data.geometryType
                  ? t(row.data.geometryType)
                  : row.data.layerType
                    ? t(row.data.layerType)
                    : null,
                row.feeds.length > 0 ? t("feeds_tools", { tools: row.feeds.join(", ") }) : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <Box
                  key={row.node.id}
                  data-testid={`replace-dataset-row-${row.node.id}`}
                  sx={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) 230px",
                    gap: "12px",
                    alignItems: "center",
                    padding: "10px 12px",
                    borderTop: index > 0 ? `1px solid ${theme.palette.divider}` : undefined,
                  }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                      <Icon
                        iconName={geometryIconFor(row.data.geometryType)}
                        style={{ fontSize: 15, color: theme.palette.text.secondary, flexShrink: 0 }}
                      />
                      <Typography noWrap sx={{ fontSize: 13, fontWeight: 700 }}>
                        {row.data.label}
                      </Typography>
                    </Box>
                    {detail && (
                      <Typography
                        noWrap
                        sx={{ ml: "23px", fontSize: 11.5, color: theme.palette.text.secondary }}>
                        {detail}
                      </Typography>
                    )}
                    {current && (
                      <Typography
                        noWrap
                        sx={{ ml: "23px", fontSize: 11.5, color: theme.palette.text.secondary }}>
                        {t("now_layer", { layer: current })}
                      </Typography>
                    )}
                    {!row.data.layerId && (
                      <Typography
                        noWrap
                        sx={{ ml: "23px", fontSize: 11.5, color: theme.palette.warning.main }}>
                        {t("unresolved_input")}
                      </Typography>
                    )}
                  </Box>
                  {candidates.length > 0 ? (
                    <Selector
                      items={[
                        { value: "", label: t("keep") },
                        ...candidates.map((layer) => ({
                          value: layer.layer_id,
                          label: layer.name,
                          icon: geometryIconFor(layer.feature_layer_geometry_type),
                        })),
                      ]}
                      selectedItems={
                        picked
                          ? {
                              value: picked.layer_id,
                              label: picked.name,
                              icon: geometryIconFor(picked.feature_layer_geometry_type),
                            }
                          : undefined
                      }
                      setSelectedItems={(items) => {
                        const item = Array.isArray(items) ? items[0] : items;
                        const value = item?.value;
                        setPicks((prev) => {
                          const next = { ...prev };
                          if (typeof value === "string" && value) next[row.node.id] = value;
                          else delete next[row.node.id];
                          return next;
                        });
                      }}
                      placeholder={t("keep")}
                      enableSearch={candidates.length > 6}
                    />
                  ) : (
                    <Typography sx={{ fontSize: 12, color: theme.palette.text.disabled, textAlign: "right" }}>
                      {t("no_other_matching_layer")}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        )}

        {warnings.map((warning) => (
          <Box
            key={`${warning.toolLabel}-${warning.paramLabel}-${warning.field}`}
            role="alert"
            sx={{
              mt: "10px",
              display: "flex",
              gap: "8px",
              alignItems: "flex-start",
              padding: "9px 12px",
              borderRadius: "9px",
              fontSize: 12.5,
              backgroundColor: alpha(theme.palette.warning.main, 0.14),
            }}>
            <Icon
              iconName={ICON_NAME.CIRCLEINFO}
              style={{ fontSize: 14, marginTop: 2, color: theme.palette.warning.main }}
            />
            <span>
              {t("field_missing_in_layer", {
                tool: warning.toolLabel,
                field: warning.field,
                param: warning.paramLabel,
                layer: warning.layerName,
              })}
            </span>
          </Box>
        ))}

        <Typography sx={{ mt: "12px", fontSize: 12, color: theme.palette.text.secondary }}>
          {t("replace_datasets_hint")}
        </Typography>
      </>
    </AppDialog>
  );
};

export default ReplaceDatasetsDialog;
