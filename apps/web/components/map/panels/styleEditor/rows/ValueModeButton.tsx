// The button right of a property: shows how its value is set and switches it (fixed, by zoom, by attribute, field
// values as they are, by classes; Reset in class scope). It is a field of the row list (FieldButton) with the mode's
// icon and a caret, so it reads as a menu. Every mode looks the same at rest; the button shows as open (the outline of
// an open field) only while its menu is.
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { Mode } from "@/lib/style/editor/forms";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";

import { type DropdownItem, DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { FieldButton } from "@/components/map/panels/styleEditor/rows/FieldButton";

/** A mode, or no value at all (a height part that is off). */
export type ModeChoice = Mode | "none";

/** Attribute and field values can share a menu (colors with a hex field): each keeps its own icon. */
const ICONS: Record<ModeChoice, ICON_NAME> = {
  none: ICON_NAME.MINUS,
  fixed: ICON_NAME.CIRCLE_DOT,
  zoom: ICON_NAME.ZOOM_IN,
  attribute: ICON_NAME.TABLE_COLUMNS,
  raw: ICON_NAME.TABLE,
  classes: ICON_NAME.BULLET_LIST,
};

/** As wide as the icon, the caret and room around them. */
const WIDTH = 40;

export interface ValueModeButtonProps {
  label: string;
  propertyKey: string;
  mode: ModeChoice;
  modes: ModeChoice[];
  /** Called with the mode and the button, for editors that open next to it. */
  onSelect: (mode: ModeChoice, anchor: HTMLElement) => void;
  /** Names and subs of the modes where the property words them its own way (a height's "By attribute"). */
  labels?: Partial<Record<ModeChoice, string>>;
  subs?: Partial<Record<ModeChoice, string>>;
  /** In class scope, when the class overrides the value. */
  onReset?: () => void;
}

export const ValueModeButton = memo(function ValueModeButton({
  label,
  propertyKey,
  mode,
  modes,
  onSelect,
  onReset,
  labels,
  subs,
}: ValueModeButtonProps) {
  const { t } = useTranslation("common");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const cap = CAPABILITIES[propertyKey];
  const sub = (m: ModeChoice) =>
    subs?.[m] ??
    (m === "zoom"
      ? t(cap?.zoom === "step" ? "style_editor.mode_zoom_sub_step" : "style_editor.mode_zoom_sub_blend")
      : m === "attribute"
        ? t(
            cap?.kind === "color"
              ? "style_editor.mode_attribute_sub_color"
              : "style_editor.mode_attribute_sub_number"
          )
        : t(`style_editor.mode_${m}_sub`));
  const name = (m: ModeChoice) => labels?.[m] ?? t(`style_editor.mode_${m}`);
  const items: DropdownItem[] = modes.map((m) => ({
    label: name(m),
    sub: sub(m),
    icon: <Icon iconName={ICONS[m]} sx={{ fontSize: 14 }} />,
    selected: m === mode,
    onClick: () => anchor && onSelect(m, anchor),
  }));
  if (onReset)
    items.push({
      label: t("style_editor.mode_reset"),
      sub: t("style_editor.mode_reset_sub"),
      icon: <Icon iconName={ICON_NAME.UNDO} sx={{ fontSize: 14 }} />,
      onClick: onReset,
    });
  return (
    <>
      <FieldButton
        ariaLabel={t("style_editor.value_mode_aria", { label, mode: name(mode) })}
        expanded={anchor !== null}
        active={anchor !== null}
        onClick={(el) => setAnchor(anchor ? null : el)}
        sx={{
          flex: "none",
          width: WIDTH,
          "& .MuiInputBase-input": {
            justifyContent: "center",
            gap: 1,
            px: 0,
          },
        }}>
        <Icon iconName={ICONS[mode]} sx={{ fontSize: 12 }} />
        <Icon iconName={ICON_NAME.CHEVRON_DOWN} sx={{ fontSize: 10 }} />
      </FieldButton>
      <DropdownMenu anchorEl={anchor} title={label} items={items} onClose={() => setAnchor(null)} />
    </>
  );
});
