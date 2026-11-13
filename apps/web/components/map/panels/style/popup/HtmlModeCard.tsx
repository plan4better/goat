// The popup's own HTML as a row of the style editor: its size in the field, which opens the HTML editor.
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { PopupProperties } from "@/lib/validations/layer";

import { NavRow } from "@/components/map/panels/styleEditor/rows";

import { HtmlEditorDialog } from "./HtmlEditorDialog";

interface Props {
  layerId: string;
  layerName: string;
  layerIcon?: ReactNode;
  popup: PopupProperties;
  onChange: (patch: Partial<PopupProperties>) => void;
}

export function HtmlModeCard({ layerId, layerName, layerIcon, popup, onChange }: Props) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);

  const stats = useMemo(() => {
    const html = popup.html ?? "";
    return { lines: html ? html.split("\n").length : 0, chars: html.length };
  }, [popup.html]);

  return (
    <>
      <NavRow
        label={t("popup_mode_html")}
        value={t("html_lines_chars", { lines: stats.lines, chars: stats.chars })}
        glyph={<Icon iconName={ICON_NAME.CODE} sx={{ fontSize: 14, color: "text.secondary" }} />}
        onOpen={() => setOpen(true)}
      />

      {/* Conditionally mounted so HtmlEditorDialog's draft useState re-seeds
          from the current popup.html on every open (no stale draft). */}
      {open && (
        <HtmlEditorDialog
          open
          layerId={layerId}
          layerName={layerName}
          layerIcon={layerIcon}
          popup={popup}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
