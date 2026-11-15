"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { CatalogSpatialFilter } from "@/lib/catalog/spatial";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import CatalogSpatialPicker, { type Mode, modeOf } from "@/components/dashboard/catalog/CatalogSpatialPicker";

/**
 * The spatial filter tool in a dialog: the picker's edits are a draft until applied.
 *
 * Framed as Connect data's open data is (a settings column beside a map that reaches the
 * frame), so choosing an area looks the same wherever GOAT asks for one.
 */

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
      // Wide enough for the fields in one strip and a map that shows a country.
      maxWidth="min(1100px, 94vw)"
      // See AddLayerFrame: a flex item paper must be allowed to shrink below its content.
      paperSx={{ minWidth: 0 }}
      // The picker pads itself: its fields and its framed map share one inset.
      bleed
      footer={
        <AppDialogFooter
          onCancel={onClose}
          primaryLabel={t("apply")}
          onPrimary={() => onApply(canApply ? draft : null)}
          // Enabled when there is a shape to apply, or an existing filter that
          // clearing the draft would remove.
          primaryDisabled={!canApply && !initial}
        />
      }>
      <CatalogSpatialPicker
        mode={mode}
        onModeChange={switchMode}
        value={draft}
        onChange={setDraft}
        onRegionAdded={() => setMode("region")}
        // Distinct from the project map's, which the Add Layer modal opens over.
        mapId="catalog-spatial-dialog"
      />
    </AppDialog>
  );
};

export default CatalogSpatialDialog;
