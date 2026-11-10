import type { DragEndEvent } from "@dnd-kit/core";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import {
  Box,
  Button,
  ClickAwayListener,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuList,
  Stack,
  TextField,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { AttributeFormatConfig, PopupFieldListBlock } from "@/lib/validations/layer";

import type { LayerField } from "@/components/map/popover/formatFeatureProperties";
import { formatFeatureProperties } from "@/components/map/popover/formatFeatureProperties";
import { useSampleFeature } from "@/components/map/popover/sampleFeature";

import { FieldFormatPopover } from "./FieldFormatPopover";
import { MiniLabel, PillToggleGroup } from "./_shared";

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
  const theme = useTheme();
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
    <Stack spacing={2} sx={{ px: 2, pb: 2 }}>
      {/* Layout */}
      <Box>
        <MiniLabel>{t("layout")}</MiniLabel>
        <PillToggleGroup
          value={block.layout}
          onChange={(v) => onChange({ ...block, layout: v })}
          options={[
            { value: "table", label: t("table") },
            { value: "list", label: t("list") },
          ]}
        />
      </Box>

      {/* Attributes header + framed list */}
      <Box>
        <Stack direction="row" alignItems="baseline" justifyContent="space-between" sx={{ pb: 0.75 }}>
          <MiniLabel>{t("attributes")}</MiniLabel>
          <Stack direction="row" spacing={1.25} alignItems="center">
            <Typography variant="caption" color="text.secondary">
              {t("n_fields", { count: attributes.length })}
            </Typography>
            {unAddedFields.length > 0 && attributes.length === 0 && (
              <Typography
                variant="caption"
                color="primary"
                sx={{ cursor: "pointer", "&:hover": { textDecoration: "underline" } }}
                onClick={resetToAllFields}>
                {t("common:add_all_fields")}
              </Typography>
            )}
          </Stack>
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

        {/* + Add attribute — dashed-outline pill */}
        <Box sx={{ pt: 1 }}>
          <Button
            variant="outlined"
            fullWidth
            disabled={unAddedFields.length === 0}
            onClick={(e) => setAddMenuAnchor(e.currentTarget)}
            startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 12 }} />}
            sx={{
              textTransform: "none",
              borderStyle: "dashed",
              borderColor: alpha(theme.palette.primary.main, 0.5),
              color: theme.palette.primary.main,
              py: 0.75,
              "&:hover": {
                borderStyle: "dashed",
                bgcolor: alpha(theme.palette.primary.main, 0.04),
              },
            }}>
            {t("add_attribute")}
          </Button>
          <Menu
            anchorEl={addMenuAnchor}
            open={Boolean(addMenuAnchor)}
            onClose={() => setAddMenuAnchor(null)}
            anchorOrigin={{ vertical: "top", horizontal: "center" }}
            transformOrigin={{ vertical: "bottom", horizontal: "center" }}
            MenuListProps={{
              sx: { width: addMenuAnchor ? addMenuAnchor.offsetWidth - 10 : undefined, p: 0 },
            }}>
            <Box sx={{ maxHeight: 300, overflowY: "auto" }}>
              <ClickAwayListener onClickAway={() => setAddMenuAnchor(null)}>
                <MenuList>
                  <MenuItem
                    onClick={() => {
                      resetToAllFields();
                      setAddMenuAnchor(null);
                    }}>
                    <Typography variant="body2" fontWeight="bold">
                      {t("common:add_all_fields")}
                    </Typography>
                  </MenuItem>
                  {unAddedFields.map((f) => (
                    <MenuItem
                      key={f.name}
                      onClick={() => {
                        addField(f);
                        setAddMenuAnchor(null);
                      }}>
                      <Typography variant="body2">{f.name}</Typography>
                    </MenuItem>
                  ))}
                </MenuList>
              </ClickAwayListener>
            </Box>
          </Menu>
        </Box>
      </Box>

      {/* Collapse after N rows */}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="body2">{t("collapse_after")}</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            type="number"
            size="small"
            value={block.collapse_after ?? ""}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              onChange({
                ...block,
                collapse_after: Number.isFinite(n) && n >= 1 ? n : null,
              });
            }}
            placeholder={t("collapse_after_placeholder")}
            inputProps={{
              style: { textAlign: "right", fontSize: 13, padding: "6px 8px" },
              min: 1,
            }}
            sx={{ width: 76 }}
          />
          <Typography variant="caption" color="text.secondary">
            {t("rows")}
          </Typography>
        </Stack>
      </Stack>

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
    </Stack>
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
