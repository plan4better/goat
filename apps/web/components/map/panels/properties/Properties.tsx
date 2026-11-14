// The layer panel's Metadata tab, laid out as the style panel is: sections with a heading each (the description, the
// lineage, the details, the fields), the facts as rows of a label and its value, the 12 px gutter. The details open
// with the dataset's size (its geometry and feature count are in the panel's header); the catalog facts after it are
// read from the catalog record the layer carries (a promoted catalog layer's own record, a fetched layer's
// provenance), in the catalog's vocabulary.
import { Box, Button, Tooltip, Typography } from "@mui/material";
import { format, formatDistance } from "date-fns";
import prettyBytes from "pretty-bytes";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { useLayerQueryables } from "@/lib/api/layers";
import type { FieldType } from "@/lib/style/compile/types";
import { isCatalogLayer } from "@/lib/utils/catalog-layer";
import { datasetUpdatedAt } from "@/lib/utils/datasetDates";
import type { ProjectLayer } from "@/lib/validations/project";

import { useCatalogLabels } from "@/hooks/catalog/useCatalogLabels";
import { fieldsOf } from "@/hooks/style/useStyleData";

import FieldKindIcon, { type FieldIndicatorKind, fieldIndicatorKind } from "@/components/common/FieldKindIcon";
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

/** A field type's name, in the words the other field lists use. */
const TYPE_LABEL_KEYS: Record<FieldType, string> = {
  string: "field_kind_string",
  number: "field_kind_number",
  integer: "integer",
  boolean: "field_kind_boolean",
  date: "field_kind_date",
  datetime: "field_kind_datetime",
};

/** Fields listed before "show all": a wide dataset's list stays short until asked for. */
const FIELDS_SHOWN = 30;

interface FieldLine {
  name: string;
  label: string;
  kind: FieldIndicatorKind;
  type: string;
}

/** One field: its kind's glyph, its name, its type at the right. A plain line, as a dataset may have hundreds. */
const Field = ({ field }: { field: FieldLine }) => (
  <Box
    component="li"
    title={field.name}
    sx={{ display: "flex", alignItems: "center", gap: 2, minHeight: 28, px: 3 }}>
    <FieldKindIcon kind={field.kind} />
    <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
      {field.label}
    </Typography>
    <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 0 }}>
      {field.type}
    </Typography>
  </Box>
);

interface PropertiesPanelProps {
  activeLayer: ProjectLayer;
  /** Lists the dataset's fields. Off on a public map, whose viewers get what the author wrote and no schema. */
  showFields?: boolean;
}

const PropertiesPanel = ({ activeLayer, showFields = true }: PropertiesPanelProps) => {
  const { t, i18n } = useTranslation("common");
  const dateLocale = useDateFnsLocale();
  const labels = useCatalogLabels();
  const record = recordOf(activeLayer);
  const description = text(activeLayer.description);
  const lineage = text(record?.["processing:lineage"]);
  const updatedAt = datasetUpdatedAt(activeLayer);
  const catalog = isCatalogLayer(activeLayer);
  // Which layer's fields are all shown: another layer opens with its list short again.
  const [allFieldsOf, setAllFieldsOf] = useState<string>();

  // A feature layer's or a table's fields: the request the style and filter tabs make, so it mostly comes from the
  // cache; a raster has none. A locked row (no access to the dataset) asks for nothing.
  const tabular = (activeLayer.type === "feature" || activeLayer.type === "table") && !activeLayer.locked;
  const { queryables } = useLayerQueryables(showFields && tabular ? activeLayer.layer_id : "");
  const fields = useMemo<FieldLine[]>(() => {
    const properties = queryables?.properties as Parameters<typeof fieldsOf>[0];
    // fieldsOf leaves out the columns every layer carries, as the style and filter tabs do. The queryable's kind
    // (a formula, a running number) picks the glyph; the type names the data.
    return fieldsOf(properties).map(({ name, label, type }) => ({
      name,
      label,
      kind: fieldIndicatorKind({ type, kind: properties?.[name]?.kind }),
      type: t(TYPE_LABEL_KEYS[type]),
    }));
  }, [queryables, t]);
  const shownFields = allFieldsOf === activeLayer.layer_id ? fields : fields.slice(0, FIELDS_SHOWN);

  const facts: { key: string; label: string; value: ReactNode }[] = [
    {
      key: "size",
      label: t("size"),
      value: activeLayer.size ? prettyBytes(activeLayer.size, { locale: i18n.language }) : undefined,
    },
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
      {/* Once the fields have arrived: a section that appears below the others moves nothing. */}
      {fields.length > 0 && (
        <PanelSection title={t("fields")}>
          <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
            {shownFields.map((field) => (
              <Field key={field.name} field={field} />
            ))}
          </Box>
          {shownFields.length < fields.length && (
            <Box sx={{ px: 3, pt: 1 }}>
              <Button variant="text" size="small" onClick={() => setAllFieldsOf(activeLayer.layer_id)}>
                {t("metadata.show_all_fields", { count: fields.length })}
              </Button>
            </Box>
          )}
        </PanelSection>
      )}
    </Box>
  );
};

export default PropertiesPanel;
