"use client";

import { Box, Button, Divider, Stack, Typography } from "@mui/material";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch } from "react-redux";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { AppDispatch } from "@/lib/store";
import { updateNode } from "@/lib/store/workflow/slice";
import type { ToolNodeData } from "@/lib/validations/workflow";
import {
  type DatasetConnection,
  connectionFromNode,
  nodeDataFromConnection,
} from "@/lib/workflows/datasetConnection";

import AddLayerDialog from "@/components/addLayer/AddLayerDialog";
import { addLayerSource } from "@/components/addLayer/sources";

const areaLine = (connection: DatasetConnection, t: (key: string) => string): string => {
  const choice = connection.areaChoice;
  if (choice?.kind === "region") {
    const names = choice.nutsIds.map((id) => choice.names?.[id] ?? id);
    return `${t("fetch_features_area")}: ${names.join(", ")}`;
  }
  if (choice?.kind === "point") return `${t("fetch_features_area")}: ${t("catalog_mode_point")}`;
  if (choice?.kind === "polygon") return `${t("fetch_features_area")}: ${t("catalog_mode_polygon")}`;
  if (choice?.kind === "view") return `${t("fetch_features_area")}: ${t("fetch_features_area_view")}`;
  return "";
};

// "amenity = school, kindergarten", or SQL for a written condition.
const filterLine = (params: Record<string, unknown>): string => {
  if (typeof params.where === "string" && params.where.trim()) return "SQL";
  const filters = (params.tag_filters ?? []) as { key: string; values: string[] }[];
  return filters.map((f) => (f.values.length ? `${f.key} = ${f.values.join(", ")}` : f.key)).join("; ");
};

const SectionTitle = ({ label }: { label: string }) => (
  <Box sx={{ mb: 2 }}>
    <Typography variant="body2" fontWeight="bold" sx={{ mb: 1 }}>
      {label}
    </Typography>
    <Divider />
  </Box>
);

/** The choice of an Integrate dataset node, made in Add layer's OpenStreetMap / Overture dialog. */
export default function IntegrateDatasetSettings({ nodeId, data }: { nodeId: string; data: ToolNodeData }) {
  const { t } = useTranslation("common");
  const dispatch = useDispatch<AppDispatch>();
  const { projectId } = useParams() ?? {};
  const [open, setOpen] = useState(false);
  const initial = connectionFromNode(data);

  const onUse = (connection: DatasetConnection) => {
    dispatch(
      updateNode({ id: nodeId, changes: { data: { ...data, ...nodeDataFromConnection(connection) } } })
    );
  };

  const lines = initial ? [areaLine(initial, t), filterLine(initial.params)].filter(Boolean) : [];

  const button = (iconName: ICON_NAME, label: string) => (
    <Button
      variant="outlined"
      size="small"
      fullWidth
      startIcon={<Icon iconName={iconName} style={{ fontSize: 15 }} />}
      onClick={() => setOpen(true)}
      sx={{ borderRadius: 4, textTransform: "none", fontWeight: "bold" }}>
      {label}
    </Button>
  );

  // Laid out like the Add dataset node's panel.
  return (
    <Box sx={{ mt: 1, mb: 2 }}>
      <SectionTitle label={initial ? t("details") : t("source")} />
      {initial ? (
        <>
          <Stack spacing={0.5}>
            <Typography variant="body2" fontWeight="bold">
              {t("source")}
            </Typography>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Icon iconName={addLayerSource("connect").icon} style={{ fontSize: 16 }} />
              <Typography variant="body2" color="text.secondary">
                {data.label}
              </Typography>
            </Stack>
            {lines.map((line) => (
              <Typography key={line} variant="body2" color="text.secondary">
                {line}
              </Typography>
            ))}
          </Stack>
          <Box sx={{ mt: 4 }}>
            <SectionTitle label={t("actions")} />
          </Box>
          {button(ICON_NAME.EDIT, t("edit"))}
        </>
      ) : (
        <Box sx={{ pt: 2 }}>{button(ICON_NAME.PLUS, t("fetch_data_choose_button"))}</Box>
      )}
      <AddLayerDialog
        source={open ? "connect" : null}
        projectId={projectId as string | undefined}
        workflow={{ initial, onUse }}
        onClose={() => setOpen(false)}
      />
    </Box>
  );
}
