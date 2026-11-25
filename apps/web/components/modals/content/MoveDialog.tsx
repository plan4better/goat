"use client";

import { LoadingButton } from "@mui/lab";
import { Box, Button, Dialog, Typography, useMediaQuery, useTheme } from "@mui/material";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { updateBundle } from "@/lib/api/bundles";
import { refreshContentFeed } from "@/lib/api/content";
import { updateFolder } from "@/lib/api/folders";
import { updateDataset } from "@/lib/api/layers";
import { updateProject } from "@/lib/api/projects";
import { refreshTemplates, updateTemplate } from "@/lib/api/templates";
import { spaceDisplayName } from "@/lib/utils/content";
import type { ContentItem, Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";

import FolderBrowser, { childrenOf } from "@/components/dashboard/common/FolderBrowser";
import { ContentDialogHeader, contentDialogPaperSx } from "@/components/modals/content/ContentDialogChrome";

const MAX_FOLDER_DEPTH = 2;

interface MoveDialogProps {
  items: ContentItem[];
  space: Space;
  folders: Folder[];
  /** The space's `home` folder id — the fallback `folder_id` for a
   * project/layer/bundle moved to the space root (folders themselves use
   * `parent_id: null` for the root instead). Undefined while the space's
   * root folder is unknown, which is what disables "Move here" at the root
   * for anything but a folder. */
  homeFolderId: string | undefined;
  onClose: () => void;
  /** Called once the move has actually happened, before `onClose` — the
   * page uses it to clear the selection the same way `ContentDeleteDialog`'s
   * `onDeleted` does. */
  onMoved: () => void;
}

/** How many levels deep a folder's own subtree goes: 0 for a leaf, 1 if it
 * has children only, etc. Used to keep a moved folder's descendants from
 * landing past the three allowed levels. */
const subtreeHeight = (folderId: string, folders: Folder[]): number => {
  const children = childrenOf(folderId, folders);
  if (children.length === 0) return 0;
  return 1 + Math.max(...children.map((child) => subtreeHeight(child.id, folders)));
};

/** A folder's own id plus every descendant's id — what the dialog must hide
 * from the folder list so a folder being moved can't be navigated into or
 * dropped on itself. Exported so the page's drag-and-drop drop handlers can
 * apply the same exclusion to a folder card/row that isn't hidden from view
 * the way the dialog's own list is. */
export const withDescendants = (folderId: string, folders: Folder[]): Set<string> => {
  const ids = new Set<string>([folderId]);
  const stack = [folderId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const child of childrenOf(current, folders)) {
      if (!ids.has(child.id)) {
        ids.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return ids;
};

const moveOne = async (
  item: ContentItem,
  targetFolderId: string | null,
  homeFolderId: string | undefined
): Promise<void> => {
  if (item.type === "folder") {
    await updateFolder(item.id, { parent_id: targetFolderId });
    return;
  }
  // `folder_id` is NOT NULL for a project/layer/bundle, so the space root
  // means its `home` folder; without that id there is nothing valid to send.
  const folderId = targetFolderId ?? homeFolderId;
  if (!folderId) throw new Error("The space root folder is unknown");
  // Every content type gets its own endpoint here: a `default` branch would
  // send a new type's id to whichever endpoint happened to be last.
  switch (item.type) {
    case "project":
      await updateProject(item.id, { folder_id: folderId });
      return;
    case "layer":
      await updateDataset(item.id, { folder_id: folderId });
      return;
    case "bundle":
      await updateBundle(item.id, { folder_id: folderId });
      return;
    case "template":
      await updateTemplate(item.id, { folder_id: folderId });
      return;
  }
};

/** Moves every item to `targetFolderId` (`null` = space root), sequentially
 * so one item's failure never leaves a later one unattempted. Shared by
 * `MoveDialog`'s `move_here` button and the page's drag-and-drop drop
 * handlers — both then do their own `refreshContentFeed`/toast/selection
 * clearing around it. */
export const moveContentItems = async (
  items: ContentItem[],
  targetFolderId: string | null,
  homeFolderId: string | undefined
): Promise<void> => {
  for (const item of items) {
    await moveOne(item, targetFolderId, homeFolderId);
  }
  // The template lists (Home band, browser, Catalog tab) have their own SWR
  // keys, which `refreshContentFeed` does not match.
  if (items.some((item) => item.type === "template")) refreshTemplates();
};

/** Whether moving `movingItems` (the folders among them) to `targetFolderId`
 * would push any moved folder's own subtree past the three allowed depth
 * levels — the same guard `MoveDialog`'s `move_here` button disables on,
 * reused by the page's drag-and-drop drop handlers so a drop can't do what
 * the dialog itself would refuse. */
export const folderDepthViolation = (
  movingItems: ContentItem[],
  targetFolderId: string | null,
  folders: Folder[],
  spaceId: string
): boolean => {
  const movingFolders = movingItems.filter((item) => item.type === "folder");
  if (movingFolders.length === 0) return false;
  const spaceFolders = folders.filter((f) => f.space_id === spaceId && f.name !== "home");
  const targetFolder = targetFolderId ? spaceFolders.find((f) => f.id === targetFolderId) : undefined;
  const newDepth = (targetFolder?.depth ?? -1) + 1;
  if (newDepth > MAX_FOLDER_DEPTH) return true;
  return movingFolders.some((folder) => newDepth + subtreeHeight(folder.id, spaceFolders) > MAX_FOLDER_DEPTH);
};

/**
 * The intra-space Move dialog: browse the space's folder tree (nested up to
 * three levels) and drop the moving item(s) at whatever level is currently
 * shown. A folder can't be moved into itself, into one of its own
 * descendants, or anywhere its own subtree would end up deeper than the
 * three allowed levels — `move_here` disables itself with an explanation
 * instead of letting that request go to the backend.
 */
const MoveDialog = ({ items, space, folders, homeFolderId, onClose, onMoved }: MoveDialogProps) => {
  const { t } = useTranslation("common");
  // Named by its title, as every AppDialog is.
  const titleId = useId();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("md"));

  const [target, setTarget] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const spaceFolders = useMemo(
    () => folders.filter((f) => f.space_id === space.id && f.name !== "home"),
    [folders, space.id]
  );

  const movingFolders = useMemo(() => items.filter((item) => item.type === "folder"), [items]);
  const hiddenFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const folder of movingFolders) {
      for (const id of withDescendants(folder.id, spaceFolders)) ids.add(id);
    }
    return ids;
  }, [movingFolders, spaceFolders]);

  const depthViolation = useMemo(
    () => folderDepthViolation(items, target, folders, space.id),
    [items, target, folders, space.id]
  );

  // The space root is only a valid target for folders until the space's own
  // `home` folder is known — a project/layer/bundle has nowhere to go.
  const rootUnavailable = target === null && !homeFolderId && items.some((item) => item.type !== "folder");

  const handleMoveHere = async () => {
    if (rootUnavailable) {
      toast.error(t("error_moving_content"));
      return;
    }
    setIsBusy(true);
    try {
      await moveContentItems(items, target, homeFolderId);
      refreshContentFeed();
      toast.success(t("moved_success"));
      onMoved();
      onClose();
    } catch {
      // Sequential awaits mean some items may already have moved before the
      // one that failed — refresh so the feed reflects wherever they
      // actually ended up, not the pre-move state.
      refreshContentFeed();
      toast.error(t("error_moving_content"));
    } finally {
      setIsBusy(false);
    }
  };

  const primaryName = items[0]?.name ?? "";
  const more = items.length > 1 ? ` +${items.length - 1}` : "";

  const spaceName = spaceDisplayName(space, t);

  return (
    <Dialog
      open
      onClose={onClose}
      aria-labelledby={titleId}
      fullScreen={fullScreen}
      PaperProps={{ sx: contentDialogPaperSx(480, fullScreen) }}>
      <ContentDialogHeader
        titleId={titleId}
        icon={ICON_NAME.FOLDER}
        title={t("move_title", { name: primaryName, more })}
        subline={
          <Typography component="div" sx={{ fontSize: 12.5, color: "text.secondary" }}>
            {t("move_subtitle", { name: spaceName })}
          </Typography>
        }
        onClose={onClose}
        closeLabel={t("close")}
        divider
      />

      <Box sx={{ padding: "12px 16px 14px", minHeight: 0 }}>
        <FolderBrowser
          space={space}
          folders={folders}
          homeFolderId={homeFolderId ?? null}
          value={target}
          onChange={setTarget}
          hiddenFolderIds={hiddenFolderIds}
          maxHeight={300}
        />

        {depthViolation && (
          <Typography sx={{ display: "block", padding: "8px 2px 0", fontSize: 11.5, color: "error.main" }}>
            {t("folder_depth_limit")}
          </Typography>
        )}

        {rootUnavailable && (
          <Typography sx={{ display: "block", padding: "8px 2px 0", fontSize: 11.5, color: "error.main" }}>
            {t("space_not_ready")}
          </Typography>
        )}
      </Box>

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "13px 18px",
          borderTop: `1px solid ${theme.palette.divider}`,
          flexShrink: 0,
        }}>
        <Typography
          component="span"
          sx={{ flex: 1, fontSize: 11.5, color: "text.disabled", lineHeight: 1.45 }}>
          {t("move_transfer_hint")}
        </Typography>
        <Button
          variant="text"
          onClick={onClose}
          sx={{
            color: "text.secondary",
            fontSize: 14,
            fontWeight: 600,
            textTransform: "none",
            flexShrink: 0,
          }}>
          {t("cancel")}
        </Button>
        <LoadingButton
          variant="contained"
          loading={isBusy}
          disabled={depthViolation || rootUnavailable}
          onClick={handleMoveHere}
          startIcon={<Icon iconName={ICON_NAME.FOLDER} style={{ fontSize: 14 }} />}
          sx={{
            flexShrink: 0,
            borderRadius: "999px",
            padding: "10px 22px",
            fontSize: 14,
            fontWeight: 700,
            textTransform: "none",
            whiteSpace: "nowrap",
          }}>
          {t("move_here")}
        </LoadingButton>
      </Box>
    </Dialog>
  );
};

export default MoveDialog;
