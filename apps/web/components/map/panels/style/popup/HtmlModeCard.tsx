// The popup's own HTML as a row of the style editor: its size in the field, which opens the HTML editor. Its Save sends
// the HTML at once and closes the editor when the save is answered; an HTML the server takes back (an error at its path)
// keeps the editor open with the draft and the server's issue.
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { issueTarget } from "@/lib/style/editor/issues";
import type { PopupProperties } from "@/lib/validations/layer";

import { useIssueAt } from "@/components/map/panels/styleEditor/IssueNotice";
import { useEditor } from "@/components/map/panels/styleEditor/context";
import { NavRow } from "@/components/map/panels/styleEditor/rows";
import type { LayerField } from "@/components/map/popover/formatFeatureProperties";

import { HtmlEditorDialog } from "./HtmlEditorDialog";

interface Props {
  layerId: string;
  layerName: string;
  layerIcon?: ReactNode;
  popup: PopupProperties;
  onChange: (patch: Partial<PopupProperties>) => void;
  /** The fields to offer, where the layer's dataset has none to ask for (a raster file's cell). */
  fields?: LayerField[];
}

const HTML_PATH = "popup.html";

export function HtmlModeCard({ layerId, layerName, layerIcon, popup, onChange, fields }: Props) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const issues = useIssueAt(HTML_PATH);
  const [open, setOpen] = useState(false);
  // The HTML the editor saved, until the save is answered.
  const [applied, setApplied] = useState<string | null>(null);

  useEffect(() => {
    if (applied === null) return;
    const saver = store.saver;
    const settle = () => {
      if (saver.status === "saving") return;
      const refused =
        store.get(HTML_PATH) !== applied &&
        saver.issues.some(
          (issue) => issue.level === "error" && issueTarget(store.document, issue.path)?.path === HTML_PATH
        );
      setApplied(null);
      if (!refused) setOpen(false);
    };
    const stop = saver.subscribe(settle);
    settle();
    return stop;
  }, [applied, store]);

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
          fields={fields}
          onClose={() => setOpen(false)}
          onSave={(html) => {
            onChange({ html });
            store.saver.saveNow();
            setApplied(html);
          }}
          saving={applied !== null}
          issues={issues}
        />
      )}
    </>
  );
}
