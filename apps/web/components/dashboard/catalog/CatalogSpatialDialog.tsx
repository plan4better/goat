"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { CatalogSpatialFilter } from "@/lib/catalog/spatial";
import type { FilterArea } from "@/lib/filter/area";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import CatalogSpatialPicker from "@/components/dashboard/catalog/CatalogSpatialPicker";
import { choicesOf, newestAlone, useChoicePieces } from "@/components/map/panels/filter/area/choices";
import type { AreaHost, AreaMap, AreaWay } from "@/components/map/panels/filter/area/host";

/**
 * The spatial filter tool in a dialog: the area picker's edits are a draft until applied.
 *
 * Framed as Connect data's open data is (the picker in a column beside a map that reaches the
 * frame), so choosing an area looks the same wherever GOAT asks for one.
 */

const CATALOG_WAYS: readonly AreaWay[] = ["polygon", "point", "regions"];
// Distinct from the project map's, which the Add Layer modal opens over.
const CATALOG_MAP: AreaMap = { id: "catalog-spatial-dialog", main: false };

/** The draft as the filter it applies: its one piece, regions, a point or a polygon. */
const filterOf = (area: FilterArea | undefined): CatalogSpatialFilter | null => {
  const choice = area && choicesOf(area)?.[0];
  return choice && choice.kind !== "view" ? choice : null;
};

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

  const [draft, setDraft] = useState<FilterArea | undefined>();
  // The draft as of now, for the picker: an outline that loaded joins this one.
  const latest = useRef(draft);
  const put = useCallback((next: FilterArea | undefined) => {
    latest.current = next;
    setDraft(next);
  }, []);

  // Reopening the dialog must show what is actually in force, not the draft from the last time
  // it was open; reset while rendering so the picker never shows the stale draft. A region in
  // force is shown once its outline has loaded; the filter keeps it by id even without one.
  const choices = useMemo(() => (open && initial ? [initial] : undefined), [open, initial]);
  const seeded = useChoicePieces(choices, true);
  const [syncedWith, setSyncedWith] = useState<{ open: boolean; initial: CatalogSpatialFilter | null }>();
  if (syncedWith?.open !== open || syncedWith.initial !== initial) {
    if (!open) setSyncedWith({ open, initial });
    else if (!initial || seeded.pieces) {
      setSyncedWith({ open, initial });
      put(seeded.pieces && { pieces: seeded.pieces, op: "inside", enabled: true });
    }
  }

  const setArea = useCallback(
    (next: FilterArea | undefined) => put(newestAlone(next, latest.current)),
    [put]
  );
  const read = useCallback(() => latest.current, []);
  const host = useMemo<AreaHost>(
    () => ({ area: draft, read, setArea, ops: false, ways: CATALOG_WAYS, map: CATALOG_MAP }),
    [draft, read, setArea]
  );
  const filter = filterOf(draft);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      icon={ICON_NAME.GLOBE}
      title={t("catalog_set_spatial_filter")}
      // Wide enough for the picker's column and a map that shows a country.
      maxWidth="min(1100px, 94vw)"
      // See AddLayerFrame: a flex item paper must be allowed to shrink below its content.
      paperSx={{ minWidth: 0 }}
      // The picker pads itself: its column and its framed map share one inset.
      bleed
      footer={
        <AppDialogFooter
          onCancel={onClose}
          primaryLabel={t("apply")}
          onPrimary={() => onApply(filter)}
          // Enabled when there is an area to apply, or an existing filter that removing the
          // draft's pieces would clear.
          primaryDisabled={!filter && !initial}
        />
      }>
      <CatalogSpatialPicker host={host} />
    </AppDialog>
  );
};

export default CatalogSpatialDialog;
