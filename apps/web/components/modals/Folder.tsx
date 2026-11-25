import { DialogContentText } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";
import { toast } from "react-toastify";
import { mutate } from "swr";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { FOLDERS_API_BASE_URL, createFolder, deleteFolder, updateFolder } from "@/lib/api/folders";

import type { DialogBaseProps } from "@/types/common/dialog";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import LabeledField from "@/components/common/LabeledField";

export interface SelectedFolderForEdit {
  id: string;
  name: string;
}

interface FolderDialogProps extends DialogBaseProps {
  type: "create" | "update" | "delete";
  selectedFolder?: SelectedFolderForEdit;
  disabled?: boolean;
  onEdit?: () => void;
  existingFolderNames?: string[];
  /** Parent folder for a newly created folder; omitted or `null` creates it
   * at a space's root. Ignored for `update`/`delete`. */
  parentId?: string | null;
  /** Space to create a root folder in when there is no `parentId`; omitted
   * creates it in the caller's personal space. Ignored for
   * `update`/`delete`. */
  spaceId?: string | null;
}

const FolderModal: React.FC<FolderDialogProps> = ({
  type,
  selectedFolder,
  open,
  existingFolderNames,
  onClose,
  onEdit,
  parentId,
  spaceId,
}) => {
  const [folderName, setFolderName] = useState<string>(selectedFolder?.name ?? "");
  const { t } = useTranslation("common");

  const handleFolderEdit = async () => {
    try {
      if (type === "create") {
        await createFolder(folderName, parentId, spaceId);
        toast.success(t("created_successfully"));
      }
      if (selectedFolder?.id) {
        if (type === "delete") {
          await deleteFolder(selectedFolder?.id);
          toast.success(t("deleted_successfully"));
        }

        if (type === "update") {
          await updateFolder(selectedFolder.id, { name: folderName });
          toast.success(t("updated_successfully"));
        }
      }

      mutate((key) => Array.isArray(key) && key[0] === FOLDERS_API_BASE_URL);
    } catch {
      // The folder API throws a fixed English message, so the toast names the
      // failed action in the reader's language instead.
      const errorKey = {
        create: "error_creating_folder",
        update: "error_updating_folder",
        delete: "error_deleting_folder",
      }[type];
      toast.error(t(errorKey));
    }

    setFolderName(selectedFolder?.name ?? "");
    onEdit?.();
  };

  const isDelete = type === "delete";

  const cancel = () => {
    setFolderName(selectedFolder?.name ?? "");
    onClose?.();
  };

  return (
    <AppDialog
      open={open}
      onClose={cancel}
      icon={isDelete ? ICON_NAME.TRASH : ICON_NAME.FOLDER}
      tone={isDelete ? "warning" : "primary"}
      title={
        {
          create: t("create_folder"),
          update: t("update_folder"),
          delete: t("delete_folder"),
        }[type]
      }
      footer={
        <AppDialogFooter
          onCancel={cancel}
          primaryLabel={
            {
              create: t("create"),
              update: t("update"),
              delete: t("delete"),
            }[type]
          }
          onPrimary={() => void handleFolderEdit()}
          primaryColor={isDelete ? "error" : "primary"}
          primaryDisabled={folderName === "" && !isDelete}
        />
      }>
      {["update", "create"].includes(type) && (
        <LabeledField
          autoFocus={true}
          autoComplete="off"
          id="folder-name"
          value={folderName}
          inputProps={{ maxLength: 30 }}
          label={t("folder_name")}
          error={
            folderName.length > 29
              ? t("folder_rule")
              : existingFolderNames?.includes(folderName)
                ? t("folder_exists")
                : undefined
          }
          onChange={(e) => setFolderName(e.target.value)}
        />
      )}

      {isDelete && (
        <DialogContentText>
          <Trans
            i18nKey="common:are_you_sure_to_delete_folder"
            values={{ folder: selectedFolder?.name }}
            components={{ b: <b /> }}
          />
        </DialogContentText>
      )}
    </AppDialog>
  );
};

export default FolderModal;
