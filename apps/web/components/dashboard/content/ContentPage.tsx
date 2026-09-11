"use client";

import {
  Box,
  Button,
  Stack,
  SwipeableDrawer,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useRouter } from "next/navigation";
import type { DragEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useDocuments } from "@/lib/api/assets";
import { refreshContentFeed, useContent, useSharedWithSpace, useSpaces } from "@/lib/api/content";
import { useFolders } from "@/lib/api/folders";
import { readTemplate, refreshTemplate, refreshTemplates, useTemplate } from "@/lib/api/templates";
import type { ContentSectionKey } from "@/lib/providers/ContentUiStateProvider";
import { useContentUiState } from "@/lib/providers/ContentUiStateProvider";
import { regenerateTemplateThumbnail } from "@/lib/templates/thumbnailSnapshot";
import {
  folderLocationLabel,
  folderPath,
  homeFolderOf,
  sectionOf,
  spaceDisplayName,
  spaceIconFor,
} from "@/lib/utils/content";
import { templateShelfOf, templateSourceLabel } from "@/lib/utils/templates";
import type { ContentItem, Space } from "@/lib/validations/content";
import type { TemplateRead } from "@/lib/validations/template";

import { ContentActions } from "@/types/common";

import { useAccumulatedPages } from "@/hooks/dashboard/content/useAccumulatedPages";
import { canActOn, canMoveAll, useContentActions } from "@/hooks/dashboard/content/useContentActions";
import { useContentDrag } from "@/hooks/dashboard/content/useContentDrag";
import type { ContentView } from "@/hooks/dashboard/content/useContentPageState";
import {
  readStoredPersonalSpaceId,
  useContentPageState,
  writeStoredPersonalSpaceId,
} from "@/hooks/dashboard/content/useContentPageState";
import { useContentSelection } from "@/hooks/dashboard/content/useContentSelection";
import { useJobStatus } from "@/hooks/jobs/JobStatus";
import { templateResultHref } from "@/hooks/templates/useUseTemplate";

import type { PopperMenuItem } from "@/components/common/PopperMenu";
import DocumentCard from "@/components/dashboard/common/DocumentCard";
import EmptyState from "@/components/dashboard/common/EmptyState";
import PageHeader from "@/components/dashboard/common/PageHeader";
import ContentActionBar from "@/components/dashboard/content/ContentActionBar";
import ContentActionDialogs from "@/components/dashboard/content/ContentActionDialogs";
import ContentAddMenu from "@/components/dashboard/content/ContentAddMenu";
import ContentBreadcrumb from "@/components/dashboard/content/ContentBreadcrumb";
import ContentCard from "@/components/dashboard/content/ContentCard";
import ContentDeleteDialog from "@/components/dashboard/content/ContentDeleteDialog";
import ContentDetailsPanel, {
  type ContentDetailsLocation,
} from "@/components/dashboard/content/ContentDetailsPanel";
import ContentFeedSkeleton from "@/components/dashboard/content/ContentFeedSkeleton";
import ContentFolderCard from "@/components/dashboard/content/ContentFolderCard";
import ContentPreviewDialog from "@/components/dashboard/content/ContentPreviewDialog";
import ContentRow from "@/components/dashboard/content/ContentRow";
import ContentSection from "@/components/dashboard/content/ContentSection";
import ContentSpacesPanel from "@/components/dashboard/content/ContentSpacesPanel";
import ContentToolbar from "@/components/dashboard/content/ContentToolbar";
import ShortcutTile from "@/components/dashboard/content/ShortcutTile";
import type { SectionGridKind } from "@/components/dashboard/content/sectionGrid";
import { sectionGridSx } from "@/components/dashboard/content/sectionGrid";
import MoveDialog, {
  folderDepthViolation,
  moveContentItems,
  withDescendants,
} from "@/components/modals/content/MoveDialog";
import ShareDialog from "@/components/modals/content/ShareDialog";
import SpaceSettingsDialog from "@/components/modals/content/SpaceSettingsDialog";
import TransferDialog from "@/components/modals/content/TransferDialog";
import TrashDialog from "@/components/modals/content/TrashDialog";
import TemplatePreviewDialog from "@/components/templates/TemplatePreviewDialog";
import SaveTemplateDialog from "@/components/templates/SaveTemplateDialog";
import UseTemplateFlow from "@/components/templates/UseTemplateFlow";

const FEED_PAGE_SIZE = 50;

const ROW_KIND_TO_ROUTE: Record<
  Exclude<ContentItem["type"], "folder" | "template" | "layer">,
  (id: string) => string
> = {
  project: (id) => `/map/${id}`,
  bundle: (id) => `/bundles/${id}`,
};

/** Actions `ContentActionDialogs` renders a dialog for. SHARE, MOVE and
 * TRANSFER each render their own dialog separately below. */
const ACTION_DIALOG_ACTIONS: ContentActions[] = [
  ContentActions.EDIT_METADATA,
  ContentActions.RENAME,
  ContentActions.DOWNLOAD,
  ContentActions.UPDATE,
  ContentActions.EXPORT,
  ContentActions.DUPLICATE,
];

type SectionKey = ContentSectionKey;

