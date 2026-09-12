"use client";

import { Box, Button, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useCatalogPreview } from "@/lib/api/catalog";
import { catalogKindOf } from "@/lib/catalog/kind";
import { datasetPeriod, itemPeriod } from "@/lib/catalog/period";
import type { CatalogCollection, CatalogItem } from "@/lib/validations/catalog";

import { describedBy, linkHref, useCatalogLabels } from "@/hooks/catalog/useCatalogLabels";

import CatalogFeatureTable from "@/components/dashboard/catalog/CatalogFeatureTable";
import CatalogFootprintMap from "@/components/dashboard/catalog/CatalogFootprintMap";
import CatalogProviderCard from "@/components/dashboard/catalog/CatalogProviderCard";
import {
  BUNDLE_ACCENT,
  DetailHeader,
  DetailTabs,
  KeywordSection,
  LicenseNotices,
  LicenseBadge,
  LicenseTerms,
  type MetaField,
  MetaSidebar,
  SectionCard,
} from "@/components/dashboard/common/DetailChrome";
import MarkdownProse from "@/components/dashboard/common/MarkdownProse";
import SchemaTable from "@/components/dashboard/common/SchemaTable";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";

/** One dataset: description, keywords and a map, metadata beside them, columns on a second tab. */

type TabId = "summary" | "data";

