"use client";

import { Box, ButtonBase, CircularProgress, Stack } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Provider } from "react-redux";

import { useBundleLayers, useBundleMemberLayers } from "@/lib/api/bundles";
import { useCatalogPreview, useCatalogResolve } from "@/lib/api/catalog";
import { useDataset } from "@/lib/api/layers";
import type { ResultItem } from "@/lib/assistant/items";
import { makeStore } from "@/lib/store";
import type { CatalogItem } from "@/lib/validations/catalog";
import type { Layer } from "@/lib/validations/layer";

import useFeaturePage from "@/hooks/useFeaturePage";

import { useDockActions } from "@/components/assistant/DockActions";
import { ITEM_PREVIEW_HEIGHT, focusRing, mutedText } from "@/components/assistant/styles";
import BundleMapPreview from "@/components/dashboard/bundle/BundleMapPreview";
import CatalogFeatureTable from "@/components/dashboard/catalog/CatalogFeatureTable";
import CatalogFootprintMap from "@/components/dashboard/catalog/CatalogFootprintMap";
import FeatureTableFrame from "@/components/dashboard/common/FeatureTableFrame";
import DatasetMapPreview from "@/components/dashboard/dataset/DatasetMapPreview";

const Loading = () => (
  <Box sx={{ height: ITEM_PREVIEW_HEIGHT, display: "flex", alignItems: "center", justifyContent: "center" }}>
    <CircularProgress size={18} />
  </Box>
);

/** A table's first rows, the way the dataset window's Data tab shows them. */
function TableRows({ dataset }: { dataset: Layer }) {
  const { fields, areFieldsLoading, data, isLoading } = useFeaturePage(dataset.id, { limit: 5 });
  return (
    <FeatureTableFrame
      fields={fields}
      data={data}
      isLoading={areFieldsLoading || isLoading}
      maxHeight={ITEM_PREVIEW_HEIGHT}
    />
  );
}

function DatasetPreview({ datasetId }: { datasetId: string }) {
  const { dataset } = useDataset(datasetId);
  if (!dataset) return <Loading />;
  if (dataset.type === "table") return <TableRows dataset={dataset} />;
  return (
    <Box sx={{ position: "relative", height: ITEM_PREVIEW_HEIGHT }}>
      <DatasetMapPreview dataset={dataset} />
    </Box>
  );
}

/** A catalog table's first rows, from the catalog's preview sample. */
function CatalogRows({ item }: { item: CatalogItem }) {
  const { t } = useTranslation("common");
  const { preview, isLoading } = useCatalogPreview(item.id);
  if (isLoading) return <Loading />;
  const features = preview?.features ?? [];
  if (!features.length) {
    return <Box sx={{ p: "12px", fontSize: 12.5, color: mutedText }}>{t("assistant_item_no_rows")}</Box>;
  }
  return (
    <CatalogFeatureTable
      features={features}
      columns={item.properties["table:columns"] ?? []}
      rows={5}
      maxHeight={ITEM_PREVIEW_HEIGHT}
    />
  );
}

function CatalogPreview({ id }: { id: string }) {
  const { item, members, isLoading } = useCatalogResolve(id);
  // A bundle shows its first member with a map: a timetable feed's tables
  // have nothing to draw, its stops do.
  const shown = item ?? members.find((member) => !!member.geometry) ?? members[0];
  if (!shown) return isLoading ? <Loading /> : null;
  // A table (stops as coordinate columns, a timetable) shows rows, as the
  // catalog's own page does: it draws a map only for a dataset with geometry.
  if (!shown.geometry) return <CatalogRows item={shown} />;
  return (
    <Box sx={{ position: "relative", height: ITEM_PREVIEW_HEIGHT }}>
      <CatalogFootprintMap item={shown} fill />
    </Box>
  );
}

function BundlePreview({ id }: { id: string }) {
  const { members } = useBundleLayers(id);
  const { memberLayers } = useBundleMemberLayers(members);
  // A bundle of tables only has nothing to draw: its "All details" lists them.
  if (members && !members.some((member) => member.type === "feature" || member.type === "raster")) {
    return null;
  }
  if (!memberLayers) return <Loading />;
  return (
    <Box sx={{ position: "relative", height: ITEM_PREVIEW_HEIGHT }}>
      <BundleMapPreview layers={memberLayers} />
    </Box>
  );
}

/**
 * A card's preview, opened with its eye button: the data on a map (a table's
 * first rows), drawn by the browser with the user's own access. Nothing of it
 * reaches the model. "All details" opens the item's own window or page.
 *
 * The maps run on a store of their own: the map component writes the popup,
 * the highlighted feature and the zoom to the store, and on a project page the
 * project's map and layer list read those from the app's store.
 */
export default function ItemPreview({ item }: { item: ResultItem }) {
  const { t } = useTranslation("common");
  const dock = useDockActions();
  const [store] = useState(makeStore);
  const datasetId = item.kind === "dataset" ? (item.datasetId ?? item.id) : item.datasetId;
  const details = () => {
    if (item.kind === "catalog") dock.openRecord(item.id);
    else if (item.kind === "bundle") dock.previewBundle(item.id);
    else if (datasetId) dock.previewDataset(datasetId);
  };
  return (
    <Provider store={store}>
      <Stack gap="6px" sx={{ mt: "10px" }}>
        <Box sx={{ borderRadius: "10px", overflow: "hidden", border: 1, borderColor: "divider" }}>
          {item.kind === "catalog" ? (
            <CatalogPreview id={item.id} />
          ) : item.kind === "bundle" ? (
            <BundlePreview id={item.id} />
          ) : datasetId ? (
            <DatasetPreview datasetId={datasetId} />
          ) : null}
        </Box>
        <ButtonBase
          onClick={details}
          sx={(theme) => ({
            alignSelf: "flex-end",
            fontFamily: "inherit",
            fontSize: 12,
            fontWeight: 600,
            color: mutedText(theme),
            borderRadius: "6px",
            px: "4px",
            "&:hover": { color: "text.primary", textDecoration: "underline" },
            ...focusRing(theme),
          })}>
          {t("assistant_item_all_details")}
        </ButtonBase>
      </Stack>
    </Provider>
  );
}