const SECTION_LABEL_KEYS: Record<SectionKey, string> = {
  folders: "folders",
  shortcuts: "shortcuts",
  projects: "projects",
  templates: "templates",
  datasets: "datasets",
};

/** Section order for the feed's own render — templates sit between projects
 * and datasets, folders/shortcuts leading as they always have. */
const SECTION_ORDER: SectionKey[] = ["folders", "shortcuts", "projects", "templates", "datasets"];

/** Where the route says we are: a space (optionally a folder inside it) or
 * one of the cross-space views. Every one of these comes from the URL path,
 * so the browsed location is a real navigable address. */
export type ContentPageProps = {
  spaceId?: string;
  folderId?: string;
  view?: ContentView;
};

const ContentPage = ({
  spaceId: routeSpaceId,
  folderId: routeFolderId,
  view: routeView,
}: ContentPageProps) => {
  const { t } = useTranslation("common");
  const router = useRouter();
  const theme = useTheme();
  // The single mobile/desktop split for this page — every layout branch
  // below (spaces sheet vs. side panel, details sheet vs. side panel,
  // icon-only toolbar, compact cards/rows) reads this one flag.
  const mobile = useMediaQuery(theme.breakpoints.down("md"));

  const { spaces, isLoading: spacesLoading } = useSpaces();
  const {
    active,
    folderId,
    search,
    setSearch,
    types,
    setTypes,
    noTypesSelected,
    orderBy,
    order,
    setSort,
    layout,
    setLayout,
    goSpace,
    goView,
    goFolder,
    goFolderIn,
    feedParams,
  } = useContentPageState({ spaceId: routeSpaceId, folderId: routeFolderId, view: routeView });
  const { folders } = useFolders({});
  const { getMenuItems } = useContentActions();

  // Expanded sections and the details panel come from the `/content` layout,
  // which outlives this component: the route segment carries the browsed
  // space and folder, so stepping into a folder mounts a new instance of the
  // page while these preferences stay as the caller set them.
  const { openSections, toggleSection, detailsOpen, setDetailsOpen, toggleDetails } = useContentUiState();

  // Below `md` there is no persistent left column — the breadcrumb's space
  // pill opens `ContentSpacesPanel` in this bottom sheet instead.
  const [spacesSheetOpen, setSpacesSheetOpen] = useState(false);

  // Trash and space settings act on the active space only (the panel only
  // ever opens either for it — see `ContentSpacesPanel`'s own
  // `my_role === "owner"` / `kind !== "personal"` gates), so a bare boolean
  // is enough state; which space renders is read from `space` below.
  const [trashOpen, setTrashOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Routes a kebab/action-bar pick to the action it named, keyed by every
  // item it applies to — one for a kebab pick, the whole selection for a
  // bulk action-bar Move/Delete. Every action renders below (see
  // `ACTION_DIALOG_ACTIONS`, DELETE, and SHARE/MOVE/TRANSFER's own
  // dialogs). `presetTargetId` is only ever set for a TRANSFER opened by
  // dropping items on a space in the spaces panel.
  const [dialog, setDialog] = useState<{
    action: ContentActions;
    items: ContentItem[];
    presetTargetId?: string;
  } | null>(null);
  // A layer opens as a preview dialog over the feed rather than navigating
  // away; kept separate from `dialog` since it isn't one of the kebab/
  // action-bar actions — clicking the row itself opens it.
  const [previewLayerId, setPreviewLayerId] = useState<string | null>(null);

  // A template opens the same way (T7): OPEN (row click or kebab) shows the
  // preview panel, while a USE_TEMPLATE kebab pick skips straight to
  // `UseTemplateFlow` once the full `TemplateRead` this row's `ContentItem`
  // doesn't carry has loaded — `autoUse` is what tells the effect below
  // which of the two to do once `loadedTemplate` arrives.
  const [templateOpen, setTemplateOpen] = useState<{ id: string; autoUse: boolean } | null>(null);
  const { template: loadedTemplate } = useTemplate(templateOpen?.id ?? null);
  const [templateToUse, setTemplateToUse] = useState<TemplateRead | null>(null);
  const [editTemplate, setEditTemplate] = useState<TemplateRead | null>(null);
  useEffect(() => {
    if (templateOpen?.autoUse && loadedTemplate) {
      setTemplateToUse(loadedTemplate);
      setTemplateOpen(null);
    }
  }, [templateOpen, loadedTemplate]);

  // "Load more" asks for the next page at a fixed size and the rows
  // accumulate here: the content endpoint caps `size` at 100, so a request
  // that grew the size instead would 422 from the third page on and leave
  // the rest of a large space unreachable. The collection is everything the
  // feed is asked for bar the page — another scope, filter or sort starts
  // over at the first page.
  const [feedPage, setFeedPage] = useState(1);
  const scopeKey = feedParams ? JSON.stringify({ ...feedParams, size: undefined }) : null;
  // Adjusted during the render that brings the change in rather than in an
  // effect afterwards: React re-renders before committing, so the feed is
  // never asked for a later page of a collection it has not read the first
  // page of, which would list a gap until that first page landed.
  const [renderedScopeKey, setRenderedScopeKey] = useState(scopeKey);
  if (renderedScopeKey !== scopeKey) {
    setRenderedScopeKey(scopeKey);
    setFeedPage(1);
  }
  const effectiveFeedParams = useMemo(
    () => (feedParams ? { ...feedParams, page: feedPage, size: FEED_PAGE_SIZE } : null),
    [feedParams, feedPage]
  );

  const { page: fetchedPage, isLoading } = useContent(effectiveFeedParams);
  const feed = useAccumulatedPages(fetchedPage, feedPage, scopeKey);

  // A dataset upload closes its dialog before the import job finishes (see
  // `useUploadFlow`), so the row it creates lands after this page has
  // already fetched — without this, an open Content page never learns the
  // job landed until a manual reload. A failure also revalidates, so
  // nothing optimistic from the failed attempt lingers in the feed.
  useJobStatus(refreshContentFeed, refreshContentFeed);

  const spaceId = active.kind === "space" ? active.spaceId : null;
  const space = spaces.find((s) => s.id === spaceId);
  // The personal space's id is remembered across visits, so its crumb can
  // read "My content" while the spaces request is still in flight. Read after
  // mount: the server has no storage, and a value the server did not render
  // would make hydration fail.
  const [storedPersonalSpaceId, setStoredPersonalSpaceId] = useState<string | null>(null);
  useEffect(() => {
    setStoredPersonalSpaceId(readStoredPersonalSpaceId());
  }, []);
  const personalSpace = spaces.find((s) => s.kind === "personal");
  useEffect(() => {
    if (personalSpace && personalSpace.id !== storedPersonalSpaceId) {
      writeStoredPersonalSpaceId(personalSpace.id);
      setStoredPersonalSpaceId(personalSpace.id);
    }
  }, [personalSpace, storedPersonalSpaceId]);
  // The bare /content route lands in the personal space, so it is personal too.
  const assumePersonal =
    spacesLoading &&
    !space &&
    active.kind === "space" &&
    (spaceId === null || (!!storedPersonalSpaceId && spaceId === storedPersonalSpaceId));
  const homeFolder = spaceId ? homeFolderOf(folders ?? [], spaceId) : undefined;
  const documentsFolderId = active.kind === "space" ? (folderId ?? homeFolder?.id) : undefined;
  const { documents } = useDocuments(documentsFolderId);

  // "Shared with {space}" only makes sense at a team/org space's own root —
  // a personal space has nothing shared into it, and inside a folder the
  // grant is on the space, not that particular folder.
  const sharedWithSpaceScopeSpaceId = space && space.kind !== "personal" && !folderId ? space.id : null;
  const { page: sharedWithSpacePage } = useSharedWithSpace(sharedWithSpaceScopeSpaceId);

  // Items shared into a team/organisation space are listed with the space's
  // own: the page heading already names the space, and each such item carries
  // its "Shared" chip, so they sort into the same kind sections rather than
  // a section of their own. Merged in the feed's own order.
  const items = useMemo(() => {
    const shared = sharedWithSpacePage?.items ?? [];
    if (shared.length === 0) return feed.items;
    const merged = [...feed.items, ...shared];
    const dir = order === "ascendent" ? 1 : -1;
    return merged.sort((a, b) => {
      const av = String(a[orderBy] ?? "");
      const bv = String(b[orderBy] ?? "");
      return (orderBy === "name" ? av.localeCompare(bv) : av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
  }, [feed.items, sharedWithSpacePage?.items, orderBy, order]);
  const grouped: Record<SectionKey, ContentItem[]> = {
    folders: items.filter((i) => sectionOf(i) === "folders"),
    shortcuts: items.filter((i) => sectionOf(i) === "shortcuts"),
    projects: items.filter((i) => sectionOf(i) === "projects"),
    templates: items.filter((i) => sectionOf(i) === "templates"),
    datasets: items.filter((i) => sectionOf(i) === "datasets"),
  };

  const selection = useContentSelection(items);
  const drag = useContentDrag();

  // Only an item the caller may act on can be dragged (owner, and not a
  // shortcut) — dragging the dragged item's own id, or the eligible members
  // of the selection when the dragged item is already part of a multi-item
  // selection. Items the caller may not move are dropped from the set
  // rather than sent along to fail server-side mid-batch.
  const isDraggable = (item: ContentItem) => canActOn(item);
  const dragItemsFor = (item: ContentItem): ContentItem[] =>
    selection.selected.has(item.id) && selection.selectedItems.length > 1
      ? selection.selectedItems.filter(isDraggable)
      : [item];
  const handleDragStart = (item: ContentItem) => (event: DragEvent<HTMLElement>) => {
    const draggedItems = dragItemsFor(item);
    if (draggedItems.length === 0) {
      event.preventDefault();
      return;
    }
    if (draggedItems.length < selection.selectedItems.length && selection.selected.has(item.id)) {
      toast.info(t("drag_skips_ineligible_items"));
    }
    event.dataTransfer.setData("text/plain", draggedItems.map((i) => i.id).join(","));
    event.dataTransfer.effectAllowed = "move";
    drag.startDrag(draggedItems);
  };
  const handleDragEnd = () => drag.endDrag();

  // Shared by both drop targets (a folder card/row and the breadcrumb
  // root): resolves the dragged ids back to items, guards the folder depth
  // limit and the self/descendant-drop cases the same way `MoveDialog`'s
  // own button does, then moves and refreshes exactly like a dialog-driven
  // move would.
  const performDrop = async (targetFolderId: string | null) => {
    const draggedItems = items.filter((i) => drag.dragIds.includes(i.id));
    drag.endDrag();
    if (draggedItems.length === 0 || !space) return;

    // A folder card/row for one of the dragged folder's own descendants is
    // still a real drop target in the current view (unlike the dialog,
    // which hides those folders from its list entirely) — refuse the same
    // drops the dialog would refuse: onto itself, or into its own subtree.
    const spaceFolders = (folders ?? []).filter((f) => f.space_id === space.id && f.name !== "home");
    const forbiddenIds = new Set<string>();
    for (const item of draggedItems) {
      if (item.type === "folder") {
        for (const id of withDescendants(item.id, spaceFolders)) forbiddenIds.add(id);
      }
    }
    if (targetFolderId && forbiddenIds.has(targetFolderId)) return;

    if (folderDepthViolation(draggedItems, targetFolderId, folders ?? [], space.id)) {
      toast.error(t("folder_depth_limit"));
      return;
    }
    // Projects, layers and bundles need a real folder id at the space root
    // (`folder_id` is NOT NULL) — without the space's `home` folder the move
    // is refused rather than sent with an empty id.
    if (targetFolderId === null && !homeFolder && draggedItems.some((i) => i.type !== "folder")) {
      toast.error(t("error_moving_content"));
      return;
    }
    try {
      await moveContentItems(draggedItems, targetFolderId, homeFolder?.id);
      refreshContentFeed();
      toast.success(t("moved_success"));
      selection.clear();
    } catch {
      // Sequential awaits mean some items may already have moved before the
      // one that failed — refresh so the feed reflects wherever they
      // actually ended up, not the pre-move state.
      refreshContentFeed();
      toast.error(t("error_moving_content"));
    }
  };
  const handleDragOverFolder = (folderId: string) => (event: DragEvent<HTMLElement>) => {
    if (drag.dragIds.length === 0) return;
    event.preventDefault();
    drag.setDropTarget(folderId);
  };
  const handleDragLeaveFolder = () => drag.setDropTarget(null);
  const handleDropFolder = (folderId: string) => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    void performDrop(folderId);
  };
  const handleDragOverRoot = (event: DragEvent<HTMLElement>) => {
    if (drag.dragIds.length === 0) return;
    event.preventDefault();
    drag.setDropTarget("root");
  };
  const handleDragLeaveRoot = () => drag.setDropTarget(null);
  const handleDropRoot = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    void performDrop(null);
  };

  // The details panel's no-selection body: the space/folder/view currently
  // browsed, plus how many items of each kind sit here (from `grouped`,
  // already computed above for the feed's own section headers).
  const currentFolder = folderId ? (folders ?? []).find((f) => f.id === folderId) : undefined;
  // The address names a space that is not one of the caller's: a folder in
  // someone else's personal space, opened from "Shared with me" or by link.
  // Its contents are still listed (the folder's grant admits the caller);
  // the page then stands in that view's place rather than in no space.
  const spaceUnknown = !!spaceId && !space && !spacesLoading && spaces.length > 0;
  // A folder shared into the browsed space heads the trail of anything
  // opened inside it — its own ancestors belong to the space it came from.
  const sharedRootFolderId = useMemo(() => {
    if (!sharedWithSpacePage?.items.length || !folderId) return null;
    const sharedFolders = new Set(
      sharedWithSpacePage.items.filter((i) => i.type === "folder").map((i) => i.id)
    );
    const trail = folderPath(folders ?? [], folderId);
    for (let i = trail.length - 1; i >= 0; i -= 1) {
      if (sharedFolders.has(trail[i].id)) return trail[i].id;
    }
    return null;
  }, [sharedWithSpacePage, folders, folderId]);
  const locationInfo: ContentDetailsLocation =
    active.kind === "view"
      ? {
          icon: active.view === "recent" ? ICON_NAME.CLOCK : ICON_NAME.SHARE,
          name: t(active.view),
          rows: [],
        }
      : {
          icon: currentFolder ? ICON_NAME.FOLDER : spaceIconFor(space),
          name: currentFolder ? currentFolder.name : spaceDisplayName(space, t),
          subKey: currentFolder
            ? "folder_label"
            : space &&
              { personal: "personal_space", team: "team_space", organization: "organization_space" }[
                space.kind
              ],
          rows: SECTION_ORDER.filter((key) => grouped[key].length > 0).map(
            (key) => [SECTION_LABEL_KEYS[key], String(grouped[key].length)] as [string, string]
          ),
        };

  const previewTarget = previewLayerId ? items.find((i) => i.id === previewLayerId) : undefined;

  const openItem = (item: ContentItem) => {
    if (item.is_shortcut) {
      if (item.type === "folder") {
        // A shortcut to a folder crosses into the target's own space, so
        // space and folder land in the URL together, as one navigation.
        goFolderIn(item.space_id, item.id);
      } else {
        openItem({ ...item, is_shortcut: false });
      }
      return;
    }
    if (item.type === "folder") {
      // A folder opened from a space stays under that space in the address,
      // even one shared in from another space: the space list and the trail
      // keep the caller's place, and the backend accepts any of the caller's
      // own spaces as the context for a folder they may read. In a
      // cross-space view there is no such context, so the folder's own space
      // comes from the item.
      goFolderIn(spaceId ?? item.space_id, item.id);
      return;
    }
    if (item.type === "layer") {
      setPreviewLayerId(item.id);
      return;
    }
    if (item.type === "template") {
      setTemplateOpen({ id: item.id, autoUse: false });
      return;
    }
    router.push(ROW_KIND_TO_ROUTE[item.type](item.id));
  };

  const handleUpdateTemplateFromSource = async (id: string) => {
    try {
      const refreshed = await refreshTemplate(id);
      // The frozen config has just been replaced, so the picture of it is
      // stale: it is re-drawn and re-stored from the config the refresh
      // left behind, the same drawing the save dialog stores.
      const updated = await regenerateTemplateThumbnail(refreshed, t);
      refreshTemplates();
      refreshContentFeed();
      if (updated.datasets_needing_share.length > 0) {
        toast.info(t("template_datasets_need_sharing", { count: updated.datasets_needing_share.length }));
      } else {
        toast.success(t("template_updated_from_source"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("error_updating_template"));
    }
  };

  const handleMenuSelect = (menuItem: PopperMenuItem, item: ContentItem) => {
    if (menuItem.id === ContentActions.OPEN) {
      openItem(item);
      return;
    }
    // Details is the panel, not a dialog: select the picked item alone so
    // the panel shows it, and open the panel.
    if (menuItem.id === ContentActions.DETAILS) {
      selection.selectOnly(item.id);
      setDetailsOpen(true);
      return;
    }
    if (menuItem.id === ContentActions.USE_TEMPLATE && item.type === "template") {
      setTemplateOpen({ id: item.id, autoUse: true });
      return;
    }
    if (menuItem.id === ContentActions.UPDATE_TEMPLATE_FROM_SOURCE && item.type === "template") {
      void handleUpdateTemplateFromSource(item.id);
      return;
    }
    if (menuItem.id === ContentActions.EDIT_TEMPLATE && item.type === "template") {
      // The dialog edits the template as read in full — the feed row lacks
      // the inputs and the resolved source it shows.
      void readTemplate(item.id)
        .then(setEditTemplate)
        .catch(() => toast.error(t("error_updating_template")));
      return;
    }
    setDialog({ action: menuItem.id as ContentActions, items: [item] });
  };

  // A shortcut's `space_id` is its *target's* real space, not the folder it
  // is listed in, so this also doubles as "the shortcut's target space".
  const spaceOf = (item: ContentItem): Space | undefined => spaces.find((s) => s.id === item.space_id);
  const menuItemsFor = (item: ContentItem) => getMenuItems(item, spaceOf(item));

  // ShareDialog is single-item only; a SHARE pick's own space is its
  // item's space (a cross-space view like "recent" has no single browsed
  // `space` to fall back on otherwise), falling back to the browsed space
  // for the rare case an item's own space isn't in `spaces` yet.
  const shareItem =
    dialog?.action === ContentActions.SHARE && dialog.items.length === 1 ? dialog.items[0] : undefined;
  const shareSpace = shareItem ? (spaceOf(shareItem) ?? space) : undefined;

  // D3, promote-only: the Share dialog's "Transfer ownership" row only
  // shows for an item the caller owns in their own personal space.
  const shareItemTransferEligible =
    !!shareItem && shareItem.my_role === "owner" && shareSpace?.kind === "personal";

  // MoveDialog can act on a whole selection; `canMove` (below) already
  // guarantees every moving item shares one `space_id`, so the first item's
  // own space (falling back to the browsed space, for the same reason as
  // `shareSpace` above) is that shared space for all of them.
  const moveDialogItems = dialog?.action === ContentActions.MOVE ? dialog.items : undefined;
  const moveSpace =
    moveDialogItems && moveDialogItems.length > 0 ? (spaceOf(moveDialogItems[0]) ?? space) : undefined;
  const moveHomeFolder = moveSpace ? homeFolderOf(folders ?? [], moveSpace.id) : undefined;

  // TransferDialog itself re-checks eligibility (and guards on it); this is
  // just what opens it, from a kebab/action-bar TRANSFER pick or a space
  // drop (which also sets `presetTargetId`).
  const transferDialogItems = dialog?.action === ContentActions.TRANSFER ? dialog.items : undefined;

  const canShare = selection.selectedItems.length === 1 && canActOn(selection.selectedItems[0]);
  const canMove = canMoveAll(selection.selectedItems);
  const canDelete = selection.selectedItems.length > 0 && selection.selectedItems.every(canActOn);

  const dispatchBulk = (action: ContentActions) => {
    if (selection.selectedItems.length === 0) return;
    // Move browses one space's folder tree, so a selection spanning spaces
    // has no destination to offer — the action bar and the details panel
    // both hide the control, and this refuses it either way.
    if (action === ContentActions.MOVE && !canMove) return;
    setDialog({ action, items: selection.selectedItems });
  };

  const isSpace = active.kind === "space";
  const hasMore = feed.hasMore;
  // The skeleton stands only while there is nothing listed at all: a further
  // page re-keys the feed, and blanking the rows already on screen for it
  // would throw the reader back to the top of the list.
  const showSkeleton = !noTypesSelected && isLoading && items.length === 0;
  // `items` already holds whatever is shared into a team/organisation space,
  // so a space that owns nothing but has items shared into it is not empty.
  const isEmpty =
    noTypesSelected || (!isLoading && items.length === 0 && (!isSpace || documents.length === 0) && feed.loaded);

  const renderCard = (item: ContentItem) => {
    const selectionProps = {
      selected: selection.selected.has(item.id),
      anySelected: selection.anySelected,
      onToggleSelect: selection.toggle,
    };
    const menuProps = {
      menuItems: menuItemsFor(item),
      onMenuSelect: (menuItem: PopperMenuItem) => handleMenuSelect(menuItem, item),
    };

    if (item.is_shortcut) {
      return (
        <ShortcutTile
          key={`${item.type}-${item.id}`}
          item={item}
          targetSpaceName={spaceDisplayName(spaceOf(item), t)}
          onOpen={openItem}
          mobile={mobile}
          {...selectionProps}
          {...menuProps}
        />
      );
    }
    if (item.type === "folder") {
      return (
        <ContentFolderCard
          key={`${item.type}-${item.id}`}
          item={item}
          space={spaceOf(item)}
          location={locationOf(item)}
          onOpen={openItem}
          draggable={isDraggable(item)}
          onDragStart={handleDragStart(item)}
          onDragEnd={handleDragEnd}
          dragOver={drag.dropTarget === item.id}
          onDragOverFolder={handleDragOverFolder(item.id)}
          onDragLeaveFolder={handleDragLeaveFolder}
          onDropFolder={handleDropFolder(item.id)}
          mobile={mobile}
          {...selectionProps}
          {...menuProps}
        />
      );
    }
    return (
      <ContentCard
        key={`${item.type}-${item.id}`}
        item={item}
        space={spaceOf(item)}
        location={locationOf(item)}
        onOpen={openItem}
        draggable={isDraggable(item)}
        onDragStart={handleDragStart(item)}
        onDragEnd={handleDragEnd}
        mobile={mobile}
        {...selectionProps}
        {...menuProps}
      />
    );
  };

  const rowVariant = active.kind === "view" ? active.view : "space";
  const renderRow = (item: ContentItem) => (
    <ContentRow
      key={`${item.type}-${item.id}`}
      item={item}
      space={spaceOf(item)}
      variant={rowVariant}
      location={locationOf(item)}
      selected={selection.selected.has(item.id)}
      anySelected={selection.anySelected}
      onToggleSelect={selection.toggle}
      onOpen={openItem}
      menuItems={menuItemsFor(item)}
      onMenuSelect={(menuItem) => handleMenuSelect(menuItem, item)}
      draggable={isDraggable(item)}
      onDragStart={handleDragStart(item)}
      onDragEnd={handleDragEnd}
      dragOver={item.type === "folder" && drag.dropTarget === item.id}
      onDragOverFolder={item.type === "folder" ? handleDragOverFolder(item.id) : undefined}
      onDragLeaveFolder={item.type === "folder" ? handleDragLeaveFolder : undefined}
      onDropFolder={item.type === "folder" ? handleDropFolder(item.id) : undefined}
      mobile={mobile}
    />
  );

  // A search reaches into every folder beneath the browsed one, so each
  // result says where it lives; while browsing, everything shown is right here.
  const locationOf = (item: ContentItem): string | undefined =>
    search ? folderLocationLabel(folders ?? [], item.folder_id) : undefined;

  const renderItems = (list: ContentItem[], grid: SectionGridKind = "cards") => {
    if (layout !== "grid") {
      return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {list.map((item) => renderRow(item))}
        </Box>
      );
    }
    return <Box sx={sectionGridSx(grid, mobile)}>{list.map((item) => renderCard(item))}</Box>;
  };

  const spacesPanel = (onPicked?: () => void) => (
    <ContentSpacesPanel
      spaces={spaces}
      loading={spacesLoading}
      active={spaceUnknown ? { kind: "view", view: "shared_with_me" } : active}
      onSelectSpace={(id) => {
        goSpace(id);
        onPicked?.();
      }}
      onSelectView={(view) => {
        goView(view);
        onPicked?.();
      }}
      dropTargetId={drag.dropTarget}
      onDragOverSpace={(hoveredSpaceId) =>
        drag.setDropTarget(
          hoveredSpaceId && drag.canDropOnSpace(hoveredSpaceId, spaces) ? hoveredSpaceId : null
        )
      }
      onDropSpace={(targetSpaceId) => {
        const draggedItems = items.filter((i) => drag.dragIds.includes(i.id));
        const canDrop = drag.canDropOnSpace(targetSpaceId, spaces);
        drag.endDrag();
        if (draggedItems.length === 0 || !canDrop) return;
        setDialog({ action: ContentActions.TRANSFER, items: draggedItems, presetTargetId: targetSpaceId });
      }}
      onOpenTrash={() => {
        setTrashOpen(true);
        onPicked?.();
      }}
      onOpenSettings={() => {
        setSettingsOpen(true);
        onPicked?.();
      }}
      mobile={!!onPicked}
      onClose={onPicked}
    />
  );

  const detailsPanel = (isMobile?: boolean) => (
    <ContentDetailsPanel
      selected={selection.selectedItems}
      spaces={spaces}
      folders={folders ?? []}
      location={locationInfo}
      onClose={() => setDetailsOpen(false)}
      onShare={() => dispatchBulk(ContentActions.SHARE)}
      onMove={() => dispatchBulk(ContentActions.MOVE)}
      onDelete={() => dispatchBulk(ContentActions.DELETE)}
      mobile={isMobile}
    />
  );

  // What the search field says it searches: the space being browsed, or the
  // cross-space view's own name.
  const scopeName = isSpace
    ? spaceDisplayName(space, t) || undefined
    : active.kind === "view"
      ? t(active.view)
      : undefined;

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        // The same measure the catalog's `Container maxWidth="xl"` gives that
        // page, so the two read as one product on a wide screen.
        width: "100%",
        maxWidth: theme.breakpoints.values.xl,
        mx: "auto",
        bgcolor: theme.palette.background.default,
      }}>
      <Box sx={{ padding: mobile ? "16px 14px 0" : "40px 40px 0", flexShrink: 0 }}>
        <PageHeader title={t("content")} subtitle={t("content_spaces_subtitle")} mobile={mobile} />
      </Box>

      <Box sx={{ flex: 1, display: "flex", minHeight: 0 }}>
        {!mobile && spacesPanel()}

        {mobile && (
          <SwipeableDrawer
            anchor="bottom"
            open={spacesSheetOpen}
            onOpen={() => setSpacesSheetOpen(true)}
            onClose={() => setSpacesSheetOpen(false)}
            disableSwipeToOpen
            PaperProps={{
              sx: { maxHeight: "78vh", borderTopLeftRadius: "16px", borderTopRightRadius: "16px" },
            }}>
            {spacesPanel(() => setSpacesSheetOpen(false))}
          </SwipeableDrawer>
        )}

        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Box sx={{ flexShrink: 0 }} onClick={(event) => event.stopPropagation()}>
            <ContentToolbar
              search={search}
              onSearch={setSearch}
              layout={layout}
              onLayout={setLayout}
              types={types}
              onTypes={setTypes}
              orderBy={orderBy}
              order={order}
              onSort={setSort}
              detailsOpen={detailsOpen}
              onToggleDetails={toggleDetails}
              scopeName={scopeName}
              breadcrumb={
                <ContentBreadcrumb
                  space={space}
                  folders={folders ?? []}
                  folderId={folderId}
                  onNavigate={goFolder}
                  view={active.kind === "view" ? active.view : undefined}
                  rootFolderId={sharedRootFolderId}
                  fallbackView={spaceUnknown ? "shared_with_me" : undefined}
                  onNavigateView={goView}
                  dragOverRoot={drag.dropTarget === "root"}
                  onDragOverRoot={isSpace ? handleDragOverRoot : undefined}
                  onDragLeaveRoot={isSpace ? handleDragLeaveRoot : undefined}
                  onDropRoot={isSpace ? handleDropRoot : undefined}
                  mobile={mobile}
                  onOpenSpaces={() => setSpacesSheetOpen(true)}
                  loading={spacesLoading}
                  assumePersonal={assumePersonal}
                />
              }
              addMenu={
                space ? (
                  <ContentAddMenu
                    folderId={folderId}
                    homeFolderId={homeFolder?.id}
                    spaceId={space.id}
                    spaceKind={space.kind}
                    disabled={space.my_role !== "owner" && space.my_role !== "editor"}
                    mobile={mobile}
                  />
                ) : null
              }
              canAdd={isSpace}
              mobile={mobile}
              actionBar={
                selection.anySelected ? (
                  <ContentActionBar
                    count={selection.selectedItems.length}
                    onClear={selection.clear}
                    canShare={canShare}
                    canMove={canMove}
                    canDelete={canDelete}
                    onShare={() => dispatchBulk(ContentActions.SHARE)}
                    onMove={() => dispatchBulk(ContentActions.MOVE)}
                    onDelete={() => dispatchBulk(ContentActions.DELETE)}
                    detailsOpen={detailsOpen}
                    onToggleDetails={toggleDetails}
                  />
                ) : undefined
              }
            />
          </Box>

          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: mobile ? "4px 14px 90px" : "4px 40px 40px",
            }}
            onClick={() => {
              if (selection.anySelected) selection.clear();
            }}>
            {active.kind === "view" && active.view === "shared_with_me" && (
              <Typography component="div" sx={{ fontSize: 12.5, color: theme.palette.text.disabled, mb: 2 }}>
                {t("shared_with_me_note")}
              </Typography>
            )}

            {showSkeleton && (
              <ContentFeedSkeleton layout={layout === "grid" ? "tiles" : "list"} mobile={mobile} />
            )}

            {!showSkeleton && isEmpty && (
              <EmptyState
                icon={ICON_NAME.FOLDER}
                title={t("nothing_here_yet")}
                hint={<Trans i18nKey="common:nothing_here_hint" components={{ b: <b /> }} />}
              />
            )}

            {!showSkeleton && !isEmpty && active.kind === "view" && (
              <Box onClick={(event) => event.stopPropagation()}>{renderItems(items)}</Box>
            )}

            {!showSkeleton && !isEmpty && isSpace && (
              <Box
                sx={{ display: "flex", flexDirection: "column", gap: "30px" }}
                onClick={(event) => event.stopPropagation()}>
                {SECTION_ORDER.map((key) =>
                  grouped[key].length > 0 ? (
                    <ContentSection
                      key={key}
                      labelKey={SECTION_LABEL_KEYS[key]}
                      count={grouped[key].length}
                      open={openSections[key]}
                      onToggle={() => toggleSection(key)}>
                      {renderItems(
                        grouped[key],
                        key === "folders" || key === "shortcuts" ? "folders" : "cards"
                      )}
                    </ContentSection>
                  ) : null
                )}

                {documents.length > 0 && (
                  <ContentSection
                    labelKey="documents"
                    count={documents.length}
                    open={openSections.documents}
                    onToggle={() => toggleSection("documents")}>
                    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                      {documents.map((document) => (
                        <DocumentCard key={document.id} document={document} />
                      ))}
                    </Box>
                  </ContentSection>
                )}

              </Box>
            )}

            {hasMore && (
              <Stack direction="row" justifyContent="center" sx={{ mt: 4 }}>
                <Button variant="outlined" onClick={() => setFeedPage((prev) => prev + 1)}>
                  {t("load_more")}
                </Button>
              </Stack>
            )}
          </Box>
        </Box>

        {!mobile && detailsOpen && detailsPanel()}
      </Box>

      {mobile && (
        <SwipeableDrawer
          anchor="bottom"
          open={detailsOpen}
          onOpen={() => setDetailsOpen(true)}
          onClose={() => setDetailsOpen(false)}
          disableSwipeToOpen
          PaperProps={{
            sx: { top: "32vh", height: "68vh", borderTopLeftRadius: "16px", borderTopRightRadius: "16px" },
          }}>
          {detailsPanel(true)}
        </SwipeableDrawer>
      )}

      {previewLayerId && (
        <ContentPreviewDialog
          layerId={previewLayerId}
          onClose={() => setPreviewLayerId(null)}
          onShare={
            previewTarget && canActOn(previewTarget)
              ? () => setDialog({ action: ContentActions.SHARE, items: [previewTarget] })
              : undefined
          }
          onMove={
            previewTarget && canActOn(previewTarget)
              ? () => setDialog({ action: ContentActions.MOVE, items: [previewTarget] })
              : undefined
          }
        />
      )}

      {templateOpen && !templateOpen.autoUse && (
        <TemplatePreviewDialog
          open
          template={loadedTemplate}
          loading={!loadedTemplate}
          sourceLabel={
            loadedTemplate ? templateSourceLabel(templateShelfOf(loadedTemplate, spaces), t) : undefined
          }
          onClose={() => setTemplateOpen(null)}
          onUse={() => loadedTemplate && setTemplateToUse(loadedTemplate)}
        />
      )}

      {editTemplate && (
        <SaveTemplateDialog
          template={editTemplate}
          onClose={() => setEditTemplate(null)}
          onSaved={() => {
            setEditTemplate(null);
            refreshContentFeed();
          }}
        />
      )}

      {templateToUse && (
        <UseTemplateFlow
          template={templateToUse}
          context={{ kind: "new_project" }}
          onClose={() => setTemplateToUse(null)}
          onDone={(result) => {
            setTemplateToUse(null);
            router.push(templateResultHref(templateToUse, result));
          }}
        />
      )}

      {dialog?.action === ContentActions.DELETE && (
        <ContentDeleteDialog
          items={dialog.items}
          onClose={() => setDialog(null)}
          onDeleted={selection.clear}
        />
      )}

      {shareItem && shareSpace && (
        <ShareDialog
          item={shareItem}
          space={shareSpace}
          folders={folders ?? []}
          onClose={() => setDialog(null)}
          onTransfer={
            shareItemTransferEligible
              ? () => setDialog({ action: ContentActions.TRANSFER, items: [shareItem] })
              : undefined
          }
        />
      )}

      {moveDialogItems && moveSpace && (
        <MoveDialog
          items={moveDialogItems}
          space={moveSpace}
          folders={folders ?? []}
          homeFolderId={moveHomeFolder?.id}
          onClose={() => setDialog(null)}
          onMoved={selection.clear}
        />
      )}

      {transferDialogItems && (
        <TransferDialog
          items={transferDialogItems}
          spaces={spaces}
          presetTargetId={dialog?.presetTargetId}
          onClose={() => setDialog(null)}
          onTransferred={selection.clear}
        />
      )}

      {trashOpen && space && <TrashDialog space={space} onClose={() => setTrashOpen(false)} />}

      {settingsOpen && space && <SpaceSettingsDialog space={space} onClose={() => setSettingsOpen(false)} />}

      {dialog && ACTION_DIALOG_ACTIONS.includes(dialog.action) && dialog.items[0] && (
        <ContentActionDialogs action={dialog.action} item={dialog.items[0]} onClose={() => setDialog(null)} />
      )}
    </Box>
  );
};

export default ContentPage;
