import type { DragEndEvent } from "@dnd-kit/core";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import { Box, IconButton, Input, Stack, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { AttributeFormatConfig, PopupFieldListBlock } from "@/lib/validations/layer";

import { useStyleData } from "@/components/map/panels/styleEditor/context";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { AddButton, NumberInput, Row, SegmentedRow } from "@/components/map/panels/styleEditor/rows";
import type { LayerField } from "@/components/map/popover/formatFeatureProperties";
import { formatFeatureProperties } from "@/components/map/popover/formatFeatureProperties";
import { useSampleFeature } from "@/components/map/popover/sampleFeature";

import { FieldFormatPopover } from "./FieldFormatPopover";

type AttributeEntry = PopupFieldListBlock["attributes"][number];
type AttributeType = AttributeEntry["type"];

// Layer fields can be "string" | "number" | "object" (JSON columns), but
// the popup attribute schema only accepts "string" | "number" | "boolean".
// Map anything that isn't a number to "string" — object fields render as
// text in the popup, and they correctly fall through the isNumber check
// below so the "123" format button is hidden.
function coerceAttributeType(fieldType: string): AttributeType {
  if (fieldType === "number") return "number";
  if (fieldType === "boolean") return "boolean";
  return "string";
}

interface Props {
  block: PopupFieldListBlock;
  fields: LayerField[];
  layerId: string;
  onChange: (next: PopupFieldListBlock) => void;
}

const MAX_SAMPLE_DISPLAY_LENGTH = 18;

function truncateSample(s: string): string {
  if (s.length <= MAX_SAMPLE_DISPLAY_LENGTH) return s;
  return s.slice(0, MAX_SAMPLE_DISPLAY_LENGTH - 1) + "…";
}

export function FieldListBlockEditor({ block, fields, layerId, onChange }: Props) {
  const { t, i18n } = useTranslation("common");
  const { fields: styleFields } = useStyleData();
  const [addMenuAnchor, setAddMenuAnchor] = useState<null | HTMLElement>(null);
  const [formatTarget, setFormatTarget] = useState<{
    name: string;
    anchorEl: HTMLElement;
  } | null>(null);

  const attributes = block.attributes;

  const setAttributes = (next: AttributeEntry[]) => {
    onChange({ ...block, attributes: next });
  };

  const updateAttribute = (name: string, partial: Partial<AttributeEntry>) => {
    setAttributes(attributes.map((a) => (a.name === name ? ({ ...a, ...partial } as AttributeEntry) : a)));
  };

  const removeAttribute = (name: string) => {
    setAttributes(attributes.filter((a) => a.name !== name));
    if (formatTarget?.name === name) setFormatTarget(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = attributes.findIndex((a) => a.name === active.id);
    const newIndex = attributes.findIndex((a) => a.name === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setAttributes(arrayMove(attributes, oldIndex, newIndex));
  };

  // Pull one feature from the layer so each row can show a real sample
  // value on the right — drops a lot of cognitive load vs. "what does
  // this field even look like". Memoize the fallback object so the
  // downstream useMemo on `sampleProperties` doesn't fire on every
  // render of this component.
  const { feature } = useSampleFeature(layerId, true);
  const sampleProperties = useMemo<Record<string, unknown>>(
    () => (feature?.properties ?? {}) as Record<string, unknown>,
    [feature?.properties]
  );

  const { byColumn } = useMemo(
    () =>
      formatFeatureProperties({
        properties: sampleProperties,
        layerFields: fields,
        lang: i18n.language,
      }),
    [sampleProperties, fields, i18n.language]
  );

  const unAddedFields = useMemo(
    () => fields.filter((f) => !attributes.some((a) => a.name === f.name)),
    [fields, attributes]
  );

  const addField = (f: { name: string; type: string }) => {
    setAttributes([...attributes, { name: f.name, type: coerceAttributeType(f.type) }]);
  };

  const resetToAllFields = () => {
    setAttributes(fields.map((f) => ({ name: f.name, type: coerceAttributeType(f.type) })));
  };

  const fieldByName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);

  const formatTargetAttr = formatTarget ? attributes.find((a) => a.name === formatTarget.name) : null;

  return (
    <>
      <SegmentedRow<PopupFieldListBlock["layout"]>
        label={t("layout")}
        value={block.layout}
        onChange={(layout) => onChange({ ...block, layout })}
        options={[
          { value: "table", label: t("table") },
          { value: "list", label: t("list") },
        ]}
      />

      {/* The attributes: a heading with their count, the framed list, then "Add attribute". */}
      <Box sx={{ px: 3, pt: 2 }}>
        <Stack direction="row" alignItems="baseline" justifyContent="space-between" sx={{ pb: 1 }}>
          <Typography variant="caption" color="text.secondary" fontWeight="bold">
            {t("attributes")}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t("n_fields", { count: attributes.length })}
          </Typography>
        </Stack>

        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 1.5,
            overflow: "hidden",
            maxHeight: 320,
            overflowY: "auto",
          }}>
          <DndContext
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}>
            <SortableContext items={attributes.map((a) => a.name)} strategy={verticalListSortingStrategy}>
              {attributes.map((attr, i) => (
                <AttributeRow
                  key={attr.name}
                  attribute={attr}
                  isLast={i === attributes.length - 1}
                  field={fieldByName.get(attr.name)}
                  sample={byColumn[attr.name] ?? ""}
                  rawSample={sampleProperties[attr.name]}
                  onLabelChange={(label) => updateAttribute(attr.name, { label: label || undefined })}
                  onRemove={() => removeAttribute(attr.name)}
                  onOpenFormat={(anchor) => setFormatTarget({ name: attr.name, anchorEl: anchor })}
                  formatOpen={formatTarget?.name === attr.name}
                />
              ))}
              {attributes.length === 0 && (
                <Box sx={{ px: 2, py: 2.5, textAlign: "center" }}>
                  <Typography variant="caption" color="text.secondary">
                    {t("no_attributes")}
                  </Typography>
                </Box>
              )}
            </SortableContext>
          </DndContext>
        </Box>

        {/* Under the list, its plus on the content's edge; the menu offers every field not listed yet. */}
        <AddButton
          disabled={unAddedFields.length === 0}
          onClick={(e) => setAddMenuAnchor(addMenuAnchor ? null : e.currentTarget)}
          sx={{ ml: -2.5, mt: 1 }}>
          {t("add_attribute")}
        </AddButton>
        <FieldPicker
          anchorEl={addMenuAnchor}
          onClose={() => setAddMenuAnchor(null)}
          placement="bottom-start"
          fields={styleFields}
          exclude={attributes.map((a) => a.name)}
          before={[{ label: t("add_all_fields"), icon: ICON_NAME.LIST, onClick: resetToAllFields }]}
          onChange={(name) => {
            const f = fieldByName.get(name);
            if (f) addField(f);
          }}
        />
      </Box>

      <Row label={t("collapse_after")} note={t("collapse_after_help")}>
        <NumberInput
          value={block.collapse_after ?? undefined}
          unit={t("collapse_after_unit")}
          min={1}
          width={96}
          placeholder={t("collapse_after_placeholder")}
          ariaLabel={t("collapse_after")}
          onChange={(n) => onChange({ ...block, collapse_after: Number.isInteger(n) && n >= 1 ? n : null })}
          onClear={() => onChange({ ...block, collapse_after: null })}
        />
      </Row>

      {/* Number-format popover — anchored to the row's "123" button.
          Floats outside the parent popper (placement="left-start") so it
          doesn't sit on top of other rows. */}
      <FieldFormatPopover
        open={Boolean(formatTarget && formatTargetAttr)}
        anchorEl={formatTarget?.anchorEl ?? null}
        config={formatTargetAttr?.format_config}
        prefix={formatTargetAttr?.prefix}
        suffix={formatTargetAttr?.suffix}
        sampleValue={
          formatTarget && typeof sampleProperties[formatTarget.name] === "number"
            ? (sampleProperties[formatTarget.name] as number)
            : null
        }
        onChange={(patch: { format_config?: AttributeFormatConfig; prefix?: string; suffix?: string }) => {
          if (!formatTarget) return;
          const cur = attributes.find((a) => a.name === formatTarget.name);
          if (!cur) return;
          const next: AttributeEntry = { ...cur };
          if ("format_config" in patch) next.format_config = patch.format_config;
          if ("prefix" in patch) next.prefix = patch.prefix;
          if ("suffix" in patch) next.suffix = patch.suffix;
          updateAttribute(formatTarget.name, next);
        }}
        onClose={() => setFormatTarget(null)}
      />
    </>
  );
}

