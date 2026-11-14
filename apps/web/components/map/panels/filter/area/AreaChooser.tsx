"use client";

// The area picker as a dialog shows it (the fetch dialog, the catalog's location filter): in place in the dialog's
// column, with the list of regions or features opening under it, as a dialog has no room beside its column, and the
// shape being drawn on the dialog's map said under it.
import { Box, IconButton, Typography } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { AreaDrawing } from "@/components/map/panels/filter/area/AreaNote";
import {
  AreaList,
  type AreaLists,
  AreaPickerContent,
  listTitle,
} from "@/components/map/panels/filter/area/AreaPicker";
import { useAreaTools } from "@/components/map/panels/filter/area/AreaTools";

export function AreaChooser({ emptyText }: { emptyText: string }) {
  const { t } = useTranslation("common");
  const { layers } = useAreaTools();
  const [open, setOpen] = useState<string | null>(null);
  const lists = useMemo<AreaLists>(
    () => ({
      open,
      show: (source) => setOpen(source),
      toggle: (source) => setOpen((now) => (now === source ? null : source)),
      close: (source) => setOpen((now) => (now === source ? null : now)),
    }),
    [open]
  );
  const title = open ? listTitle(open, layers, t) : "";
  return (
    <Box>
      <AreaPickerContent lists={lists} emptyText={emptyText} />
      <AreaDrawing />
      {open && (
        <Box
          component="section"
          aria-label={title}
          sx={{ mt: 2, mx: 2, border: 1, borderColor: "divider", borderRadius: 2, pb: 2 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, pl: 3, pr: 1, pt: 1.5 }}>
            <Typography variant="body2" fontWeight="bold" noWrap sx={{ flex: 1, minWidth: 0 }}>
              {title}
            </Typography>
            <IconButton size="small" aria-label={t("style_editor.close")} onClick={() => setOpen(null)}>
              <Icon iconName={ICON_NAME.CLOSE} sx={{ fontSize: 12 }} />
            </IconButton>
          </Box>
          <AreaList source={open} />
        </Box>
      )}
    </Box>
  );
}
