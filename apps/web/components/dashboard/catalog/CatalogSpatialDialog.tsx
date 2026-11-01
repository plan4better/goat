"use client";

import { Box, Button, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { CatalogSpatialFilter } from "@/lib/catalog/spatial";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import CatalogSpatialPicker, { type Mode, modeOf } from "@/components/dashboard/catalog/CatalogSpatialPicker";
import SpatialModeSwitch from "@/components/dashboard/catalog/SpatialModeSwitch";

/** The spatial filter tool in a dialog: the picker's edits are a draft until applied. */

const CatalogSpatialDialog = ({
  open,
  initial,
  onClose,
  onApply,
}: {
  open: boolean;
  initial: CatalogSpatialFilter | null;
  onClose: () => void;
  onApply: (filter: CatalogSpatialFilter | null) => void;
}) => {
  const { t } = useTranslation("common");

  const [mode, setMode] = useState<Mode>(() => modeOf(initial));
  const [draft, setDraft] = useState<CatalogSpatialFilter | null>(initial);

  // Reopening the dialog must show what is actually in force, not the draft from the last
  // time it was open; reset while rendering so the picker never mounts on the stale draft.
  const [syncedWith, setSyncedWith] = useState({ open, initial });
  if (syncedWith.open !== open || syncedWith.initial !== initial) {
    setSyncedWith({ open, initial });
    if (open) {
      setMode(modeOf(initial));
      setDraft(initial);
    }
  }

  const switchMode = (next: Mode) => {
    setMode(next);
    // A shape from another mode cannot be reinterpreted, so switching clears it.
    setDraft((current) => (current && modeOf(current) !== next ? null : current));
  };

  const canApply =
    (draft?.kind === "region" && draft.nutsIds.length > 0) ||
    draft?.kind === "point" ||
    (draft?.kind === "polygon" && draft.ring.length >= 3);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      icon={ICON_NAME.GLOBE}
      title={t("catalog_set_spatial_filter")}
      subtitle={t("catalog_spatial_dialog_subtitle")}
      maxWidth={900}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          primaryLabel={t("apply")}
          onPrimary={() => onApply(canApply ? draft : null)}
          // Enabled when there is a shape to apply, or an existing filter that
          // clearing the draft would remove.
          primaryDisabled={!canApply && !initial}
          extra={
            <Button
              onClick={() => setDraft(null)}
              disabled={!draft}
              startIcon={<Icon iconName={ICON_NAME.TRASH} style={{ fontSize: 13 }} />}>
              {t("clear_all")}
            </Button>
          }
        />
      }>
      <CatalogSpatialPicker
        mode={mode}
        value={draft}
        onChange={setDraft}
        onRegionAdded={() => setMode("region")}
        // Distinct from the project map's, which the Add Layer modal opens over.
        mapId="catalog-spatial-dialog"
        modeSwitch={
          <Box>
            <Typography variant="caption" fontWeight={600} color="text.secondary">
              {t("catalog_selection_type")}
            </Typography>
            <SpatialModeSwitch
              value={mode}
              onChange={switchMode}
              modes={[
                { id: "region", label: t("catalog_mode_region"), icon: ICON_NAME.GLOBE },
                { id: "point", label: t("catalog_mode_point"), icon: ICON_NAME.LOCATION },
                { id: "polygon", label: t("catalog_mode_polygon"), icon: ICON_NAME.POLYGON_FEATURE },
              ]}
            />
          </Box>
        }
      />
    </AppDialog>
  );
};

export default CatalogSpatialDialog;
