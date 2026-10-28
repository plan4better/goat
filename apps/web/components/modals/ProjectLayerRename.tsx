import { Checkbox, FormControlLabel, Stack, TextField, Typography } from "@mui/material";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { mutate } from "swr";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { matchesContentListKey } from "@/lib/api/datasets";
import { updateDataset, useDataset } from "@/lib/api/layers";
import { updateProjectLayer, useProjectLayers } from "@/lib/api/projects";
import type { ProjectLayer } from "@/lib/validations/project";
import { isCatalogLayer } from "@/lib/utils/catalog-layer";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

interface ProjectLayerRenameDialogProps {
  open: boolean;
  projectLayer: ProjectLayer;
  onRename?: () => void;
  onClose?: () => void;
}

const ProjectLayerRenameModal: React.FC<ProjectLayerRenameDialogProps> = ({
  open,
  projectLayer,
  onClose,
  onRename,
}) => {
  const { t } = useTranslation("common");
  const { projectId } = useParams() as { projectId: string };
  const [isLoading, setIsLoading] = useState(false);
  const { dataset } = useDataset(projectLayer?.layer_id);
  const { mutate: mutateProjectLayers } = useProjectLayers(projectId);
  const [renameSourceLayer, setRenameSourceLayer] = useState(false);
  const [layerName, setLayerName] = useState(projectLayer.name);

  async function handleRename() {
    try {
      setIsLoading(true);
      if (!projectLayer) return;

      await updateProjectLayer(projectId, projectLayer.id, { name: layerName });

      if (renameSourceLayer && dataset) {
        await updateDataset(dataset.id, {
          name: layerName,
        });
        // Invalidate dataset layers cache
        mutate(matchesContentListKey);
        toast.success(t("rename_layer_success"));
      }

      // Always refresh project layers after rename
      mutateProjectLayers();

      onRename?.();
    } catch (error) {
      toast.error(t("error_renaming_layer"));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <AppDialog
      open={open}
      onClose={() => onClose?.()}
      icon={ICON_NAME.EDITPEN}
      title={t("rename_project_layer")}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          primaryLabel={t("rename")}
          onPrimary={() => void handleRename()}
          primaryLoading={isLoading}
        />
      }>
      <Stack>
        <TextField
          autoFocus
          size="small"
          fullWidth
          inputProps={{
            style: {
              fontSize: "0.875rem",
              fontWeight: "bold",
            },
          }}
          defaultValue={layerName}
          onChange={(e) => {
            setLayerName(e.target.value);
          }}
        />
      </Stack>
      {!isCatalogLayer(projectLayer) && (
        <Stack sx={{ mt: 2 }}>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                color="primary"
                checked={renameSourceLayer}
                onChange={(e) => {
                  setRenameSourceLayer(e.target.checked);
                }}
              />
            }
            label={
              <Typography variant="body2" fontWeight="bold">
                {t("rename_dataset_source")}
              </Typography>
            }
          />
        </Stack>
      )}
    </AppDialog>
  );
};

export default ProjectLayerRenameModal;
