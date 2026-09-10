import { zodResolver } from "@hookform/resolvers/zod";
import LoadingButton from "@mui/lab/LoadingButton";
import { Box, Button, Dialog, DialogTitle, Stack, TextField, Typography } from "@mui/material";
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

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";
import type { GetContentQueryParams } from "@/lib/validations/common";

import { MuiFileInput } from "@/components/common/FileInput";
import { RhfAutocompleteField } from "@/components/common/form-inputs/AutocompleteField";

const importProjectSchema = z.object({
  folder_id: z.string().min(1),
  project_name: z.string().optional(),
});

type ImportProjectForm = z.infer<typeof importProjectSchema>;

interface ProjectImportModalProps {
  open: boolean;
  onClose?: () => void;
  onImportStarted?: () => void;
}

const ProjectImportModal: React.FC<ProjectImportModalProps> = ({ open, onClose, onImportStarted }) => {
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

  const {
    watch,
    reset,
    control,
  } = useForm<ImportProjectForm>({
    mode: "onChange",
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
      // Auto-populate project name from filename if empty
      if (!projectName) {
        const name = file.name
          .replace(/^project-export-/, "")
          .replace(/-\d{8}_\d{6}\.zip$/, "")
          .replace(/\.zip$/, "")
          .replace(/_/g, " ");
        setProjectName(name);
      }
    }
  };

  const allowSubmit = useMemo(() => {
    return watchFormValues.folder_id && fileValue && !isBusy;
  }, [watchFormValues, fileValue, isBusy]);

  const folderOptions = useMemo(() => {
    return folders?.map((folder) => ({
      value: folder.id,
      label: folder.name,
      icon: (
        <Icon fontSize="small" iconName={folder.name === "home" ? ICON_NAME.HOUSE : ICON_NAME.FOLDER} />
      ),
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
    <Dialog open={open} onClose={handleOnClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("import_project")}</DialogTitle>
      <Box sx={{ px: 4, pb: 2 }}>
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
        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 4 }}>
          <Button onClick={handleOnClose} variant="text" sx={{ borderRadius: 0 }}>
            <Typography variant="body2" fontWeight="bold">
              {t("cancel")}
            </Typography>
          </Button>
          <LoadingButton
            disabled={!allowSubmit}
            loading={isBusy}
            onClick={handleImport}
            variant="contained"
            color="primary">
            <Typography variant="body2" fontWeight="bold" color="inherit">
              {t("import")}
            </Typography>
          </LoadingButton>
        </Stack>
      </Box>
    </Dialog>
  );
};

export default ProjectImportModal;
