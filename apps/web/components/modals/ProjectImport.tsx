import { zodResolver } from "@hookform/resolvers/zod";
import { Stack, TextField } from "@mui/material";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { z } from "zod";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { requestDatasetUpload } from "@/lib/api/datasets";
import { useFolders } from "@/lib/api/folders";
import { executeProcessAsync } from "@/lib/api/processes";
import { uploadFileToS3 } from "@/lib/services/s3";
import { setRunningJobIds } from "@/lib/store/jobs/slice";
import type { GetContentQueryParams } from "@/lib/validations/common";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { MuiFileInput } from "@/components/common/FileInput";
import { RhfAutocompleteField } from "@/components/common/form-inputs/AutocompleteField";

const importProjectSchema = z.object({
  folder_id: z.string().min(1),
  project_name: z.string().optional(),
});

type ImportProjectForm = z.infer<typeof importProjectSchema>;

interface ProjectImportModalProps {
  open: boolean;
  /** Pre-selects the destination folder — the one the caller is browsing.
   * Read once, at mount: a caller that needs it to follow the current folder
   * mounts a fresh modal per open. */
  defaultFolderId?: string;
  onClose?: () => void;
  onImportStarted?: () => void;
}

const ProjectImportModal: React.FC<ProjectImportModalProps> = ({
  open,
  defaultFolderId,
  onClose,
  onImportStarted,
}) => {
  const { t } = useTranslation("common");
  const queryParams: GetContentQueryParams = {
    order: "descendent",
    order_by: "updated_at",
  };
  const { folders } = useFolders(queryParams);
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const [isBusy, setIsBusy] = useState(false);
  const [fileValue, setFileValue] = useState<File | undefined>(undefined);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const [projectName, setProjectName] = useState<string>("");

  const { watch, reset, control } = useForm<ImportProjectForm>({
    mode: "onChange",
    defaultValues: { folder_id: defaultFolderId ?? "" },
    resolver: zodResolver(importProjectSchema),
  });

  const watchFormValues = watch();

  const handleOnClose = () => {
    reset();
    setFileValue(undefined);
    setFileError(undefined);
    setProjectName("");
    onClose?.();
  };

  const handleFileChange = (file: File | null) => {
    setFileError(undefined);
    setFileValue(undefined);
    if (file && file.name) {
      if (!file.name.endsWith(".zip")) {
        setFileError(t("invalid_file_type"));
        return;
      }
      setFileValue(file);
      // The name stays empty unless the user types one: the archive carries
      // the project's own name, and the file name is a sanitised copy of it
      // (parentheses and other characters stripped for the file system), so
      // pre-filling from it would rename the project on every import.
    }
  };

  const allowSubmit = useMemo(() => {
    return watchFormValues.folder_id && fileValue && !isBusy;
  }, [watchFormValues, fileValue, isBusy]);

  const folderOptions = useMemo(() => {
    return folders?.map((folder) => ({
      value: folder.id,
      label: folder.name,
      icon: <Icon fontSize="small" iconName={folder.name === "home" ? ICON_NAME.HOUSE : ICON_NAME.FOLDER} />,
    }));
  }, [folders]);

  const handleImport = async () => {
    if (!fileValue || !watchFormValues.folder_id) return;

    try {
      setIsBusy(true);

      // 1. Get presigned URL
      const presigned = await requestDatasetUpload({
        filename: fileValue.name,
        content_type: "application/zip",
        file_size: fileValue.size,
      });

      // 2. Upload to S3
      await uploadFileToS3(fileValue, presigned);

      // 3. Object key the file was stored under
      const s3Key = presigned.key;

      // 4. Trigger import job via OGC Processes
      const job = await executeProcessAsync("project_import", {
        s3_key: s3Key,
        target_folder_id: watchFormValues.folder_id,
        ...(projectName ? { project_name: projectName } : {}),
      });

      if (job?.jobID) {
        dispatch(setRunningJobIds([...runningJobIds, job.jobID]));
      }
      toast.success(t("project_import_started"));
      onImportStarted?.();
      handleOnClose();
    } catch (_error) {
      toast.error(t("error_importing_project"));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onClose={handleOnClose}
      icon={ICON_NAME.UPLOAD}
      title={t("import_project")}
      maxWidth={600}
      footer={
        <AppDialogFooter
          onCancel={handleOnClose}
          primaryLabel={t("import")}
          onPrimary={() => void handleImport()}
          primaryDisabled={!allowSubmit}
          primaryLoading={isBusy}
        />
      }>
      <Stack direction="column" spacing={4} sx={{ my: 1 }}>
        <RhfAutocompleteField
          disabled={isBusy}
          options={folderOptions ?? []}
          control={control}
          name="folder_id"
          label={t("folder_location")}
        />
        <MuiFileInput
          inputProps={{ accept: ".zip" }}
          fullWidth
          error={!!fileError}
          helperText={fileError || t("accepts_zip_files")}
          value={fileValue ?? null}
          multiple={false}
          onChange={handleFileChange}
          placeholder={t("select_project_archive")}
        />
        {fileValue && (
          <TextField
            fullWidth
            label={t("project_name")}
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            helperText={t("optional_rename_on_import")}
          />
        )}
      </Stack>
    </AppDialog>
  );
};

export default ProjectImportModal;
