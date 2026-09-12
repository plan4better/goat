"use client";

import { Box, Stack, TablePagination, Typography, useTheme } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { layerTypeLabelKey } from "@/lib/utils/content";
import { DEFAULT_ROWS_PER_PAGE_OPTIONS } from "@/lib/utils/pagination";
import type { Layer } from "@/lib/validations/layer";

import { useCatalogLabels } from "@/hooks/catalog/useCatalogLabels";
import { useFeaturePage } from "@/hooks/useFeaturePage";

import {
  DetailHeader,
  DetailTabs,
  KeywordSection,
  LicenseNotices,
  LicenseBadge,
  type MetaField,
  MetaSidebar,
} from "@/components/dashboard/common/DetailChrome";
import FeatureTableFrame from "@/components/dashboard/common/FeatureTableFrame";
import MarkdownProse from "@/components/dashboard/common/MarkdownProse";
import DatasetMapPreview from "@/components/dashboard/dataset/DatasetMapPreview";

/** One owned dataset: description, keywords and a map, metadata beside them,
 * rows on a second tab. The body of the Content preview dialog, which is where
 * a dataset is read. Its sections sit flat on the dialog's own paper — a card
 * inside a modal frames what is already framed. */

type TabId = "summary" | "data";

type DatasetDetailProps = {
  dataset: Layer;
  /** Buttons for the header's actions slot (Share, Move…). */
  actions?: React.ReactNode;
};

/** The catalog record a promoted layer carries verbatim — the catalog's own
 * vocabulary, not an enum we mapped it into. */
const catalogItemOf = (dataset: Layer) =>
  (dataset.other_properties as { catalog_item?: Record<string, string | number | null> } | undefined)
    ?.catalog_item;

/** The frame a dataset map is drawn in: a bordered, rounded surface of its own
 * height, which the map fills. */
const MapFrame = ({ dataset }: { dataset: Layer }) => {
  const theme = useTheme();
  return (
    <Box
      sx={{
        position: "relative",
        // A real height rather than "whatever the column leaves".
        flex: "none",
        height: { xs: 320, md: 460 },
        borderRadius: 2.5,
        overflow: "hidden",
        border: `1px solid ${theme.palette.divider}`,
      }}>
      <DatasetMapPreview dataset={dataset} />
    </Box>
  );
};

/** A section's heading, at the weight and size the catalog's section cards
 * title theirs with. */
const SectionHeading = ({ children }: { children: React.ReactNode }) => (
  <Typography sx={{ fontSize: 15, fontWeight: 600, mb: 3.5 }}>{children}</Typography>
);

/** The rows themselves, paged. Its own component so the feature request is
 * made only once the tab is opened. */
const DataTab = ({ dataset }: { dataset: Layer }) => {
  const { fields, areFieldsLoading, data, rowsPerPage, page, totalCount, onPageChange, onRowsPerPageChange } =
    useFeaturePage(dataset.id, { limit: 25 });

  return (
    <FeatureTableFrame
      fields={fields}
      data={data}
      isLoading={areFieldsLoading}
      footer={
        <TablePagination
          component="div"
          rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
          count={totalCount}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={onPageChange}
          onRowsPerPageChange={onRowsPerPageChange}
          // The frame draws the footer's own top border; TablePagination is a
          // TableCell underneath, whose bottom rule would double the frame's
          // rounded edge.
          sx={{ borderBottom: "none" }}
        />
      }
    />
  );
};

