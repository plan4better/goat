"use client";

import { Box, Button, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { layerCard } from "@/lib/catalog/card";
import { datasetPeriod } from "@/lib/catalog/period";
import type { CatalogCollection, CatalogItem } from "@/lib/validations/catalog";

import { linkHref, useCatalogLabels } from "@/hooks/catalog/useCatalogLabels";

import CatalogCard from "@/components/dashboard/catalog/CatalogCard";
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

/** A bundle: the dataset's description, its layers as result cards, and the shared metadata beside them. */
const CatalogBundleDetail = ({
  collection,
  members,
  onBack,
  onOpenMember,
  starred = {},
  onToggleStar,
  onToggleAll,
}: {
  collection: CatalogCollection;
  members: CatalogItem[];
  onBack: () => void;
  onOpenMember: (member: CatalogItem) => void;
  starred?: Record<string, boolean>;
  onToggleStar?: (member: CatalogItem) => void;
  onToggleAll?: (members: CatalogItem[], save: boolean) => void;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const labels = useCatalogLabels();

  const memberCount = (collection["goat:member_count"] as number | undefined) ?? members.length;

  /**
   * When the dataset's data is from: its own `extent.temporal` where it states
   * one, otherwise the span of its layers' dates.
   */
  const dataDate = labels.periodField(datasetPeriod(collection, members));
  // `other` is STAC's "unknown", not a licence — see `licenseLabel`.
  const licenseLabel = labels.licenseLabel(collection.license);
  const licenseHref =
    linkHref(collection.links, "license") ?? linkHref(collection.links, "via");
  const allSaved = members.length > 0 && members.every((member) => starred[member.id]);

  const fields: (MetaField | false | undefined)[] = [
    {
      icon: ICON_NAME.LAYERS,
      label: t("metadata.headings.type"),
      value: `${t("catalog_bundle")} · ${labels.formatCount(memberCount)}`,
    },
    {
      icon: ICON_NAME.DATA_CATEGORY,
      label: t("metadata.headings.data_category"),
      value: labels.categoryLabel(collection.themes),
    },
    {
      icon: ICON_NAME.GLOBE,
      label: t("metadata.headings.geographical_code"),
      value: labels.regionLabel(collection["goat:geographical_code"]),
    },
    (!!licenseLabel || !!licenseHref || !!collection.attribution) && {
      icon: ICON_NAME.LICENSE,
      label: t("metadata.headings.license"),
      value: (
        <Stack direction="row" spacing={1.5} alignItems="center">
          {licenseLabel ? (
            <LicenseBadge license={licenseLabel} href={licenseHref} />
          ) : (
            <LicenseTerms href={licenseHref} />
          )}
          <LicenseNotices attribution={collection.attribution} />
        </Stack>
      ),
    },
    // A Collection states its time as `extent.temporal`, and since 2026-08-04 it does so on every row — so the extent wins here and the fallback to the layers' own dates covers only a Collection that states nothing.
    !!dataDate && {
      icon: ICON_NAME.CALENDAR,
      label: t(dataDate.labelKey),
      value: dataDate.value,
    },
    {
      icon: ICON_NAME.CLOCK,
      label: t("catalog_updated"),
      value: labels.formatDate(collection.updated as string | undefined),
    },
  ];

  return (
    <>
      <DetailHeader
        onBack={onBack}
        title={collection.title || collection.id}
        badge={{ label: t("catalog_bundle"), color: BUNDLE_ACCENT }}
        actions={
          <>
            {onToggleAll && members.length > 0 && (
              <Button
                variant="outlined"
                color={allSaved ? "primary" : "inherit"}
                onClick={() => onToggleAll(members, !allSaved)}
                startIcon={
                  <Icon
                    iconName={ICON_NAME.STAR}
                    style={{ fontSize: 13 }}
                    htmlColor={allSaved ? theme.palette.primary.main : theme.palette.text.secondary}
                  />
                }
                sx={allSaved ? { backgroundColor: theme.palette.action.hover } : undefined}>
                {allSaved ? t("catalog_all_saved") : t("catalog_save_all")}
              </Button>
            )}
            <Tooltip title={t("catalog_tab_coming_soon")} placement="top">
              <Box component="span" sx={{ display: "inline-flex" }}>
                <Button
                  variant="contained"
                  disabled
                  startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 13 }} />}>
                  {t("catalog_add_all_to_project")}
                </Button>
              </Box>
            </Tooltip>
          </>
        }
      />

      <DetailTabs
        tabs={[{ id: "summary", label: t("summary") }]}
        active="summary"
        onChange={() => undefined}
      />

      <Stack direction={{ xs: "column", md: "row" }} spacing={6} alignItems="flex-start" sx={{ mb: 10 }}>
        <Stack spacing={4} sx={{ flex: 1, minWidth: 0 }}>
          <SectionCard title={t("metadata.headings.description")}>
            {collection.description ? (
              <MarkdownProse>{collection.description}</MarkdownProse>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {t("catalog_no_description")}
              </Typography>
            )}
            <KeywordSection keywords={collection.keywords} />
          </SectionCard>

          <SectionCard
            title={t("catalog_layers_in_bundle")}
            note={t("catalog_member_count", { count: memberCount })}>
            <Stack spacing={3.5}>
              {members.map((member) => (
                <CatalogCard
                  key={member.id}
                  card={layerCard(member)}
                  onClick={() => onOpenMember(member)}
                  starred={!!starred[member.id]}
                  onToggleStar={onToggleStar ? () => onToggleStar(member) : undefined}
                />
              ))}
              {members.length === 0 && (
                <Typography variant="body2" color="text.secondary">
                  {t("catalog_bundle_members_unavailable")}
                </Typography>
              )}
            </Stack>
          </SectionCard>
        </Stack>

        <MetaSidebar fields={fields}>
          <CatalogProviderCard
            providers={collection.providers}
            publisher={collection["goat:publisher"] as string | undefined}
            sourceHref={linkHref(collection.links, "via")}
          />
        </MetaSidebar>
      </Stack>
    </>
  );
};

export default CatalogBundleDetail;
