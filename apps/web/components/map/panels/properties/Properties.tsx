// The layer panel's Metadata tab, laid out as the style panel is: sections with a heading each (the description, the
// lineage, the details), the facts as rows of a label and its value, the 12 px gutter. Every field but the
// description is read from the catalog record the layer carries (a promoted catalog layer's own record, a fetched
// layer's provenance), in the catalog's vocabulary.
import { Box, Tooltip, Typography } from "@mui/material";
import { format, formatDistance } from "date-fns";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { isCatalogLayer } from "@/lib/utils/catalog-layer";
import { datasetUpdatedAt } from "@/lib/utils/datasetDates";
import type { ProjectLayer } from "@/lib/validations/project";

import { useCatalogLabels } from "@/hooks/catalog/useCatalogLabels";

import MarkdownProse from "@/components/dashboard/common/MarkdownProse";
import { PanelSection, Row } from "@/components/map/panels/styleEditor/rows";

type CatalogRecord = Record<string, string | number | null | undefined>;

/** The record the layer's metadata is read from: a promoted catalog layer's own, else a fetched layer's provenance. */
function recordOf(layer: ProjectLayer): CatalogRecord | undefined {
  const other = layer.other_properties as
    | { catalog_item?: CatalogRecord; provenance?: CatalogRecord }
    | undefined;
  return other?.catalog_item ?? other?.provenance;
}

const text = (value: unknown): string | undefined =>
  value === null || value === undefined || value === "" ? undefined : String(value);

/** A fact's value: wraps anywhere, so a long value without spaces ("a/b/c") cannot widen the panel. */
const Value = ({ children }: { children: ReactNode }) => (
  <Typography variant="body2" sx={{ overflowWrap: "anywhere", py: 1 }}>
    {children}
  </Typography>
);

/** Prose (the description, the lineage) in the panel's gutter. */
const Prose = ({ children }: { children: string }) => (
  <Box sx={{ px: 3, pt: 1 }}>
    <MarkdownProse>{children}</MarkdownProse>
  </Box>
);

const PropertiesPanel = ({ activeLayer }: { activeLayer: ProjectLayer }) => {
  const { t } = useTranslation("common");
  const dateLocale = useDateFnsLocale();
  const labels = useCatalogLabels();
  const record = recordOf(activeLayer);
  const description = text(activeLayer.description);
  const lineage = text(record?.["processing:lineage"]);
  const updatedAt = datasetUpdatedAt(activeLayer);
  const catalog = isCatalogLayer(activeLayer);

  const facts: { key: string; label: string; value: ReactNode }[] = [
    { key: "publisher", label: t("metadata.headings.publisher"), value: text(record?.publisher) },
    { key: "license", label: t("metadata.headings.license"), value: text(record?.license) },
    { key: "attribution", label: t("metadata.headings.attribution"), value: text(record?.attribution) },
    {
      key: "category",
      label: t("category"),
      value: labels.conceptLabel(text(record?.category)),
    },
    {
      key: "language",
      label: t("metadata.headings.language_code"),
      value: labels.languageLabel(text(record?.language_code)),
    },
  ].filter((fact) => fact.value);

  return (
    <Box sx={{ pb: 3 }}>
      {/* The description's section stays, with a line saying there is none: the tab is never blank. */}
      <PanelSection
        title={t("metadata.headings.description")}
        empty={t("metadata.no_metadata_available.description")}>
        {description && <Prose>{description}</Prose>}
      </PanelSection>
      {lineage && (
        <PanelSection title={t("metadata.headings.lineage")}>
          <Prose>{lineage}</Prose>
        </PanelSection>
      )}
      {(facts.length > 0 || catalog || updatedAt) && (
        <PanelSection title={t("details")}>
          {facts.map(({ key, label, value }) => (
            <Row key={key} label={label}>
              <Value>{value}</Value>
            </Row>
          ))}
          {/* Where the layer came from: someone else's dataset. Deliberately not a link to the catalog entry: the
            mirror is rebuilt wholesale on every sync, so a promoted layer outlives the entry it came from and the
            link would eventually 404. */}
          {catalog && (
            <Row label={t("source")}>
              <Icon iconName={ICON_NAME.GLOBE} sx={{ fontSize: 13, color: "text.secondary" }} />
              <Value>{t("catalog")}</Value>
            </Row>
          )}
          {updatedAt && (
            <Row label={t("metadata.headings.updated")}>
              {/* The date itself, not "12 days ago": this is provenance, and a relative distance is only easy to read
                for something recent. The relative form stays, one hover away. */}
              <Tooltip
                title={formatDistance(new Date(updatedAt), new Date(), {
                  addSuffix: true,
                  locale: dateLocale,
                })}
                placement="bottom-start"
                arrow>
                <Typography variant="body2" sx={{ width: "fit-content" }}>
                  {format(new Date(updatedAt), "PP", { locale: dateLocale })}
                </Typography>
              </Tooltip>
            </Row>
          )}
        </PanelSection>
      )}
    </Box>
  );
};

export default PropertiesPanel;