const DatasetDetail = ({ dataset, actions }: DatasetDetailProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const labels = useCatalogLabels();
  const [tab, setTab] = useState<TabId>("summary");

  const typeLabelKey = layerTypeLabelKey(dataset.type);
  const catalogItem = catalogItemOf(dataset);
  const rawLineage = catalogItem?.["processing:lineage"];
  const lineage = typeof rawLineage === "string" && rawLineage !== "" ? rawLineage : undefined;
  const owner = dataset.owned_by;
  const ownerName = owner ? [owner.firstname, owner.lastname].filter(Boolean).join(" ") : "";

  const tabs = useMemo(() => {
    const list: { id: TabId; label: string }[] = [{ id: "summary", label: t("summary") }];
    if (dataset.type === "table" || dataset.type === "feature") {
      list.push({ id: "data", label: t("data") });
    }
    return list;
  }, [dataset.type, t]);

  const hasMap = dataset.type === "feature" || dataset.type === "raster";
  /** The description opens the summary, so it renders where it has something to
   * carry — and, for a dataset with no map either, as the empty line that keeps
   * the column from being blank. */
  const showDescription = !!dataset.description || !!lineage || !!dataset.tags?.length || !hasMap;

  const stringOf = (value: string | number | null | undefined) =>
    value === null || value === undefined || value === "" ? undefined : String(value);

  const fields: (MetaField | false | undefined)[] = [
    {
      icon: ICON_NAME.LAYERS,
      label: t("metadata.headings.type"),
      value: t(typeLabelKey),
    },
    {
      icon: ICON_NAME.MAP,
      label: t("metadata.headings.geometry_type"),
      value: labels.geometryLabel(dataset.feature_layer_geometry_type),
    },
    {
      icon: ICON_NAME.DATA_CATEGORY,
      label: t("metadata.headings.data_category"),
      value: labels.conceptLabel(stringOf(catalogItem?.category)),
    },
    (!!stringOf(catalogItem?.license) ||
      !!stringOf(catalogItem?.attribution) ||
      !!lineage) && {
      icon: ICON_NAME.LICENSE,
      label: t("metadata.headings.license"),
      value: (
        <Stack direction="row" spacing={1.5} alignItems="center">
          {!!stringOf(catalogItem?.license) && (
            <LicenseBadge license={stringOf(catalogItem?.license) as string} />
          )}
          <LicenseNotices attribution={stringOf(catalogItem?.attribution)} lineage={lineage} />
        </Stack>
      ),
    },
    {
      // The catalog says publisher where a layer says owner; both are shown, so
      // each keeps the icon it is filed under (METADATA_HEADER_ICONS).
      icon: ICON_NAME.ORGANIZATION,
      label: t("metadata.headings.publisher"),
      value: stringOf(catalogItem?.publisher),
    },
    {
      icon: ICON_NAME.LANGUAGE,
      label: t("metadata.headings.language_code"),
      value: labels.languageLabel(stringOf(catalogItem?.language_code)),
    },
    {
      icon: ICON_NAME.USER,
      label: t("owner"),
      value: ownerName,
    },
    {
      icon: ICON_NAME.CALENDAR,
      label: t("created"),
      value: labels.formatDate(dataset.created_at),
    },
    {
      icon: ICON_NAME.CLOCK,
      label: t("last_updated"),
      value: labels.formatDate(dataset.updated_at),
    },
  ];

  return (
    <>
      <DetailHeader
        size="compact"
        title={dataset.name}
        badge={{ label: t(typeLabelKey) }}
        actions={actions}
      />

      <DetailTabs<TabId> tabs={tabs} active={tab} onChange={setTab} />

      <Stack direction={{ xs: "column", md: "row" }} spacing={6} alignItems="flex-start">
        <Stack spacing={4} sx={{ flex: 1, minWidth: 0, alignSelf: "stretch" }}>
          {tab === "summary" && (
            <>
              {showDescription && (
                <Box>
                  <SectionHeading>{t("metadata.headings.description")}</SectionHeading>
                  {dataset.description ? (
                    <MarkdownProse>{dataset.description}</MarkdownProse>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      {t("no_description")}
                    </Typography>
                  )}
                  {lineage && (
                    <Box sx={{ mt: 4.5, pt: 4, borderTop: `1px solid ${theme.palette.divider}` }}>
                      <Typography
                        sx={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: theme.palette.text.secondary,
                          mb: 2.5,
                        }}>
                        {t("metadata.headings.lineage")}
                      </Typography>
                      <MarkdownProse>{lineage}</MarkdownProse>
                    </Box>
                  )}
                  <KeywordSection keywords={dataset.tags} />
                </Box>
              )}

              {hasMap && <MapFrame dataset={dataset} />}
            </>
          )}

          {tab === "data" && <DataTab dataset={dataset} />}
        </Stack>

        {tab === "summary" && <MetaSidebar fields={fields} flat />}
      </Stack>
    </>
  );
};

export default DatasetDetail;