const CatalogLayerDetail = ({
  item,
  collection,
  onBack,
  backLabel,
  starred,
  onToggleStar,
}: {
  item: CatalogItem;
  /** The item's parent, which carries description, keywords and providers. */
  collection?: CatalogCollection;
  onBack: () => void;
  backLabel?: string;
  starred?: boolean;
  onToggleStar?: () => void;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const labels = useCatalogLabels();
  const [tab, setTab] = useState<TabId>("summary");

  const props = item.properties;
  const { description, keywords } = describedBy(item, collection);
  const columns = props["table:columns"] ?? [];
  // The same SWR key the map uses, so the two share one request: the tab shows
  // the sample as rows and the map draws it as geometry.
  const { preview } = useCatalogPreview(item.id);
  const hasMap = !!item.geometry;
  const memberCount = (collection?.["goat:member_count"] as number | undefined) ?? 1;
  const inBundle = memberCount > 1;
  /** Inside a bundle, the layer's own title is what distinguishes it from its siblings ("… SHP EPSG:31259"). */
  const title = inBundle ? props.title : collection?.title || props.title;
  // `other` is STAC's "unknown", not a licence — see `licenseLabel`.
  const licenseLabel = labels.licenseLabel(props.license);
  const licenseHref =
    linkHref(item.links, "license") ??
    linkHref(collection?.links, "license") ??
    linkHref(collection?.links, "via");
  const periodField = labels.periodField(inBundle ? itemPeriod(item) : datasetPeriod(collection, [item]));

  /** How big the dataset is, beside the sample that shows a slice of it — the two numbers a reader needs to judge what the rows below them represent. */
  const datasetSize = useMemo(() => {
    const parts: string[] = [];
    const rows = props["table:row_count"];
    if (typeof rows === "number") parts.push(t("catalog_row_count_short", { count: rows }));
    if (columns.length) parts.push(t("catalog_schema_column_count", { count: columns.length }));
    if (!parts.length) return undefined;
    return (
      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
        {parts.join(" · ")}
      </Typography>
    );
  }, [props, columns.length, t]);

  const tabs = useMemo(() => {
    const list: { id: TabId; label: string }[] = [{ id: "summary", label: t("summary") }];
    if (columns.length > 0) {
      // No count on the tab. The table below it lists the columns, so the badge
      // repeated a number nobody was going to act on.
      list.push({ id: "data", label: t("data") });
    }
    return list;
  }, [columns.length, t]);

  const fields: (MetaField | false | undefined)[] = [
    {
      icon: ICON_NAME.LAYERS,
      label: t("metadata.headings.type"),
      // Resolved with `asMember`, so a layer inside a bundle reports its own kind
      // rather than the "bundle" its collection stamped on it.
      value: labels.kindLabel(catalogKindOf(item, inBundle)),
    },
    !!props["goat:geometryType"] && {
      icon: ICON_NAME.MAP,
      label: t("metadata.headings.geometry_type"),
      value: labels.geometryLabel(props["goat:geometryType"]),
    },
    {
      icon: ICON_NAME.DATA_CATEGORY,
      label: t("metadata.headings.data_category"),
      value: labels.categoryLabel(props.themes),
    },
    {
      icon: ICON_NAME.GLOBE,
      label: t("metadata.headings.geographical_code"),
      value: labels.regionLabel(props["goat:geographical_code"]),
    },
    {
      icon: ICON_NAME.LANGUAGE,
      label: t("metadata.headings.language"),
      value: labels.languageLabel(props.language?.code),
    },
    (!!licenseLabel ||
      !!licenseHref ||
      !!collection?.attribution ||
      !!props["processing:lineage"]) && {
      icon: ICON_NAME.LICENSE,
      label: t("metadata.headings.license"),
      value: (
        <Stack direction="row" spacing={1.5} alignItems="center">
          {licenseLabel ? (
            <LicenseBadge license={licenseLabel} href={licenseHref} />
          ) : (
            <LicenseTerms href={licenseHref} />
          )}
          <LicenseNotices
            attribution={collection?.attribution}
            lineage={props["processing:lineage"]}
          />
        </Stack>
      ),
    },
    // When the data is from, headed by what the value turns out to be: a reference year for a single date, a period for a span (`periodField`).
    !!periodField && {
      icon: ICON_NAME.CALENDAR,
      label: t(periodField.labelKey),
      value: periodField.value,
    },
    {
      icon: ICON_NAME.CLOCK,
      label: t("catalog_updated"),
      value: labels.formatDate(props.updated),
    },
  ];

  return (
    <>
      <DetailHeader
        onBack={onBack}
        backLabel={backLabel}
        title={title}
        badge={
          inBundle && collection
            ? {
                label: t("catalog_part_of_bundle", { bundle: collection.title || collection.id }),
                color: BUNDLE_ACCENT,
                plain: true,
              }
            : null
        }
        actions={
          <>
            {onToggleStar && (
              <Button
                variant="outlined"
                color={starred ? "primary" : "inherit"}
                onClick={onToggleStar}
                startIcon={
                  <Icon
                    iconName={ICON_NAME.STAR}
                    style={{ fontSize: 13 }}
                    htmlColor={starred ? theme.palette.primary.main : theme.palette.text.secondary}
                  />
                }
                sx={starred ? { backgroundColor: theme.palette.action.hover } : undefined}>
                {starred ? t("catalog_saved") : t("save")}
              </Button>
            )}
            <Tooltip title={t("catalog_tab_coming_soon")} placement="top">
              {/* A disabled button emits no pointer events, so the tooltip needs a wrapper to hang off. */}
              <Box component="span" sx={{ display: "inline-flex" }}>
                <Button
                  variant="contained"
                  disabled
                  startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 13 }} />}>
                  {t("catalog_add_to_project")}
                </Button>
              </Box>
            </Tooltip>
          </>
        }
      />

      <DetailTabs<TabId> tabs={tabs} active={tab} onChange={setTab} />

      <Stack direction={{ xs: "column", md: "row" }} spacing={6} alignItems="flex-start" sx={{ mb: 10 }}>
        <Stack spacing={4} sx={{ flex: 1, minWidth: 0, alignSelf: "stretch" }}>
          {tab === "summary" && (
            <>
              <SectionCard title={t("metadata.headings.description")}>
                {description ? (
                  <MarkdownProse>{description}</MarkdownProse>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    {t("catalog_no_description")}
                  </Typography>
                )}
                <KeywordSection keywords={keywords} />
              </SectionCard>

              {hasMap && (
                <Box
                  sx={{
                    position: "relative",
                    // A real height rather than "whatever the sidebar leaves".
                    flex: { xs: "none", md: "none" },
                    height: { xs: 320, md: 460 },
                    borderRadius: 2.5,
                    overflow: "hidden",
                    border: `1px solid ${theme.palette.divider}`,
                    boxShadow: surfaceShadows(theme).rest,
                  }}>
                  <CatalogFootprintMap item={item} fill />
                </Box>
              )}
            </>
          )}

          {tab === "data" && (
            <>
              {/* The sample first: "what does a record look like" is the question a data tab is opened with, and the dictionary answers a narrower one. */}
              {!!preview?.features?.length && (
                <SectionCard title={t("catalog_feature_table")} right={datasetSize}>
                  <CatalogFeatureTable
                    features={preview.features}
                    columns={columns}
                    truncated={!!preview["goat:truncated"]}
                  />
                </SectionCard>
              )}
              {/* No subtitle: the heading and the column headers underneath it already say what this is. */}
              <SectionCard title={t("catalog_columns")}>
                <SchemaTable columns={columns} />
              </SectionCard>
            </>
          )}
        </Stack>

        {tab === "summary" && (
          <MetaSidebar fields={fields}>
            <CatalogProviderCard
              providers={collection?.providers}
              publisher={props["goat:publisher"]}
              sourceHref={linkHref(item.links, "via")}
            />
          </MetaSidebar>
        )}
      </Stack>
    </>
  );
};

export default CatalogLayerDetail;
