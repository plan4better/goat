"use client";

import { Box, Button, Skeleton, Typography, useTheme } from "@mui/material";
import type { DragEvent } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { folderPath, spaceIconFor } from "@/lib/utils/content";
import type { Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";

interface ContentBreadcrumbProps {
  space?: Space;
  folders: Folder[];
  folderId: string | null;
  onNavigate: (folderId: string | null) => void;
  /** The space is still loading but is known to be the caller's personal
   * space, so the crumb reads "My content" instead of a placeholder. */
  assumePersonal?: boolean;
  /** Set for a cross-space view ("shared_with_me"/"recent"), which has no
   * folder hierarchy of its own — the breadcrumb then shows only the view's
   * own label instead of a space/folder trail. */
  view?: "shared_with_me" | "recent";
  /** The trail starts at this folder: a folder shared into the browsed space
   * is the root of what can be seen of its own space, so its ancestors — in
   * a space the caller may not even be able to see — stay out of the trail. */
  rootFolderId?: string | null;
  /** Set when the address names a space the caller cannot see (a folder in
   * someone else's personal space, reached from "Shared with me" or by
   * link): the trail then starts at that view instead of at a space name. */
  fallbackView?: "shared_with_me";
  onNavigateView?: (view: "shared_with_me") => void;
  /** Whether a drag is currently hovering the space-name crumb — dropping
   * there moves the dragged item(s) to the space root. */
  dragOverRoot?: boolean;
  onDragOverRoot?: (event: DragEvent<HTMLElement>) => void;
  onDragLeaveRoot?: (event: DragEvent<HTMLElement>) => void;
  onDropRoot?: (event: DragEvent<HTMLElement>) => void;
  /** Below `md`, there is no persistent spaces panel — the space/view label
   * becomes a pill button that opens `ContentSpacesPanel` in a bottom sheet
   * instead of a plain crumb. */
  mobile?: boolean;
  onOpenSpaces?: () => void;
  /** Whether the space list is still being fetched. The space-name crumb then
   * renders as a placeholder rather than as a name nobody knows yet. */
  loading?: boolean;
}

const CRUMB_FONT_SIZE = 19;

/** The Content page's "you are here" trail: the active space, then the
 * folders down to the current one. The space's `home` folder is never shown
 * as a step — the backend folds its children into the space root, so the
 * space icon itself already stands for it. The space-name crumb doubles as
 * a drop target for drag-to-move: dropping an item there moves it to the
 * space root regardless of which folder is currently open. */
const ContentBreadcrumb = ({
  space,
  folders,
  folderId,
  onNavigate,
  assumePersonal = false,
  view,
  rootFolderId,
  fallbackView,
  onNavigateView,
  dragOverRoot,
  onDragOverRoot,
  onDragLeaveRoot,
  onDropRoot,
  mobile,
  onOpenSpaces,
  loading,
}: ContentBreadcrumbProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const openSpaces = mobile ? onOpenSpaces : undefined;

  const crumbSx = (last: boolean) => ({
    fontSize: mobile ? 15.5 : CRUMB_FONT_SIZE,
    fontWeight: last ? 700 : 600,
    color: last ? theme.palette.text.primary : theme.palette.text.secondary,
    letterSpacing: "-0.2px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    background: "none",
    border: "none",
    padding: 0,
    fontFamily: "inherit",
  });

  const separator = (
    <Icon
      iconName={ICON_NAME.CHEVRON_RIGHT}
      style={{ fontSize: mobile ? 15 : 17, color: theme.palette.text.disabled, flexShrink: 0 }}
    />
  );

  if (view) {
    if (openSpaces) {
      return (
        <Button
          onClick={openSpaces}
          variant="outlined"
          size="small"
          sx={{ borderRadius: 999, textTransform: "none" }}
          startIcon={
            <Icon iconName={view === "recent" ? ICON_NAME.CLOCK : ICON_NAME.SHARE} fontSize="small" />
          }
          endIcon={<Icon iconName={ICON_NAME.CHEVRON_DOWN} style={{ fontSize: 12 }} />}>
          {t(view)}
        </Button>
      );
    }
    return (
      <>
        <Icon
          iconName={view === "recent" ? ICON_NAME.CLOCK : ICON_NAME.SHARE}
          style={{ fontSize: 19, color: theme.palette.text.secondary, flexShrink: 0 }}
        />
        <Typography component="span" sx={{ ...crumbSx(true), cursor: "default" }}>
          {t(view)}
        </Typography>
      </>
    );
  }

  const fullPath = folderPath(folders, folderId).filter((f) => f.name !== "home");
  const rootIndex = rootFolderId ? fullPath.findIndex((f) => f.id === rootFolderId) : -1;
  const path = rootIndex > 0 ? fullPath.slice(rootIndex) : fullPath;
  const spaceUnknown = !space && !assumePersonal && !fallbackView;
  const spaceLabel =
    space?.kind === "personal" || assumePersonal
      ? t("my_content")
      : (space?.name ?? (fallbackView ? t(fallbackView) : "…"));
  const rootIcon = fallbackView && !space ? ICON_NAME.SHARE : spaceIconFor(space);
  const navigateRoot = () => {
    if (!space && fallbackView && onNavigateView) onNavigateView(fallbackView);
    else onNavigate(null);
  };
  const spaceCrumbSkeleton = <Skeleton variant="text" width={120} sx={{ fontSize: 14 }} />;

  const folderCrumbs = path.map((folder, index) => (
    <Box key={folder.id} sx={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
      {separator}
      <Typography
        component="button"
        type="button"
        onClick={() => onNavigate(folder.id)}
        sx={crumbSx(index === path.length - 1)}>
        {folder.name}
      </Typography>
    </Box>
  ));

  if (openSpaces) {
    return (
      <>
        <Button
          onClick={openSpaces}
          variant="outlined"
          size="small"
          sx={{ borderRadius: 999, textTransform: "none", flexShrink: 0 }}
          startIcon={<Icon iconName={rootIcon} style={{ fontSize: 13 }} />}
          endIcon={<Icon iconName={ICON_NAME.CHEVRON_DOWN} style={{ fontSize: 12 }} />}>
          {loading && spaceUnknown ? spaceCrumbSkeleton : spaceLabel}
        </Button>
        {folderCrumbs}
      </>
    );
  }

  return (
    <>
      <Icon
        iconName={rootIcon}
        style={{ fontSize: 19, color: theme.palette.text.secondary, flexShrink: 0 }}
      />
      <Typography
        component="button"
        type="button"
        onClick={navigateRoot}
        onDragOver={onDragOverRoot}
        onDragLeave={onDragLeaveRoot}
        onDrop={onDropRoot}
        sx={{
          ...crumbSx(path.length === 0),
          ...(dragOverRoot && {
            outline: `2px dashed ${theme.palette.primary.main}`,
            outlineOffset: 2,
            borderRadius: "4px",
          }),
        }}>
        {loading && spaceUnknown ? spaceCrumbSkeleton : spaceLabel}
      </Typography>
      {folderCrumbs}
    </>
  );
};

export default ContentBreadcrumb;
