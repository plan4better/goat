// The popup's appearance as the style editor's rows: its layout, the corner a pinned popup sits in, its width and
// greatest height (empty for Auto) and its header.
import { useTranslation } from "react-i18next";

import type { PopupProperties } from "@/lib/validations/layer";

import { ChoiceRow, NumberInput, Row } from "@/components/map/panels/styleEditor/rows";

interface Props {
  popup: PopupProperties;
  onChange: (patch: Partial<PopupProperties>) => void;
}

// Phase 1 renders only popup + pinned. modal/sidebar are valid in the schema
// but hidden here until their render slots exist.
const ENABLED_LAYOUTS = ["popup", "pinned"] as const;
const ANCHORS = ["top_left", "top_right", "bottom_left", "bottom_right"] as const;
const HEADERS = ["standard", "compact", "none"] as const;

/** A size in px, or undefined (Auto) for anything but a positive whole number (the schema's constraint). */
const positiveInt = (n: number) => (Number.isInteger(n) && n > 0 ? n : undefined);

/** A size in px that is Auto while empty. */
function SizeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  const { t } = useTranslation("common");
  return (
    <Row label={label}>
      <NumberInput
        value={value}
        unit="px"
        min={1}
        width={96}
        placeholder={t("auto")}
        ariaLabel={label}
        onChange={(n) => onChange(positiveInt(n))}
        onClear={() => onChange(undefined)}
      />
    </Row>
  );
}

export function PopupAppearanceSettings({ popup, onChange }: Props) {
  const { t } = useTranslation("common");
  return (
    <>
      <ChoiceRow<PopupProperties["layout"]>
        label={t("popup_layout")}
        value={popup.layout}
        options={ENABLED_LAYOUTS.map((value) => ({ value, label: t(`popup_layout_${value}`) }))}
        onChange={(layout) => onChange({ layout })}
      />
      {popup.layout === "pinned" && (
        <ChoiceRow<NonNullable<PopupProperties["anchor"]>>
          label={t("anchor")}
          value={popup.anchor ?? "top_right"}
          options={ANCHORS.map((value) => ({ value, label: t(`anchor_${value}`) }))}
          onChange={(anchor) => onChange({ anchor })}
        />
      )}
      <SizeRow label={t("popup_width")} value={popup.width} onChange={(width) => onChange({ width })} />
      <SizeRow
        label={t("popup_max_height")}
        value={popup.max_height}
        onChange={(max_height) => onChange({ max_height })}
      />
      <ChoiceRow<PopupProperties["header"]>
        label={t("popup_header_label")}
        value={popup.header}
        options={HEADERS.map((value) => ({ value, label: t(`popup_header_${value}`) }))}
        onChange={(header) => onChange({ header })}
      />
    </>
  );
}
