import { Alert, DialogContentText, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { ProjectLayerTreeNode } from "@/lib/validations/project";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import LabeledField from "@/components/common/LabeledField";

type LayerGroupModalMode = "create" | "rename" | "delete";

interface ProjectLayerGroupModalProps {
  open: boolean;
  onClose: () => void;
  mode: LayerGroupModalMode;
  projectId: string;
  existingGroup?: ProjectLayerTreeNode;
  layerTree?: ProjectLayerTreeNode[];
  onSubmit?: (data: { name?: string; groupId?: number }) => Promise<void>;
}

const ProjectLayerGroupModal = ({
  open,
  onClose,
  mode,
  existingGroup,
  layerTree = [],
  onSubmit,
}: ProjectLayerGroupModalProps) => {
  const { t } = useTranslation("common");
  const [isLoading, setIsLoading] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) {
      if (mode === "rename" && existingGroup) {
        setName(existingGroup.name);
      } else if (mode === "create") {
        setName("");
      }
    }
  }, [open, mode, existingGroup]);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
  };

  const handleSubmit = async () => {
    setIsLoading(true);
    try {
      const data: { name?: string; groupId?: number } = {};

      if (mode === "create" || mode === "rename") {
        data.name = name.trim();
      }

      if ((mode === "rename" || mode === "delete") && existingGroup) {
        data.groupId = existingGroup.id;
      }

      if (onSubmit) {
        await onSubmit(data);
      }

      const successMessage =
        mode === "create"
          ? t("group_created_successfully")
          : mode === "rename"
            ? t("group_renamed_successfully")
            : t("group_deleted_successfully");

      toast.success(successMessage);
      handleClose();
    } catch (error) {
      console.error(`Error ${mode}ing group:`, error);
      const errorMessage =
        mode === "create"
          ? t("error_creating_group")
          : mode === "rename"
            ? t("error_renaming_group")
            : t("error_deleting_group");
      toast.error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setName("");
    onClose();
  };

  // Membership, not existence: deleting the group drops the project's links to
  // the bundle's layers. The bundle and its data are untouched, so the wording
  // says "remove" where the generic group says "delete".
  const isBundleGroup = !!existingGroup?.bundle_id;

  const getDialogTitle = () => {
    switch (mode) {
      case "create":
        return t("create_group");
      case "rename":
        return t("rename_group");
      case "delete":
        return isBundleGroup ? t("remove_bundle") : t("delete_group");
      default:
        return t("group");
    }
  };

  const getSubmitButtonText = () => {
    switch (mode) {
      case "create":
        return t("create");
      case "rename":
        return t("rename");
      case "delete":
        return isBundleGroup ? t("remove") : t("delete");
      default:
        return t("submit");
    }
  };

  // Check if the group has children (layers or subgroups)
  const getGroupChildren = () => {
    if (!existingGroup || mode !== "delete") return { layers: [], groups: [] };

    const children = layerTree.filter((node) => node.parent_id === existingGroup.id);
    const layers = children.filter((node) => node.type === "layer");
    const groups = children.filter((node) => node.type === "group");

    return { layers, groups };
  };

  const { layers: childLayers, groups: childGroups } = getGroupChildren();
  const hasChildren = childLayers.length > 0 || childGroups.length > 0;

  const isDelete = mode === "delete";

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      icon={isDelete ? ICON_NAME.TRASH : ICON_NAME.LAYERS}
      tone={isDelete ? "warning" : "primary"}
      title={getDialogTitle()}
      closeDisabled={isLoading}
      footer={
        <AppDialogFooter
          onCancel={handleClose}
          cancelDisabled={isLoading}
          primaryLabel={getSubmitButtonText()}
          onPrimary={() => void handleSubmit()}
          primaryColor={isDelete ? "error" : "primary"}
          primaryLoading={isLoading}
        />
      }>
      {isDelete ? (
        <>
          <DialogContentText>
            <Trans
              i18nKey={
                isBundleGroup ? "common:are_you_sure_to_remove_bundle" : "common:are_you_sure_to_delete_group"
              }
              values={{ group: existingGroup?.name }}
              components={{ b: <b /> }}
            />
          </DialogContentText>
          {hasChildren && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              <Stack>
                <Trans
                  i18nKey={isBundleGroup ? "common:bundle_remove_warning" : "common:group_delete_warning"}
                  values={{
                    layerCount: childLayers.length,
                    groupCount: childGroups.length,
                  }}
                  components={{ b: <b /> }}
                />
                {childLayers.length > 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
                    <b>{t("layers")}:</b> {childLayers.map((layer) => layer.name).join(", ")}
                  </Typography>
                )}
                {!isBundleGroup && childGroups.length > 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                    <b>{t("subgroups")}:</b> {childGroups.map((group) => group.name).join(", ")}
                  </Typography>
                )}
              </Stack>
            </Alert>
          )}
        </>
      ) : (
        <Stack spacing={3} sx={{ mt: 1 }}>
          <LabeledField
            id="layer-group-name"
            name="name"
            label={t("group_name")}
            value={name}
            onChange={handleNameChange}
            placeholder={t("enter_group_name")}
            // A group's name is no personal detail: the browser has nothing to suggest.
            autoComplete="off"
            autoFocus
          />
        </Stack>
      )}
    </AppDialog>
  );
};

export default ProjectLayerGroupModal;
