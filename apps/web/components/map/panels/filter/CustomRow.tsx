"use client";

// A part of the saved filter no condition row says (an area, a nested group, a function): "Custom filter" with its
// CQL on hover. It keeps filtering as it was saved; it can be switched off or removed, never edited here.
import { Box, Tooltip, Typography } from "@mui/material";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { CustomRow as CustomRowModel } from "@/lib/filter/model";

import { RowShell } from "@/components/map/panels/filter/RowShell";

/** The CQL the tooltip shows at most: an area can hold thousands of points. */
const SHOWN_CHARS = 1200;

export interface CustomRowProps {
  row: CustomRowModel;
  canEdit: boolean;
  /** Switches the row on or off; no switch without it. */
  onToggle?: (id: string) => void;
  onRemove: (id: string) => void;
}

export const CustomRow = memo(function CustomRow({ row, canEdit, onToggle, onRemove }: CustomRowProps) {
  const { t } = useTranslation("common");
  const cql = useMemo(() => {
    const text = JSON.stringify(row.cql, null, 2) ?? "";
    return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}\n…` : text;
  }, [row.cql]);
  return (
    <RowShell
      id={row.id}
      glyph={<Icon iconName={ICON_NAME.CODE} sx={{ fontSize: 14, color: "text.secondary" }} />}
      off={!row.enabled}
      canEdit={canEdit}
      onToggle={onToggle && (() => onToggle(row.id))}
      onRemove={() => onRemove(row.id)}>
      <Tooltip
        placement="left"
        title={
          <>
            {t("filter_panel.custom_note")}
            <Box
              component="pre"
              sx={{
                m: 0,
                pt: 2,
                fontSize: 11,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                maxHeight: 320,
              }}>
              {cql}
            </Box>
          </>
        }>
        <Typography
          variant="body2"
          fontWeight="bold"
          noWrap
          tabIndex={0}
          sx={{ width: "fit-content", maxWidth: "100%" }}>
          {t("filter_panel.custom")}
        </Typography>
      </Tooltip>
    </RowShell>
  );
});
