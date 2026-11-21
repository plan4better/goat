import { useTranslation } from "react-i18next";

import type { PopupDividerBlock } from "@/lib/validations/layer";

import { SliderRow } from "@/components/map/panels/styleEditor/rows";

import { BlockColorRow, type OpenBlockColor } from "./_shared";

interface Props {
  block: PopupDividerBlock;
  onChange: (next: PopupDividerBlock) => void;
  openColor: OpenBlockColor;
}

// Neutral hairline used when the user hasn't picked a color. Matches the
// muted look of MUI's default divider in both light and dark themes
// without us having to read the theme here.
const DEFAULT_PREVIEW_COLOR = "#C4C4C4";

export function DividerBlockEditor({ block, onChange, openColor }: Props) {
  const { t } = useTranslation("common");

  return (
    <>
      <SliderRow
        label={t("thickness")}
        min={1}
        max={8}
        step={1}
        unit="px"
        value={block.thickness}
        onChange={(thickness) => onChange({ ...block, thickness })}
      />
      <BlockColorRow<PopupDividerBlock>
        label={t("color")}
        value={block.color || DEFAULT_PREVIEW_COLOR}
        openColor={openColor}
        read={(b) => b.color || DEFAULT_PREVIEW_COLOR}
        write={(b, color) => ({ ...b, color })}
      />
    </>
  );
}
