"use client";

import { Divider, Menu } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { type ICON_NAME } from "@p4b/ui/components/Icon";

import AddLayerDialog from "@/components/addLayer/AddLayerDialog";
import { ADD_LAYER_GROUPS, type AddLayerSourceId, sourcesFor } from "@/components/addLayer/sources";
import { MenuHeading, MenuRow } from "@/components/common/MenuRow";

/**
 * Where a layer comes from: a menu of sources, and the dialog the chosen one opens.
 *
 * The entry point for every source, so a host writes a button and this. Sources are not
 * peers in weight — a file upload is a short form, the catalog is a search over thousands
 * of collections — and a menu says that plainly: you pick before anything opens, and what
 * opens is sized for the one job. A tab bar instead promised interchangeable views and made
 * one frame morph between two widths.
 *
 * The trigger stays with the host: the layer panel's is a full-width button in a sidebar
 * and the datasets page's sits in a toolbar, and neither should be this component's
 * business.
 */
const AddLayerMenu = ({
  anchorEl,
  onClose,
  projectId,
  defaultFolderId,
  sources: allowed,
  placement = "bottom",
  extra,
  onSourceClose,
}: {
  /** The trigger; the menu is open whenever this is set. */
  anchorEl: HTMLElement | null;
  onClose: () => void;
  projectId?: string;
  defaultFolderId?: string;
  /** Restricts the sources offered; by default every one the host supports. */
  sources?: AddLayerSourceId[];
  /** `top` opens the menu above the trigger, for a button near the foot of a panel. */
  placement?: "top" | "bottom";
  /**
   * Entries that are not layer sources but belong in the same menu — a document upload on
   * the datasets page, which is not a dataset and has nothing to do with these flows.
   */
  extra?: { key: string; label: string; icon: ICON_NAME; onSelect: () => void }[];
  /**
   * Called when a source's dialog closes, whether or not anything was added: a host showing
   * what a source adds to — the datasets list — revalidates here.
   */
  onSourceClose?: () => void;
}) => {
  const { t } = useTranslation("common");
  const [openSource, setOpenSource] = useState<AddLayerSourceId | null>(null);

  const sources = sourcesFor({ hasProject: !!projectId }).filter(
    (entry) => !allowed || allowed.includes(entry.id)
  );

  /**
   * The entries, in their groups, with empty groups dropped.
   *
   * Extras join the first group: a document is new data by the only measure this menu
   * sorts by, whatever else it is not.
   */
  const groups = ADD_LAYER_GROUPS.map((group) => ({
    ...group,
    items: [
      ...sources
        .filter((source) => source.group === group.id)
        .map((source) => ({
          key: source.id,
          label: t(source.labelKey),
          icon: source.icon,
          onSelect: () => setOpenSource(source.id),
        })),
      ...(group.id === "new" ? (extra ?? []) : []),
    ],
  })).filter((group) => group.items.length > 0);

  // A heading over the only group would label the menu rather than divide it: the datasets
  // page offers one group, and there "Add new data" says no more than the button did.
  const showHeadings = groups.length > 1;

  return (
    <>
      <Menu
        anchorEl={anchorEl}
        open={!!anchorEl}
        onClose={onClose}
        // The width belongs to the paper, not to the list inside it: as a `minWidth` on the
        // list the paper kept its own shrink-to-fit width and the list overflowed it.
        sx={{
          "& .MuiPaper-root": {
            width: 260,
            maxWidth: "calc(100vw - 32px)",
          },
        }}
        anchorOrigin={{ vertical: placement === "top" ? "top" : "bottom", horizontal: "center" }}
        transformOrigin={{ vertical: placement === "top" ? "bottom" : -5, horizontal: "center" }}>
        {groups.flatMap((group, index) => [
          index > 0 ? <Divider key={`divider-${group.id}`} sx={{ my: "4px" }} /> : null,
          showHeadings ? <MenuHeading key={`heading-${group.id}`}>{t(group.labelKey)}</MenuHeading> : null,
          ...group.items.map((item) => (
            <MenuRow
              key={item.key}
              icon={item.icon}
              label={item.label}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            />
          )),
        ])}
      </Menu>

      <AddLayerDialog
        source={openSource}
        projectId={projectId}
        defaultFolderId={defaultFolderId}
        onClose={() => {
          setOpenSource(null);
          onSourceClose?.();
        }}
      />
    </>
  );
};

export default AddLayerMenu;
