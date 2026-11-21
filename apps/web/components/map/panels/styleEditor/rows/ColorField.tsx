// A color as one field that opens the color picker: its swatch and its hex, as the other fields that open an editor.
// The color is typed in the picker. A color taken from elsewhere ("Same as fill" on outlines, "Same as line" on
// arrows) shows as text over a hatch.
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { HATCH } from "@/lib/style/editor/summaries";

import { useIsOpener } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ValueButton } from "@/components/map/panels/styleEditor/rows/GroupRow";

export { HATCH };

export interface ColorFieldProps {
  value: string | undefined;
  onOpenPicker: (anchor: HTMLElement) => void;
  /** The value is taken from another part: `label` says which, `shown` whether it is now. */
  sentinel?: { label: string; shown: boolean };
}

export const ColorField = memo(function ColorField({ value, onOpenPicker, sentinel }: ColorFieldProps) {
  const { t } = useTranslation("common");
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const open = useIsOpener(button);
  const showsSentinel = sentinel?.shown ?? false;
  return (
    <ValueButton
      value={showsSentinel ? sentinel?.label : (value?.toUpperCase() ?? "")}
      swatch={{ background: showsSentinel || !value ? HATCH : value }}
      ariaLabel={t("style_editor.pick_color")}
      onOpen={onOpenPicker}
      buttonRef={setButton}
      expanded={open}
      active={open}
    />
  );
});
