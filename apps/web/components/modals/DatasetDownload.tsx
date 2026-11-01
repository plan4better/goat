import { Box, MenuItem, Select, Stack, Typography } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { downloadLayerDirect, startDatasetExport } from "@/lib/api/layers";
import { useJobs } from "@/lib/api/processes";
import { useUserProfile } from "@/lib/api/users";
import { setRunningJobIds } from "@/lib/store/jobs/slice";
import { creditsErrorMessage } from "@/lib/utils/credits";
import { getSuggestedCRS } from "@/lib/utils/map/crs-suggestions";
import type { FeatureDataExchangeType } from "@/lib/validations/common";
import { featureDataExchangeType, tableDataExchangeType } from "@/lib/validations/common";
import type { DatasetDownloadRequest, Layer } from "@/lib/validations/layer";
import type { ProjectLayer } from "@/lib/validations/project";
import { isCatalogLayer } from "@/lib/utils/catalog-layer";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

interface DownloadDatasetDialogProps {
  open: boolean;
  onClose?: () => void;
  disabled?: boolean;
  onDownload?: () => void;
  dataset: ProjectLayer | Layer;
}

const DatasetDownloadModal: React.FC<DownloadDatasetDialogProps> = ({
  open,
  disabled,
  onClose,
  onDownload,
  dataset,
}) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const mapMode = useAppSelector((state) => state.map.mapMode);
  const isPublicMode = mapMode === "public";
  const { mutate } = useJobs({ read: false });
  const { userProfile } = useUserProfile();

  // Support both 'type' (Layer schema) and 'layer_type' (ProjectLayerTreeNode)
  // For ProjectLayerTreeNode, 'type' is "layer" or "group", so we need 'layer_type' for the actual layer type
  const layerType = (dataset as { layer_type?: string }).layer_type || dataset.type;
  const isSpatialLayer = layerType === "feature" || layerType === "raster";

  // Catalog layers can only be downloaded by their owner (not applicable in public mode)
  const layerOwnerId = (dataset as { user_id?: string }).user_id;
  const isCatalogNotOwned =
    !isPublicMode &&
    isCatalogLayer(dataset) &&
    layerOwnerId &&
    userProfile?.id &&
    layerOwnerId !== userProfile.id;

  // Compute CRS suggestions based on the layer extent
  const crsSuggestions = useMemo(() => {
    if (!isSpatialLayer) return [];
    const extent = (dataset as { extent?: string }).extent;
    return getSuggestedCRS(extent || "");
  }, [isSpatialLayer, dataset]);

  const [dataDownloadType, setDataDownloadType] = useState<FeatureDataExchangeType>(
    isSpatialLayer ? featureDataExchangeType.Enum.gpkg : tableDataExchangeType.Enum.csv
  );

  const [isBusy, setIsBusy] = useState(false);

  const [dataCrs, setDataCrs] = useState<string | null>(isSpatialLayer ? "4326" : null);

  const handleDownload = async () => {
    try {
      if (!dataset) return;
      setIsBusy(true);

      const layerId = dataset["layer_id"] || dataset["id"];

      if (isPublicMode) {
        // Public mode: download directly from GeoAPI (no auth needed)
        const crs = dataCrs ? `EPSG:${dataCrs}` : undefined;
        await downloadLayerDirect(layerId, dataDownloadType, dataset.name, crs);
        onDownload?.();
      } else {
        // Authenticated mode: use async job via OGC API Processes
        if (!userProfile?.id) return;

        const ownerUserId = (dataset as { user_id?: string }).user_id || userProfile.id;

        const payload = {
          id: layerId,
          file_type: dataDownloadType,
          file_name: dataset.name,
          user_id: userProfile.id,
          layer_owner_id: ownerUserId,
        };
        if (dataCrs) {
          payload["crs"] = `EPSG:${dataCrs}`;
        }
        if (dataset["layer_id"] && dataset["query"] && dataset["query"]["cql"]) {
          payload["query"] = dataset["query"]["cql"];
        }

        const response = await startDatasetExport(
          payload as DatasetDownloadRequest & { user_id: string; layer_owner_id: string }
        );

        const jobId = response?.jobID;
        if (jobId) {
          await mutate();
          dispatch(setRunningJobIds([...runningJobIds, jobId]));
        }

        toast.info(t("export_started") || "Export started. Check the jobs menu for progress.");
        onDownload?.();
      }
    } catch (error) {
      toast.error(creditsErrorMessage(error, t, `${t("error_downloading")} ${dataset.name}`));
    } finally {
      setIsBusy(false);
      onClose?.();
    }
  };

  // Order: global first, then UTM, then regional
  const orderedCrs = [
    ...crsSuggestions.filter((s) => s.group === "global"),
    ...crsSuggestions.filter((s) => s.group === "utm"),
    ...crsSuggestions.filter((s) => s.group === "regional"),
  ];

  return (
    <AppDialog
      open={open}
      onClose={() => onClose?.()}
      icon={ICON_NAME.DOWNLOAD}
      title={t("download")}
      subtitle={dataset.name}
      maxWidth={444}
      closeDisabled={isBusy}
      footer={
        // A catalog dataset someone else owns cannot be exported at all, so the
        // dialog only says so and offers the way out.
        isCatalogNotOwned ? (
          <AppDialogFooter primaryLabel={t("close")} onPrimary={() => onClose?.()} />
        ) : (
          <AppDialogFooter
            onCancel={onClose}
            cancelDisabled={isBusy}
            primaryLabel={t("download")}
            onPrimary={() => void handleDownload()}
            primaryDisabled={disabled}
            primaryLoading={isBusy}
          />
        )
      }>
      {isCatalogNotOwned ? (
        <Typography variant="body2" sx={{ py: 2 }}>
          {t("catalog_download_not_allowed")}
        </Typography>
      ) : (
        <Stack spacing={2} sx={{ py: 2 }}>
          <Box>
            <Typography variant="caption">{t(`download_type`)}</Typography>
            <Select
              fullWidth
              disabled={isBusy}
              sx={{
                my: 2,
              }}
              id="download-simple-select"
              value={dataDownloadType}
              onChange={(e) => setDataDownloadType(e.target.value as FeatureDataExchangeType)}>
              {isSpatialLayer &&
                featureDataExchangeType.options.map((type: string) => (
                  <MenuItem key={type} value={type}>
                    {t(`${type}`)}
                  </MenuItem>
                ))}
              {!isSpatialLayer &&
                tableDataExchangeType.options.map((type: string) => (
                  <MenuItem key={type} value={type}>
                    {t(`${type}`)}
                  </MenuItem>
                ))}
            </Select>
          </Box>
          {isSpatialLayer && (
            <Box>
              <Typography variant="caption">{t(`download_crs`)}</Typography>
              <Select
                fullWidth
                disabled={isBusy}
                sx={{
                  my: 2,
                }}
                id="download-crs-select"
                value={dataCrs}
                onChange={(e) => setDataCrs(e.target.value as string)}>
                {orderedCrs.map((crs) => (
                  <MenuItem key={crs.code} value={crs.code}>
                    {crs.label}
                  </MenuItem>
                ))}
              </Select>
            </Box>
          )}
        </Stack>
      )}
    </AppDialog>
  );
};

export default DatasetDownloadModal;