interface AttributeRowProps {
  attribute: AttributeEntry;
  isLast: boolean;
  field: LayerField | undefined;
  sample: string;
  rawSample: unknown;
  onLabelChange: (label: string) => void;
  onRemove: () => void;
  onOpenFormat: (anchorEl: HTMLElement) => void;
  formatOpen: boolean;
}

function AttributeRow({
  attribute,
  isLast,
  field,
  sample,
  rawSample,
  onLabelChange,
  onRemove,
  onOpenFormat,
  formatOpen,
}: AttributeRowProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: attribute.name,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isNumber = attribute.type === "number" || field?.type === "number";
  const hasFormatConfig = !!attribute.format_config && Object.keys(attribute.format_config).length > 0;
  const hasPrefixOrSuffix = !!(attribute.prefix || attribute.suffix);
  const hasAnyFormatting = hasFormatConfig || hasPrefixOrSuffix;

  const sampleText = rawSample == null || rawSample === "" ? "—" : truncateSample(sample);

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        bgcolor: isDragging ? alpha(theme.palette.primary.main, 0.05) : "transparent",
        borderBottom: isLast ? 0 : 1,
        borderColor: "divider",
        "&:hover": {
          bgcolor: alpha(theme.palette.text.primary, 0.02),
          "& .row-drag": { opacity: 1 },
          "& .row-remove": { opacity: 1 },
        },
      }}>
      <Stack direction="row" alignItems="center" sx={{ pl: 0.5, pr: 0.5, py: 0.25, minHeight: 40 }}>
        <Box
          {...attributes}
          {...listeners}
          className="row-drag"
          sx={{
            cursor: "grab",
            display: "flex",
            alignItems: "center",
            color: theme.palette.text.secondary,
            opacity: 0,
            transition: "opacity 120ms",
            flexShrink: 0,
          }}>
          <DragIndicatorIcon sx={{ fontSize: 16 }} />
        </Box>

        {/* Label edit — pre-populate with the field name when the user
            hasn't set a custom label yet, so the visible text is the
            real input value (not a placeholder). Avoids the "cursor
            jumps to start / first keystroke wipes the row" feel that a
            placeholder gives, since placeholders render text in an empty
            input. */}
        <Input
          value={attribute.label !== undefined ? attribute.label : attribute.name}
          onChange={(e) => onLabelChange(e.target.value)}
          disableUnderline
          inputProps={{ maxLength: 128, style: { padding: "4px 0" } }}
          sx={{
            flex: 1,
            minWidth: 0,
            ml: 0.25,
            "& .MuiInputBase-input": {
              fontSize: 13,
              fontWeight: "bold",
              color: "text.primary",
            },
          }}
        />

        <Tooltip title={sample.length > MAX_SAMPLE_DISPLAY_LENGTH ? sample : ""} disableInteractive>
          <Typography
            variant="caption"
            sx={{
              color: alpha(theme.palette.text.primary, 0.45),
              ml: 0.75,
              flexShrink: 0,
              maxWidth: 110,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
            {sampleText}
          </Typography>
        </Tooltip>

        {isNumber && (
          <Tooltip title={t("format_number")} disableInteractive>
            <Box
              component="button"
              onClick={(e) => onOpenFormat(e.currentTarget as HTMLElement)}
              sx={{
                ml: 0.75,
                px: 0.75,
                py: 0.25,
                border: 1,
                borderColor:
                  formatOpen || hasAnyFormatting
                    ? theme.palette.primary.main
                    : alpha(theme.palette.text.primary, 0.2),
                borderRadius: 0.75,
                bgcolor: formatOpen ? alpha(theme.palette.primary.main, 0.08) : "transparent",
                color: hasAnyFormatting
                  ? theme.palette.primary.main
                  : alpha(theme.palette.text.primary, 0.55),
                fontSize: 11,
                fontWeight: "bold",
                lineHeight: 1.2,
                cursor: "pointer",
                fontFamily: "monospace",
                letterSpacing: 0.5,
                flexShrink: 0,
                "&:hover": {
                  borderColor: theme.palette.primary.main,
                  color: theme.palette.primary.main,
                },
              }}>
              123
            </Box>
          </Tooltip>
        )}

        <IconButton
          size="small"
          className="row-remove"
          onClick={onRemove}
          sx={{
            ml: 0.25,
            p: 0.25,
            opacity: 0,
            transition: "opacity 120ms",
            color: alpha(theme.palette.text.primary, 0.5),
            "&:hover": { color: theme.palette.error.main, bgcolor: "transparent" },
          }}>
          <Icon iconName={ICON_NAME.XCLOSE} style={{ fontSize: 12 }} htmlColor="inherit" />
        </IconButton>
      </Stack>
    </Box>
  );
}
