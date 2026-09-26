"use client";

import {
  Box,
  Button,
  Divider,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { mutate } from "swr";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { refreshContentFeed } from "@/lib/api/content";
import { FOLDERS_API_BASE_URL, createFolder } from "@/lib/api/folders";
import type { Space } from "@/lib/validations/content";

import AddLayerDialog from "@/components/addLayer/AddLayerDialog";
import NameDialog from "@/components/dashboard/common/NameDialog";
import type { NewProjectIntent } from "@/components/dashboard/common/NewProjectMenu";
import {
  DASHBOARD_MENU_SLOT_PROPS,
  NEW_PROJECT_ITEMS,
  NewProjectFlows,
} from "@/components/dashboard/common/NewProjectMenu";
import DocumentUploadModal from "@/components/modals/DocumentUpload";

interface ContentAddMenuProps {
  /** The folder currently being browsed, if any. */
  folderId: string | null | undefined;
  /** The active space's root folder — where a project/dataset/document lands
   * when nothing more specific is being browsed. */
  homeFolderId: string | undefined;
  /** The active space, so a new folder created at its root lands in that
   * space rather than in the caller's personal one. */
  spaceId: string;
  spaceKind: Space["kind"];
  disabled?: boolean;
  /** Below `md`, the trigger becomes a round 40px `+` icon button instead
   * of the desktop's labelled button. */
  mobile?: boolean;
}

/**
 * The Content page's "Add new" control: one button, one menu (Folder / the
 * three project starts / Dataset / Connect service / Document). Folder asks
 * for a name and nothing else, and so does a blank project; the other two
 * project starts open the template browser and the archive import, all three
 * shared with Home through `NewProjectFlows`. Dataset opens the file-upload
 * dialog straight away, Connect service the dialog that reads a map service's
 * address, and Document its own upload modal. A new folder always
 * nests under whatever is currently being browsed — `folderId` when inside one, the
 * space's true root (`parent_id: null` in `spaceId`) otherwise; a project,
 * dataset or document lands in `folderId` when browsing a folder, or the
 * space's home folder at the root (a space's root is not itself a folder
 * these can be filed in). Until that home folder is known, those entries are
 * disabled rather than silently filing into the caller's personal space.
 */
const ContentAddMenu = ({
  folderId,
  homeFolderId,
  spaceId,
  spaceKind,
  disabled,
  mobile,
}: ContentAddMenuProps) => {
  const { t } = useTranslation("common");
  const buttonRef = useRef<HTMLButtonElement>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [projectIntent, setProjectIntent] = useState<NewProjectIntent | null>(null);
  const [documentOpen, setDocumentOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  const folderParentId = folderId ?? null;
  const targetFolderId = folderId ?? homeFolderId;
  // A space still being provisioned has no root folder to file content in;
  // a folder can still be created there, since its root is `parent_id: null`.
  const rootMissing = spaceKind !== "personal" && !targetFolderId;

  const items: {
    key: string;
    label: string;
    icon: ICON_NAME;
    onSelect: () => void;
    disabled?: boolean;
    /** Opens the group of project starts, set off from the entries above. */
    dividerBefore?: boolean;
    /** Closes it. */
    dividerAfter?: boolean;
  }[] = [
    {
      key: "folder",
      label: t("new_folder"),
      icon: ICON_NAME.FOLDER,
      onSelect: () => setFolderOpen(true),
    },
    ...NEW_PROJECT_ITEMS.map((item, index) => ({
      key: item.key,
      label: t(item.labelKey),
      icon: item.icon,
      onSelect: () => setProjectIntent(item.key),
      disabled: rootMissing,
      dividerBefore: index === 0,
      dividerAfter: index === NEW_PROJECT_ITEMS.length - 1,
    })),
    {
      key: "dataset",
      label: t("dataset"),
      icon: ICON_NAME.LAYERS,
      onSelect: () => setUploadOpen(true),
      disabled: rootMissing,
    },
    {
      key: "connect",
      label: t("connect_service"),
      icon: ICON_NAME.LINK,
      onSelect: () => setConnectOpen(true),
      disabled: rootMissing,
    },
    {
      key: "document",
      label: t("upload_document"),
      icon: ICON_NAME.FILE,
      onSelect: () => setDocumentOpen(true),
      disabled: rootMissing,
    },
  ];

  return (
    <>
      {mobile ? (
        <Tooltip title={t("add_new")}>
          <span>
            <IconButton
              ref={buttonRef}
              disabled={disabled}
              aria-label={t("add_new")}
              onClick={() => setMenuOpen(true)}
              sx={{
                width: 40,
                height: 40,
                bgcolor: "primary.main",
                color: "primary.contrastText",
                "&:hover": { bgcolor: "primary.dark" },
                "&.Mui-disabled": { bgcolor: "action.disabledBackground" },
              }}>
              <Icon iconName={ICON_NAME.PLUS} fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      ) : (
        <Button
          ref={buttonRef}
          variant="contained"
          disabled={disabled}
          aria-label={t("add_new")}
          startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 16 }} />}
          onClick={() => setMenuOpen(true)}
          sx={{
            height: 38,
            px: "18px",
            borderRadius: "999px",
            fontSize: 14,
            fontWeight: 700,
            textTransform: "none",
            flexShrink: 0,
            boxShadow: (theme) => theme.shadows[1],
            "&:hover": { boxShadow: (theme) => theme.shadows[1] },
          }}>
          {t("add_new")}
        </Button>
      )}

      <Menu
        anchorEl={buttonRef.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        slotProps={DASHBOARD_MENU_SLOT_PROPS}>
        {items.flatMap((item) => [
          // Direct children of `Menu`: `MenuList` clones its own children to
          // drive arrow-key navigation and typeahead, so a wrapper element in
          // between would take those away — which is why the dividers are
          // siblings rather than a nested group. A disabled entry explains
          // itself with a caption under its label instead of a tooltip.
          ...(item.dividerBefore ? [<Divider key={`${item.key}-before`} />] : []),
          <MenuItem
            key={item.key}
            disabled={item.disabled}
            onClick={() => {
              setMenuOpen(false);
              item.onSelect();
            }}>
            <ListItemIcon sx={{ minWidth: 30 }}>
              <Icon iconName={item.icon} style={{ fontSize: 15 }} />
            </ListItemIcon>
            <Box>
              <Typography variant="body2">{item.label}</Typography>
              {item.disabled && (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  {t("space_not_ready")}
                </Typography>
              )}
            </Box>
          </MenuItem>,
          ...(item.dividerAfter ? [<Divider key={`${item.key}-after`} />] : []),
        ])}
      </Menu>

      {folderOpen && (
        <NameDialog
          title={t("new_folder")}
          icon={ICON_NAME.FOLDER}
          placeholder={t("folder_name_placeholder")}
          cta={t("create_folder")}
          onClose={() => setFolderOpen(false)}
          onSubmit={async (name) => {
            try {
              await createFolder(name, folderParentId, spaceId);
            } catch {
              throw new Error(t("error_creating_folder"));
            }
            // The folder tree feeds the breadcrumb, the move dialog and the
            // spaces panel, so both caches are revalidated.
            void mutate((key) => Array.isArray(key) && key[0] === FOLDERS_API_BASE_URL);
            refreshContentFeed();
            toast.success(t("created_successfully"));
            setFolderOpen(false);
          }}
        />
      )}

      <NewProjectFlows
        intent={projectIntent}
        onClose={() => setProjectIntent(null)}
        location={{ spaceId, folderId: targetFolderId }}
      />

      {/* The two sources that need a folder rather than a project: a file
       * upload ("Dataset") and a map service. Mounted only while open,
       * because both flows resolve their starting folder once, at mount, and
       * never re-read `defaultFolderId`; a fresh instance per open picks up
       * whatever folder is being browsed now. Catalog and Create belong to
       * the map builder, where a layer is added to a project. */}
      {uploadOpen && (
        <AddLayerDialog
          source="upload"
          defaultFolderId={targetFolderId}
          onClose={() => {
            setUploadOpen(false);
            refreshContentFeed();
          }}
        />
      )}

      {connectOpen && (
        <AddLayerDialog
          source="connect"
          defaultFolderId={targetFolderId}
          onClose={() => {
            setConnectOpen(false);
            refreshContentFeed();
          }}
        />
      )}

      <DocumentUploadModal
        open={documentOpen}
        onClose={() => setDocumentOpen(false)}
        defaultFolderId={targetFolderId}
        onSuccess={refreshContentFeed}
      />
    </>
  );
};

export default ContentAddMenu;
