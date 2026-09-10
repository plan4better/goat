import { zodResolver } from "@hookform/resolvers/zod";
import LoadingButton from "@mui/lab/LoadingButton";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { requestDatasetUpload } from "@/lib/api/datasets";
import { getWritableFolders, useFolders } from "@/lib/api/folders";
import { createLayer } from "@/lib/api/layers";
import { useJobs } from "@/lib/api/processes";
import { useProject } from "@/lib/api/projects";
import { uploadFileToS3 } from "@/lib/services/s3";
import { setRunningJobIds } from "@/lib/store/jobs/slice";
import type { GetContentQueryParams } from "@/lib/validations/common";
import type { Folder } from "@/lib/validations/folder";
import type { LayerMetadata } from "@/lib/validations/layer";
import { createLayerFromDatasetSchema, layerMetadataSchema } from "@/lib/validations/layer";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { parseTabularPreview, type TabularPreview } from "@/lib/utils/tabular-preview";

import { MuiFileInput } from "@/components/common/FileInput";
import FolderSelect from "@/components/dashboard/common/FolderSelect";

interface DatasetUploadDialogProps {
  open: boolean;
  onClose?: () => void;
  projectId?: string;
  defaultFolderId?: string;
}

const DatasetUploadModal: React.FC<DatasetUploadDialogProps> = ({ open, onClose, projectId, defaultFolderId }) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);

  const { project } = useProject(projectId);
  const { mutate } = useJobs({
    read: false,
  });
  const queryParams: GetContentQueryParams = {
    order: "descendent",
    order_by: "updated_at",
  };
  const { folders: allFolders } = useFolders(queryParams);
  const folders = getWritableFolders(allFolders);
  const [activeStep, setActiveStep] = useState(0);
  const [fileValue, setFileValue] = useState<File>();
  const [fileUploadError, setFileUploadError] = useState<string>();
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>();
  const folderInitialized = useRef(false);
  const [isBusy, setIsBusy] = useState(false);
  const [tabularPreview, setTabularPreview] = useState<TabularPreview | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [selectedSheet, setSelectedSheet] = useState<string>("");

  const isTabular = useMemo(() => {
    if (!fileValue) return false;
    const ext = fileValue.name.split(".").pop()?.toLowerCase();
    return ext === "csv" || ext === "xlsx" || ext === "xls";
  }, [fileValue]);

  const steps = useMemo(() => {
    const base = [t("select_file"), t("destination_and_metadata"), t("confirmation")];
    if (isTabular) {
      return [base[0], t("preview_and_configure"), base[1], base[2]];
    }
    return base;
  }, [isTabular, t]);

  const previewStep = isTabular ? 1 : -1;
  const metadataStep = isTabular ? 2 : 1;
  const confirmationStep = isTabular ? 3 : 2;

  useEffect(() => {
    if (!folders || folderInitialized.current) return;
    const projectFolder = folders.find((folder) => folder.id === project?.folder_id);
    if (projectFolder) {
      setSelectedFolder(projectFolder);
      folderInitialized.current = true;
    } else if (defaultFolderId) {
      const defaultFolder = folders.find((folder) => folder.id === defaultFolderId);
      if (defaultFolder) {
        setSelectedFolder(defaultFolder);
        folderInitialized.current = true;
      }
    }
  }, [folders, project?.folder_id, defaultFolderId]);

  useEffect(() => {
    if (!fileValue || !isTabular) {
      setTabularPreview(null);
      return;
    }
    let cancelled = false;
    parseTabularPreview(fileValue, { hasHeader, sheetName: selectedSheet || undefined })
      .then((preview) => {
        if (!cancelled) {
          setTabularPreview(preview);
          if (!selectedSheet && preview.sheetNames.length > 0) {
            setSelectedSheet(preview.sheetNames[0]);
          }
        }
      })
      .catch((err) => {
        console.error("Preview parse error:", err);
        if (!cancelled) setTabularPreview(null);
      });
    return () => { cancelled = true; };
  }, [fileValue, isTabular, hasHeader, selectedSheet]);

  const {
    register,
    getValues,
    reset,
    formState: { errors, isValid },
  } = useForm<LayerMetadata>({
    mode: "onChange",
    resolver: zodResolver(layerMetadataSchema),
  });

  const handleNext = () => {
    setActiveStep((prevActiveStep) => prevActiveStep + 1);
  };

  const handledBack = () => {
    setActiveStep((prevActiveStep) => prevActiveStep - 1);
  };

  const acceptedFileTypes = useMemo(() => {
    return [".gpkg", ".geojson", ".zip", ".kml", ".csv", ".xlsx", ".parquet"];
  }, []);

  const handleChange = (file) => {
    setFileUploadError(undefined);
    setFileValue(undefined);
    if (file && file.name) {
      const isAcceptedType = acceptedFileTypes.some((type) => file.name.endsWith(type));
      if (!isAcceptedType) {
        setFileUploadError("Invalid file type. Please select a file of type");
        return;
      }

      // Autodetect dataset type (for UI feedback only - backend does actual detection)
      const isFeatureLayer =
        file.name.endsWith(".gpkg") ||
        file.name.endsWith(".geojson") ||
        file.name.endsWith(".zip") ||
        file.name.endsWith(".shp") ||
        file.name.endsWith(".kml") ||
        file.name.endsWith(".parquet");
      const isTable = file.name.endsWith(".csv") || file.name.endsWith(".xlsx");
      if (!isFeatureLayer && !isTable) {
        setFileUploadError("Invalid file type");
        return;
      }
      setFileValue(file);
    }
  };

  const handleOnClose = () => {
    setFileValue(undefined);
    setActiveStep(0);
    setFileUploadError(undefined);
    setIsBusy(false);
    setTabularPreview(null);
    setHasHeader(true);
    setSelectedSheet("");
    setSelectedFolder(undefined);
    folderInitialized.current = false;
    reset();
    onClose?.();
  };

  const fileName = useMemo(() => {
    if (fileValue) {
      // remove extension if in accepted file types
      const fileExtension = fileValue.name.split(".").pop();
      if (fileExtension && acceptedFileTypes.includes(`.${fileExtension}`)) {
        return fileValue.name.replace(`.${fileExtension}`, "");
      }
      return fileValue.name;
    }
    return "";
  }, [acceptedFileTypes, fileValue]);

  const handleUpload = async () => {
    try {
      if (!fileValue) return;
      setIsBusy(true);

      // Request backend for presigned URL
      const presigned = await requestDatasetUpload({
        filename: fileValue.name,
        content_type: fileValue.type || "application/octet-stream",
        file_size: fileValue.size,
      });

      // Upload file to S3 directly
      await uploadFileToS3(fileValue, presigned);

      // Tell backend to promote → dataset
      const payload = createLayerFromDatasetSchema.parse({
        ...getValues(),
        folder_id: selectedFolder?.id,
        s3_key: presigned.key,
        ...(isTabular && { has_header: hasHeader }),
        ...(isTabular && selectedSheet && { sheet_name: selectedSheet }),
      });

      // Kick off layer creation via OGC API Processes
      const response = await createLayer(payload, projectId);

      // OGC Job response has jobID not job_id
      const jobId = response?.jobID;
      if (jobId) {
        mutate();
        dispatch(setRunningJobIds([...runningJobIds, jobId]));
      }
    } catch (error) {
      toast.error(t("error_uploading_dataset"));
      console.error("error", error);
    } finally {
      handleOnClose();
    }
  };

  return (
    <Dialog open={open} onClose={handleOnClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("upload_dataset")}</DialogTitle>
      <DialogContent>
        <Box sx={{ width: "100%" }}>
          <Stepper activeStep={activeStep} alternativeLabel>
            {steps.map((label) => (
              <Step key={label}>
                <StepLabel>{label}</StepLabel>
              </Step>
            ))}
          </Stepper>
        </Box>
      </DialogContent>
      <Box sx={{ px: 4 }}>
        {activeStep === 0 && (
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
              <b>CSV</b>, <b>XLSX</b>, <b>Parquet</b>
            </Typography>
          </>
        )}
        {activeStep === previewStep && isTabular && (
          <Stack direction="column" spacing={3}>
            {/* Sheet selector - only for multi-sheet XLSX */}
            {tabularPreview && tabularPreview.sheetNames.length > 1 && (
              <TextField
                select
                fullWidth
                label={t("worksheet")}
                value={selectedSheet}
                onChange={(e) => setSelectedSheet(e.target.value)}
                size="small"
              >
                {tabularPreview.sheetNames.map((name) => (
                  <MenuItem key={name} value={name}>
                    {name}
                  </MenuItem>
                ))}
              </TextField>
            )}

            {/* Header toggle */}
            <FormControlLabel
              control={
                <Switch
                  checked={hasHeader}
                  onChange={(e) => setHasHeader(e.target.checked)}
                  color="primary"
                  size="small"
                />
              }
              label={
                <Typography variant="body2" fontWeight="bold">
                  {t("first_row_is_header")}
                </Typography>
              }
            />

            {/* Data preview table */}
            {tabularPreview && tabularPreview.headers.length > 0 && (
              <>
                <TableContainer sx={{ maxHeight: 280, border: 1, borderColor: "divider", borderRadius: 1 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        {tabularPreview.headers.map((header, i) => (
                          <TableCell key={i} sx={{ fontWeight: "bold", whiteSpace: "nowrap" }}>
                            {header}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {tabularPreview.rows.map((row, ri) => (
                        <TableRow key={ri}>
                          {row.map((cell, ci) => (
                            <TableCell key={ci} sx={{ whiteSpace: "nowrap", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                              <Typography variant="body2">{cell}</Typography>
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <Typography variant="caption" color="text.secondary">
                  {t("showing_first_rows", { count: tabularPreview.rows.length, total: tabularPreview.totalRows })}
                </Typography>
                {!hasHeader && (
                  <Typography variant="caption" color="text.secondary">
                    {t("rename_columns_hint")}
                  </Typography>
                )}
              </>
            )}
          </Stack>
        )}
        {activeStep === metadataStep && (
          <>
            <Stack direction="column" spacing={4}>
              <FolderSelect
                folders={folders}
                selectedFolder={selectedFolder}
                setSelectedFolder={setSelectedFolder}
              />

              <TextField
                fullWidth
                required
                defaultValue={fileName}
                label={t("name")}
                {...register("name")}
                error={!!errors.name}
                helperText={errors.name?.message}
              />
              <TextField
                fullWidth
                multiline
                rows={4}
                label={t("description")}
                {...register("description")}
                error={!!errors.description}
                helperText={errors.description?.message}
              />
            </Stack>
          </>
        )}
        {activeStep === confirmationStep && (
          <Stack direction="column" spacing={4}>
            <Typography variant="caption">{t("review")}</Typography>
            <Typography variant="body2">
              <b>{t("file")}:</b> {fileValue?.name}
            </Typography>
            <Typography variant="body2">
              <b>{t("destination")}:</b> {selectedFolder?.name}
            </Typography>
            <Typography variant="body2">
              <b>{t("name")}:</b> {getValues("name")}
            </Typography>
            <Typography variant="body2">
              <b>{t("description")}:</b> {getValues("description")}
            </Typography>
          </Stack>
        )}
      </Box>
      <DialogActions
        disableSpacing
        sx={{
          pt: 6,
          pb: 2,
          justifyContent: "space-between",
        }}>
        <Stack direction="row" spacing={2} justifyContent="flex-start">
          {activeStep > 0 && (
            <Button variant="text" onClick={handledBack}>
              <Typography variant="body2" fontWeight="bold">
                {t("back")}
              </Typography>
            </Button>
          )}
        </Stack>
        <Stack direction="row" spacing={2} justifyContent="flex-end">
          <Button onClick={handleOnClose} variant="text">
            <Typography variant="body2" fontWeight="bold">
              {t("cancel")}
            </Typography>
          </Button>
          {activeStep < steps.length - 1 && (
            <Button
              disabled={
                (activeStep === 0 && !fileValue) ||
                (activeStep === metadataStep && (isValid !== true || selectedFolder === null))
              }
              onClick={handleNext}
              variant="outlined"
              color="primary">
              <Typography variant="body2" fontWeight="bold" color="inherit">
                {t("next")}
              </Typography>
            </Button>
          )}
          {activeStep === steps.length - 1 && (
            <LoadingButton
              onClick={handleUpload}
              disabled={isBusy}
              loading={isBusy}
              variant="contained"
              color="primary">
              <Typography variant="body2" fontWeight="bold" color="inherit">
                {t("upload")}
              </Typography>
            </LoadingButton>
          )}
        </Stack>
      </DialogActions>
    </Dialog>
  );
};

export default DatasetUploadModal;
