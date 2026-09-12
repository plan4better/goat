import { Box, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { requestDatasetUpload } from "@/lib/api/datasets";
import { updateLayerDataset } from "@/lib/api/layers";
import { useJobs } from "@/lib/api/processes";
import { uploadFileToS3 } from "@/lib/services/s3";
import { setRunningJobIds } from "@/lib/store/jobs/slice";

import type { ContentDialogBaseProps } from "@/types/dashboard/content";

import { useFileUpload } from "@/hooks/dashboard/ContentHooks";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { MuiFileInput } from "@/components/common/FileInput";

const DatasetUpdateModal: React.FC<ContentDialogBaseProps> = ({ open, onClose, content }) => {
  const { t } = useTranslation("common");
  const [isBusy, setIsBusy] = useState(false);
  const { fileValue, setFileValue, fileUploadError, setFileUploadError, handleChange, acceptedFileTypes } =
    useFileUpload();
  const dispatch = useAppDispatch();
  const { mutate } = useJobs({
    read: false,
  });
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const handleOnClose = () => {
    setIsBusy(false);
    setFileValue(undefined);
    setFileUploadError(undefined);
    onClose?.();
  };
  const handleUpdate = async () => {
    try {
      setIsBusy(true);
      let s3Key: string | undefined;

      if (content?.data_type === "wfs") {
        // Direct WFS refresh via OGC API Processes
        const response = await updateLayerDataset(content.id, { refresh_wfs: true });
        // OGC Job response has jobID not job_id
        const jobId = response?.jobID;
        if (jobId) {
          mutate();
          dispatch(setRunningJobIds([...runningJobIds, jobId]));
        }
      } else if (fileValue) {
        // Request backend for presigned URL
        const presigned = await requestDatasetUpload({
          filename: fileValue.name,
          content_type: fileValue.type || "application/octet-stream",
          file_size: fileValue.size,
        });

        // Upload file to S3 directly
        await uploadFileToS3(fileValue, presigned);
        s3Key = presigned.key;

        const layerId = content.id;
        const response = await updateLayerDataset(layerId, { s3_key: s3Key });
        // OGC Job response has jobID not job_id
        const jobId = response?.jobID;
        if (jobId) {
          mutate();
          dispatch(setRunningJobIds([...runningJobIds, jobId]));
        }
      }
      toast.info(`"${t("dataset_update")}" - ${t("job_started")}`);
    } catch (error) {
      toast.error(t("error_update_dataset"));
    } finally {
      setIsBusy(false);
      onClose && onClose();
    }
  };
  return (
    <AppDialog
      open={open}
      onClose={handleOnClose}
      icon={ICON_NAME.UPLOAD}
      title={t("dataset_update")}
      subtitle={content.name}
      footer={
        <AppDialogFooter
          onCancel={handleOnClose}
          primaryLabel={t("update")}
          onPrimary={() => void handleUpdate()}
          primaryDisabled={isBusy || (!fileValue && content.data_type !== "wfs")}
          primaryLoading={isBusy}
        />
      }>
      <Box sx={{ width: "100%" }}>
        {content.data_type === "wfs" && (
          <Stack direction="column" spacing={4}>
            <Typography variant="body2">
              <b>{t("url")}:</b> {content.other_properties?.url}
            </Typography>
            <Typography variant="body2">
              <b>{t("layer")}:</b> {content.other_properties?.layers}
            </Typography>
          </Stack>
        )}
        {!content.data_type && (
          <>
            <Typography variant="caption">{t("select_file_to_upload")}</Typography>
            <MuiFileInput
              sx={{
                my: 2,
              }}
              inputProps={{
                accept: acceptedFileTypes.join(","),
              }}
              fullWidth
              error={!!fileUploadError}
              helperText={fileUploadError}
              value={fileValue}
              multiple={false}
              onChange={handleChange}
              placeholder={`${t("eg")} file.gpkg, file.geojson, file.parquet, shapefile.zip`}
            />
            <Typography variant="caption">
              {t("supported")} <b>GeoPackage</b>, <b>GeoJSON</b>, <b>Shapefile (.zip)</b>, <b>KML</b>,{" "}
              <b>CSV</b>, <b>XLSX</b>
            </Typography>
          </>
        )}
      </Box>
    </AppDialog>
  );
};

export default DatasetUpdateModal;
