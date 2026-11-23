import { useTranslation } from "react-i18next";

import type { PopupButtonBlock } from "@/lib/validations/layer";

import { SegmentedRow, TextRow } from "@/components/map/panels/styleEditor/rows";

import { BlockColorRow, type OpenBlockColor } from "./_shared";

interface Props {
  block: PopupButtonBlock;
  onChange: (next: PopupButtonBlock) => void;
  openColor: OpenBlockColor;
}

const DEFAULT_COLOR = "#FFB400";

export function ButtonBlockEditor({ block, onChange, openColor }: Props) {
  const { t } = useTranslation("common");

  return (
    <>
      <TextRow
        label={t("label")}
        value={block.label}
        onChange={(value) => onChange({ ...block, label: value })}
      />
      <TextRow
        label={t("popup_link")}
        placeholder="https://…/{{id}}"
        value={block.url_template}
        note={t("url_template_help")}
        onChange={(value) => onChange({ ...block, url_template: value })}
      />
      <SegmentedRow<PopupButtonBlock["style"]>
        label={t("button_style")}
        value={block.style}
        onChange={(style) => onChange({ ...block, style })}
        options={[
          { value: "link", label: t("style_link") },
          { value: "outlined", label: t("style_outlined") },
          { value: "filled", label: t("style_filled") },
        ]}
      />
      <BlockColorRow<PopupButtonBlock>
        label={t("color")}
        value={block.color || DEFAULT_COLOR}
        openColor={openColor}
        read={(b) => b.color || DEFAULT_COLOR}
        write={(b, color) => ({ ...b, color })}
      />
    </>
  );
}
