import { Box, Button } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { Editor } from "@tiptap/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PopupTextBlock } from "@/lib/validations/layer";

import FieldChip from "@/lib/extensions/field-chip";

import {
  DEFAULT_INLINE_EXTENSIONS,
  InlineRichTextEditor,
} from "@/components/common/InlineRichTextEditor";
import { useStyleData } from "@/components/map/panels/styleEditor/context";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";

interface Props {
  block: PopupTextBlock;
  onChange: (next: PopupTextBlock) => void;
}

export function TextBlockEditor({ block, onChange }: Props) {
  const { t } = useTranslation("common");
  const { fields } = useStyleData();
  const [fieldMenu, setFieldMenu] = useState<HTMLElement | null>(null);

  // Spread the editor's default extensions so toolbar commands (color,
  // font size, link, etc.) stay registered, then add FieldChip on top
  // for `{{field}}` token insertion.
  const extensions = useMemo(
    () => [...DEFAULT_INLINE_EXTENSIONS, FieldChip],
    [],
  );

  // "Insert field" as the label template's: a text button opening the app's field list.
  const renderInsertField = (editor: Editor) => (
    <>
      <Button
        variant="text"
        size="small"
        color="inherit"
        aria-haspopup="listbox"
        aria-expanded={fieldMenu !== null}
        onClick={(e) => setFieldMenu(fieldMenu ? null : e.currentTarget)}>
        {t("style_editor.insert_field")}
      </Button>
      <FieldPicker
        anchorEl={fieldMenu}
        onClose={() => setFieldMenu(null)}
        title={t("style_editor.insert_field")}
        placement="bottom-start"
        fields={fields}
        onChange={(name) => editor.chain().focus().insertField(name).run()}
      />
    </>
  );

  return (
    // The rows' inset, so the editor lines up with the rows of the other blocks.
    <Box sx={{ px: 3 }}>
      <InlineRichTextEditor
        value={block.html}
        onChange={(html) => onChange({ ...block, html })}
        extensions={extensions}
        toolbarExtras={renderInsertField}
        contentSx={(theme) => ({
          // Pill-shaped field chip — primary-tinted, monospaced, sized to
          // read as a token inside running text.
          "& .field-chip": {
            display: "inline-block",
            px: 0.875,
            mx: 0.25,
            bgcolor: alpha(theme.palette.primary.main, 0.14),
            color: "primary.main",
            borderRadius: 1,
            fontSize: "0.9em",
            fontWeight: "bold",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            lineHeight: 1.5,
          },
        })}
      />
    </Box>
  );
}
