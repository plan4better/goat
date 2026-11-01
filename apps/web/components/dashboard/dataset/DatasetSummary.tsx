import { Divider, Stack, Typography, styled, useTheme } from "@mui/material";
import React from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@p4b/ui/components/Icon";

import { METADATA_HEADER_ICONS } from "@/lib/constants/metadataIcons";
import type { Layer } from "@/lib/validations/layer";
import type { ProjectLayer } from "@/lib/validations/project";

import MarkdownProse from "@/components/dashboard/common/MarkdownProse";

interface DatasetSummaryProps {
  dataset: Layer | ProjectLayer;
  hideEmpty?: boolean; // Prop to control empty field display
  hideMainSection?: boolean; // Prop to control main section display
}

const ContainerWrapper = styled("div")({
  containerType: "inline-size",
  width: "100%",
});

const LayoutContainer = styled("div")({
  display: "flex",
  flexDirection: "row",
  gap: "16px",
  width: "100%",
  "@container (max-width: 600px)": {
    flexDirection: "column",
  },
});

const MetadataSection = styled("div")({
  flex: 4,
  order: 1,

  "@container (max-width: 600px)": {
    order: 2,
    flex: "1 1 100%",
  },
});

const MainContentSection = styled("div")({
  flex: 1,
  order: 2,

  "@container (max-width: 600px)": {
    order: 1,
    flex: "1 1 100%",
  },
});

/** What the sidebar tiles summarise: the catalog record's own field names, each
 * paired with the key our translations and icons are filed under. */
const SUMMARY_TILES = [
  { field: "license", i18nKey: "license" },
  { field: "publisher", i18nKey: "publisher" },
  { field: "category", i18nKey: "data_category" },
  { field: "language_code", i18nKey: "language_code" },
] as const;

const DatasetSummary: React.FC<DatasetSummaryProps> = ({
  dataset,
  hideEmpty = false,
  hideMainSection = false,
}) => {
  const theme = useTheme();
  const { t } = useTranslation(["common", "countries"]);
  // Every field but `description` is read out of the catalog record, so each
  // entry names the record's own key. `i18nKey` is separate because the two
  // vocabularies differ: the catalog says `category` and `processing:lineage`
  // where our strings are filed under `data_category` and `lineage`.
  const metadataSummaryFields = [
    { field: "description", i18nKey: "description", type: "markdown" },
    { field: "processing:lineage", i18nKey: "lineage", type: "markdown" },
    { field: "publisher", i18nKey: "publisher", type: "text" },
    { field: "license", i18nKey: "license", type: "text" },
    { field: "attribution", i18nKey: "attribution", type: "text" },
    { field: "category", i18nKey: "data_category", type: "text" },
    { field: "language_code", i18nKey: "language_code", type: "text" },
  ].map(({ field, i18nKey, type }) => ({
    field,
    i18nKey,
    type,
    heading: t(`metadata.headings.${i18nKey}`),
    noMetadataAvailable: t(`metadata.no_metadata_available.${i18nKey}`),
  }));

  // `description` is the layer's own column; every other summarised field
  // lives in the metadata document.
  // A layer holds no metadata of its own: a user's upload is its name,
  // description and tags, and a promoted catalog layer carries the catalog's
  // own record verbatim. So everything but `description` is read from that
  // record, in the catalog's vocabulary — `DL-DE-BY-2.0`, not an enum we would
  // have to map it into.
  // A fetched layer states its source in the same keys, under `provenance`.
  const other = dataset.other_properties as
    | {
        catalog_item?: Record<string, string | number | null>;
        provenance?: Record<string, string | number | null>;
      }
    | undefined;
  const catalogItem = other?.catalog_item ?? other?.provenance;

  const valueOf = (field: string): string | undefined => {
    const raw = field === "description" ? dataset.description : catalogItem?.[field];
    return raw === null || raw === undefined || raw === "" ? undefined : String(raw);
  };

  const hasAnyMetadata = metadataSummaryFields.some(({ field }) => !!valueOf(field));
  const shouldRenderMetadataSection = !hideEmpty || hasAnyMetadata;

  return (
    <ContainerWrapper>
      <LayoutContainer>
        {shouldRenderMetadataSection && (
          <MetadataSection>
            <Stack spacing={4} sx={{ width: "100%" }}>
              {metadataSummaryFields.map(({ field, heading, noMetadataAvailable, type }) => {
                if (hideEmpty && !valueOf(field)) return null;
                return (
                  <Stack key={field} spacing={1}>
                    <Typography variant="caption">{heading}</Typography>
                    <Divider />
                    {!valueOf(field) && (
                      <Typography variant="body2" sx={{ fontStyle: "italic" }}>
                        {noMetadataAvailable}
                      </Typography>
                    )}
                    {type === "markdown" && valueOf(field) && (
                      <MarkdownProse>{valueOf(field) as string}</MarkdownProse>
                    )}
                    {type === "text" && valueOf(field) && (
                      <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                        {valueOf(field)}
                      </Typography>
                    )}
                  </Stack>
                );
              })}
            </Stack>
          </MetadataSection>
        )}

        {!hideMainSection && (
          <MainContentSection>
            <Stack spacing={2}>
              {SUMMARY_TILES.map(({ field, i18nKey }) => (
                <div key={field} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <Icon
                    iconName={METADATA_HEADER_ICONS[i18nKey]}
                    style={{ fontSize: 14, flexShrink: 0 }}
                    htmlColor={theme.palette.text.secondary}
                  />
                  <div style={{ minWidth: 0 }}>
                    <Typography variant="caption" noWrap>
                      {t(`common:metadata.headings.${i18nKey}`)}
                    </Typography>
                    <Typography variant="body2" fontWeight="bold" noWrap>
                      {valueOf(field) ?? ""}
                    </Typography>
                  </div>
                </div>
              ))}
            </Stack>
          </MainContentSection>
        )}
      </LayoutContainer>
    </ContainerWrapper>
  );
};

export default DatasetSummary;
