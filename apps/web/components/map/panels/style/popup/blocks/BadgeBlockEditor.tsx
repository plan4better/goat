import { Box, IconButton, Typography } from "@mui/material";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { PopupBadgeBlock } from "@/lib/validations/layer";

import { LayerValueSelectorPopper } from "@/components/map/panels/style/other/LayerValueSelectorPopper";
import { useStyleData } from "@/components/map/panels/styleEditor/context";
import { FieldPickerButton } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import {
  AddButton,
  ColorField,
  Row,
  SegmentedRow,
  SwitchRow,
} from "@/components/map/panels/styleEditor/rows";

import { BlockColorRow, type OpenBlockColor } from "./_shared";

interface Props {
  block: PopupBadgeBlock;
  layerId: string;
  onChange: (next: PopupBadgeBlock) => void;
  openColor: OpenBlockColor;
}

const DEFAULT_COLOR = "#56CA00";
const FALLBACK_COLOR = "#8A8D93";

export function BadgeBlockEditor({ block, layerId, onChange, openColor }: Props) {
  const { t } = useTranslation("common");
  const { fields } = useStyleData();
  const field = fields.find((f) => f.name === block.field);

  return (
    <>
      {/* Categorical badge values come from text fields: numbers and dates don't fit a label chip. */}
      <Row label={t("badge_field")}>
        <FieldPickerButton
          ariaLabel={t("badge_field")}
          text={field?.label ?? t("style_editor.pick_field")}
          fields={fields}
          filter="text"
          value={block.field}
          onChange={(name) => onChange({ ...block, field: name })}
        />
      </Row>
      <SegmentedRow<PopupBadgeBlock["mode"]>
        label={t("color_mode")}
        value={block.mode}
        onChange={(mode) => onChange({ ...block, mode })}
        options={[
          { value: "single", label: t("single_color") },
          { value: "per_value", label: t("by_value") },
        ]}
      />
      {block.mode === "single" ? (
        <BlockColorRow<PopupBadgeBlock>
          label={t("color")}
          value={block.color || DEFAULT_COLOR}
          openColor={openColor}
          read={(b) => b.color || DEFAULT_COLOR}
          write={(b, color) => ({ ...b, color })}
        />
      ) : (
        <PerValuePalette
          layerId={layerId}
          fieldName={field ? block.field : ""}
          palette={block.palette}
          openColor={openColor}
          onRemove={(key) => {
            const next = { ...block.palette };
            delete next[key];
            onChange({ ...block, palette: next });
          }}
          onAddValues={(values) => {
            const next = { ...block.palette };
            for (const v of values) {
              if (!next[v]) next[v] = FALLBACK_COLOR;
            }
            onChange({ ...block, palette: next });
          }}
        />
      )}
      <SwitchRow
        label={t("full_width")}
        on={block.full_width}
        onToggle={() => onChange({ ...block, full_width: !block.full_width })}
      />
    </>
  );
}

/** A color per value: a row per value (its color in the field, removed with the button beside it), then "Add value"
 * with the layer's values to pick from. */
function PerValuePalette({
  layerId,
  fieldName,
  palette,
  openColor,
  onRemove,
  onAddValues,
}: {
  layerId: string;
  fieldName: string;
  palette: Record<string, string>;
  openColor: OpenBlockColor;
  onRemove: (key: string) => void;
  onAddValues: (values: string[]) => void;
}) {
  const { t } = useTranslation("common");
  const entries = Object.entries(palette);
  const addButtonRef = useRef<HTMLElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Local selection inside the popper — what the user is currently
  // ticking. Committed to the palette in onDone (with the fallback
  // color). Kept separate from `palette` so closing the picker without
  // pressing Done discards the in-progress selection.
  const [pickerValues, setPickerValues] = useState<string[] | null>(null);

  const handleDone = () => {
    if (pickerValues && pickerValues.length > 0) {
      onAddValues(pickerValues);
    }
    setPickerValues(null);
    setPickerOpen(false);
  };

  return (
    <>
      {entries.length === 0 ? (
        <Row label={t("value_colors")}>
          <Typography variant="caption" color="text.secondary">
            {t("badge_no_values_yet")}
          </Typography>
        </Row>
      ) : (
        entries.map(([value, color]) => (
          <Row
            key={value}
            label={<span title={value}>{value}</span>}
            actions={
              <IconButton
                size="small"
                aria-label={t("style_editor.remove_value", { value })}
                onClick={() => onRemove(value)}>
                <Icon iconName={ICON_NAME.CLOSE} sx={{ fontSize: 12 }} />
              </IconButton>
            }>
            <ColorField
              value={color}
              onOpenPicker={(anchor) =>
                openColor<PopupBadgeBlock>(
                  anchor,
                  value,
                  (b) => b.palette[value] ?? color,
                  (b, hex) => ({ ...b, palette: { ...b.palette, [value]: hex } })
                )
              }
            />
          </Row>
        ))
      )}
      {/* Under the last value, its plus on the content's edge. */}
      <Box sx={{ px: 3 }}>
        <Box ref={addButtonRef} component="span" sx={{ display: "inline-flex" }}>
          <AddButton
            disabled={!fieldName}
            onClick={() => {
              setPickerValues(null);
              setPickerOpen(true);
            }}
            sx={{ ml: -2.5 }}>
            {t("add_value")}
          </AddButton>
        </Box>
      </Box>

      {pickerOpen && (
        <LayerValueSelectorPopper
          open={pickerOpen}
          layerId={layerId}
          fieldName={fieldName}
          selectedValues={pickerValues}
          onSelectedValuesChange={setPickerValues}
          anchorEl={addButtonRef.current}
          onDone={handleDone}
          // Drop the popper directly below the Add value button so it
          // sits inside / under the badge edit panel instead of flying
          // across the screen (the default offset is tuned for the wide
          // style panel).
          placement="bottom-start"
          offset={[0, 4]}
        />
      )}
    </>
  );
}
