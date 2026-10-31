"use client";

import {
  Box,
  ButtonBase,
  ClickAwayListener,
  Dialog,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import type { TextUIPart } from "ai";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { type DragEvent, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { refreshWorkflowList } from "@/lib/api/workflows";
import { addItemToProject } from "@/lib/assistant/addToProject";
import { plainTranslate } from "@/lib/assistant/chips";
import {
  refreshConversationLists,
  updateConversation,
  useConversations,
} from "@/lib/assistant/conversations";
import { openCreatedWorkflow, workflowHref } from "@/lib/assistant/createdWorkflows";
import { assistantErrorKey } from "@/lib/assistant/errors";
import { conversationTitle, provisionalTitle } from "@/lib/assistant/history";
import {
  getActiveSurface,
  getDockState,
  openConversation,
  peekFirstMessage,
  setDockState,
  useActiveSurface,
  useDockState,
} from "@/lib/assistant/store";
import type { AssistantMessage } from "@/lib/assistant/types";
import { followWorkflowChanges } from "@/lib/assistant/workflowEdits";
import appStore from "@/lib/store";
import { setMapMode } from "@/lib/store/map/slice";
import { requestWorkflowReload } from "@/lib/store/workflow/slice";
import { DROP_FILE_EXTENSIONS, NEEDS_SETUP, carriesFiles, extensionOf } from "@/lib/utils/dataFiles";

import { useAppDispatch } from "@/hooks/store/ContextHooks";

import ConversationHistory from "@/components/assistant/ConversationHistory";
import ConversationPane from "@/components/assistant/ConversationPane";
import { type DockActions, DockActionsContext } from "@/components/assistant/DockActions";
import DockPanel from "@/components/assistant/DockPanel";
import { DialogLoadFailed, DockErrorBoundary, orLoadFailed } from "@/components/assistant/LoadFailed";
import NewConversation from "@/components/assistant/NewConversation";
import {
  CARD_RADIUS,
  accentSoft,
  accentText,
  dockBackdropSx,
  dockHeaderSx,
  dockInsetPaperSx,
  dockSidebarSx,
  focusRing,
  headerIconButtonSx,
} from "@/components/assistant/styles";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";
import { TOOLBAR_HEIGHT } from "@/components/header/Toolbar";

// What a dropped file, a card's "All details" or a bundle opens: each carries the
// catalog, content or map stack with it, so the dock loads it only when it opens.
// Code that does not load (gone after a deploy) shows a notice with a reload instead.
const AddLayerDialog = dynamic(
  () => orLoadFailed(import("@/components/addLayer/AddLayerDialog"), DialogLoadFailed),
  { ssr: false }
);
const ContentPreviewDialog = dynamic(
  () => orLoadFailed(import("@/components/dashboard/content/ContentPreviewDialog"), DialogLoadFailed),
  { ssr: false }
);
const BundlePreviewDialog = dynamic(
  () => orLoadFailed(import("@/components/dashboard/bundle/BundlePreviewDialog"), DialogLoadFailed),
  { ssr: false }
);

/** The text of the first user message, as the history shows it for an untitled conversation. */
function firstUserText(messages: AssistantMessage[]): string | null {
  const first = messages.find((message) => message.role === "user");
  const text = first?.parts
    .filter((part): part is TextUIPart => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text || null;
}

/** The assistant's mark before its name: the sparkle on a 28px tinted square. */
function AssistantMark() {
  const theme = useTheme();
  return (
    <Box
      aria-hidden
      sx={{
        width: 28,
        height: 28,
        borderRadius: "8px",
        flex: "none",
        bgcolor: accentSoft(theme),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
      <Icon iconName={ICON_NAME.SPARKLES} style={{ fontSize: 15, color: accentText(theme) }} />
    </Box>
  );
}

/** "Beta" after the assistant's name, in the accent shade that keeps its contrast in both modes. */
function BetaChip() {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Typography
      component="span"
      sx={{
        flex: "none",
        px: "6px",
        py: "1px",
        border: `1px solid ${accentText(theme)}`,
        borderRadius: "6px",
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.04em",
        lineHeight: 1.4,
        textTransform: "uppercase",
        color: accentText(theme),
      }}>
      {t("assistant_beta")}
    </Typography>
  );
}

/**
 * The assistant (spec §10): a panel docked on the right, or a near full-screen
 * view with the history beside it. A data file dropped here opens the existing
 * upload dialog; files are never chat attachments. `framed`: it replaces its
 * loading frame (DockSkeleton), which came in already, so it shows at once.
 */
export default function AssistantDock({
  variant,
  framed = false,
}: {
  variant: "docked" | "fullscreen";
  framed?: boolean;
}) {
  const { t } = useTranslation("common");
  const router = useRouter();
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down("md"));
  const dock = useDockState();
  const surface = useActiveSurface();
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyHintId = useId();
  const [upload, setUpload] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [bundlePreview, setBundlePreview] = useState<string | null>(null);
  const dispatch = useAppDispatch();
  const pathname = usePathname();
  const { conversations } = useConversations({});
  // The title of the open conversation: the history's (renamed or titled since) or the loaded one's;
  // without a title, its first message (the history lists the newest conversations only).
  const [loaded, setLoaded] = useState<{
    id: string;
    title: string | null;
    firstMessage: string | null;
  } | null>(null);
  const active = conversations.find((conversation) => conversation.id === dock.conversationId);
  const own = loaded?.id === dock.conversationId ? loaded : null;
  // A conversation just started: the message it was started with names it until the history
  // or its load knows its first message. Read once it opens, since its chat forgets it on sending.
  const sentFirst = (id: string | null) => ({
    id,
    text: id ? provisionalTitle(peekFirstMessage(id)?.text) : null,
  });
  const [provisional, setProvisional] = useState(() => sentFirst(dock.conversationId));
  if (provisional.id !== dock.conversationId) setProvisional(sentFirst(dock.conversationId));
  const title = dock.conversationId
    ? conversationTitle(
        {
          title: active?.title ?? own?.title ?? null,
          first_message: active?.first_message ?? own?.firstMessage ?? provisional.text,
        },
        plainTranslate(t)
      )
    : t("assistant_new_conversation");
  const inProject = !!surface?.project;
  /** Workflows the card's Open reads the list for before it opens them. */
  const openingWorkflows = useRef(new Set<string>());

  const actions = useMemo<DockActions>(
    () => ({
      openRecord: (id) => {
        const href = `/catalog/${encodeURIComponent(id)}`;
        if (inProject) window.open(href, "_blank", "noopener");
        else router.push(href);
      },
      openProject: (projectId) => {
        const href = `/map/${projectId}`;
        if (inProject) window.open(href, "_blank", "noopener");
        else router.push(href);
      },
      openInProjectMode: (projectId, mode, itemId) => {
        // The project page reads mode and item from the URL, also when it is open already.
        const href =
          mode === "workflows"
            ? workflowHref(projectId, itemId)
            : `/map/${projectId}?mode=${mode}&layout=${encodeURIComponent(itemId)}`;
        if (inProject && surface?.project?.id !== projectId) {
          window.open(href, "_blank", "noopener");
          return;
        }
        if (mode !== "workflows") {
          router.push(href);
          return;
        }
        // The page selects the workflow only from a list that carries it, and the
        // cached list may predate it (one the assistant just created): read it first.
        // A second click while it is read starts nothing; a person who left the
        // project meanwhile stays where they went.
        if (openingWorkflows.current.has(itemId)) return;
        openingWorkflows.current.add(itemId);
        const from = getActiveSurface()?.project?.id ?? null;
        void refreshWorkflowList(projectId)
          .catch(() => undefined)
          .then(() => {
            openingWorkflows.current.delete(itemId);
            if ((getActiveSurface()?.project?.id ?? null) === from) router.push(href);
          });
      },
      openCreatedWorkflow: (projectId, workflowId) =>
        openCreatedWorkflow(
          { projectId, workflowId },
          {
            openProjectId: () => getActiveSurface()?.project?.id ?? null,
            // The app's one store (StoreProvider provides this object), read when
            // asked, so an edit made while the list is read counts. Features drawn
            // or edited on the map and not saved yet count too, as the map's own
            // "stop editing" confirmation counts them.
            hasUnsavedChanges: () => {
              const { workflow, featureEditor } = appStore.getState();
              return workflow.isDirty || Object.keys(featureEditor.pendingFeatures).length > 0;
            },
            refreshList: refreshWorkflowList,
            navigate: (href) => router.push(href),
          }
        ),
      followWorkflowChanges: (changes) =>
        followWorkflowChanges(changes, {
          // The app's one store, as above: the Workflows editor takes the change over
          // when it shows that workflow, also once it opens again.
          openWorkflowId: () => appStore.getState().workflow.selectedWorkflowId,
          openProjectId: () => getActiveSurface()?.project?.id ?? null,
          requestReload: (id, revision) => appStore.dispatch(requestWorkflowReload({ id, revision })),
          refreshList: refreshWorkflowList,
        }),
      unsavedWorkflowChanges: (workflowIds) => {
        // A pan alone does not count: it is saved after the change is loaded.
        const { selectedWorkflowId, contentDirty } = appStore.getState().workflow;
        return !!selectedWorkflowId && contentDirty && workflowIds.includes(selectedWorkflowId);
      },
      previewDataset: (layerId) => setPreview(layerId),
      previewBundle: (bundleId) => setBundlePreview(bundleId),
      zoomToLayer: (layerProjectId) => void getActiveSurface()?.zoomToLayer?.(layerProjectId),
      addToProject: async (item, projectId = getActiveSurface()?.uploadTo?.projectId) => {
        if (!projectId) throw new Error("No project to add to");
        return addItemToProject(projectId, item);
      },
      openInProject: async (projectId, options = {}) => {
        if (options.bindConversationId) {
          try {
            await updateConversation(options.bindConversationId, { project_id: projectId });
            // The open conversation is read only elsewhere from now on (spec §10).
            setDockState({
              bound: {
                conversationId: options.bindConversationId,
                projectId,
                projectName: options.projectName ?? null,
              },
            });
            void refreshConversationLists();
          } catch (error) {
            toast.error(t(assistantErrorKey(error)));
            return;
          }
        }
        const conversationId = getDockState().conversationId;
        setDockState({
          open: true,
          review: options.partId && conversationId ? { conversationId, partId: options.partId } : null,
        });
        // A map view applies in Map mode only; from Workflows, Layouts or the
        // dashboard of the same project this switches the mode (W21).
        dispatch(setMapMode("data"));
        if (pathname !== `/map/${projectId}`) router.push(`/map/${projectId}`);
      },
      openCatalog: (href) => router.push(href),
      newConversationHere: () => openConversation(null),
    }),
    [dispatch, inProject, pathname, router, surface?.project?.id, t]
  );

  const onDragOver = (event: DragEvent) => {
    if (carriesFiles(event)) event.preventDefault();
  };
  const onDrop = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length > 1) {
      toast.warning(t("drop_one_file_only"));
      return;
    }
    const [file] = files;
    if (!file) return;
    if (!DROP_FILE_EXTENSIONS.includes(extensionOf(file))) {
      toast.error(t("assistant_drop_not_data"));
      return;
    }
    setUpload(file);
  };

  const expandLabel = t(variant === "docked" ? "assistant_expand" : "assistant_collapse");
  // Full screen beside its sidebar, the sidebar is the history: the title only names the conversation.
  // A phone shows the docked layout over the whole screen, so it keeps the compact sizes too.
  const sidebar = variant === "fullscreen" && !isPhone;
  const titleText = (
    <Typography
      noWrap
      sx={{
        flex: sidebar ? undefined : "0 1 auto",
        minWidth: 0,
        textAlign: sidebar ? "center" : "left",
        fontSize: sidebar ? 13.5 : 14,
        fontWeight: 700,
        letterSpacing: "-0.2px",
        color: "text.primary",
      }}>
      {title}
    </Typography>
  );
  const header = (
    <Stack direction="row" alignItems="center" gap="4px" sx={dockHeaderSx(theme, sidebar)}>
      {sidebar ? (
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center", pl: "64px" }}>
          {titleText}
        </Box>
      ) : (
        <>
          <AssistantMark />
          <ButtonBase
            onClick={() => setHistoryOpen((value) => !value)}
            aria-expanded={historyOpen}
            // Named by the visible title; what it opens is its description.
            aria-describedby={historyHintId}
            sx={{
              // A button does not inherit the page font by itself.
              fontFamily: "inherit",
              flex: "0 1 auto",
              minWidth: 0,
              justifyContent: "flex-start",
              gap: "8px",
              borderRadius: "8px",
              py: "6px",
              pl: "4px",
              pr: "6px",
              "&:hover": { bgcolor: "action.hover" },
              ...focusRing(theme),
            }}>
            {titleText}
            <Icon
              iconName={ICON_NAME.CHEVRON_DOWN}
              style={{
                fontSize: 11,
                flexShrink: 0,
                color: theme.palette.text.secondary,
                transform: historyOpen ? "rotate(180deg)" : undefined,
                transition: "transform 120ms",
              }}
            />
          </ButtonBase>
          <BetaChip />
          <Box sx={{ flex: 1 }} />
          {/* Outside the button, so it describes it without becoming part of its name. */}
          <Box component="span" id={historyHintId} sx={visuallyHidden}>
            {t("assistant_history")}
          </Box>
          <Tooltip title={t("assistant_new_conversation")}>
            <IconButton
              aria-label={t("assistant_new_conversation")}
              onClick={() => {
                setHistoryOpen(false);
                openConversation(null);
              }}
              sx={headerIconButtonSx(theme)}>
              <Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 14, color: "inherit" }} />
            </IconButton>
          </Tooltip>
        </>
      )}
      {!isPhone && (
        <Tooltip title={expandLabel}>
          <IconButton
            aria-label={expandLabel}
            onClick={() => setDockState({ expanded: variant === "docked" })}
            sx={headerIconButtonSx(theme)}>
            <Icon
              iconName={variant === "docked" ? ICON_NAME.MAXIMIZE : ICON_NAME.MINIMIZE}
              style={{ fontSize: 13, color: "inherit" }}
            />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title={t("close")}>
        <IconButton
          aria-label={t("close")}
          onClick={() => setDockState({ open: false, expanded: false })}
          sx={headerIconButtonSx(theme)}>
          <Icon iconName={ICON_NAME.CLOSE} style={{ fontSize: 13, color: "inherit" }} />
        </IconButton>
      </Tooltip>
    </Stack>
  );

  const historyMenu = historyOpen && !sidebar && (
    <ClickAwayListener onClickAway={() => setHistoryOpen(false)}>
      <Paper
        elevation={0}
        sx={{
          position: "absolute",
          top: TOOLBAR_HEIGHT,
          left: 12,
          right: 12,
          zIndex: 2,
          maxHeight: "min(60%, 440px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: CARD_RADIUS,
          border: 1,
          borderColor: "divider",
          boxShadow: surfaceShadows(theme).hover,
        }}>
        <ConversationHistory onPicked={() => setHistoryOpen(false)} />
      </Paper>
    </ClickAwayListener>
  );

  const conversation = dock.conversationId ? (
    <ConversationPane
      key={dock.conversationId}
      conversationId={dock.conversationId}
      big={sidebar}
      onLoaded={(detail) =>
        setLoaded({
          id: detail.conversation.id,
          title: detail.conversation.title,
          firstMessage: firstUserText(detail.messages),
        })
      }
    />
  ) : (
    <NewConversation big={sidebar} />
  );
  const pane = <DockErrorBoundary resetKey={dock.conversationId}>{conversation}</DockErrorBoundary>;

  const dialogs = (
    <>
      {upload && (
        <AddLayerDialog
          source="upload"
          projectId={surface?.uploadTo?.projectId}
          defaultFolderId={surface?.uploadTo?.folderId}
          initialFile={upload}
          autoOpenSetup={NEEDS_SETUP.includes(extensionOf(upload))}
          onClose={() => setUpload(null)}
        />
      )}
      {preview && <ContentPreviewDialog layerId={preview} onClose={() => setPreview(null)} />}
      {bundlePreview && (
        <BundlePreviewDialog bundleId={bundlePreview} onClose={() => setBundlePreview(null)} />
      )}
    </>
  );

  if (variant === "docked") {
    return (
      <DockActionsContext.Provider value={actions}>
        <DockPanel label={t("assistant_ask_ai")} entrance={!framed} onDragOver={onDragOver} onDrop={onDrop}>
          {header}
          {historyMenu}
          {pane}
        </DockPanel>
        {dialogs}
      </DockActionsContext.Provider>
    );
  }

  const enterAtOnce = framed ? { enter: 0, exit: theme.transitions.duration.leavingScreen } : undefined;
  return (
    <DockActionsContext.Provider value={actions}>
      <Dialog
        open
        fullScreen={isPhone}
        maxWidth={false}
        onClose={() => setDockState({ expanded: false })}
        aria-label={t("assistant_ask_ai")}
        transitionDuration={enterAtOnce}
        // The backdrop's own props replace the ones the dialog passes it, its duration too.
        slotProps={{ backdrop: { sx: dockBackdropSx(theme), transitionDuration: enterAtOnce } }}
        PaperProps={{ sx: isPhone ? undefined : dockInsetPaperSx(theme) }}>
        <Stack direction="row" sx={{ height: "100%", minHeight: 0 }} onDragOver={onDragOver} onDrop={onDrop}>
          {sidebar && (
            <Box sx={dockSidebarSx}>
              <Stack
                direction="row"
                alignItems="center"
                gap="10px"
                // Level with the conversation header beside it.
                sx={{
                  boxSizing: "content-box",
                  height: TOOLBAR_HEIGHT,
                  pb: "1px",
                  flexShrink: 0,
                  px: "18px",
                }}>
                <AssistantMark />
                <Typography sx={{ fontSize: 15, fontWeight: 700, color: "text.primary" }}>
                  {t("assistant_ask_ai")}
                </Typography>
                <BetaChip />
              </Stack>
              <Box sx={{ px: "10px", pb: "4px" }}>
                <ButtonBase
                  onClick={() => openConversation(null)}
                  sx={{
                    fontFamily: "inherit",
                    width: "100%",
                    justifyContent: "flex-start",
                    gap: "10px",
                    px: "10px",
                    py: "8px",
                    borderRadius: "8px",
                    fontSize: 13,
                    fontWeight: 700,
                    color: "text.primary",
                    bgcolor: dock.conversationId ? "transparent" : accentSoft(theme),
                    "&:hover": { bgcolor: dock.conversationId ? "action.hover" : accentSoft(theme) },
                    ...focusRing(theme),
                  }}>
                  <Icon
                    iconName={ICON_NAME.PLUS}
                    style={{ fontSize: 13, color: theme.palette.text.secondary }}
                  />
                  {t("assistant_new_conversation")}
                </ButtonBase>
              </Box>
              <ConversationHistory variant="sidebar" />
            </Box>
          )}
          <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
            {header}
            {historyMenu}
            {pane}
          </Stack>
        </Stack>
      </Dialog>
      {dialogs}
    </DockActionsContext.Provider>
  );
}
