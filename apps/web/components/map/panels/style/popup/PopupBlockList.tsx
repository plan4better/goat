// The popup's blocks as the style editor lists rules: a row per block (its kind's icon and name in the field, opening
// its editor), moved up and down with the arrows beside it, removed from its editor's header; "Add block" opens the
// panel's menu of block kinds.
import { Box, IconButton } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { v4 } from "uuid";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { PopupBlock } from "@/lib/validations/layer";

import { DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { AddButton, NavRow } from "@/components/map/panels/styleEditor/rows";

interface BlockTypeMeta {
  value: PopupBlock["type"];
  label: string; // i18n key
  icon: ICON_NAME;
}

// Icons chosen from the available ICON_NAME enum
// (packages/js/ui/components/Icon.tsx).
const BLOCK_TYPES: BlockTypeMeta[] = [
  { value: "text", label: "text_block", icon: ICON_NAME.TEXT },
  { value: "fieldList", label: "field_list", icon: ICON_NAME.LIST },
  { value: "image", label: "image", icon: ICON_NAME.IMAGE },
  { value: "button", label: "button_block", icon: ICON_NAME.LINK },
  { value: "badge", label: "badge_block", icon: ICON_NAME.DATA_CATEGORY },
  { value: "divider", label: "divider_block", icon: ICON_NAME.DIVIDER },
];

/** `buttonLabel` is the default text of a new button block, in the editor's
 * language: it is stored with the block and shown to every popup reader. */
function makeBlock(type: PopupBlock["type"], buttonLabel: string): PopupBlock {
  const id = v4();
  switch (type) {
    case "text":
      return { id, type, html: "" };
    case "fieldList":
      return { id, type, layout: "table", attributes: [], collapse_after: null };
    case "image":
      return {
        id,
        type,
        source: "field",
        sizing: "fixed",
        height: 140,
        aspect: "16/9",
      };
    case "button":
      return { id, type, label: buttonLabel, url_template: "", style: "link" };
    case "badge":
      // `field` is required (.min(1)); user must replace this placeholder
      // before save in the block edit popper.
      return {
        id,
        type,
        field: "placeholder",
        mode: "single",
        palette: {},
        full_width: false,
      };
    case "divider":
      return { id, type, thickness: 1 };
  }
}

interface PopupBlockListProps {
  blocks: PopupBlock[];
  onChange: (next: PopupBlock[]) => void;
  onEdit: (block: PopupBlock, anchorEl: HTMLElement) => void;
}

export function PopupBlockList({ blocks, onChange, onEdit }: PopupBlockListProps) {
  const { t } = useTranslation("common");
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const move = (from: number, to: number) => {
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  return (
    <>
      {blocks.map((block, index) => {
        const meta = BLOCK_TYPES.find((bt) => bt.value === block.type)!;
        return (
          <Box key={block.id} data-block-row>
            <NavRow
              value={t(meta.label)}
              glyph={<Icon iconName={meta.icon} sx={{ fontSize: 14, color: "text.secondary" }} />}
              onOpen={(anchor) => onEdit(block, anchor)}
              // Both moves on every row of a list (the ends disabled), as the rules have them.
              actions={
                blocks.length > 1 && (
                  <>
                    <IconButton
                      size="small"
                      disabled={index === 0}
                      aria-label={t("style_editor.move_rule_up")}
                      onClick={() => move(index, index - 1)}>
                      <Icon iconName={ICON_NAME.CHEVRON_UP} sx={{ fontSize: 10 }} />
                    </IconButton>
                    <IconButton
                      size="small"
                      disabled={index === blocks.length - 1}
                      aria-label={t("style_editor.move_rule_down")}
                      onClick={() => move(index, index + 1)}>
                      <Icon iconName={ICON_NAME.CHEVRON_DOWN} sx={{ fontSize: 10 }} />
                    </IconButton>
                  </>
                )
              }
            />
          </Box>
        );
      })}
      {/* Under the last block, its plus on the content's edge. */}
      <Box sx={{ px: 3, pt: blocks.length ? 1 : 0 }}>
        <AddButton
          onClick={(event) => setMenuAnchor(menuAnchor ? null : event.currentTarget)}
          sx={{ ml: -2.5 }}>
          {t("add_block")}
        </AddButton>
      </Box>
      <DropdownMenu
        anchorEl={menuAnchor}
        placement="bottom-start"
        items={BLOCK_TYPES.map((bt) => ({
          label: t(bt.label),
          icon: bt.icon,
          onClick: () => onChange([...blocks, makeBlock(bt.value, t("open"))]),
        }))}
        onClose={() => setMenuAnchor(null)}
      />
    </>
  );
}
